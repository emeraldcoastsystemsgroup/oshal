/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Lean single-purpose bot registry — stripped to ticket processing bots only
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rebalanced: drop the single-purpose bots, add code-developer, code-reviewer, documentation-writer for local dev
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Repoint all 18 codex-cli/openai-codex bots to claude-code/claude-code: the codex CLI path produced no output (gpt-5.3-codex unauthenticated), which broke the always-on cockpit chat (project-manager) AND every swarm bot. The per-bot harnessType override wins over the global provider, so setting claude-code in the UI had no effect until the registry matched. Gemini research-bot left as-is.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Renamed the inline-controller container targets to oshal-api (compose service rename); the genuine local-harness registry/personas are unchanged (only the mis-named API service was renamed).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-083: promoted the 11 inline-on-api concierges (shopping/travel/career-advisor/social-writer/storage/deck-builder/finance/trading/identity/spotify/movies) to REAL bot-nodes (own containers, codex) so the queue manager's BID_REQUEST call-out reaches them; added general-bot (a0…0099) as the low-confidence fallback owner; rescoped generic capability tags (preference-learning/checkout-handoff/compute/devops/etc.) to domain-scoped ones so bots stop over-bidding across domains.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-087: scoped the internal machinery (project-manager, task-manager, queue-bot, oshal-developer, codex-packer, oshal-assistant) to accessRoles operator+swarm — outside Jarvis's discovery/call reach. Domain bots stay unscoped (open to every caller).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added quality-judge (a0…0053) — the shared LLM-judge/grading concierge (inline on oshal-api, claude-code, operator+swarm scoped), mirrored from the canonical registry (register in BOTH). Grading is LLM work: JudgeService/@/features/quality-judge routes it here so the controller never calls an LLM.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1: removed brand-graphics (b00f…0001) — carved to the oshal-applications store package, whose loader-side ManifestBotRegistrar registers it on activation (zero core-registry edits is the whole point). vids-operator (b00e…0001) stays: it belongs to the vids app, still framework-resident.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #2: removed kid-lens-bot (a0…0043) — youtube-kids carved to the store; the package manifest registers the inline bot on activation, same as brand-graphics.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Plan F item 3: added a2a-sample-agent (ea…0001) — the example outbound A2A dispatch target (harnessType 'a2a', endpoint from A2A_SAMPLE_AGENT_URL), mirrored IDENTICALLY from the canonical registry (register in BOTH). Inert until the endpoint env is set; operator+swarm scoped; narrow capabilities so the call-out never picks it.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | De-brand final pass: renamed this file (from its legacy-branded name to …-local.ts) and its export (to LOCAL_BOT_REGISTRY). This lean lineup is the DEFAULT active registry — getActiveRegistry() resolves here unless SWARM_REGISTRY=full opts into the fuller SWARM_BOT_REGISTRY. Same bots, same order; no behavior change. A stale legacy SWARM_REGISTRY value now falls through to this default (hot-swap-safe).
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Fix ADR-085 carve id collision: drone-operator moved b0100000-…001 → b00f0000-…001 (mirrors the canonical registry). portrait-studio's store package had taken b0100000-…001; operator-chosen resolution keeps portrait there and reverts drone-operator to its already-in-DB b00f0000 id. See scripts/swarm-app-bot-integrity-check.sh.
 */

import type { SwarmBotDefinition } from './swarm-bot-registry';

/**
 * @description OSHAL swarm bot registry for local and deployed execution — the lean,
 * default-active lineup. Balanced: orchestration (PM, QA), implementation (code-dev,
 * devops), quality (reviewer, docs), and incident (RCA, incident-response).
 */
export const LOCAL_BOT_REGISTRY: ReadonlyArray<SwarmBotDefinition> = [
  // ── Purchasing (Shopping) app ─────────────────────────────────────────────
  {
    // A REAL bot-node in its OWN container (shopping-bot) on CODEX — promoted from
    // inline-on-api (ADR-083) so the queue manager's BID_REQUEST call-out reaches it.
    // Its sandbox shells out to scripts/oshal-walmart.js for product search/deals.
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
  // ── Eats (Uber Eats) app ──────────────────────────────────────────────────
  {
    // A REAL bot-node in its OWN container (eats-bot) on CODEX — its sandbox shells out to
    // scripts/oshal-uber.js (search/menu/order → the Uber Eats checkout deep-link). The build queue
    // HTTP-dispatches Jarvis food tickets here (isolated, traceable) and the surface reaches it via
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
  // ── Rides (Uber Rides) app ────────────────────────────────────────────────
  {
    // A REAL bot-node in its OWN container (rides-bot) on CODEX — its sandbox shells out to
    // scripts/oshal-uber-rides.js (estimate + the device-aware booking link). The build queue
    // HTTP-dispatches Jarvis ride tickets here (isolated, traceable) and the surface reaches it via
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
  // ── Feeds app ─────────────────────────────────────────────────────────────
  {
    // Inline on the api via the orchestrator; reads the user's indexed Slack feed through
    // the feeds CLI tool (oshal-feeds.js) and summarizes what matters. Lets Jarvis route
    // Slack/"what did I miss" requests to a real bot with a real tool.
    agentId: 'fd000000-0000-0000-0000-000000000001',
    name: 'feeds-curator',
    port: 3074,
    container: 'oshal-api',
    role: 'communications/feeds',
    capabilities: ['feed-aggregation', 'feed-summarization', 'hot-area-detection', 'trend-analysis', 'sentiment-triage'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Travel app (ADR-059) ──────────────────────────────────────────────────
  {
    // A REAL bot-node in its OWN container (travel-bot) on CODEX — promoted from
    // inline-on-api (ADR-083) so the call-out reaches it. The travel route still runs
    // REAL flight search through the Duffel connector CLI and hands off a booking link.
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
  // ── Orchestration ─────────────────────────────────────────────────────────
  {
    agentId: 'a0000000-0000-0000-0000-000000000001',
    name: 'project-manager',
    port: 3010,
    container: 'oshal-local-api',
    role: 'project-manager',
    capabilities: ['orchestration', 'task-decomposition', 'quality-enforcement'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],   // planner, not a doer — outside Jarvis's world (ADR-087)
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000006',
    name: 'task-manager',
    port: 3040,
    container: 'oshal-local-task-manager',
    role: 'swarm/qa-gatekeeper',
    capabilities: ['qa', 'verification', 'testing', 'acceptance-criteria'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],   // QA gatekeeper (ADR-087)
  },
  // (Career Hunter carved to its store add-on 2026-07-21: the career-hunter package registers
  //  cb000000-…0001 with its own engine; no core career bot blocks. career-advisor cb…0002 retired.)
  // ── Implementation ────────────────────────────────────────────────────────
  {
    agentId: 'a0000000-0000-0000-0000-000000000002',
    name: 'code-developer',
    port: 3041,
    container: 'oshal-local-code-developer',
    role: 'localhost/worker',
    capabilities: ['coding', 'implementation', 'debugging', 'refactoring', 'feature-development', 'bug-fixing', 'api-design'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000008',
    name: 'devops-bot',
    port: 3042,
    container: 'oshal-local-devops',
    role: 'localhost/worker',
    capabilities: ['infrastructure', 'cicd', 'kubernetes', 'docker', 'monitoring', 'scripting', 'bash', 'deployment'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Quality ───────────────────────────────────────────────────────────────
  {
    agentId: 'a0000000-0000-0000-0000-000000000003',
    name: 'code-reviewer',
    port: 3043,
    container: 'oshal-local-code-reviewer',
    role: 'localhost/worker',
    capabilities: ['code-review', 'security', 'quality', 'best-practices', 'architecture-review'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000004',
    name: 'documentation-writer',
    port: 3044,
    container: 'oshal-local-documentation-writer',
    role: 'localhost/worker',
    capabilities: ['documentation', 'readme', 'adr', 'jsdoc', 'technical-writing', 'handover'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Incident & Analysis ───────────────────────────────────────────────────
  {
    agentId: 'a0000000-0000-0000-0000-000000000016',
    name: 'rca-specialist',
    port: 3045,
    container: 'oshal-local-rca-specialist',
    role: 'localhost/worker',
    capabilities: ['debugging', 'investigation', 'root-cause', 'incident', 'analysis', 'troubleshooting'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    agentId: 'a0000000-0000-0000-0000-00000000000b',
    name: 'incident-response-bot',
    port: 3046,
    container: 'oshal-local-incident-response',
    role: 'localhost/worker',
    capabilities: ['incident-response', 'triage', 'runbook-execution', 'stakeholder-communication'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Digest / Productivity ──────────────────────────────────────────────────
  // email-summarizer — the Intelligent Communication app's accountable email
  // bot. A first-class oshal-bot node (own container, heartbeat, mesh): it owns
  // Gmail + Calendar knowledge and other swarm bots talk to it for email work.
  // Reads the per-user connector token (oshal_connections) — no separate CLI auth.
  {
    agentId: 'b0000000-0000-0000-0000-000000000001',
    name: 'communications-bot',
    port: 3034,
    container: 'email-bot',
    requiresOwnNode: true,
    role: 'comms/email-calendar-social',
    capabilities: [
      'email-summarization', 'gmail-triage', 'outlook-mail', 'calendar-digest',
      'meeting-agenda', 'reply-drafting', 'inbox-triage', 'social-signals-feed',
      'social-publishing',
    ],
    // CODEX, not claude-code: the persona shells out (`node oshal-gmail.js`) and
    // claude-code-as-root cannot auto-approve bash. Keep execution on this bot's
    // own node so the token-broker credential file and Gmail CLI share a workspace.
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  // Forecast weather is deliberately separate from weather-analyst below. This
  // node answers local current-condition/forecast requests with the deterministic
  // NWS-backed format-weather tool; weather-analyst remains the trading signal bot.
  {
    agentId: 'a0000000-0000-0000-0000-000000000036',
    name: 'weather-bot',
    port: 3032,
    container: 'weather-bot',
    requiresOwnNode: true,
    role: 'weather/forecast-specialist',
    capabilities: [
      'current-weather', 'weather-forecast', 'local-weather-report',
      'weather-data-formatting',
    ],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
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
  // ── Bot Authoring ──────────────────────────────────────────────────────────
  // codex-packer — interview-driven bot factory. You chat with it; it runs the
  // 8-question interview (task/inputs/outputs/success-criteria/corpus/external
  // services/trigger+side-effects/PII+tool-whitelist), then emits a single-
  // purpose packed bot (persona YAML + manifest into deployed-apps/ + optional
  // kb/) staged for the operator's one-click injection in the Forge surface —
  // the bot never calls /api/swarm/apps/load itself. Runs inline in the api
  // container (an inline concierge node). MUST exist in BOTH
  // registries — guarded by codex-packer-created-bot.spec.ts.
  {
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
    accessRoles: ['operator', 'swarm'],   // operator-driven bot factory (ADR-087)
  },
  // ── Delivery: the client-engagement method as four bots ─────────────────────
  // docs/delivery/ENGAGEMENT-METHOD.md is the method; these run it. All inline on
  // the api (same pattern as codex-packer) — they reason over a repo and leave
  // documents behind, so they need the workspace and a shell, not their own LLM
  // node. Personas carry the quality gates. MUST match swarm-bot-registry.ts.
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
  // ── Per-app chat agents (inline, like codex-packer) ─────────────────────────
  // Each swarm app gets its OWN right-rail chat bot instead of everyone sharing
  // email-summarizer. They run inline in the api container (no dedicated node)
  // and route through the same TaskController→harness→recordCost path as
  // codex-packer/project-manager, so their chat cost lands in chat_tasks under
  // their own agent_id — per-app cost attribution, not lumped under the comms bot.
  {
    agentId: 'a0000000-0000-0000-0000-000000000040',
    name: 'social-writer',
    port: 3082,
    container: 'social-writer-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'social/content-partner',
    capabilities: ['post-drafting', 'voice-matching', 'content-refinement', 'personal-branding', 'linkedin-post-drafting', 'x-post-drafting', 'facebook-page-post-drafting', 'caption-writing', 'hook-and-cta-crafting'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000041',
    name: 'storage-assistant',
    port: 3083,
    container: 'storage-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'storage/operations-assistant',
    capabilities: ['storage-target-config', 'github-repo-create', 'file-store-listing', 'storage-backend-routing', 'storage-management'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000042',
    name: 'deck-builder',
    port: 3084,
    container: 'deck-builder-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'presentations/guide',
    capabilities: ['presentation-outline', 'slide-structure', 'deck-template-recommendation', 'pitch-deck-drafting', 'deck-guidance'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  // video-director — the Video Studio app (swarm-apps/video.yaml, ?app=video). Reason-only
  // storyboard drafter, inline on the api (claude-code) like deck-builder; the api renders
  // the real .mp4 (Veo + ffmpeg). Cost lands in chat_tasks under this agent_id.
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
  // on every scene, no narrator, a distinct camera per frame, motion-only direction. Cost lands in
  // chat_tasks under this agent_id.
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
  // the canonical registry's (register in BOTH). id 053: 052 is screenplay-writer.
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
  // it's prop machinery reached only via POST /api/pumpkin/chat. Keep IDENTICAL to the canonical
  // registry (register in BOTH). id 054: 053 is quality-judge.
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
  // finance-analyst — the Finance app's REAL bot-node (ADR-083 own-node promotion; codex,
  // shells scripts/oshal-plaid.js in its finance-bot container). The Finance APP carved to the
  // oshal-applications store 2026-07-17 (ADR-085 Wave 1 finale), but this heavy-bot entry stays
  // FRAMEWORK-RESIDENT per ADR-093's interim tier — the manifest bot mapper only expresses
  // inline concierges, so container/registry/persona/CLI remain the operator-applied fragment
  // (vids-operator precedent). The packaged app's workflow resolves this bot by name.
  {
    agentId: 'a0000000-0000-0000-0000-000000000044',
    name: 'finance-analyst',
    port: 3085,
    container: 'finance-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'finance/analysis-specialist',
    capabilities: ['personal-finance-brief', 'net-worth-analysis', 'account-balance-aggregation', 'portfolio-holdings-review', 'spending-and-cashflow-analysis', 'budget-tracking'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  // trading-analyst — the Intelligent Trades stock-trading app (swarm-apps/trading.yaml, ADR-052/053).
  // REASON-ONLY: the api captures market signals + does deterministic broker I/O (Alpaca); this bot
  // reasons over the captured signal(s) and returns a structured trade DECISION (the decision tree).
  // It never shells out and never places orders itself — so it runs INLINE on the api container
  // (claude-code) like finance-analyst, and its cost lands in chat_tasks under this agent_id.
  // id 046: 045 belongs to identity-advisor.
  {
    agentId: 'a0000000-0000-0000-0000-000000000046',
    name: 'trading-analyst',
    port: 3086,
    container: 'trading-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'trading/decision-specialist',
    capabilities: ['market-signal-analysis', 'trade-decision', 'decision-tree-justification', 'portfolio-audit', 'autopilot-pnl', 'order-forensics', 'risk-gate-forensics'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  // security-analyst — the Security Center self-security app (swarm-apps/security.yaml, ADR-055).
  // REASON-ONLY: the api runs the deterministic scanners (committed secrets, unauthenticated routes,
  // vulnerable deps, runtime/ledger/audit anomalies) and stores findings; this bot reasons over ONE
  // finding and returns a structured triage (real threat? false positive? attack scenario? fix?).
  // It never scans, never shells out, and never remediates — so it runs INLINE on the api container
  // (claude-code) like finance-analyst / trading-analyst, and its cost lands in chat_tasks under this
  // agent_id. id 047: 046 belongs to trading-analyst. See security-routes.ts.
  {
    agentId: 'a0000000-0000-0000-0000-000000000047',
    name: 'security-analyst',
    port: 3010,
    container: 'oshal-api',
    role: 'security/triage-specialist',
    capabilities: ['finding-triage', 'threat-assessment', 'attack-scenario-analysis', 'remediation-recommendation'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // trading-research-analyst — finds + classifies gravity masses from news/research for Intelligent
  // Trades (ADR-054). REASON-ONLY inline on the api like trading-analyst. id 049 (047=security, 048 taken).
  {
    agentId: 'a0000000-0000-0000-0000-000000000049',
    name: 'trading-research-analyst',
    port: 3010,
    container: 'oshal-api',
    role: 'trading/research-mass-finder',
    capabilities: ['event-classification', 'influencer-gravity', 'coupling-estimation', 'market-impact-assessment'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // weather-analyst — turns live NWS severe-weather alerts into disaster-demand gravity masses
  // (ADR-054, scripts/oshal-weather.js). REASON-ONLY inline on the api. id 04a.
  {
    agentId: 'a0000000-0000-0000-0000-00000000004a',
    name: 'weather-analyst',
    port: 3010,
    container: 'oshal-api',
    role: 'trading/weather-mass-finder',
    capabilities: ['weather-impact', 'disaster-demand', 'coupling-estimation'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // world-analyst — the World Intelligence (Layer B) bot (swarm-apps/world.yaml).
  // READS + FRESHENS the shared world graph/series through the world_* tools (cli over the local
  // /api/world, scripts/oshal-world.js): bias-aware sentiment (political+econ+kind), entity graph,
  // pull-rate, and news ingestion. Runs INLINE on the api container (claude-code) like the other
  // reason+tool analysts; cost lands in chat_tasks under this agent_id. agentId matches the manifest
  // + persona (the build-your-own-swarm-app "compiles-but-fails" rule: registry id == manifest id).
  {
    agentId: 'b00d0000-0000-0000-0000-000000000001',
    name: 'world-analyst',
    port: 3010,
    container: 'oshal-api',
    role: 'intelligence/world-analyst',
    capabilities: ['world-query', 'sentiment-analysis', 'news-ingestion', 'entity-extraction', 'bias-analysis'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Drone Ops app (ADR-098) ───────────────────────────────────────────────
  {
    // Form B inline concierge: DRAFTS waypoint missions from natural language over live
    // telemetry (swarm-apps/drone.yaml). It never actuates — flight is deterministic code in
    // src/features/drone, and execution is a human-approved POST on /api/drone. Operator+swarm
    // scoped (ADR-087): Jarvis must not reach a flight-planning bot.
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
  // ── Camera Ops app (?app=camera) ──────────────────────────────────────────
  {
    // Form B inline concierge: interprets a natural-language instruction into ONE validated
    // camera command over live state (swarm-apps/camera.yaml). It never actuates directly —
    // control is deterministic code in src/features/camera; the route validates + executes,
    // and destructive ops (delete-all) are confirmation-gated. Operator+swarm scoped (ADR-087).
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
  // ── Sat Ops app (ADR-102) ─────────────────────────────────────────────────
  {
    // Form B inline concierge: DRAFTS ADCS command suggestions (point/detumble/desat/safe)
    // from natural language over live fleet telemetry (swarm-apps/sat-ops.yaml). It never
    // actuates — the ADCS is deterministic code in src/features/sat-ops, every draft is
    // route-validated, and sending is a human-approved POST. Operator+swarm scoped (ADR-087).
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
    // scans and DRAFTS capture guidance. It never runs a reconstruction — that is deterministic I/O
    // in src/features/spatial-mapping, kicked by a human upload on /api/spaces. The surface
    // (?app=spaces) is a view over the bot's scan store (ADR-036). Operator+swarm scoped (ADR-087).
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
  // identity-advisor — the Identity Hub access-review bot (swarm-apps/identity.yaml).
  // REASON-ONLY: the api resolves the caller's connection METADATA inventory (provider,
  // account label, personal/shared, default flag, token expiry — NEVER the tokens) and
  // hands it to this bot in the task; the bot flags what needs attention (expired logins,
  // duplicates, recommended-but-missing connectors). No shell-out, no connector — so it
  // runs INLINE on the api container (claude-code) like finance-analyst, and its cost
  // lands in chat_tasks under this agent_id. See identity-routes.ts.
  {
    agentId: 'a0000000-0000-0000-0000-000000000045',
    name: 'identity-advisor',
    port: 3087,
    container: 'identity-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'identity/access-advisor',
    capabilities: ['connection-inventory-review', 'access-health-review', 'expired-login-detection', 'duplicate-account-detection', 'stale-connection-detection', 'missing-connector-suggestion', 'default-account-check'],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  },
  // workflow-assistant — the Workflow Studio builder bot (ADR-039, persona workflow-assistant.yaml).
  // INLINE CONCIERGE (like movies/spotify/travel): the BRAIN runs via the orchestrator and turns a
  // spoken/typed process description into one validated `workflow-graph` block; the authenticated
  // studio surface persists + renders it. Reason-only (no shell-out, no per-user connector), so it
  // runs INLINE on the api container; BYOK on the swarm default login. Reached via POST
  // /api/workflow-studio/chat and selectable on the general /chat path. id 051 (050 = oshal-assistant).
  {
    agentId: 'a0000000-0000-0000-0000-000000000051',
    name: 'workflow-assistant',
    port: 3010,
    container: 'oshal-api',
    role: 'workflow/orchestration-specialist',
    capabilities: ['workflow-design', 'process-architecture', 'orchestration', 'workflow-validation'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // oshal-assistant ("Jarvis") — the unified front door over every OSHAL app (swarm-apps/jarvis.yaml).
  // REASON-ONLY: the jarvis route (jarvis-routes.ts) uses this bot to CLASSIFY the user's message
  // (which specialist app handles it) and to SYNTHESIZE the specialists' replies into one answer.
  // It never fetches data or shells out — it runs INLINE on the api container (claude-code) like
  // finance-analyst / identity-advisor, and its classify+synthesize cost lands in chat_tasks under
  // this agent_id (the delegated specialists' cost lands under their own ids). See ADR-050.
  // FIRST-CLASS BOT-NODE (2026-06-19): Jarvis runs in its OWN container on the any-bot runtime,
  // NOT inline on the controller. Inline = claude-code one-shot that can't round-trip tool_use, so
  // every authorized tool (career_database, etc.) was a ghost. As a bot-node it executes inside the
  // any-bot wrapper (AgenticController + ToolUseParser) where tools actually run, and the orb surface
  // reaches it via BotNodeClient → http://jarvis-bot:5000/api/swarm-execute. See jarvis-must-be-framework-bot.
  {
    agentId: 'a0000000-0000-0000-0000-000000000050',
    name: 'oshal-assistant',
    port: 3052,
    container: 'jarvis-bot',
    role: 'assistant/unified-front-door',
    capabilities: ['intent-routing', 'cross-app-orchestration', 'answer-synthesis'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    // Jarvis's own brain: jarvis-routes invokes it directly by id (not discovery), so this
    // scoping only keeps it out of catalogs/call-outs — it must never delegate to itself (ADR-087).
    accessRoles: ['operator', 'swarm'],
  },
  // home-bot — Smart-home (home) app worker. Runs on CODEX in its OWN container
  // (oshal-local-home-bot): it shells out to `node /app/scripts/oshal-smartthings.js`
  // to read/command the user's hub and OWNS the per-user store (home-data volume,
  // :rw). It must be a real bot-node endpoint — the surface's fast loop reaches it via
  // BotNodeClient → http://home-bot:5000/api/swarm-execute (NOT inline on the controller,
  // which doesn't serve that route). See home-routes.ts + swarm-apps/home.yaml + ADR-036.
  {
    agentId: 'd0000000-0000-0000-0000-000000000001',
    name: 'home-bot',
    port: 3061,
    container: 'home-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'smart-home/device-control',
    capabilities: ['smart-home-control', 'smartthings', 'device-control', 'scene-execution', 'home-automation'],
    harnessType: 'codex-cli',
    apiType: 'codex-cli',
  },
  // cloud-ops-bot — DevOps/Cloud (GCP) worker. CODEX so it can shell out to
  // scripts/oshal-gcp.js (API-based gcloud replacement) with the user's web-OAuth
  // token. Own container/endpoint — the chat/fast loop reaches it via BotNodeClient →
  // http://cloud-ops-bot:5000/api/swarm-execute. See swarm-apps/cloud.yaml + ADR-042.
  {
    agentId: 'd0000000-0000-0000-0000-000000000002',
    name: 'cloud-ops-bot',
    port: 3067,
    container: 'cloud-ops-bot',
    requiresOwnNode: true,   // ADR-083: owners execute on their OWN node — overrides the legacy prefer-inline codex rule
    role: 'devops/cloud',
    capabilities: ['gcp-inventory', 'gcp-projects', 'gcp-compute', 'gcp-enabled-apis', 'gcp-cost-optimization', 'gcp-health-audit', 'gcp-iam-audit'],
    harnessType: 'codex-cli',
    apiType: 'codex-cli',
  },
  // ── Platform advisory (graph / RCA) ────────────────────────────────────────
  {
    agentId: 'e0000000-0000-0000-0000-000000000001',
    name: 'graph-analyst',
    port: 3051,
    container: 'oshal-local-graph-analyst',
    role: 'localhost/worker',
    capabilities: ['graph-query', 'opensearch-query', 'correlation', 'rca', 'topology', 'impact-analysis'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    agentId: 'e0000000-0000-0000-0000-000000000200',
    name: 'advisor-bot',
    port: 3056,
    container: 'oshal-local-advisor',
    role: 'localhost/platform-advisor',
    capabilities: [
      'oshal-platform-knowledge', 'opensearch-query', 'graph-query',
      'incident-analysis', 'architecture-guidance', 'api-documentation',
      'oshal-integration-knowledge', 'how-to-guidance',
    ],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Research ───────────────────────────────────────────────────────────────
  // Switched to gemini-cli harness as a deliberate harness mix — Gemini's
  // 2.5 Pro / Flash models have strong web-research + long-context behavior
  // useful for the research role. Auth via GEMINI_API_KEY env var (Google
  // AI Studio key) or OAuth session at ~/.gemini/ mounted from host.
  {
    agentId: 'a0000000-0000-0000-0000-00000000000c',
    name: 'research-bot',
    port: 3049,
    container: 'oshal-local-research-bot',
    role: 'localhost/worker',
    capabilities: ['research', 'analysis', 'documentation', 'investigation', 'web-search', 'competitive-analysis'],
    harnessType: 'gemini-cli',
    apiType: 'google-gemini',
  },
  // ── Testing ────────────────────────────────────────────────────────────────
  {
    agentId: 'a0000000-0000-0000-0000-000000000005',
    name: 'test-engineer',
    port: 3048,
    container: 'oshal-local-test-engineer',
    role: 'localhost/worker',
    capabilities: ['testing', 'validation', 'verification', 'test-automation', 'qa', 'acceptance-criteria'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── QA (mandatory swarm participant) ───────────────────────────────────────
  {
    agentId: 'a0000000-0000-0000-0000-00000000000e',
    name: 'tester-bot',
    port: 3050,
    container: 'oshal-local-tester-bot',
    role: 'localhost/worker',
    capabilities: ['testing', 'qa', 'test-standards', 'acceptance-criteria', 'test-automation'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Architecture & Design ─────────────────────────────────────────────────
  {
    agentId: 'a0000000-0000-0000-0000-000000000018',
    name: 'system-architect',
    port: 3047,
    container: 'oshal-local-system-architect',
    role: 'localhost/worker',
    capabilities: ['architecture', 'design', 'system-modeling', 'technical-specification', 'decomposition', 'research', 'analysis'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Incident Remediation ─────────────────────────────────────────
  // Worker for the `incident-remediation` ticket type via
  // swarm-apps/incident-remediation.yaml (ticketType: incident-remediation,
  // pipeline: incident-rca, workerBot: incident-remediation-bot). Also reachable
  // via build-pipeline capability routing (k8s / aws / splunk / servicenow
  // inspection) and by its dedicated container `oshal-local-incident-remediation`
  // for operator-direct dispatch.
  {
    agentId: 'e0000000-0000-0000-0000-000000000100',
    name: 'incident-remediation-bot',
    port: 3054,
    container: 'oshal-local-incident-remediation',
    role: 'incident/remediation-specialist',
    capabilities: ['incident-investigation', 'root-cause-analysis', 'remediation-scripting', 'topology-analysis', 'log-analysis', 'infrastructure-inspection', 'splunk-query', 'servicenow-query', 'kubernetes-inspection', 'aws-inspection'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Queue Bot — quality reviewer for all workflows ────────────────
  {
    agentId: 'f0000000-0000-0000-0000-000000000001',
    name: 'queue-bot',
    port: 3055,
    container: 'oshal-local-queue-bot',
    role: 'queue/quality-reviewer',
    capabilities: ['quality-review', 'deliverable-assessment', 'feedback-generation'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
    accessRoles: ['operator', 'swarm'],   // internal reviewer (ADR-087)
  },
  // ── Backfill 2026-06-20: bots declared in manifests but absent from this registry, surfaced by the
  // boot wiring audit (validate-swarm-wiring). Without an entry BotNodeClient can't resolve them and any
  // execution throws (compiles-but-fails). Definitions copied from the canonical SWARM_BOT_REGISTRY where
  // present; the rest are inline reason+tool bots (oshal-api) like the other ticket-driven analysts.
  // ── Media concierges (REAL bot-nodes — promoted from inline, ADR-083) ──
  {
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
  // ── General fallback owner (ADR-083 §5) ──────────────────────────────────
  {
    // The low-confidence FALLBACK: when no knowledge owner claims a task in the
    // call-out, it lands here — a general, tool-capable doer with the full CLI
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
  // ── Video (inline on the api; drives the vids-operator worker) ──────────────
  // brand-graphics (b00f…0001) was carved to the store 2026-07-17 (ADR-085 Wave 1);
  // its bot registers from the installed package's manifest, not here.
  {
    agentId: 'b00e0000-0000-0000-0000-000000000001',
    name: 'vids-operator',
    port: 3079,
    container: 'oshal-api',
    role: 'media/video',
    capabilities: ['veo-prompt-craft', 'vids-generate', 'vids-operate', 'shot-planning'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── Federal capture (ticket-driven reason bots, inline on the api) ──
  {
    agentId: 'b0000000-0000-0000-0000-000000000040',
    name: 'capture-specialist',
    port: 3010,
    container: 'oshal-api',
    role: 'capture/opportunity-specialist',
    capabilities: ['opportunity-triage', 'pursue-watch-nobid', 'capture-analysis', 'proposal-shaping'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  {
    agentId: 'b0000000-0000-0000-0000-000000000041',
    name: 'capture-coordinator',
    port: 3010,
    container: 'oshal-api',
    role: 'capture/pipeline-coordinator',
    capabilities: ['capture-pipeline', 'opportunity-tracking', 'pursuit-coordination'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── DevOps / Vault (inline; runtime is the build, but it must at least resolve) ──
  {
    agentId: 'a0000000-0000-0000-0000-0000000000d0',
    name: 'vault-bot',
    port: 3010,
    container: 'oshal-api',
    role: 'devops/vault-broker',
    capabilities: ['credential-brokering', 'short-lived-creds', 'privileged-runtime'],
    harnessType: 'claude-code',
    apiType: 'claude-code',
  },
  // ── External A2A (outbound gateway, BACKLOG Plan F item 3) ──────────────────
  // a2a-sample-agent — the EXAMPLE outbound A2A dispatch target. An EXTERNAL agent:
  // execution is an A2A JSON-RPC call (message/send + tasks/get) to the endpoint named by
  // a2aEndpointEnv — the remote owns its own reasoning (two-runtimes rule; in-swarm bots
  // stay on the Redis mesh). INERT until A2A_SAMPLE_AGENT_URL is set (clean factory error →
  // visible fallback). Credential: A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT (or
  // A2A_OUTBOUND_ALLOW_ANON=true for a dev sample). Narrow capabilities keep it out of the
  // call-out; accessRoles keeps it out of Jarvis until proven (ADR-087). Keep IDENTICAL in
  // BOTH registries (docs/building-a-bot.md).
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
  // (Little Monsters education bots removed — carved out to the oshal-applications store package, ADR-085.)
];
