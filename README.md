# WebEdt Main App

The main application and orchestrator for WebEdt - a web-based editor platform that creates isolated containerized development environments.

## Overview

WebEdt Main App manages user sessions, provisions containerized service instances via Dokploy, and provides the primary interface for managing development workspaces.

## Features

- **Session Management**: Create and manage multiple isolated development sessions
- **Dokploy Integration**: Automatic provisioning of containerized environments
- **HTTPS by Default**: Every session gets automatic HTTPS with Let's Encrypt
- **Database**: SQLite-based persistence for sessions, messages, and configuration
- **WebSocket Streaming**: Real-time communication with containerized services
- **GitHub Integration**: OAuth integration for repository access

## Project Structure

```
webedt-main-app/
├── src/
│   ├── backend/          # Express server
│   │   ├── db.ts         # SQLite database layer
│   │   ├── routes/       # API routes
│   │   ├── services/     # Business logic (Dokploy, auth, git, etc.)
│   │   └── types/        # TypeScript type definitions
│   ├── frontend/         # React frontend
│   │   └── src/
│   │       ├── components/  # React components
│   │       ├── pages/       # Page components
│   │       └── api/         # API client
│   └── shared/           # Shared types (bridge, messages, sessions)
├── var/
│   └── chat.db           # SQLite database (IMPORTANT!)
├── docs/                 # Documentation
├── scripts/              # Utility scripts
└── package.json
```

## Getting Started

### Prerequisites

- Node.js >= 18.17.0
- Dokploy instance (for container provisioning)

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file based on `.env.example`:

```bash
# Server
PORT=3000
NODE_ENV=development

# Security
JWT_SECRET=your-random-secret-here
CODEX_WEBAPP_SECRET=another-random-secret-for-encryption

# Dokploy Configuration
DOKPLOY_BASE_URL=https://your-dokploy-instance.com/api
DOKPLOY_API_KEY=your-dokploy-api-key
DOKPLOY_DOMAIN_HOST=your-domain.com

# Main App URLs (for container communication)
MAIN_APP_URL=http://localhost:3000
MAIN_APP_WS_URL=ws://localhost:3000

# Database
DATABASE_PATH=./var/chat.db
```

### Development

```bash
npm run dev
```

The server will start on `http://localhost:3000`.

### Production Build

```bash
npm run build
npm start
```

## Database

The database is located at `var/chat.db`. Key tables include:

- `deploy_configs` - Dokploy configuration
- `sessions` - User sessions and workspace information
- `session_settings` - Session-specific configuration
- `messages` - Chat/interaction history

## Dokploy Integration

Each session automatically provisions a containerized service via Dokploy:

1. **Application Creation**: Creates Dokploy application with specified GitHub repo
2. **Environment Variables**: Injects SESSION_ID, SESSION_TOKEN, and connection URLs
3. **Build Configuration**: Uses Nixpacks for automatic build detection or custom Dockerfile
4. **Domain Setup**: Automatically creates HTTPS domain with path `/{sessionId}`
5. **Deployment**: Triggers deployment and monitors status

**Service URLs**: `https://{DOKPLOY_DOMAIN_HOST}/{sessionId}`

## API Endpoints

### Sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:id` - Get session details
- `DELETE /api/sessions/:id` - Delete session

### Deployment
- `GET /api/deploy/config` - Get Dokploy configuration
- `POST /api/deploy/config` - Update Dokploy configuration
- `GET /api/deploy/services/:sessionId` - Get service status

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/github/oauth` - GitHub OAuth flow

## Scripts

```bash
npm run dev           # Start development server
npm run build         # Build for production
npm run typecheck     # Run TypeScript type checking
npm start             # Start production server
```

## Useful Commands

### View server logs
```bash
tail -f /tmp/server-output.log
```

### Access database
```bash
sqlite3 var/chat.db
```

### Kill processes on ports
```bash
lsof -ti:3000,3001 | xargs kill -9
```

## Recent Changes

- **2025-11-03**: Migrated from monorepo to standalone repository
- **2025-11-02**: Added automatic HTTPS domain configuration for all sessions
- **2025-11-02**: Changed default build strategy from Dockerfile to Nixpacks

## License

Private
