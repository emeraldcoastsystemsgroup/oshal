/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted canonical swarm bot registry and runtime identity resolution for targeted mesh delivery
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D3: isBotAccessibleTo now requires EVERY matching registry definition to permit the caller (most-restrictive-wins). getActiveRegistry() concatenates statics + dynamic app bots, so one agentId can carry two defs; the old find() took the first (statics) and silently ignored the other — which both dropped a packaged bot's scoping AND let a package WIDEN a core bot's reach by re-declaring its agentId with no roles. A package can now only narrow.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed project-manager role from 'swarm/primary' to 'project-manager' to enable QueueManagerService instantiation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Fixed persona identity collisions — rca-specialist→0016, presentation-bot→0017, architect-bot→0018. Added validatePersonaIdentities().
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Added missing agentId to 6 bots — slug registration caused Redis/DB UUID mismatch, filtering these bots from all routing candidates
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Renamed the inline-controller container target to oshal-api (compose service rename); resolves to http://oshal-api:5000 via internalEndpointUrl.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085: registerAppBots/unregisterAppBots — installed app packages contribute bots to the ACTIVE registry at activate() (retracted on deactivate), so store apps are dispatchable with ZERO hand-edits here; getActiveRegistry() = static base + dynamic entries (statics win on collision). Retires the manual "backfill" pattern for future apps; kills the little-monsters 6-bot boot wiring-audit failure.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-083: promoted shopping/spotify/movies/travel concierges to REAL bot-nodes (own containers, codex) so the call-out reaches them; rescoped generic capability tags (preference-learning/checkout-handoff/compute/devops) to domain-scoped ones; added general-bot (a0…0099) as the low-confidence fallback owner.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-087: accessRoles caller-role scoping on SwarmBotDefinition + isBotAccessibleTo(). Internal machinery (project-manager, queue-bot, task-manager, agent-factory, oshal-developer) scoped to operator+swarm so Jarvis neither discovers nor reaches it; omitted declaration keeps a bot open to every caller.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Added quality-judge (a0…0053) — the shared LLM-judge/grading concierge (inline on oshal-api, claude-code, operator+swarm scoped). Grading is LLM work: JudgeService/@/features/quality-judge routes it here so the controller never calls an LLM and grading cost lands under this agent_id.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #3: removed lora-director (a0…0049) — LoRA Studio carved to the store; the package manifest registers the inline bot on activation. Surgical by NAME, not agentId: …049 is also trading-research-analyst in the local registry (trading's bot, untouched).
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Plan F item 3: added optional a2aEndpointEnv to SwarmBotDefinition (declares WHICH env var carries an external A2A agent's endpoint — URLs stay out of source) and the a2a-sample-agent example entry (ea…0001, harnessType 'a2a', endpoint from A2A_SAMPLE_AGENT_URL). Operator+swarm scoped (ADR-087: out of Jarvis until the outbound gateway is proven) with deliberately narrow capabilities so the call-out never picks it until an operator points it at a real endpoint.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Fix ADR-085 carve id collision: drone-operator moved b0100000-…001 → b00f0000-…001. The portrait-studio store package had reused b0100000-…001, so the live DB had that id as portrait-artist (active) and drone-operator displaced to b00f0000-…001 (inactive). Operator-chosen resolution: portrait keeps b0100000, drone-operator reverts to its (already-in-DB) b00f0000 id. Surfaced by scripts/swarm-app-bot-integrity-check.sh.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Registry parity: codex-packer (the Bot Forge, a0…030) existed ONLY in the local registry, so SWARM_REGISTRY=full silently dropped the Forge bot while its app manifest, ribbon tab, and chat surface all stayed up. Added the same inline entry here (container oshal-api, claude-code, operator+swarm scoped per ADR-087); parity guarded by codex-packer-created-bot.spec.ts.
 */

import { createChildLogger } from '@/shared/logger';
import { roleCanAccess, type SwarmAccessRole } from '@/shared/types';
import { LOCAL_BOT_REGISTRY } from './swarm-bot-registry-local';

const logger = createChildLogger({ module: 'swarm-bot-registry' });
const INTERNAL_SWARM_PORT = 5000;

/**
 * @description Static compose-derived definition for one known swarm bot container.
 */
export interface SwarmBotDefinition {
  agentId?: string;
  name: string;
  port: number;
  container: string;
  role: string;
  capabilities: string[];
  /**
   * @description Optional harness type override for this bot.
   * When set, the bot's LLM calls route through the specified harness adapter
   * rather than the process-level default resolved from global-config.json.
   *
   * Values: 'cline' | 'codex-cli' | 'claude-code' | 'gemini-cli' | 'a2a' | 'noop'
   * Omit to use the process-level provider (default behaviour).
   */
  harnessType?: string;

  /**
   * @description The API/provider this bot is wired to use.
   * Must be compatible with the declared harnessType:
   *   - 'claude-code' harness → apiType MUST be 'claude-code' (spawns Claude Code CLI)
   *   - 'cline' harness       → any provider ('openai', 'claude-code', etc.)
   *   - 'codex-cli' harness   → apiType MUST be 'openai' or 'openai-codex'
   *   - 'a2a' harness         → apiType MUST be 'a2a' (external agent; endpoint via a2aEndpointEnv)
   *   - 'noop' harness        → apiType is ignored
   *
   * When set with 'cline' harnessType, overrides process-level FORCE_LLM_PROVIDER
   * so this bot uses its declared API regardless of the global override.
   * Required when harnessType is set — omit only for process-level default routing.
   */
  apiType?: string;

  /**
   * @description When true, ticket dispatch MUST reach this bot's own container via
   * BotNodeClient (/api/swarm-execute) and never fall back to inline execution on the
   * api — the bot's workspace/state (e.g. oshal-developer's repo clone at /app/dev-repo)
   * exists only on its node. Overrides the legacy prefer-inline rule for codex bots
   * (which predates the bot-node JS CodexProvider). ADR-081.
   */
  requiresOwnNode?: boolean;

  /**
   * @description For harnessType 'a2a' ONLY: the NAME of the env var carrying the
   * external agent's JSON-RPC endpoint URL (e.g. 'A2A_SAMPLE_AGENT_URL'). The
   * indirection keeps deployment URLs out of source while letting each external
   * bot point at a different remote. The outbound bearer token is always
   * resolved separately from A2A_OUTBOUND_TOKEN_<BOTKEY> (never declared here).
   */
  a2aEndpointEnv?: string;

  /**
   * @description Caller roles allowed to discover/call this bot (ADR-087). Omit
   * to keep the bot open to every caller (the default). Declare WITHOUT 'jarvis'
   * to take the bot out of the assistant's world entirely: it disappears from
   * Jarvis's app catalog and is filtered from the queue call-out on
   * jarvis-sourced tickets. Direct-by-id invocations the platform itself makes
   * (e.g. jarvis-routes running its own brain) are not discovery and stay
   * unaffected.
   */
  accessRoles?: SwarmAccessRole[];
}

/**
 * @description Canonical runtime identity for one swarm bot container.
 */
export interface SwarmRuntimeIdentity {
  agentId: string;
  agentName: string;
  aliases: string[];
  role: string;
  capabilities: string[];
  externalPort: number | null;
  endpointUrl: string;
  internalEndpointUrl: string;
}

/**
 * ADR-085: bots contributed by INSTALLED APP PACKAGES at activate() time. A store
 * app must be dispatchable without hand-editing the static arrays below (the
 * 2026-06-20 backfill block in the local registry is exactly the pattern this
 * retires). Keyed by app name so deactivate/uninstall can cleanly retract —
 * a stale entry would keep resolving inline dispatch for a removed app.
 */
const DYNAMIC_APP_BOTS = new Map<string, SwarmBotDefinition[]>();

/**
 * @description Register an installed app's bots into the ACTIVE registry (they
 * become resolvable exactly like static entries: endpoint resolution, harness
 * override, capability fallback, accessRoles checks, and the boot wiring audit).
 * Replaces any previous registration for the same app (re-activation safe).
 * @param appName - Owning app (retraction key).
 * @param defs - Registry definitions for the app's bots.
 */
export function registerAppBots(appName: string, defs: SwarmBotDefinition[]): void {
  DYNAMIC_APP_BOTS.set(appName, defs);
}

/**
 * @description Retract an app's dynamically registered bots (toggle-off/uninstall).
 * Idempotent.
 * @param appName - Owning app.
 */
export function unregisterAppBots(appName: string): void {
  DYNAMIC_APP_BOTS.delete(appName);
}

/** @returns The dynamically registered (package-contributed) bot definitions. */
function dynamicAppBots(): SwarmBotDefinition[] {
  return [...DYNAMIC_APP_BOTS.values()].flat();
}

/**
 * @description Returns the active bot registry based on SWARM_REGISTRY env var,
 * plus every installed app package's dynamically registered bots (ADR-085).
 * DEFAULT is the lean LOCAL_BOT_REGISTRY; SWARM_REGISTRY=full opts into the fuller
 * SWARM_BOT_REGISTRY. Any other/legacy value (or unset) resolves to the default,
 * so a stale env never selects the wrong lineup.
 *
 * Statics come FIRST, so consumers using `.find()` resolve a colliding agentId to the core
 * definition — a package may not re-declare a core bot (validator rule). **Access checks are the
 * deliberate exception:** `isBotAccessibleTo` scans EVERY matching definition and requires all of
 * them to permit the caller (ADR-085 D3), because a first-match-wins read would let a package widen
 * a core bot's reach by re-declaring its agentId with no accessRoles. For access, restriction wins.
 */
export function getActiveRegistry(): ReadonlyArray<SwarmBotDefinition> {
  const base = (process.env.SWARM_REGISTRY ?? '').trim().toLowerCase() === 'full'
    ? SWARM_BOT_REGISTRY
    : LOCAL_BOT_REGISTRY;
  const dynamic = dynamicAppBots();
  return dynamic.length ? [...base, ...dynamic] : base;
}

/**
 * @description Whether a caller role may discover/call the given bot (ADR-087).
 *
 * Resolves the bot's declared accessRoles from the ACTIVE registry. A bot that declares no roles —
 * or that the registry doesn't know at all — is open to every caller: scoping is always a
 * deliberate opt-in (ADR-087's backward-compatibility contract).
 *
 * **Most-restrictive-wins across every matching definition (ADR-085 D3).** `getActiveRegistry()`
 * concatenates the statics with the dynamic app bots, so one agentId can have TWO definitions. The
 * old `find()` took the first — statics — and silently ignored the dynamic one. That cuts both
 * ways: a packaged bot's scoping would be dropped on the floor, and a package could *widen* a core
 * bot's reach by re-declaring its agentId with no roles. Requiring EVERY matching definition to
 * permit the caller means a package can only ever narrow, never widen.
 *
 * @param agentId - The bot's agent UUID.
 * @param role - The caller role asking (e.g. 'jarvis').
 * @returns True when the caller may see and reach the bot.
 */
export function isBotAccessibleTo(agentId: string | null | undefined, role: SwarmAccessRole): boolean {
  if (!agentId) return true;
  const defs = getActiveRegistry().filter((b) => b.agentId === agentId);
  if (!defs.length) return true; // unknown bot — open, per ADR-087
  return defs.every((d) => roleCanAccess(d.accessRoles, role));
}

/** @description Static compose-derived swarm bot registry used for route compatibility and identity resolution. */
export const SWARM_BOT_REGISTRY: ReadonlyArray<SwarmBotDefinition> = [
  {
    agentId: 'a0000000-0000-0000-0000-000000000001',
    name: 'project-manager',
    port: 3010,
    container: 'oshal-api',
    role: 'project-manager',
    capabilities: ['orchestration', 'task-decomposition', 'quality-enforcement'],
    accessRoles: ['operator', 'swarm'],   // planner, not a doer — outside Jarvis's world (ADR-087)
  },
  {
    agentId: 'f0000000-0000-0000-0000-000000000001',
    name: 'queue-bot',
    port: 3055,
    container: 'queue-bot',
    role: 'project-manager',
    capabilities: ['orchestration', 'quality-review', 'deliverable-assessment', 'feedback-generation'],
    // claude-code CLI blocks --dangerously-skip-permissions when running as root in
    // bot containers, which prevents file writes and reduces output to
    // "please approve" prompts. codex-cli has no equivalent restriction and
    // already works end-to-end (validated by LM education + build pipelines),
    // so route the incident reviewer through codex.
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
    accessRoles: ['operator', 'swarm'],   // internal reviewer (ADR-087)
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000006',
    name: 'task-manager',
    port: 3011,
    container: 'oshal-local-task-manager',
    role: 'swarm/qa-gatekeeper',
    capabilities: ['qa', 'verification', 'testing'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
    accessRoles: ['operator', 'swarm'],   // QA gatekeeper (ADR-087)
  },
  // (Career Hunter worker carved to its store add-on 2026-07-21 — the package registers
  //  cb000000-…0001 with its own engine; no core career-hunter bot block.)
  {
    // Apply-operator — a REMOTE WORKER bot in the career-hunter family. It does NOT run in a swarm
    // container; it runs on the operator's desktop (oshal-chat/remote-client) and drives the real
    // logged-in Chrome via its browser_control MCP to submit an approved, packet-ready application.
    // codex-cli (gpt-5.5 vision) reasons over screenshots. Reached via remote-client dispatch, so it
    // has a registry identity but no compose service. Swarm-side control: /api/apply-operator.
    agentId: 'cb000000-0000-0000-0000-000000000003',
    name: 'apply-operator',
    port: 5000,            // bots listen on 5000 internally; unused for this remote-worker identity
    container: 'apply-operator',
    role: 'career/application-submitter',
    capabilities: ['ats-form-fill', 'browser-screen-control', 'application-submission', 'email-code-retrieval', 'application-recording'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // LinkedIn-profile-operator — apply-operator's sibling on the SAME remote-worker rail (LinkedIn
    // has NO profile-edit API). Applies an APPROVED Profile Studio plan (headline/about/skills/
    // custom URL/background banner/featured resume) by driving the operator's real logged-in Chrome
    // via browser_control on the desktop. Registry identity only, no compose service; dispatched by
    // profile-studio-dispatch, resolves via /api/profile-studio/ingest.
    agentId: 'cb000000-0000-0000-0000-000000000004',
    name: 'linkedin-profile-operator',
    port: 5000,            // unused for this remote-worker identity
    container: 'linkedin-profile-operator',
    role: 'career/profile-customizer',
    capabilities: ['linkedin-profile-editing', 'browser-screen-control', 'profile-media-upload'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
    accessRoles: ['operator', 'swarm'],  // ADR-087: internal machinery — dispatched by Profile Studio, not Jarvis-discoverable
  },
  {
    // Smart-home (home) app worker — controls the user's SmartThings hub per user_sub.
    // codex-cli so it can shell out to scripts/oshal-smartthings.js in its sandbox.
    agentId: 'd0000000-0000-0000-0000-000000000001',
    name: 'home-bot',
    port: 3061,
    container: 'home-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'smart-home/device-control',
    capabilities: ['smart-home-control', 'smartthings', 'device-control', 'scene-execution', 'home-automation'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Cloud-Ops (GCP) app worker — drives Google Cloud via the REST APIs (the
    // API-based gcloud replacement) with the user's web-OAuth token. codex-cli so it
    // can shell out to scripts/oshal-gcp.js. See swarm-apps/cloud.yaml.
    agentId: 'd0000000-0000-0000-0000-000000000002',
    name: 'cloud-ops-bot',
    port: 3067,
    container: 'cloud-ops-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'devops/cloud',
    capabilities: ['gcp-inventory', 'gcp-projects', 'gcp-compute', 'gcp-enabled-apis', 'gcp-cost-optimization', 'gcp-health-audit', 'gcp-iam-audit'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Purchasing (Shopping) app — inline concierge run via the orchestrator on the
    // caller's configured provider; products come from the Walmart connector CLI.
    agentId: 'b0070000-0000-0000-0000-000000000001',
    name: 'shopping-concierge',
    port: 3069,
    container: 'shopping-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'commerce/purchasing',
    capabilities: ['product-search', 'retail-price-comparison', 'shopping-list-management', 'cross-retailer-cart-building', 'rollback-deal-tracking', 'retail-checkout-handoff', 'purchase-preference-memory'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Eats (Uber Eats) app — a REAL bot-node in its OWN container (eats-bot) so the build queue
    // HTTP-dispatches Jarvis food tickets here (isolated, cost/audit under this agent_id) instead of
    // falling back to in-process execution on the controller. CODEX so its sandbox shells out to
    // scripts/oshal-uber.js (search/menu/order → the Uber Eats checkout deep-link). Reached via
    // BotNodeClient → http://eats-bot:5000/api/swarm-execute. See swarm-apps/eats.yaml.
    agentId: 'b0080000-0000-0000-0000-000000000001',
    name: 'eats-concierge',
    port: 3071,
    container: 'eats-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'commerce/food-delivery',
    capabilities: ['restaurant-search', 'menu-browse', 'food-order-building', 'uber-eats-checkout-handoff', 'dietary-filtering', 'cuisine-preferences'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Rides (Uber Rides) app — a REAL bot-node in its OWN container (rides-bot), so the build queue
    // HTTP-dispatches to it (isolated, cost/audit under this agent_id) instead of falling back to
    // in-process execution on the controller. CODEX so its sandbox shells out to
    // scripts/oshal-uber-rides.js (estimate + the device-aware booking link). Reached via
    // BotNodeClient → http://rides-bot:5000/api/swarm-execute. See swarm-apps/rides.yaml.
    agentId: 'b0090000-0000-0000-0000-000000000001',
    name: 'rides-concierge',
    port: 3072,
    container: 'rides-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'transportation/rides',
    capabilities: ['ride-fare-estimate', 'ride-options-comparison', 'rideshare-trip-planning', 'uber-ride-handoff', 'ride-preference-learning'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Feeds app — inline on the api via the orchestrator; reads the user's indexed Slack
    // feed through the feeds CLI tool (oshal-feeds.js) and summarizes what matters.
    agentId: 'fd000000-0000-0000-0000-000000000001',
    name: 'feeds-curator',
    port: 3074,
    container: 'oshal-api',
    role: 'communications/feeds',
    capabilities: ['feed-aggregation', 'feed-summarization', 'hot-area-detection', 'trend-analysis', 'sentiment-triage'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    // Spotify (music) app — inline concierge run via the orchestrator; discovery +
    // playlist-building hit the live Spotify Web API with the listener's brokered token,
    // playback is an open.spotify.com deep-link handoff.
    agentId: 'b00a0000-0000-0000-0000-000000000001',
    name: 'spotify-concierge',
    port: 3073,
    container: 'spotify-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'media/music',
    capabilities: ['spotify-music-search', 'spotify-playlist-building', 'music-recommendation', 'music-taste-learning', 'now-playing-awareness'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Movies & TV app — inline concierge run via the orchestrator; discovery via the live
    // TMDB API (operator key), watching + tickets are deep-link handoffs (JustWatch/Fandango).
    agentId: 'b00b0000-0000-0000-0000-000000000001',
    name: 'movies-concierge',
    port: 3076,
    container: 'movies-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'media/film-tv',
    capabilities: ['movie-tv-discovery', 'title-search', 'where-to-watch-streaming', 'watchlist-curation', 'movie-taste-learning', 'showtimes-handoff'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Drone Ops app (ADR-098) — Form B inline concierge: DRAFTS waypoint missions from natural
    // language over live telemetry (swarm-apps/drone.yaml). It never actuates — flight is
    // deterministic code in src/features/drone, and execution is a human-approved POST on
    // /api/drone. Operator+swarm scoped (ADR-087): Jarvis must not reach a flight-planning bot.
    agentId: 'b00f0000-0000-0000-0000-000000000001',
    name: 'drone-operator',
    port: 3010,
    container: 'oshal-api',
    role: 'robotics/drone-flight-planning',
    capabilities: ['drone-mission-drafting', 'waypoint-planning', 'drone-telemetry-briefing', 'geofence-awareness'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    // Camera Ops app (?app=camera) — Form B inline concierge: interprets a natural-language
    // instruction into ONE validated camera command over live state (swarm-apps/camera.yaml).
    // It never actuates directly — control is deterministic code in src/features/camera; the
    // route validates + executes, and destructive ops (delete-all) are confirmation-gated.
    // Operator+swarm scoped (ADR-087), drone-operator's device-control sibling.
    agentId: 'b0200000-0000-0000-0000-000000000001',
    name: 'camera-operator',
    port: 3012,
    container: 'oshal-api',
    role: 'devices/camera-control',
    capabilities: ['camera-control-intent', 'camera-status-briefing', 'capture-planning'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    // Sat Ops app (ADR-102) — Form B inline concierge: DRAFTS ADCS command suggestions
    // (point/detumble/desat/safe) from natural language over live fleet telemetry
    // (swarm-apps/sat-ops.yaml). It never actuates — the ADCS is deterministic code in
    // src/features/sat-ops, every draft is route-validated, and sending is a human-approved
    // POST. Operator+swarm scoped (ADR-087), drone-operator's sibling.
    agentId: 'b0102000-0000-0000-0000-000000000001',
    name: 'sat-operator',
    port: 3011,
    container: 'oshal-api',
    role: 'space/satellite-operations-planning',
    capabilities: ['sat-command-drafting', 'adcs-mode-planning', 'sat-telemetry-briefing', 'pass-window-awareness', 'conjunction-awareness'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    // Spaces app (ADR-111) — Form B inline concierge: briefs the user's video->3D reconstruction
    // scans and DRAFTS capture guidance (how to film a room for a good gaussian-splat). It never
    // runs a reconstruction — that is deterministic I/O in src/features/spatial-mapping, kicked by
    // a human upload on /api/spaces. The surface (?app=spaces) is a view over the bot's scan store
    // (ADR-036). Operator+swarm scoped (ADR-087), the drone/camera/sat ops-family sibling.
    agentId: 'b0300000-0000-0000-0000-000000000001',
    name: 'spaces-operator',
    port: 3027,
    container: 'oshal-api',
    role: 'reconstruction/spatial-capture',
    capabilities: ['scan-status-briefing', 'capture-planning', 'guided-capture', 'reconstruction-guidance', 'coverage-briefing'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    // Travel app (ADR-059) — inline concierge run via the orchestrator; REAL flight search via
    // the Duffel connector CLI, prices feed the swarm price DB, booking is a deep-link handoff.
    agentId: 'b00c0000-0000-0000-0000-000000000001',
    name: 'travel-concierge',
    port: 3075,
    container: 'travel-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'travel/concierge',
    capabilities: ['flight-search', 'hotel-search', 'car-search', 'fare-price-intelligence', 'fare-watch', 'trip-itinerary-planning', 'traveller-preference-learning', 'booking-handoff'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // General fallback owner (ADR-083 §5): when no knowledge owner claims a task in
    // the call-out, it lands here — a general, tool-capable doer with the full CLI
    // mount — never on project-manager (a planner, not a doer).
    agentId: 'a0000000-0000-0000-0000-000000000099',
    name: 'general-bot',
    port: 3099,
    container: 'general-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'general/fallback',
    capabilities: ['general-assistance', 'cross-domain-synthesis', 'web-research', 'overflow-fallback'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    // Workflow Studio (ADR-039) — inline concierge run via the orchestrator; the BRAIN turns a
    // spoken/typed process description into a workflow graph, the authenticated studio surface
    // persists + renders it. Reason-only (no shell-out); BYOK on the swarm default login. Reached
    // via POST /api/workflow-studio/chat and selectable on the general /chat path.
    agentId: 'a0000000-0000-0000-0000-000000000051',
    name: 'workflow-assistant',
    port: 3010,
    container: 'oshal-api',
    role: 'workflow/orchestration-specialist',
    capabilities: ['workflow-design', 'process-architecture', 'orchestration', 'workflow-validation'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    // codex-packer — the Bot Forge (interview-driven bot factory), inline on the api like the
    // local registry's entry. MUST match swarm-bot-registry-local.ts: this bot backs the Forge
    // ribbon tab + Packs studio in EVERY registry mode — parity guarded by
    // codex-packer-created-bot.spec.ts. Operator+swarm scoped (ADR-087).
    agentId: 'a0000000-0000-0000-0000-000000000030',
    name: 'codex-packer',
    port: 3010,
    container: 'oshal-api',
    role: 'bot-authoring/factory',
    capabilities: [
      'bot-authoring', 'persona-design', 'manifest-emission',
      'interview-driven-spec', 'codex-packing',
    ],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  // ── Delivery: the client-engagement method as four bots ─────────────────────
  // docs/delivery/ENGAGEMENT-METHOD.md is the method; these run it. All inline on
  // the api (same pattern as codex-packer) — they reason over a repo and leave
  // documents behind, so they need the workspace and a shell, not their own LLM
  // node. Personas carry the quality gates. MUST match swarm-bot-registry-local.ts.
  {
    agentId: 'a0000000-0000-0000-0000-000000000063',
    name: 'delivery-analyst',
    port: 3010,
    container: 'oshal-api',
    role: 'delivery/business-analyst',
    capabilities: [
      'requirements-discovery', 'transcript-analysis', 'gap-analysis',
      'codebase-baseline', 'scope-definition',
    ],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000062',
    name: 'delivery-sizer',
    port: 3010,
    container: 'oshal-api',
    role: 'delivery/capacity-analyst',
    capabilities: [
      'capacity-planning', 'load-projection', 'query-benchmarking',
      'concurrency-testing', 'growth-modelling', 'index-analysis',
    ],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000061',
    name: 'delivery-architect',
    port: 3010,
    container: 'oshal-api',
    role: 'delivery/solution-architect',
    capabilities: [
      'reference-architecture', 'as-is-to-be', 'hosting-cost-comparison',
      'high-availability', 'backup-and-recovery', 'decision-trees',
    ],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000064',
    name: 'delivery-verifier',
    port: 3010,
    container: 'oshal-api',
    role: 'delivery/verification-handover',
    capabilities: [
      'deployment-parity', 'browser-verification', 'regression-guards',
      'artifact-packaging', 'handover-documentation',
    ],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000002',
    name: 'code-developer',
    port: 3012,
    container: 'code-developer',
    role: 'localhost/worker',
    capabilities: ['coding', 'implementation', 'debugging'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  // video-director — the Video Studio app (swarm-apps/video.yaml, ?app=video).
  // REASON-ONLY: drafts a scene-by-scene storyboard JSON; the api renders the real .mp4
  // deterministically (Veo + ffmpeg via the video-generation slice). No shell-out, no
  // connector — runs INLINE on the api container (claude-code) like deck-builder, and its
  // cost lands in chat_tasks under this agent_id. id 048: 047 is security-analyst.
  {
    agentId: 'a0000000-0000-0000-0000-000000000048',
    name: 'video-director',
    port: 3010,
    container: 'oshal-api',
    role: 'video/storyboard-director',
    capabilities: ['video-storyboard', 'scene-direction', 'short-form-scripting', 'caption-writing'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // screenplay-writer — the Video Studio's SERIES screenwriter (swarm-apps/video.yaml,
  // ticketType video-series). REASON-ONLY concierge node inline on the api: it writes episode packs
  // as text and never shells out; the vids-operator remote worker renders them. Its persona
  // (ai-lab/bot-personas/screenplay-writer.yaml) carries the hard-won rules — four scenes, dialogue
  // on every scene, no narrator, a distinct camera per frame, motion-only direction. Keep this entry
  // identical to the local registry's (docs/building-a-bot.md: register in BOTH). id 052: 049-051 taken.
  {
    agentId: 'a0000000-0000-0000-0000-000000000052',
    name: 'screenplay-writer',
    port: 3010,
    container: 'oshal-api',
    role: 'media/screenplay-writer',
    capabilities: ['episode-scripting', 'series-bible', 'dialogue-writing', 'shot-direction'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // quality-judge — the shared LLM-judge/grading concierge (persona quality-judge.yaml).
  // REASON-ONLY: consumers (POST /api/judge, the token-chase optimizer's quality check,
  // persona evals) hand it {task, output, rubric[], reference?} via JudgeService
  // (@/features/quality-judge) and it returns ONE strict JSON verdict {score, dimensions,
  // rationale}. Grading is LLM work, so it runs on this bot — INLINE on the api container
  // (claude-code) like workflow-assistant (docs/building-a-bot.md Form B), BYOK on the swarm
  // default login; cost lands in chat_tasks under this agent_id. Keep this entry identical to
  // the local registry's (register in BOTH). id 053: 052 is screenplay-writer.
  {
    agentId: 'a0000000-0000-0000-0000-000000000053',
    name: 'quality-judge',
    port: 3010,
    container: 'oshal-api',
    role: 'quality/llm-judge',
    capabilities: ['output-grading', 'rubric-scoring', 'quality-verdict', 'llm-judging'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],   // grading machinery for other services, not a Jarvis-facing domain bot (ADR-087)
  },
  // pumpkin-bot — the animated jack-o'-lantern Halloween prop (swarm-apps/pumpkin.yaml, ?app=pumpkin).
  // REASON-ONLY: in AUTONOMOUS mode the projector surface sends it what a guest said and it replies
  // IN CHARACTER as a talking pumpkin ({say, expression, intensity}); the surface speaks + lip-syncs
  // the reply. MIMIC mode is pure STT->TTS and never reaches this bot. Runs INLINE on the api
  // (claude-code) like quality-judge (docs/building-a-bot.md Form B), BYOK on the swarm default login;
  // cost lands in chat_tasks under this agent_id. accessRoles keeps it out of the Jarvis bot list —
  // it's prop machinery reached only via POST /api/pumpkin/chat. Keep IDENTICAL to the local registry
  // (register in BOTH). id 054: 053 is quality-judge.
  {
    agentId: 'a0000000-0000-0000-0000-000000000054',
    name: 'pumpkin-bot',
    port: 3010,
    container: 'oshal-api',
    role: 'seasonal/jack-o-lantern-voice',
    capabilities: ['halloween-persona', 'in-character-conversation', 'spooky-improv', 'prop-voice'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],   // seasonal prop persona, not a Jarvis-facing domain bot
  },
  // ambient-analyst — the ambient Person Model enrichment concierge (ADR-100 Phase 2, persona
  // ambient-analyst.yaml). REASON-ONLY: the enrichment runtime hands it a small batch of the
  // owner's OWN consented attributed utterances and it returns ONE strict JSON object of per-line
  // {tone, intent, topics[], ask?, commitment?}. Runs INLINE on the api (claude-code) like
  // quality-judge (docs/building-a-bot.md Form B), BYOK on the swarm default login; cost lands in
  // chat_tasks under this agent_id. accessRoles keeps it out of the Jarvis bot list — enrichment
  // machinery reached only by EnrichmentService. Keep IDENTICAL in BOTH registries. id 055: 054 is pumpkin-bot.
  {
    agentId: 'a0000000-0000-0000-0000-000000000055',
    name: 'ambient-analyst',
    port: 3010,
    container: 'oshal-api',
    role: 'ambient/person-model-enrichment',
    capabilities: ['transcript-enrichment', 'tone-intent-inference', 'ask-extraction'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],   // enrichment machinery, not a Jarvis-facing domain bot (ADR-087)
  },
  // a2a-sample-agent — the EXAMPLE outbound A2A dispatch target (BACKLOG Plan F item 3).
  // An EXTERNAL agent: execution is an A2A JSON-RPC call (message/send + tasks/get) to the
  // endpoint named by a2aEndpointEnv — the remote owns its own reasoning, so the controller
  // never calls an LLM (two-runtimes rule), and in-swarm bots stay on the Redis mesh.
  // INERT until configured: with A2A_SAMPLE_AGENT_URL unset the a2a factory throws a clean
  // config error and resolveHarnessForAgent logs + falls back — a visible skip. Credential:
  // A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT (or A2A_OUTBOUND_ALLOW_ANON=true for a dev sample).
  // Capabilities are deliberately narrow (no domain keywords) so the queue call-out never
  // picks it, and accessRoles keeps it OUT of Jarvis until proven (ADR-087). Keep IDENTICAL
  // in BOTH registries (docs/building-a-bot.md).
  {
    agentId: 'ea000000-0000-0000-0000-000000000001',
    name: 'a2a-sample-agent',
    port: 3097,
    container: 'oshal-api',   // outbound call originates on the api; the WORK runs on the remote agent
    role: 'external/a2a-remote-agent',
    capabilities: ['a2a-remote-delegation', 'external-agent-execution'],
    harnessType: 'a2a',
    apiType: 'a2a',
    a2aEndpointEnv: 'A2A_SAMPLE_AGENT_URL',
    accessRoles: ['operator', 'swarm'],   // out of Jarvis until the outbound gateway is proven (ADR-087)
  },
  // (lora-director (a0…0049) removed: LoRA Studio carved to the oshal-applications store,
  //  ADR-085 Wave 1 — the package manifest registers the inline bot on activation. NOTE the
  //  …049 id is ALSO trading-research-analyst in the local registry — that one is trading's.)
  {
    agentId: 'a0000000-0000-0000-0000-000000000003',
    name: 'code-reviewer',
    port: 3013,
    container: 'code-reviewer',
    role: 'localhost/worker',
    capabilities: ['code-review', 'security', 'quality'],
    harnessType: 'claude-code',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000016',
    name: 'rca-specialist',
    port: 3014,
    container: 'rca-specialist',
    role: 'localhost/worker',
    capabilities: ['debugging', 'investigation', 'root-cause', 'incident', 'analysis'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000017',
    name: 'presentation-bot',
    port: 3015,
    container: 'presentation-bot',
    role: 'localhost/worker',
    capabilities: ['presentation', 'slides', 'reporting', 'visualization'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000004',
    name: 'documentation-writer',
    port: 3016,
    container: 'documentation-writer',
    role: 'localhost/worker',
    capabilities: ['documentation', 'readme', 'adr'],
    harnessType: 'cline',
    apiType: 'openai-codex',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000007',
    name: 'agent-factory',
    port: 3017,
    container: 'agent-factory',
    role: 'swarm/factory',
    capabilities: ['agent-creation', 'bot-provisioning', 'persona-generation'],
    accessRoles: ['operator', 'swarm'],   // provisioning machinery (ADR-087)
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000008',
    name: 'devops-bot',
    port: 3018,
    container: 'devops-bot',
    role: 'localhost/worker',
    capabilities: ['infrastructure', 'cicd', 'kubernetes', 'docker', 'monitoring'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-00000000000b',
    name: 'incident-response-bot',
    port: 3019,
    container: 'incident-response-bot',
    role: 'localhost/worker',
    capabilities: ['incident-response', 'triage', 'runbook-execution', 'stakeholder-communication'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    agentId: 'e0000000-0000-0000-0000-000000000200',
    name: 'advisor-bot',
    port: 3056,
    container: 'advisor-bot',
    role: 'localhost/platform-advisor',
    capabilities: [
      'oshal-platform-knowledge', 'opensearch-query', 'graph-query',
      'incident-analysis', 'architecture-guidance', 'api-documentation',
      'oshal-integration-knowledge', 'how-to-guidance',
    ],
  },
  {
    agentId: 'a0000000-0000-0000-0000-00000000000c',
    name: 'research-bot',
    port: 3020,
    container: 'research-bot',
    role: 'localhost/worker',
    capabilities: ['research', 'analysis', 'documentation', 'investigation'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    agentId: 'a0000000-0000-0000-0000-00000000000a',
    name: 'security-auditor-bot',
    port: 3021,
    container: 'security-auditor-bot',
    role: 'localhost/worker',
    capabilities: ['security', 'compliance', 'vulnerability-assessment', 'audit'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000005',
    name: 'test-engineer',
    port: 3022,
    container: 'test-engineer',
    role: 'localhost/worker',
    capabilities: ['testing', 'validation', 'verification', 'test-automation', 'qa'],
    harnessType: 'cline',
    apiType: 'openai-codex',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000018',
    name: 'architect-bot',
    port: 3023,
    container: 'system-architect',
    role: 'localhost/worker',
    capabilities: ['architecture', 'design', 'system-modeling', 'diagrams', 'patterns', 'review'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    agentId: 'a0000000-0000-0000-0000-00000000000d',
    name: 'business-plan-bot',
    port: 3024,
    container: 'business-plan-bot',
    role: 'localhost/worker',
    capabilities: ['business-planning', 'financial-analysis', 'market-research', 'strategy', 'pitch-decks'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-00000000000e',
    name: 'tester-bot',
    port: 3025,
    container: 'tester-bot',
    role: 'localhost/worker',
    capabilities: ['testing', 'qa', 'test-standards', 'acceptance-criteria', 'test-automation'],
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000023',
    name: 'google-bot',
    port: 3026,
    container: 'google-bot',
    role: 'localhost/worker',
    capabilities: [
      'google-workspace', 'google-api', 'gmail', 'google-drive',
      'google-docs', 'google-sheets', 'google-slides', 'google-calendar',
    ],
    // Live on the gemini-cli harness — Google's own runtime for the Google bot.
    // Reads GEMINI_API_KEY (compose falls back to GOOGLE_API_KEY) on the model
    // in GEMINI_MODEL (gemini-2.5-flash). Requires pay-as-you-go billing on the
    // AI Studio project: the free tier 429s under load. The ~/.gemini OAuth
    // mount is the no-key fallback. Makes gemini-cli a live 5th runtime.
    harnessType: 'gemini-cli',
    apiType: 'gemini',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000021',
    name: 'facebook-bot',
    port: 3033,
    container: 'facebook-bot',
    role: 'localhost/worker',
    capabilities: [
      'social-media', 'facebook-api', 'content-publishing',
      'community-engagement', 'comment-management', 'feed-monitoring',
      'oauth-integration', 'graph-api',
    ],
  },
  // (Little Monsters education bots removed — carved out to the oshal-applications
  //  store package, ADR-085. Its bots register via the installed manifest.)
  // ── Platform Development (ADR-081) ─────────────────────────────────────────
  // oshal-developer — the dedicated OSHAL platform-development specialist. Owns
  // ticketType 'oshal-dev' (superadmin-gated at dispatch): works in its OWN clone
  // of this repo (/app/dev-repo, cloned at container start from OSHAL_DEV_REPO_URL —
  // never the live tree or the host mount), follows Rule 0 (main-only, small commits,
  // push immediately, guard hooks on), and reports back on the ticket. codex-cli so
  // it can shell out (git, tsc, vitest) in its sandbox; the idle-based harness
  // timeout (ADR-081) lets long dev runs stream without being killed on duration.
  {
    agentId: 'de000000-0000-0000-0000-000000000001',
    name: 'oshal-developer',
    port: 3080,
    container: 'oshal-developer',
    role: 'platform/developer',
    capabilities: [
      'platform-development', 'typescript', 'feature-slice-design',
      'documentation-quality', 'codebase-indexing', 'self-hosting',
    ],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
    requiresOwnNode: true,   // the repo clone lives on the node — inline execution has no /app/dev-repo
    accessRoles: ['operator', 'swarm'],   // privileged; reachable only via the superadmin-gated 'oshal-dev' lane (ADR-087)
  },
];

/**
 * @description Canonical registry for known swarm bot containers and identities.
 */
export class SwarmBotRegistry {
  /**
   * @description Returns the static swarm bot definitions derived from the local compose topology.
   * @returns Immutable-safe copies of the known swarm bot entries.
   */
  static listDefinitions(): SwarmBotDefinition[] {
    return getActiveRegistry().map((bot) => ({
      ...bot,
      capabilities: [...bot.capabilities],
    }));
  }

  /**
   * @description Resolves the current process environment into a canonical runtime bot identity.
   * @param env - Environment variables for the running bot process.
   * @returns Canonical runtime identity used for registry heartbeats and targeted mesh channels.
   */
  static resolveRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): SwarmRuntimeIdentity {
    const agentIdEnv = normalizeIdentifier(env.AGENT_ID);
    const botNameEnv = normalizeIdentifier(env.BOT_NAME);
    const matched = findDefinition(agentIdEnv, botNameEnv);
    const externalPort = parseExternalPort(env.AGENT_EXTERNAL_PORT, matched?.port);
    const identity = matched
      ? buildKnownIdentity(matched, agentIdEnv, botNameEnv, externalPort)
      : buildFallbackIdentity(agentIdEnv, botNameEnv, externalPort, env.AGENT_ENDPOINT_URL);

    logger.info(
      {
        agentId: identity.agentId,
        agentName: identity.agentName,
        aliases: identity.aliases,
        externalPort: identity.externalPort,
      },
      'Resolved swarm runtime identity',
    );
    return identity;
  }
}

function findDefinition(agentId?: string, botName?: string): SwarmBotDefinition | undefined {
  if (agentId) {
    const byAgentId = getActiveRegistry().find((bot) => bot.agentId === agentId);
    if (byAgentId) {
      return byAgentId;
    }
  }

  if (botName) {
    return getActiveRegistry().find((bot) => bot.name === botName);
  }

  return undefined;
}

function buildKnownIdentity(
  bot: SwarmBotDefinition,
  agentIdEnv: string | undefined,
  botNameEnv: string | undefined,
  externalPort: number | null,
): SwarmRuntimeIdentity {
  const agentId = bot.agentId ?? agentIdEnv ?? bot.name;
  const aliases = uniqueIdentifiers([agentIdEnv, botNameEnv, bot.name], agentId);
  return {
    agentId,
    agentName: bot.name,
    aliases,
    role: bot.role,
    capabilities: [...bot.capabilities],
    externalPort,
    endpointUrl: buildEndpointUrl(externalPort),
    internalEndpointUrl: `http://${bot.container}:${INTERNAL_SWARM_PORT}`,
  };
}

function buildFallbackIdentity(
  agentIdEnv: string | undefined,
  botNameEnv: string | undefined,
  externalPort: number | null,
  endpointUrlEnv?: string,
): SwarmRuntimeIdentity {
  const agentId = agentIdEnv ?? botNameEnv ?? 'unknown-agent';
  const agentName = botNameEnv ?? agentIdEnv ?? 'unknown-agent';
  const aliases = uniqueIdentifiers([agentIdEnv, botNameEnv], agentId);
  return {
    agentId,
    agentName,
    aliases,
    role: 'unknown',
    capabilities: [],
    externalPort,
    endpointUrl: buildFallbackEndpointUrl(externalPort, endpointUrlEnv),
    internalEndpointUrl: `http://${agentName}:${INTERNAL_SWARM_PORT}`,
  };
}

function buildEndpointUrl(externalPort: number | null): string {
  // AGENT_ENDPOINT_URL takes precedence (K8s service URLs).
  // Falls back to localhost:port for docker-compose local dev.
  const envUrl = process.env.AGENT_ENDPOINT_URL?.trim();
  if (envUrl) return envUrl;
  return externalPort == null ? '' : `http://localhost:${externalPort}`;
}

function buildFallbackEndpointUrl(externalPort: number | null, endpointUrlEnv?: string): string {
  const envUrl = process.env.AGENT_ENDPOINT_URL?.trim();
  if (envUrl) return envUrl;
  if (externalPort != null) {
    return `http://localhost:${externalPort}`;
  }
  return endpointUrlEnv?.trim() ?? '';
}

function parseExternalPort(rawPort?: string, fallbackPort?: number): number | null {
  if (typeof rawPort === 'string' && rawPort.trim().length > 0) {
    const parsed = Number.parseInt(rawPort, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return typeof fallbackPort === 'number' ? fallbackPort : null;
}

function normalizeIdentifier(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * @description Validates that all persona definitions in the registry have unique agent IDs and names.
 * Call at server boot before queue-manager begins dispatching.
 * On violation: logs ERROR with conflicting entries and calls process.exit(1).
 */
export function validatePersonaIdentities(): void {
  const idMap = new Map<string, string[]>();
  const nameMap = new Map<string, string[]>();
  const activeRegistry = getActiveRegistry();

  for (const bot of activeRegistry) {
    const id = bot.agentId ?? bot.name;
    const existing = idMap.get(id) ?? [];
    existing.push(bot.name);
    idMap.set(id, existing);

    const nameEntries = nameMap.get(bot.name) ?? [];
    nameEntries.push(id);
    nameMap.set(bot.name, nameEntries);
  }

  const violations: string[] = [];

  for (const [id, names] of idMap.entries()) {
    if (names.length > 1) {
      violations.push(`Duplicate agent_id "${id}" across bots: ${names.join(', ')}`);
    }
  }

  for (const [name, ids] of nameMap.entries()) {
    if (ids.length > 1) {
      violations.push(`Duplicate bot name "${name}" across agent IDs: ${ids.join(', ')}`);
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      logger.error({ violation: v }, 'PERSONA IDENTITY COLLISION DETECTED');
    }
    logger.error(
      { violationCount: violations.length },
      'Persona identity validation FAILED — refusing to start. Fix duplicate agent_id or name values in SWARM_BOT_REGISTRY.',
    );
    process.exit(1);
  }

  logger.info(
    { botCount: activeRegistry.length },
    'Persona identity validation passed — no duplicate agent_id or name values',
  );
}

function uniqueIdentifiers(values: Array<string | undefined>, primary: string): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    if (!value || value === primary || seen.has(value)) {
      continue;
    }
    seen.add(value);
    aliases.push(value);
  }
  return aliases;
}
