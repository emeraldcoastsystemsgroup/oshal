# ADR: Swarm Application Manifests

**Date:** 2026-04-20  
**Author:** maintainer@emeraldcoastsystemsgroup.com  
**Status:** Proposed  
**Implementation Target:** Weekend of 2026-04-25/26  

---

## Decision

Introduce a **Swarm Application Manifest** — a YAML file that declares a group of bots, tools, UI surfaces, and ticket workflows as a single deployable application. The manifest can be loaded, unloaded, and toggled on/off at runtime. When toggled off, all associated bots deactivate, ribbon icons disappear, and ticket processing stops. When toggled on, everything restores.

---

## Problem

OSHAL is a platform for building applications. Each application is a configuration of the swarm — a handful of bots with personas, tools, UI surfaces, and ticket workflows. Today there is no concept of an "application" as a unit:

- Bots are individually registered in `swarm-bot-registry.ts` and the `agents` table
- UI surfaces are independently registered via `registerDynamicToolUI()`
- Routes are unconditionally mounted in `server.ts`
- Workflow pipelines are hardcoded in `WORKFLOW_PIPELINES` array
- There is no way to "turn off Little Monsters" without manually deactivating 6 bots, deregistering 4 ribbon icons, and commenting out route mounts

This makes it impossible to:
- Run multiple applications on the same swarm and toggle them independently
- Deploy a new application without modifying framework source code
- Give operators a UI to manage installed applications
- Test an application in isolation

---

## Context: What Already Works

The building blocks for application manifests already exist in the framework:

| Capability | Existing Implementation | Gap |
|---|---|---|
| Bot activation/deactivation | `updateAgentStatus(agentId, 'inactive')` in `agent-profile-repository.ts` → excluded from routing by `normalizeCandidates()` | No group concept — must toggle individually |
| Dynamic UI registration | `POST /api/tools/register` with TTL → `GET /api/tools/dynamic` → `RibbonNav._loadToolViews()` | No deregistration endpoint, no grouping |
| Registry switching | `SWARM_REGISTRY` switches the lean bot registry in `getActiveRegistry()` | Binary switch, not per-app |
| Bot lifecycle | `SwarmBotLifecycleService` — restart, stop, rebuild via shell scripts | No bulk operations by app |
| Persona loading | YAML files in `ai-lab/bot-personas/` loaded by `bot-entrypoint.sh` | No association to an application |
| Workflow pipelines | `WORKFLOW_PIPELINES` array in `queue-manager-service.ts` | Hardcoded, not configurable |

---

## Proposed Design

### 1. Application Manifest File

New directory: `swarm-apps/` at project root. Each YAML file defines one application.

```yaml
# swarm-apps/little-monsters.yaml
name: little-monsters
displayName: Little Monsters
description: Voice-first ADHD study companion for K-12 students
version: 1.0.0
status: active  # active | inactive — the master toggle

# Bots owned by this application
bots:
  - agentId: ed000000-0000-0000-0000-000000000001
    name: lecture-scribe
    persona: ai-lab/bot-personas/lecture-scribe.yaml
    role: education/lecture-processing
    capabilities:
      - audio-transcription
      - note-generation
      - assignment-extraction
      - flashcard-generation
      - knowledge-indexing

  - agentId: ed000000-0000-0000-0000-000000000002
    name: class-tutor
    persona: ai-lab/bot-personas/class-tutor.yaml
    role: education/tutor
    capabilities:
      - tutoring
      - socratic-method
      - subject-expertise
      - rag-query

  - agentId: ed000000-0000-0000-0000-000000000003
    name: quiz-master
    persona: ai-lab/bot-personas/quiz-master.yaml
    role: education/assessment
    capabilities:
      - quiz-generation
      - assessment
      - bloom-taxonomy

  - agentId: ed000000-0000-0000-0000-000000000004
    name: textbook-librarian
    persona: ai-lab/bot-personas/textbook-librarian.yaml
    role: education/knowledge-management
    capabilities:
      - pdf-ingestion
      - knowledge-management
      - content-indexing

  - agentId: ed000000-0000-0000-0000-000000000005
    name: study-coach
    persona: ai-lab/bot-personas/study-coach.yaml
    role: education/planning
    capabilities:
      - study-planning
      - performance-analysis
      - motivation

  - agentId: ed000000-0000-0000-0000-000000000006
    name: writing-coach
    persona: ai-lab/bot-personas/writing-coach.yaml
    role: education/writing
    capabilities:
      - writing-feedback
      - essay-structure
      - grammar-guidance

# Foundation persona (shared by all bots in this app)
foundation:
  persona: ai-lab/bot-personas/education-foundation.yaml

# Tools auto-discovered from this directory
toolsDir: any-bot/server/services/tools/education/

# UI surfaces registered in the cockpit ribbon
ui:
  static:
    - toolName: lm-myday
      label: My Day
      icon: codicon codicon-heart
      iframeUrl: /api/education/my-day
    - toolName: lm-dashboard
      label: Classes
      icon: codicon codicon-home
      iframeUrl: /api/education/dashboard
    - toolName: lm-recorder
      label: Record
      icon: codicon codicon-record
      iframeUrl: /api/education/recorder
  dynamic:
    # Per-class icons registered at runtime from DB
    source: lm_classes
    labelField: name
    icon: codicon codicon-book
    iframeUrlTemplate: /api/education/class?classId={class_id}

# Express routes this application provides
routes:
  - module: src/app/routes/education-routes.ts
    mountPath: /api/education
    factory: createEducationRoutes
    requiresAuth: true
    requiresContext: true
  - module: src/app/routes/education-calendar-routes.ts
    mountPath: /api/education
    factory: createEducationCalendarRoutes
    requiresAuth: true
    requiresContext: true

# Database migrations owned by this application
migrations:
  - scripts/migrations/019-education-platform.sql
  - scripts/migrations/020-seed-education-bots.sql
  - scripts/migrations/021-calendar-and-notifications.sql

# Ticket type and workflow pipeline
ticketType: education
workflow:
  name: Education Processing Pipeline
  pipeline: education
  phases:
    - intake
    - processing
    - delivery
  workerBot: lecture-scribe

# Theme contributed by this application
theme: src/pages/cockpit/css/themes/little-monsters.css

# Shared CSS for all UI surfaces
sharedCss: any-bot/server/services/tools/education/education.css
```

### 2. Database Table

```sql
-- scripts/migrations/022-swarm-applications.sql
CREATE TABLE IF NOT EXISTS swarm_applications (
  app_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  manifest_path VARCHAR(500) NOT NULL,
  agent_ids UUID[] NOT NULL DEFAULT '{}',
  tool_names TEXT[] NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swarm_apps_status ON swarm_applications(status);
```

### 3. Application Service

**New file:** `src/features/agent-management/services/swarm-app-service.ts`

```typescript
class SwarmAppService {
  // Load an application from its manifest file
  async loadApp(manifestPath: string): Promise<SwarmApplication>
  
  // Unload — deactivate all bots, deregister all UIs, set status inactive
  async unloadApp(appName: string): Promise<void>
  
  // Toggle on/off — the key operation
  async toggleApp(appName: string, active: boolean): Promise<void>
  
  // List all installed applications with health status
  async listApps(filter?: { status?: string }): Promise<SwarmApplication[]>
  
  // Get detailed status — which bots are online, which tools registered
  async getAppStatus(appName: string): Promise<AppStatusDetail>
}
```

**Toggle implementation logic:**

```
toggleApp(appName, active=false):
  1. Query swarm_applications for agent_ids and tool_names
  2. For each agent_id: UPDATE agents SET status='inactive'
     → normalizeCandidates() immediately excludes them from routing
     → No container restart needed
  3. For each tool_name: deregisterDynamicToolUI(toolName)
     → Next RibbonNav poll shows no education icons
  4. UPDATE swarm_applications SET status='inactive'

toggleApp(appName, active=true):
  1. For each agent_id: UPDATE agents SET status='active'
     → normalizeCandidates() includes them again
  2. For each UI in manifest: registerDynamicToolUI(...)
     → Ribbon icons reappear
  3. For dynamic UIs (per-class): query DB, register each
  4. UPDATE swarm_applications SET status='active'
```

### 4. API Endpoints

**New file:** `src/app/routes/swarm-app-routes.ts`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/swarm/apps` | List all installed applications with status |
| `GET` | `/api/swarm/apps/:name` | Get app detail (bots, tools, health) |
| `POST` | `/api/swarm/apps/load` | Load app from manifest path |
| `PATCH` | `/api/swarm/apps/:name/toggle` | `{ active: true/false }` — the master switch |
| `DELETE` | `/api/swarm/apps/:name` | Unload app completely |

### 5. Tool Deregistration

**Modify:** `src/app/routes/tool-routes.ts`

Add exported function:
```typescript
export function deregisterDynamicToolUI(toolName: string): void {
  dynamicTools.delete(toolName);
}
```

Add endpoint:
```
DELETE /api/tools/dynamic/:toolName
```

### 6. Dynamic Workflow Pipeline Registry

**Modify:** `src/features/swarm-orchestration/services/queue-manager-service.ts`

Replace hardcoded `WORKFLOW_PIPELINES` array with a registry service that merges:
1. Built-in pipelines (build, incident) — always available
2. App-contributed pipelines — loaded from active app manifests
3. DB-registered pipelines — for runtime additions

```typescript
class WorkflowPipelineRegistry {
  private builtIn: WorkflowDefinition[] = [
    { ticketType: 'build', name: 'Software Build Swarm', pipeline: 'swarm', workerBot: 'system-architect' },
    { ticketType: 'incident', name: 'Incident RCA Pipeline', pipeline: 'incident-rca', workerBot: 'rca-specialist', maxRevisions: 2 },
  ];
  
  private appPipelines: Map<string, WorkflowDefinition> = new Map();
  
  registerFromApp(appName: string, pipeline: WorkflowDefinition): void
  unregisterApp(appName: string): void
  getPipeline(ticketType: string): WorkflowDefinition | undefined
}
```

### 7. Conditional Route Loading

**Modify:** `src/app/server.ts`

Instead of unconditionally mounting education routes:
```typescript
// Current (hardcoded):
app.use('/api/education', requiresAuth, createEducationRoutes(ctx));

// Future (app-driven):
for (const appManifest of activeApps) {
  for (const route of appManifest.routes) {
    const factory = require(route.module)[route.factory];
    app.use(route.mountPath, route.requiresAuth ? requiresAuth : noOp, factory(ctx));
  }
}
```

---

## What This Enables

1. **Operator control:** `PATCH /api/swarm/apps/little-monsters/toggle { active: false }` → entire education platform goes dark in seconds
2. **Multi-app swarm:** Run Little Monsters + a CRM bot suite + a DevOps monitor on the same swarm, toggle independently
3. **Clean deployment:** Drop a YAML manifest + persona files + tool files = new application installed
4. **Cockpit integration:** Future "Applications" panel with toggle switches per app
5. **Testing:** Load an app, run its tests, unload — no interference with other apps

---

## What This Does NOT Cover (future ADRs)

- Per-app permissions/auth (which users can access which app)
- App marketplace or remote manifest installation
- App versioning, rolling updates, or rollback
- Per-app cost budgets and tracking
- App-level configuration UI in cockpit settings
- Inter-app communication or shared bot pools

---

## Migration Path

1. Write the `SwarmAppService` and API endpoints
2. Create `swarm-apps/little-monsters.yaml` manifest for the existing education platform
3. Migrate existing hardcoded education route mounting to app-driven loading
4. Add `deregisterDynamicToolUI` to tool-routes
5. Make `WORKFLOW_PIPELINES` dynamic via `WorkflowPipelineRegistry`
6. Test: toggle off, verify everything gone; toggle on, verify everything back
7. Playwright tests for the toggle flow

---

## Files Summary

**Create:**
- `swarm-apps/little-monsters.yaml`
- `scripts/migrations/022-swarm-applications.sql`
- `src/features/agent-management/services/swarm-app-service.ts`
- `src/app/routes/swarm-app-routes.ts`

**Modify:**
- `src/app/routes/tool-routes.ts` — add deregistration
- `src/app/routes/index.ts` — export new routes
- `src/app/server.ts` — conditional route loading
- `src/features/swarm-orchestration/services/queue-manager-service.ts` — dynamic pipeline registry
- `src/app/composition/app-context.ts` — add SwarmAppService (optional)
