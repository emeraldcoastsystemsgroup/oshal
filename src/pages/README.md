# Pages Directory

Self-contained HTML/CSS/JS page bundles served by the OSHAL Express server. Each subdirectory is a standalone mini-app mounted at its own route.

## Current Pages

| Page | Route | Mode | Purpose |
|------|-------|------|---------|
| `chat/` | `/swarmbot/chat` | Native | Standalone chat interface with provider/model configuration |
| `cockpit/` | `/cockpit/` | Native | 3-column operational cockpit with ribbon nav, Engineering screens, and embedded chat |
| `config/` | `/config/` | Native | Agent-scoped configuration admin with ownership contract |
| `health-dashboard/` | `/health-dashboard/` | Native Beta | Native health monitoring page (also available via legacy compat route) |
| `mesh-dashboard/` | `/mesh-dashboard/` | Native | Native mesh process-flow dashboard for channel lifecycle, participant load, and ticket linkage |
| `ops-dashboard/` | `/ops-dashboard/` | Native | Native operations dashboard for runtime health, dispatch coverage, queue flow, and attention items |
| `rag-center/` | `/rag-center/` | Native | Native vector-ops page for RAG inventory, runtime health, collection coverage, and live retrieval testing |
| `queue-manager-admin/` | `/queue-manager-admin/` | Native | Native queue manager process-flow page for dispatch, agent load, and run correlation |
| `queue-dashboard/` | `/queue-dashboard/` | Replacement | OSHAL replacement for the old Bull Board queue dashboard with native refresh/status controller and live queue telemetry |
| `redis-visibility/` | `/redis-visibility/` | Native Beta | Redis diagnostics and visibility page (also available via legacy compat route) |
| `process-lab/` | `/process-lab/` | Native | Non-invasive lifecycle tracing lab for running preset tickets, watching flow state, and reviewing captured swarm artifacts |

## Legacy UI-Enhanced Assets

Legacy `any-bot/ui-enhanced` assets remain mounted for compatibility CSS/JS/font support, but Engineering route ownership is now native/replacement.

| Page | Route | Purpose |
|------|-------|---------|
| `health-dashboard.html` | `/ui-enhanced/health-dashboard.html` | Full legacy health dashboard (cockpit default) |
| `redis-visibility.html` | `/ui-enhanced/redis-visibility.html` | Full legacy Redis visibility (cockpit default) |

## Engineering Screen Status

The cockpit Engineering view (`AdvancedView.js`) renders 9 engineering screens. All are operational:

- **Native**: task-explorer, config, health-dashboard, redis-visibility, queue-manager-admin, mesh-dashboard, ops-dashboard, rag-center
- **Replacement**: queue-dashboard

## Operator Documentation

- `docs/cockpit-user-handbook.md` — screen-by-screen cockpit user manual with button-by-button behavior notes

## Adding a New Page

1. Create a directory under `src/pages/<page-name>/`
2. Add `index.html` as the entry point
3. Add CSS and JS files as needed
4. Mount in `src/app/server.ts` using `mountStaticHtmlPage()` or explicit Express static serving
5. Update this README
