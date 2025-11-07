import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface WorkerNode {
  hostname: string;
  id: string;
  availability: string;
}

// Configuration
const DOKPLOY_MANAGER = process.env.DOKPLOY_MANAGER_HOST || "dokploy-manager";
const EDITOR_VOLUME_NAME = process.env.EDITOR_VOLUME_NAME || "webedt-editor-volume";
const SERVICE_APP_REPO = "https://github.com/ETdoFresh/webedt-service-app";

/**
 * Get list of worker nodes with storage enabled
 */
export async function getStorageWorkerNodes(): Promise<WorkerNode[]> {
  console.log("[VOLUME] Fetching worker nodes with storage enabled...");

  const cmd = `ssh ${DOKPLOY_MANAGER} "docker node ls \\
    --filter 'role=worker' \\
    --filter 'label=webedt.storage=enabled' \\
    --format '{{.Hostname}}|{{.ID}}|{{.Availability}}'"`;

  try {
    const { stdout } = await execAsync(cmd);

    if (!stdout.trim()) {
      console.warn("[VOLUME] No worker nodes with webedt.storage=enabled label found");
      // Fallback: Get all worker nodes
      return getAllWorkerNodes();
    }

    const nodes = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [hostname, id, availability] = line.split("|");
        return { hostname, id, availability };
      });

    console.log(`[VOLUME] Found ${nodes.length} storage-enabled worker nodes:`, nodes.map(n => n.hostname).join(", "));
    return nodes;
  } catch (error) {
    console.error("[VOLUME] Failed to get storage worker nodes:", error);
    throw new Error("Failed to query Docker Swarm worker nodes");
  }
}

/**
 * Get all worker nodes (fallback if no labels set)
 */
async function getAllWorkerNodes(): Promise<WorkerNode[]> {
  console.log("[VOLUME] Falling back to all worker nodes...");

  const cmd = `ssh ${DOKPLOY_MANAGER} "docker node ls \\
    --filter 'role=worker' \\
    --format '{{.Hostname}}|{{.ID}}|{{.Availability}}'"`;

  const { stdout } = await execAsync(cmd);

  const nodes = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hostname, id, availability] = line.split("|");
      return { hostname, id, availability };
    });

  console.log(`[VOLUME] Found ${nodes.length} worker nodes:`, nodes.map(n => n.hostname).join(", "));
  return nodes;
}

/**
 * Select worker node for new session using round-robin
 */
let lastNodeIndex = -1;
export async function selectWorkerNode(): Promise<string> {
  const nodes = await getStorageWorkerNodes();

  if (nodes.length === 0) {
    throw new Error("No worker nodes available for storage");
  }

  // Round-robin selection
  lastNodeIndex = (lastNodeIndex + 1) % nodes.length;
  const selectedNode = nodes[lastNodeIndex].hostname;

  console.log(`[VOLUME] Selected worker node: ${selectedNode} (${lastNodeIndex + 1}/${nodes.length})`);
  return selectedNode;
}

/**
 * Create volume on specific worker node
 */
export async function createVolumeOnWorkerNode(
  volumeName: string,
  workerNode: string,
): Promise<void> {
  console.log(`[VOLUME] Creating volume ${volumeName} on worker node ${workerNode}`);

  // Execute docker volume create on the specific worker node
  const cmd = `ssh ${workerNode} "docker volume create ${volumeName}"`;

  try {
    const { stdout } = await execAsync(cmd);
    console.log(`[VOLUME] ✓ Created volume: ${volumeName} on ${workerNode}`);
  } catch (error) {
    console.error(`[VOLUME] ✗ Failed to create volume ${volumeName} on ${workerNode}:`, error);
    throw error;
  }
}

/**
 * Delete volume on specific worker node
 */
export async function deleteVolumeOnWorkerNode(
  volumeName: string,
  workerNode: string,
): Promise<void> {
  console.log(`[VOLUME] Deleting volume ${volumeName} from worker node ${workerNode}`);

  // Use || true to not fail if volume doesn't exist
  const cmd = `ssh ${workerNode} "docker volume rm ${volumeName} || true"`;

  try {
    await execAsync(cmd);
    console.log(`[VOLUME] ✓ Deleted volume: ${volumeName} from ${workerNode}`);
  } catch (error) {
    console.warn(`[VOLUME] ⚠ Failed to delete volume ${volumeName} from ${workerNode}:`, error);
    // Don't throw - best effort cleanup
  }
}

/**
 * Check if volume exists on worker node
 */
export async function volumeExistsOnNode(
  volumeName: string,
  workerNode: string,
): Promise<boolean> {
  const cmd = `ssh ${workerNode} "docker volume inspect ${volumeName} >/dev/null 2>&1 && echo 'exists' || echo 'not-found'"`;

  try {
    const { stdout } = await execAsync(cmd);
    return stdout.trim() === "exists";
  } catch (error) {
    return false;
  }
}

/**
 * Create editor volume on ALL worker nodes (shared read-only content)
 */
export async function createEditorVolumeOnAllWorkers(): Promise<void> {
  const nodes = await getStorageWorkerNodes();

  console.log(`[VOLUME] Creating editor volume on ${nodes.length} worker nodes...`);

  const results = await Promise.allSettled(
    nodes.map((node) => createEditorVolumeOnNode(node.hostname))
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(`[VOLUME] Editor volume setup complete: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    console.error("[VOLUME] Some nodes failed to create editor volume:");
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(`  - ${nodes[i].hostname}: ${result.reason}`);
      }
    });
  }

  if (succeeded === 0) {
    throw new Error("Failed to create editor volume on any worker node");
  }
}

/**
 * Create editor volume on specific worker node
 */
async function createEditorVolumeOnNode(workerNode: string): Promise<void> {
  console.log(`[VOLUME] Setting up editor volume on ${workerNode}...`);

  // Check if volume already exists
  const exists = await volumeExistsOnNode(EDITOR_VOLUME_NAME, workerNode);
  if (exists) {
    console.log(`[VOLUME] Editor volume already exists on ${workerNode}, skipping`);
    return;
  }

  // Create volume and populate with editor code
  const cmd = `ssh ${workerNode} "
    docker volume create ${EDITOR_VOLUME_NAME} && \\
    docker run --rm -v ${EDITOR_VOLUME_NAME}:/app node:20-slim bash -c '
      cd /app &&
      apt-get update && apt-get install -y git && \\
      git clone ${SERVICE_APP_REPO} . && \\
      npm ci && \\
      npm run build && \\
      npm ci --production && \\
      echo \"Editor volume ready\" && \\
      ls -la
    '
  "`;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for build output
    });

    console.log(`[VOLUME] ✓ Editor volume ready on ${workerNode}`);
    if (stdout) console.log(`[VOLUME] Build output: ${stdout.substring(0, 500)}...`);
  } catch (error) {
    console.error(`[VOLUME] ✗ Failed to setup editor volume on ${workerNode}:`, error);
    throw error;
  }
}

/**
 * Update editor volume on all worker nodes (pulls latest code)
 */
export async function updateEditorVolumeOnAllWorkers(): Promise<void> {
  const nodes = await getStorageWorkerNodes();

  console.log(`[VOLUME] Updating editor volume on ${nodes.length} worker nodes...`);

  const results = await Promise.allSettled(
    nodes.map((node) => updateEditorVolumeOnNode(node.hostname))
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(`[VOLUME] Editor volume update complete: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    console.error("[VOLUME] Some nodes failed to update editor volume:");
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(`  - ${nodes[i].hostname}: ${result.reason}`);
      }
    });
  }
}

/**
 * Update editor volume on specific worker node
 */
async function updateEditorVolumeOnNode(workerNode: string): Promise<void> {
  console.log(`[VOLUME] Updating editor volume on ${workerNode}...`);

  const cmd = `ssh ${workerNode} "
    docker run --rm -v ${EDITOR_VOLUME_NAME}:/app node:20-slim bash -c '
      cd /app && \\
      apt-get update && apt-get install -y git && \\
      git pull && \\
      npm ci && \\
      npm run build && \\
      npm ci --production && \\
      echo \"Editor volume updated\"
    '
  "`;

  try {
    await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    console.log(`[VOLUME] ✓ Editor volume updated on ${workerNode}`);
  } catch (error) {
    console.error(`[VOLUME] ✗ Failed to update editor volume on ${workerNode}:`, error);
    throw error;
  }
}

/**
 * Get editor volume status across all worker nodes
 */
export async function getEditorVolumeStatus(): Promise<{
  nodes: Array<{ hostname: string; exists: boolean; error?: string }>;
  totalNodes: number;
  readyNodes: number;
}> {
  const nodes = await getStorageWorkerNodes();

  console.log(`[VOLUME] Checking editor volume status on ${nodes.length} nodes...`);

  const statuses = await Promise.all(
    nodes.map(async (node) => {
      try {
        const exists = await volumeExistsOnNode(EDITOR_VOLUME_NAME, node.hostname);
        return { hostname: node.hostname, exists };
      } catch (error) {
        return {
          hostname: node.hostname,
          exists: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  const readyNodes = statuses.filter((s) => s.exists).length;

  return {
    nodes: statuses,
    totalNodes: nodes.length,
    readyNodes,
  };
}

/**
 * List all volumes on a worker node
 */
export async function listVolumesOnNode(workerNode: string): Promise<string[]> {
  const cmd = `ssh ${workerNode} "docker volume ls --format '{{.Name}}'"`;

  try {
    const { stdout } = await execAsync(cmd);
    return stdout.trim().split("\n").filter(Boolean);
  } catch (error) {
    console.error(`[VOLUME] Failed to list volumes on ${workerNode}:`, error);
    return [];
  }
}

/**
 * Find orphaned session volumes (volumes that don't have a database record)
 */
export async function findOrphanedVolumes(
  activeSessions: Set<string>,
): Promise<Map<string, string[]>> {
  const nodes = await getStorageWorkerNodes();
  const orphanedByNode = new Map<string, string[]>();

  for (const node of nodes) {
    const volumes = await listVolumesOnNode(node.hostname);
    const sessionVolumes = volumes.filter((v) => v.startsWith("session-"));

    const orphaned = sessionVolumes.filter((volumeName) => {
      // Extract session ID from volume name (session-{sessionId})
      const sessionId = volumeName.replace(/^session-/, "");
      return !activeSessions.has(sessionId);
    });

    if (orphaned.length > 0) {
      orphanedByNode.set(node.hostname, orphaned);
      console.log(`[VOLUME] Found ${orphaned.length} orphaned volumes on ${node.hostname}`);
    }
  }

  return orphanedByNode;
}

/**
 * Cleanup orphaned volumes
 */
export async function cleanupOrphanedVolumes(
  orphanedByNode: Map<string, string[]>,
): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const errors: string[] = [];

  for (const [node, volumes] of orphanedByNode.entries()) {
    for (const volumeName of volumes) {
      try {
        await deleteVolumeOnWorkerNode(volumeName, node);
        deleted.push(`${volumeName} on ${node}`);
      } catch (error) {
        const errorMsg = `${volumeName} on ${node}: ${error}`;
        errors.push(errorMsg);
      }
    }
  }

  return { deleted, errors };
}
