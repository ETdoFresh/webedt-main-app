import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import { z } from "zod";
import { database } from "../db";
import type { DeployConfig, DeployEnvVar } from "../../shared/dokploy";
import { createDokployClient } from "../services/dokployClient";
import { synchronizeDokployApplication } from "../services/dokploySyncService";
import {
  createWorkspaceArchive,
  getArtifactPath,
} from "../services/workspaceArchiveService";
import { requireAdmin } from "../middleware/auth";
import {
  createEditorVolumeOnAllWorkers,
  updateEditorVolumeOnAllWorkers,
  getEditorVolumeStatus,
  findOrphanedVolumes,
  cleanupOrphanedVolumes,
  getStorageWorkerNodes,
} from "../services/dockerSwarmVolumeHelper";

const router = Router();
router.use(requireAdmin);

const envVarSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string().optional(),
  masked: z.boolean().optional(),
  isSecret: z.boolean().optional(),
});

const gitSourceSchema = z.object({
  type: z.literal("git"),
  provider: z.enum(["github", "gitlab", "bitbucket", "custom"]),
  repository: z.string().optional(),
  owner: z.string().optional(),
  branch: z.string().optional(),
  buildPath: z.string().optional(),
  projectId: z.string().optional(),
});

const workspaceSourceSchema = z.object({
  type: z.literal("workspace"),
  lastUploadedAt: z.string().optional().nullable(),
  artifactUrl: z.string().optional().nullable(),
  artifactKey: z.string().optional().nullable(),
  expiresAt: z.string().optional().nullable(),
});

const buildSchema = z.object({
  buildType: z.enum([
    "dockerfile",
    "heroku_buildpacks",
    "paketo_buildpacks",
    "nixpacks",
    "static",
  ]),
  dockerfile: z.string().optional().nullable(),
  dockerContextPath: z.string().optional().nullable(),
  dockerBuildStage: z.string().optional().nullable(),
  publishDirectory: z.string().optional().nullable(),
});

const resourcesSchema = z.object({
  cpuLimit: z.number().nullable().optional(),
  cpuReservation: z.number().nullable().optional(),
  memoryLimit: z.number().nullable().optional(),
  memoryReservation: z.number().nullable().optional(),
  replicas: z.number().int().nullable().optional(),
});

const configSchema = z.object({
  baseUrl: z.string().trim().min(1),
  authMethod: z.enum(["x-api-key", "authorization"]),
  projectId: z.string().trim().min(1).optional(),
  environmentId: z.string().trim().min(1).optional(),
  serverId: z.string().trim().min(1).optional(),
  githubId: z.string().trim().min(1).optional(),
  applicationId: z.string().trim().min(1).optional(),
  appName: z.string().trim().min(1).optional(),
  domain: z.string().trim().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  traefikConfig: z.string().optional(),
  autoDeploy: z.boolean().optional(),
  env: z.array(envVarSchema).optional(),
  source: z.discriminatedUnion("type", [gitSourceSchema, workspaceSourceSchema]),
  build: buildSchema.optional(),
  resources: resourcesSchema.optional(),
  lastSyncedAt: z.string().optional(),
  apiKey: z.string().optional().nullable(),
});

const loadConfigOrThrow = (): { config: DeployConfig; hasApiKey: boolean } => {
  const stored = database.getDeployConfig();
  if (!stored) {
    throw new Error("Dokploy configuration is not initialized.");
  }
  return { config: stored.config, hasApiKey: stored.hasApiKey };
};

const maskEnvVars = (env?: DeployEnvVar[]): DeployEnvVar[] | undefined => {
  if (!env) {
    return undefined;
  }

  return env.map((entry) => ({
    ...entry,
    value: entry.masked ? undefined : entry.value,
  }));
};

router.get("/deploy/config", (_req: Request, res: Response) => {
  const stored = database.getDeployConfig();
  if (!stored) {
    res.status(404).json({ error: "Dokploy configuration not found." });
    return;
  }

  res.json({
    ...stored.config,
    hasApiKey: stored.hasApiKey,
    env: maskEnvVars(stored.config.env),
  });
});

router.put("/deploy/config", (req: Request, res: Response) => {
  const parsed = configSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const { formErrors, fieldErrors } = parsed.error.flatten();
    const messages = [...formErrors, ...Object.values(fieldErrors).flat()].filter(
      (message) => message && message.length > 0,
    );
    res.status(400).json({ error: messages.join("; ") || "Invalid payload" });
    return;
  }

  const body = parsed.data;
  const current = database.getDeployConfig();
  const currentEnvMap = new Map<string, DeployEnvVar>();
  if (current?.config.env) {
    current.config.env.forEach((entry) => {
      currentEnvMap.set(entry.key, entry);
    });
  }

  const mergedEnv = body.env?.map((entry) => {
    if (entry.masked && (entry.value === undefined || entry.value === null)) {
      const previous = currentEnvMap.get(entry.key);
      if (previous && previous.value !== undefined) {
        return { ...entry, value: previous.value };
      }
    }
    return entry;
  });

  const configToSave: DeployConfig = {
    baseUrl: body.baseUrl,
    authMethod: body.authMethod,
    projectId: body.projectId,
    environmentId: body.environmentId,
    serverId: body.serverId,
    githubId: body.githubId,
    applicationId: body.applicationId ?? current?.config.applicationId,
    appName: body.appName,
    domain: body.domain,
    port: body.port,
    traefikConfig: body.traefikConfig,
    autoDeploy: body.autoDeploy,
    env: mergedEnv,
    source: body.source,
    build: body.build,
    resources: body.resources,
    lastSyncedAt: body.lastSyncedAt ?? current?.config.lastSyncedAt,
  };

  const saved = database.saveDeployConfig({
    config: configToSave,
    apiKey: body.apiKey === undefined ? undefined : body.apiKey,
  });

  res.json({
    ...saved.config,
    hasApiKey: saved.hasApiKey,
    env: maskEnvVars(saved.config.env),
  });
});

router.post("/deploy/test", async (req: Request, res: Response) => {
  try {
    // Allow testing with unsaved credentials
    const baseUrlOverride = typeof req.body?.baseUrl === "string" ? req.body.baseUrl : undefined;
    const authMethodOverride = typeof req.body?.authMethod === "string" ? req.body.authMethod : undefined;
    const apiKeyOverride = typeof req.body?.apiKey === "string" ? req.body.apiKey : undefined;

    let config: DeployConfig;
    let apiKey: string;

    if (baseUrlOverride && apiKeyOverride) {
      // Test with provided credentials (before saving)
      config = {
        baseUrl: baseUrlOverride,
        authMethod: (authMethodOverride as DeployAuthMethod) || "x-api-key",
        projectId: "",
        serverId: null,
        applicationId: null,
        appName: null,
        domain: null,
        port: null,
        traefikConfig: null,
        autoDeploy: null,
        env: [],
        source: null,
        build: null,
        resources: null,
        lastSyncedAt: null,
      };
      apiKey = apiKeyOverride;
    } else {
      // Test with saved credentials
      const stored = loadConfigOrThrow();
      config = stored.config;
      apiKey = apiKeyOverride ?? database.getDeployApiKey();
      if (!apiKey) {
        throw new Error("Dokploy API key is not configured.");
      }
    }

    const client = createDokployClient(config, apiKey);
    const result = await client.request({ method: "GET", path: "/project.all" });
    res.json({ ok: true, projects: result });
  } catch (error) {
    console.error("Failed to test Dokploy connection", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to connect to Dokploy.",
    });
  }
});

router.post("/deploy/sync", async (_req: Request, res: Response) => {
  try {
    const stored = loadConfigOrThrow();
    const apiKey = database.getDeployApiKey();
    if (!apiKey) {
      throw new Error("Dokploy API key is not configured.");
    }
    const result = await synchronizeDokployApplication(stored.config, apiKey);
    const saved = database.saveDeployConfig({
      config: result.config,
    });

    res.json({
      ...saved.config,
      hasApiKey: saved.hasApiKey,
      env: maskEnvVars(saved.config.env),
    });
  } catch (error) {
    console.error("Failed to synchronize Dokploy application", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Synchronization failed.",
    });
  }
});

router.post("/deploy/deploy", async (_req: Request, res: Response) => {
  try {
    const stored = loadConfigOrThrow();
    const apiKey = database.getDeployApiKey();
    if (!apiKey) {
      throw new Error("Dokploy API key is not configured.");
    }
    if (!stored.config.applicationId) {
      throw new Error("Configure applicationId before triggering a deployment.");
    }
    const client = createDokployClient(stored.config, apiKey);
    const result = await client.request({
      method: "POST",
      path: "/application.deploy",
      body: {
        applicationId: stored.config.applicationId,
      },
    });
    res.json({ ok: true, result });
  } catch (error) {
    console.error("Failed to trigger Dokploy deployment", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Deployment failed.",
    });
  }
});

router.get("/deploy/projects", async (_req: Request, res: Response) => {
  try {
    const stored = loadConfigOrThrow();
    const apiKey = database.getDeployApiKey();
    if (!apiKey) {
      throw new Error("Dokploy API key is not configured.");
    }
    const client = createDokployClient(stored.config, apiKey);
    const projects = await client.request({ method: "GET", path: "/project.all" });
    res.json({ projects });
  } catch (error) {
    console.error("Failed to fetch Dokploy projects", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to fetch projects.",
    });
  }
});

router.get("/deploy/applications", async (req: Request, res: Response) => {
  try {
    const stored = loadConfigOrThrow();
    const apiKey = database.getDeployApiKey();
    if (!apiKey) {
      throw new Error("Dokploy API key is not configured.");
    }
    const client = createDokployClient(stored.config, apiKey);
    const projects = await client.request<any[]>({ method: "GET", path: "/project.all" });
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    const applications = projects
      .filter((project) => !projectId || project.projectId === projectId)
      .flatMap((project) => project.applications ?? [])
      .map((app: any) => ({
        applicationId: app.applicationId ?? app.id ?? app.appName,
        name: app.name ?? app.appName,
        description: app.description ?? "",
      }));

    res.json({ applications });
  } catch (error) {
    console.error("Failed to fetch Dokploy applications", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to fetch applications.",
    });
  }
});

router.get("/deploy/environments", async (req: Request, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    console.log('[DEPLOY] Fetching environments for projectId:', projectId);

    if (!projectId) {
      res.status(400).json({ error: "projectId query parameter is required." });
      return;
    }

    const stored = loadConfigOrThrow();
    const apiKey = database.getDeployApiKey();
    if (!apiKey) {
      throw new Error("Dokploy API key is not configured.");
    }

    const client = createDokployClient(stored.config, apiKey);

    // Fetch all projects and find the matching one
    const projects = await client.request<any[]>({
      method: "GET",
      path: "/project.all",
    });

    console.log('[DEPLOY] All projects response:', JSON.stringify(projects, null, 2));

    // Find the specific project
    const project = Array.isArray(projects)
      ? projects.find((p: any) => (p.projectId || p.id) === projectId)
      : null;

    if (!project) {
      console.log('[DEPLOY] Project not found:', projectId);
      res.json({ environments: [] });
      return;
    }

    console.log('[DEPLOY] Found project:', JSON.stringify(project, null, 2));

    // Extract environments from the project
    const environments = project.environments || [];

    const formattedEnvironments = Array.isArray(environments)
      ? environments.map((env: any) => ({
          environmentId: env.environmentId || env.id || "",
          name: env.name || env.environmentId || env.id || "Unnamed Environment",
        }))
      : [];

    console.log('[DEPLOY] Formatted environments:', formattedEnvironments);
    res.json({ environments: formattedEnvironments });
  } catch (error) {
    console.error("[DEPLOY] Failed to fetch Dokploy environments", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to fetch environments.",
    });
  }
});

router.get("/deploy/github-providers", async (_req: Request, res: Response) => {
  try {
    const stored = loadConfigOrThrow();
    const apiKey = database.getDeployApiKey();
    if (!apiKey) {
      throw new Error("Dokploy API key is not configured.");
    }

    const client = createDokployClient(stored.config, apiKey);

    // Try to fetch GitHub providers
    const providers = await client.request<any[]>({
      method: "GET",
      path: "/github.all",
    });

    const formattedProviders = Array.isArray(providers)
      ? providers.map((provider: any) => ({
          githubId: provider.githubId || provider.id || "",
          name: provider.name || provider.githubAppName || "Unnamed Provider",
          githubAppName: provider.githubAppName || "",
        }))
      : [];

    res.json({ providers: formattedProviders });
  } catch (error) {
    console.error("[DEPLOY] Failed to fetch GitHub providers", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to fetch GitHub providers.",
    });
  }
});

router.post("/deploy/upload", async (req: Request, res: Response) => {
  try {
    const stored = loadConfigOrThrow();
    const workspaceRoot =
      typeof req.body?.workspaceRoot === "string" && req.body.workspaceRoot.trim().length > 0
        ? req.body.workspaceRoot.trim()
        : undefined;

    const archive = await createWorkspaceArchive({ workspaceRoot });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const origin = `${req.protocol}://${req.get("host")}`;
    const artifactUrl = `${origin}/api/deploy/artifacts/${archive.key}`;

    const updatedConfig: DeployConfig = {
      ...stored.config,
      source: {
        type: "workspace",
        artifactKey: archive.key,
        artifactUrl,
        lastUploadedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };

    const saved = database.saveDeployConfig({ config: updatedConfig });

    res.json({
      artifactKey: archive.key,
      artifactUrl,
      size: archive.size,
      expiresAt: expiresAt.toISOString(),
      config: {
        ...saved.config,
        hasApiKey: saved.hasApiKey,
        env: maskEnvVars(saved.config.env),
      },
    });
  } catch (error) {
    console.error("Failed to upload workspace archive", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Upload failed.",
    });
  }
});

router.get("/deploy/artifacts/:key", (req: Request, res: Response) => {
  try {
    const filePath = getArtifactPath(req.params.key ?? "");
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Artifact not found." });
      return;
    }

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.key ?? "workspace.tar.gz"}"`,
    );
    res.sendFile(filePath);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid artifact key.",
    });
  }
});

// ============================================
// VOLUME MANAGEMENT ENDPOINTS
// ============================================

/**
 * Get list of storage-enabled worker nodes
 */
router.get("/deploy/volumes/worker-nodes", async (_req: Request, res: Response) => {
  try {
    const nodes = await getStorageWorkerNodes();
    res.json({
      nodes: nodes.map(n => ({
        hostname: n.hostname,
        id: n.id,
        availability: n.availability,
      })),
      count: nodes.length,
    });
  } catch (error) {
    console.error("Failed to get worker nodes:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get worker nodes",
    });
  }
});

/**
 * Get editor volume status across all worker nodes
 */
router.get("/deploy/volumes/editor/status", async (_req: Request, res: Response) => {
  try {
    const status = await getEditorVolumeStatus();
    res.json(status);
  } catch (error) {
    console.error("Failed to get editor volume status:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get editor volume status",
    });
  }
});

/**
 * Create editor volume on all worker nodes
 * This is a one-time setup operation
 */
router.post("/deploy/volumes/editor/setup", async (_req: Request, res: Response) => {
  try {
    console.log("[ADMIN] Starting editor volume setup on all worker nodes...");
    await createEditorVolumeOnAllWorkers();
    const status = await getEditorVolumeStatus();

    res.json({
      message: "Editor volume setup complete",
      status,
    });
  } catch (error) {
    console.error("Failed to setup editor volumes:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to setup editor volumes",
    });
  }
});

/**
 * Update editor volume on all worker nodes (pull latest code)
 */
router.post("/deploy/volumes/editor/update", async (_req: Request, res: Response) => {
  try {
    console.log("[ADMIN] Updating editor volumes on all worker nodes...");
    await updateEditorVolumeOnAllWorkers();
    const status = await getEditorVolumeStatus();

    res.json({
      message: "Editor volumes updated successfully",
      status,
    });
  } catch (error) {
    console.error("Failed to update editor volumes:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to update editor volumes",
    });
  }
});

/**
 * Find orphaned session volumes (volumes without database records)
 */
router.get("/deploy/volumes/orphaned", async (_req: Request, res: Response) => {
  try {
    // Get all active session IDs from database
    const sessions = database.listSessions(""); // Empty userId gets all sessions (admin)
    const activeSessionIds = new Set(sessions.map(s => s.id));

    const orphanedByNode = await findOrphanedVolumes(activeSessionIds);

    // Convert Map to object for JSON response
    const orphanedVolumes: Record<string, string[]> = {};
    let totalOrphaned = 0;

    for (const [node, volumes] of orphanedByNode.entries()) {
      orphanedVolumes[node] = volumes;
      totalOrphaned += volumes.length;
    }

    res.json({
      orphanedVolumes,
      totalOrphaned,
      nodeCount: orphanedByNode.size,
    });
  } catch (error) {
    console.error("Failed to find orphaned volumes:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to find orphaned volumes",
    });
  }
});

/**
 * Cleanup orphaned session volumes
 */
router.post("/deploy/volumes/cleanup", async (_req: Request, res: Response) => {
  try {
    // Get all active session IDs from database
    const sessions = database.listSessions(""); // Empty userId gets all sessions (admin)
    const activeSessionIds = new Set(sessions.map(s => s.id));

    console.log("[ADMIN] Finding orphaned volumes...");
    const orphanedByNode = await findOrphanedVolumes(activeSessionIds);

    console.log("[ADMIN] Cleaning up orphaned volumes...");
    const result = await cleanupOrphanedVolumes(orphanedByNode);

    res.json({
      message: "Cleanup complete",
      deleted: result.deleted,
      errors: result.errors,
      deletedCount: result.deleted.length,
      errorCount: result.errors.length,
    });
  } catch (error) {
    console.error("Failed to cleanup orphaned volumes:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to cleanup orphaned volumes",
    });
  }
});

export default router;
