/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Baseline for the signed-in route ratchet (tests/unit/operator-route-ratchet.spec.ts): every controller /api mount that ANY signed-in user reaches (requiresAuth or delegated-user auth at the mount, no operator gate), as of 2026-10-05. Pre-existing mounts are recorded as LEGACY, not approved: many gate operator actions per route inside their modules, and each is reviewed module by module during convergence (operator gate at the mount, or a written reason). New mounts cannot be LEGACY.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, first slice: /api/personal-graph and /api/personal-graph/ingest are operator mounts now (entries removed); /api/swarm/packs is reviewed (deploy is admin-only). LEGACY_CEILING 107 -> 104.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, second slice: /api/logs, /api/process-lab, /api/bot/restart|rebuild|rollback, /api/proxy-health, /api/redis-visibility and /api/swarm/ops are operator mounts now (entries removed); /api/checkpoints is reviewed (owner-scoped). Admin-only routes inside still-LEGACY mounts: /api/governance/posture, Plane ticket sync (/api/tickets/sync/*), /api/swarm/bots/proxy-health. LEGACY_CEILING 104 -> 95.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, intake: /api/intake/fast and /api/v1/intake are reviewed (tickets filed as the caller's own; intake sessions bound to their starter). LEGACY_CEILING 95 -> 93.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, cockpit: /api/v1 is reviewed (by-id ticket routes owner-checked, the explorer's unscoped copies removed). LEGACY_CEILING 93 -> 92.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, tenants: /api/tenants is reviewed (adding a person is portal-admin only). LEGACY_CEILING 92 -> 91.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, RAG: /api/rag is reviewed (ingest grants limited to the caller's own tenants). LEGACY_CEILING 91 -> 90.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, BYO LLM: /api/connect/any-llm is reviewed (stored keys reused only for their own endpoint). LEGACY_CEILING 90 -> 89.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Route review 2026-10-05, connector specs: /api/connectors/:provider/:resource (writes on the shared deployment account admin-only) and /_resources (static catalog) are reviewed. LEGACY_CEILING 89 -> 87.
 */

/** Marks a mount that was signed-in-only before the ratchet existed and has not been reviewed yet. */
export const LEGACY = 'legacy: signed-in-only at the mount before the 2026-10-05 ratchet; not yet reviewed';

/**
 * @description The most LEGACY entries allowed. It only goes DOWN: when a module review puts a mount
 * behind requiresOperator or writes its reason, lower this number in the same change.
 */
export const LEGACY_CEILING = 87;

/**
 * @description One /api mount any signed-in user can reach, recorded on purpose.
 *
 * WHY a reason is mandatory for new entries: the portal admin is the only account that may change
 * swarm-wide state (Roger, 2026-10-05). A mount without an operator gate is reachable by every
 * ordinary user, so a new one must say why that is safe: owner-scoped data, per-route operator
 * checks inside the module (cite file:line), or deliberately shared.
 */
export interface SignedInRouteEntry {
  /** The `/api/...` mount path exactly as the registrar declares it. */
  path: string;
  /** LEGACY, or why every signed-in user may reach it (more than 40 characters). */
  reason: string;
}

export const SIGNED_IN_ROUTES: readonly SignedInRouteEntry[] = [
  { path: '/api/a2a/agents', reason: LEGACY },
  { path: '/api/access-review', reason: LEGACY },
  { path: '/api/agents', reason: LEGACY },
  { path: '/api/antigravity/auth', reason: LEGACY },
  { path: '/api/apply-operator', reason: LEGACY },
  { path: '/api/batch-jobs', reason: LEGACY },
  { path: '/api/bot/status', reason: LEGACY },
  { path: '/api/budgets', reason: LEGACY },
  { path: '/api/calendar', reason: LEGACY },
  { path: '/api/capability-providers', reason: LEGACY },
  { path: '/api/channels', reason: LEGACY },
  { path: '/api/checkpoints', reason: 'A checkpoint belongs to its task: GET, restore and delete answer 404 unless the caller may read the stored task result (checkpoint-routes.ts callerMayUseCheckpoint, reviewed 2026-10-05)' },
  { path: '/api/claude-code/auth', reason: LEGACY },
  { path: '/api/cockpit/home/preferences', reason: LEGACY },
  { path: '/api/config', reason: LEGACY },
  { path: '/api/connect', reason: LEGACY },
  { path: '/api/connect/any-llm', reason: 'Each user saves and tests their own LLM connection (tenant saves need membership); a stored key is reused only for the exact endpoint it was saved for (byo-llm-routes.ts, reviewed 2026-10-05)' },
  { path: '/api/connect/free-tier', reason: LEGACY },
  { path: '/api/connectors', reason: LEGACY },
  { path: '/api/connectors/:id/actions/:action', reason: LEGACY },
  { path: '/api/connectors/:provider/:resource', reason: 'Off unless CONNECTOR_SPEC_ROUTES=on; calls run on the caller\'s own connection, the deployment account serves reads only as the swarm default, and writes on it need the portal admin; every call is audited (connector-spec-routes.ts, reviewed 2026-10-05)' },
  { path: '/api/connectors/:provider/_resources', reason: 'Returns only the static resource catalog of a provider the caller is allowed to use; no credential is read and the provider is never called (connector-spec-routes.ts, reviewed 2026-10-05)' },
  { path: '/api/content', reason: LEGACY },
  { path: '/api/dev-console', reason: LEGACY },
  { path: '/api/devops', reason: LEGACY },
  { path: '/api/eval-wall', reason: LEGACY },
  { path: '/api/experience/availability', reason: LEGACY },
  { path: '/api/facebook-auth', reason: LEGACY },
  { path: '/api/forge', reason: LEGACY },
  { path: '/api/gemini/auth', reason: LEGACY },
  { path: '/api/governance', reason: LEGACY },
  { path: '/api/graph', reason: LEGACY },
  { path: '/api/health-dashboard/nodes', reason: LEGACY },
  { path: '/api/health-dashboard/registry', reason: LEGACY },
  { path: '/api/help', reason: LEGACY },
  { path: '/api/intake', reason: LEGACY },
  { path: '/api/intake/fast', reason: 'Every user may file a ticket from a sentence; the ticket is filed as the caller\'s own (fast-intake-routes.ts ownerSub = caller, reviewed 2026-10-05)' },
  { path: '/api/jarvis', reason: LEGACY },
  { path: '/api/jarvis/ambient', reason: LEGACY },
  { path: '/api/jarvis/ambient/person', reason: LEGACY },
  { path: '/api/jarvis/ambient/test-fixture', reason: LEGACY },
  { path: '/api/jarvis/briefings', reason: LEGACY },
  { path: '/api/jarvis/calling', reason: LEGACY },
  { path: '/api/join', reason: LEGACY },
  { path: '/api/judge', reason: LEGACY },
  { path: '/api/linkedin-assistant', reason: LEGACY },
  { path: '/api/llm-governance/status', reason: LEGACY },
  { path: '/api/location', reason: LEGACY },
  { path: '/api/me', reason: LEGACY },
  { path: '/api/memory', reason: LEGACY },
  { path: '/api/mesh/channels', reason: LEGACY },
  { path: '/api/mesh/create', reason: LEGACY },
  { path: '/api/notify', reason: LEGACY },
  { path: '/api/openai-codex/oauth', reason: LEGACY },
  { path: '/api/ops/alert-pipeline', reason: LEGACY },
  { path: '/api/ops/refusals', reason: LEGACY },
  { path: '/api/optimize', reason: LEGACY },
  { path: '/api/personal', reason: LEGACY },
  { path: '/api/privacy', reason: LEGACY },
  { path: '/api/providers', reason: LEGACY },
  { path: '/api/queue/dlq', reason: LEGACY },
  { path: '/api/rag', reason: 'Search is filtered to what the caller may read; ingest is owned by the caller and may be shared only with their own tenants; kernel collections and collection delete need the admin (rag-routes.ts, reviewed 2026-10-05)' },
  { path: '/api/rca', reason: LEGACY },
  { path: '/api/search', reason: LEGACY },
  { path: '/api/settings/llm-default', reason: LEGACY },
  { path: '/api/slack', reason: LEGACY },
  { path: '/api/status', reason: LEGACY },
  { path: '/api/stream', reason: LEGACY },
  { path: '/api/swarm', reason: LEGACY },
  { path: '/api/swarm/agents', reason: LEGACY },
  { path: '/api/swarm/apps', reason: LEGACY },
  { path: '/api/swarm/bots', reason: LEGACY },
  { path: '/api/swarm/config', reason: LEGACY },
  { path: '/api/swarm/memory', reason: LEGACY },
  { path: '/api/swarm/packs', reason: 'Packs are per-user (each caller lists, reads and downloads only their own pack directory); deploying a pack registers swarm-wide bots, so POST /:name/deploy requires the portal admin (swarm-pack-routes.ts requireOperator, reviewed 2026-10-05)' },
  { path: '/api/swarm/registries', reason: LEGACY },
  { path: '/api/swarm/roles', reason: LEGACY },
  { path: '/api/takeout', reason: LEGACY },
  { path: '/api/tasks', reason: LEGACY },
  { path: '/api/tenants', reason: 'Every user may create a tenant and list the tenants they belong to; member and connection reads require membership, adding a person requires the portal admin, and removing or re-roling requires a tenant admin (tenant-routes.ts, reviewed 2026-10-05)' },
  { path: '/api/test-lab', reason: LEGACY },
  { path: '/api/tickets', reason: LEGACY },
  { path: '/api/tickets/active', reason: LEGACY },
  { path: '/api/token-chase', reason: LEGACY },
  { path: '/api/tools/verify', reason: LEGACY },
  { path: '/api/trace', reason: LEGACY },
  { path: '/api/ui', reason: LEGACY },
  { path: '/api/updates', reason: LEGACY },
  { path: '/api/user', reason: LEGACY },
  { path: '/api/user-model', reason: LEGACY },
  { path: '/api/v1', reason: 'The cockpit and task explorer: list routes scope to the caller (operator ?scope=all), by-id ticket routes answer only the owner or the operator, project and log administration is operator-gated (cockpit-routes.ts, task-explorer-routes.ts, reviewed 2026-10-05)' },
  { path: '/api/v1/agent', reason: LEGACY },
  { path: '/api/v1/intake', reason: 'Every user may run the intake interview; a session belongs to the user who started it (others get 404) and the submitted ticket is the caller\'s own (intake-assistant-routes.ts, reviewed 2026-10-05)' },
  { path: '/api/voice', reason: LEGACY },
  { path: '/api/voice-sim', reason: LEGACY },
  { path: '/api/workflow-studio', reason: LEGACY },
  { path: '/api/workspaces', reason: LEGACY },
];
