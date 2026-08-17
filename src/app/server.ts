/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — Express server entry point
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added static file serving for UI assets
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed conflicting manual auth routes and consolidated on express-openid-connect
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added /health endpoint for Docker healthcheck (public, no auth)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Deleted src/api/server.js.legacy (unused)
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added mock login/logout routes and user-info endpoint for MOCK_OIDC mode
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Integrated OpenAPI/Swagger docs using swagger-jsdoc and swagger-ui-express
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Registered /api/logs route for debug stream (requiresAuth)
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Registered /api/voice routes for STT/TTS endpoints (requiresAuth)
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Registered Layer 1 Tools Framework routes (tool-routes, agent-tool-routes)
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Registered tool verification routes
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit UI route and static file serving
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Registered RAG routes for ChromaDB integration
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Registered Presentron routes and fixed cockpit auth ordering
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Added chat standalone fallback paths and normalized OSHAL naming in API metadata/log output
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Added legacy /auth/* alias redirects to /login, /logout, and /callback for compatibility with existing UI buttons
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Added OpenAI Codex-aware /auth/callback routing so OAuth callbacks route to /api/openai-codex/oauth/callback while preserving Keycloak callback support
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Added authenticated chat asset serving so standalone chat can load tool-approval modal assets
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Switched /chat route to explicit HTML file reads for deterministic standalone page delivery and error logging
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Limited server startup side effects to direct execution so validation scripts can import createApp safely
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Registered OpenAI Codex OAuth routes and served UI OAuth patch script alongside legacy ui-logic.js
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Added secondary listener on localhost:1455 for OpenAI Codex OAuth callbacks while preserving primary app port
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Added /fonts static route for codicon assets to resolve chat stylesheet MIME errors
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Redirected root and legacy /chat.html to standalone /chat to prevent legacy UI fallback and module script parse errors
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Reordered /chat standalone file resolution to prioritize source-of-truth page assets over stale copied api artifacts
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis-backed schedule runtime wiring and legacy self-scheduling API route registration
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Added Claude Code auth routes and injected Claude Code UI auth patch alongside existing OpenAI Codex patch
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Added OIDC callback state-mismatch recovery to restart login flow instead of surfacing raw bad request errors
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | Registered checkpoint and memory routes plus RAG knowledge-memory recording for non-swarm memory layers
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Registered dedicated agent-profile routes under /api/agents/:agentId/profile
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | Registered generic intake routes under /api/intake/providers/:provider/pull
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | Delegated swarm route registration to extension module
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | Added /shared/ui/css static route to serve design-system CSS for /ui route
 * 34 | maintainer@emeraldcoastsystemsgroup.com   | Fixed error middleware to return JSON instead of falling through to Express default HTML handler
 * 35 | maintainer@emeraldcoastsystemsgroup.com   | Mounted the OSHAL-native task explorer page and API routes for the first engineering-screen migration slice
 * 36 | maintainer@emeraldcoastsystemsgroup.com   | Disabled static directory redirects for /task-explorer so the standalone engineering page resolves without redirect loops
 * 37 | maintainer@emeraldcoastsystemsgroup.com   | Mounted the OSHAL-native config admin engineering page to replace the dead legacy /config route
 * 38 | maintainer@emeraldcoastsystemsgroup.com   | Mounted a dedicated /swarmbot/chat page so cockpit can host a bot-scoped swarm workspace instead of the standalone chat app
 * 39 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed standalone UI surface and cockpit/static route mounting into dedicated helpers so server.ts stays below the governance threshold before engineering-screen retrofit work
 * 40 | maintainer@emeraldcoastsystemsgroup.com   | Extracted scheduler runtime wiring into schedule-runtime.ts so server.ts continues decomposing toward governance compliance
 * 41 | maintainer@emeraldcoastsystemsgroup.com   | Mounted legacy engineering compatibility routes and queue-dashboard replacement page for cockpit Engineering restoration
 * 42 | maintainer@emeraldcoastsystemsgroup.com   | Registered RCA analysis routes under /api/rca for rca-specialist bot
 * 43 | maintainer@emeraldcoastsystemsgroup.com   | Registered section-based presentation generation routes under /api/presentations/sections
 * 44 | maintainer@emeraldcoastsystemsgroup.com   | Promoted queue-manager-admin to native OSHAL page route and removed legacy route ownership overlap
 * 45 | maintainer@emeraldcoastsystemsgroup.com   | Mounted native mesh-dashboard page route so cockpit Engineering loads OSHAL mesh process flow directly
 * 46 | maintainer@emeraldcoastsystemsgroup.com   | Mounted native ops-dashboard page route and removed legacy ops/mesh HTML route overlap
 * 47 | maintainer@emeraldcoastsystemsgroup.com   | Added authenticated /code bridge route so cockpit workspace links redirect to the configured code-server target instead of returning OSHAL 404
 * 48 | maintainer@emeraldcoastsystemsgroup.com   | Hardened the /code bridge to accept both /code and /code/ so older cockpit artifact links and stale server instances fail less often during code-server handoff
 * 49 | maintainer@emeraldcoastsystemsgroup.com   | Mounted native rag-center page route so cockpit Engineering can host live RAG inventory and query tooling
 * 50 | maintainer@emeraldcoastsystemsgroup.com   | Normalized /code bridge folder and file query paths onto the configured shared workspace root so swarm code-server handoff no longer leaks host-local absolute paths
 * 51 | maintainer@emeraldcoastsystemsgroup.com   | Wired the /code bridge workspace-root lookup to persisted global settings so the new cockpit/config-admin field drives runtime behavior without env-only edits
 * 52 | maintainer@emeraldcoastsystemsgroup.com   | Mounted native user-dashboard page route for real-time user ticket visibility
 * 53 | maintainer@emeraldcoastsystemsgroup.com   | Added root-level GET /callback for Claude Code OAuth (Claude only allows localhost:port/callback redirect URIs)
 * 54 | maintainer@emeraldcoastsystemsgroup.com   | Added legacy /api-docs redirect to /docs so stale operator links still resolve after runtime refreshes
 * 55 | maintainer@emeraldcoastsystemsgroup.com   | Fixed Swagger/OpenAPI route discovery so built/containerized runtimes load annotated route operations instead of emitting an empty spec
 * 56 | maintainer@emeraldcoastsystemsgroup.com   | Added callback-port root handling so bot-owned redirect listeners can accept auth callbacks on / without pretending to be a second primary app surface
 * 57 | maintainer@emeraldcoastsystemsgroup.com   | WS1: Registered debug routes — runtime trace analyzer endpoint for per-ticket phase/round observability
 * 58 | maintainer@emeraldcoastsystemsgroup.com   | BF-031: Added process-level crash guards (unhandledRejection, uncaughtException, SIGTERM/SIGINT/exit logging) to prevent silent Node 15+ process death
 * 59 | maintainer@emeraldcoastsystemsgroup.com   | B4/CM-2: Codicon fonts now served from @vscode/codicons npm package instead of legacy any-bot/ui-enhanced path
 * 60 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/ui profile routes so the cockpit ribbon can overlay a packaged app (e.g. Little Monsters) without modifying framework routes
 * 61 | maintainer@emeraldcoastsystemsgroup.com   | ADR 2026-04-20: mounted /api/swarm/apps and auto-load manifests on boot
 * 62 | maintainer@emeraldcoastsystemsgroup.com   | ADR 2026-04-20 Phase 1 close: mounted swarm-app gate middleware so deactivating an app 503s its routes
 * 63 | maintainer@emeraldcoastsystemsgroup.com   | Demo mode: seed LM student/classes/flashcards/assignments at boot + mount /login, /logout, /api/auth/user for MOCK_OIDC deployments
 * 64 | maintainer@emeraldcoastsystemsgroup.com   | Boot uses autoLoadAllWithRetry so transient pg timeouts during cold-start can no longer leave the ribbon registry empty
 * 65 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/career-hunter (requiresAuth) — the Career-Hunter routes existed but were never registered, causing "Cannot GET /api/career-hunter/board"
 * 66 | maintainer@emeraldcoastsystemsgroup.com   | Mounted automatic audit-capture middleware after identity resolution (records every mutating + sensitive /api request to the append-only audit trail).
 * 67 | maintainer@emeraldcoastsystemsgroup.com   | Graceful shutdown: SIGTERM/SIGINT drain shutdown hooks (db pool, queue manager) before exit — the controller previously logged and force-exited without closing anything (2026-07-05 leak audit)
 * 68 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/workflow-studio run-history routes (requiresAuth) — GET /runs + /runs/:runId for the studio Runs panel / run inspector
 * 69 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: (1) nightly oshal-dev docs-quality schedule (workflow:oshal-dev, 04:00, gated on OSHAL_DEV_OWNER_SUB so the ticket owner passes the privileged-dispatch gate); (2) /api/graph mount → serviceSecretOr(requiresAuth) so bot-nodes maintain per-user graphs (codebase index) via the trusted-service headers.
 * 70 | maintainer@emeraldcoastsystemsgroup.com   | Root landing default → /cockpit/ (operator decision 2026-07-07): bare / lands on the authorization-shaped framework ribbon; explicit ?app= URLs stay authoritative; LANDING_PATH still overrides per deployment.
 * 71 | maintainer@emeraldcoastsystemsgroup.com   | /api/security mount is now operator-only (requiresAuth + requiresOperator): Security Center findings map the platform's own weak points (secret locations/previews, ungated routes) and must never be visible to basic users (operator decision 2026-07-07).
 * 72 | maintainer@emeraldcoastsystemsgroup.com   | Mounted the authenticated, owner-scoped Jarvis ambient settings/transcript/review API at /api/jarvis/ambient.
 * 73 | maintainer@emeraldcoastsystemsgroup.com   | Started the local-time ambient daily review scheduler with confirmation-only user-model proposal delivery.
 * 74 | maintainer@emeraldcoastsystemsgroup.com   | Mounted authenticated owner-private speaker profiles and bounded memory-only diarization audio routes ahead of the general Jarvis router.
 * 75 | maintainer@emeraldcoastsystemsgroup.com   | /api/jarvis mount → serviceSecretOr(requiresAuth): the headless swarm CLI (scripts/swarm-cli.js) and internal bots authenticate with X-Service-Secret + x-oshal-user-sub instead of an OIDC session — same trusted-service pattern as the message routes and /api/graph (ADR-081).
 * 76 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 P1: inject ManifestRouteMounterImpl(app, requiresAuth, ctx) into SwarmAppService so an installed app package can dynamically mount its own routes (flag APP_PACKAGE_DYNAMIC_ROUTES, default off → no runtime change).
 * 77 | maintainer@emeraldcoastsystemsgroup.com   | GET /ui-logic.js now concatenates ui-provider-fields.js + ui-provider-models.js ahead of ui-logic.js (catalog data extracted from the over-cap ui-logic.js; src/api has no static mount, so the route is the only delivery path — served script content unchanged).
 * 78 | maintainer@emeraldcoastsystemsgroup.com   | 1000-line cap decomposition: moved the standalone HTML/asset-path helpers to server-ui-assets.ts, the auth-callback/OIDC-recovery/onboarding helpers to server-auth-helpers.ts, and the manifest schedule registrar/deregistrar/per-user reconciler/nightly oshal-dev schedule to swarm-app-schedule-wiring.ts. Pure moves — route registration order, middleware order, and env handling are unchanged.
 * 79 | maintainer@emeraldcoastsystemsgroup.com   | Swarm-app autoload now awaits waitForBootstrapComplete() (bounded 90s) before its first pass — on a clean DB it raced migration 022 (swarm_applications) and logged ~40 self-healing ERROR lines at first boot (BACKLOG "Noisy first-boot logs"). Route mounting is unaffected; the gate only delays the background autoload chain.
 * 80 | maintainer@emeraldcoastsystemsgroup.com   | Personal access tokens: mounted createCliTokenAuthMiddleware right after the TV-token injector (Bearer oshal_pat_… → authenticated req.oidc, so every requiresAuth route accepts a PAT as its owner) and /api/cli-tokens (mint/list/revoke/whoami) behind serviceSecretOr(requiresAuth). Industry-standard CLI auth for swarm-cli login — humans hold revocable per-user tokens, not the machine-wide service secret.
 * 81 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D11: pass SwarmAppService.manifestToolOwner into createToolRoutes as the tool-ownership port, so the runtime tool register/deregister routes 409 instead of clobbering a tool an active app owns.
 * 82 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/budgets (cost-governance spend budgets + spend reads) behind requiresAuth — operators manage any scope, users only their own 'user'-scope cap; enforcement itself runs in the queue manager + inline-execution chokepoints.
 * 83 | maintainer@emeraldcoastsystemsgroup.com   | Mounted the connector write-action tier (POST /api/connectors/:id/actions/:action) inside the CONNECTOR_SPEC_ROUTES gate, right after mountConnectorSpecRoutes and behind the same ADR-067 marketplace provider gate — the write tier is deliberately never on where the read tier is off.
 * 84 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/search (global search over the caller's OWN swarm data: tickets/chat/personal vault/RAG) behind requiresAuth, sharing the /api/rag RagService instance so both surfaces rank and permission-filter identically.
 * 85 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/judge (shared LLM-judge/grading service) behind requiresAuth — grading runs on the quality-judge concierge bot (a0…0053) via the inline-concierge transport so cost lands in chat_tasks under the judge, never an LLM call from controller code.
 * 86 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/batch-jobs behind requiresAuth so operators can view persisted batch Job runtime/CPU telemetry.
 * 87 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/trace (run-trace read-model: one ticket's phases -> bot executions -> per-LLM-call cost waterfall, assembled from already-persisted rows) behind requiresAuth — per-ticket ownership (owner_sub; operator sees any) is enforced inside TraceService, so a ticket a caller can't see returns the same not-found as a missing one (no existence leak).
 * 88 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/persona-evals (persona regression evals — golden-task gate) behind requiresAuth + requiresOperator: kick/poll suite runs on the active provider lane, file-backed results history. Operator-gated because a real-lane run spends LLM tokens and exposes persona internals.
 * 89 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/notify (notification preference center: self-scoped per-topic routing prefs + confirm-gated test send) — the factory applies requiresAuth per-route internally (claude-code-auth-routes pattern), so the mount itself is unwrapped.
 * 90 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/me data-lifecycle routes (per-user export bundle + two-step signed-token delete) behind requiresAuth, next to the other governance registrations — segment-bounded mount so /api/me never shadows /api/memory.
 * 91 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/queue/dlq (queue dead-letter list + operator requeue over oshal_queue_dlq, migration 081) — requiresAuth + requiresOperator inside the factory; the quarantining DeadLetterService instance is wired in the swarm extension, this mount is the list/requeue surface.
 * 92 | maintainer@emeraldcoastsystemsgroup.com   | /api/career-hunter mount → serviceSecretOr(requiresAuth) (the /api/graph + /api/jarvis trusted-service pattern): career-advisor's career_refresh tool triggers the admin scrape+index chain via X-Service-Secret + X-Oshal-User-Sub. All existing career data routes resolve identity via callerSub() (OIDC-only) and 401 service callers; only the new /run/refresh routes honor the trusted sub, re-checked against career-admin.
 * 93 | maintainer@emeraldcoastsystemsgroup.com   | Guests skip the onboarding gate (needsOnboarding → false for guest identities): onboarding configures providers, which the guest Tier-B write block forbids (PUT /api/user/onboarding 403s), and every guest sub is a fresh UUID — without this every "Continue as guest" session bounced to /welcome and could never reach the cockpit the oswarm.ai demo link promises.
 * 94 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/sat (ADR-102 W1): sat-node heartbeat ingest + fleet listing + point/mode command dial, serviceSecretOr(requiresAuth) like /api/drone — nodes authenticate with the service secret, operators with OIDC. Sim-only engines by construction; the approve rail lands with the W3 surface.
 * 95 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/movies: Movies & TV carved to the oshal-applications store (ADR-085 Wave 2 carve #1). The installed package's manifest mounts the same routes (auth: oidc); the movies-concierge bot-node quadruple stays core per ADR-093's interim tier.
 * 96 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/spotify: Spotify carved to the oshal-applications store (ADR-085 Wave 2 carve #2, first packaged service-or-oidc mount). Same disposition as movies — the spotify-concierge bot-node quadruple stays core per ADR-093.
 * 97 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/rides: Rides carved to the oshal-applications store (ADR-085 Wave 2 carve #3). Same disposition — the rides-concierge bot-node quadruple stays core per ADR-093; the packaged route still shells scripts/oshal-uber-rides.js from the image.
 * 98 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/eats: Eats carved to the oshal-applications store (ADR-085 Wave 2 carve #4). Same disposition — the eats-concierge bot-node quadruple stays core per ADR-093; the packaged route still shells scripts/oshal-uber.js from the image.
 * 99 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/purchasing: Purchasing (Shopping) carved to the oshal-applications store (ADR-085 Wave 2 carve #5). Same disposition — the shop-concierge bot-node quadruple stays core per ADR-093; the packaged route still shells scripts/oshal-walmart.js from the image.
 * 100 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/career-hunter + /api/career-hunter/graph: Career Hunter carved to the oshal-applications store (ADR-085 Wave 3 carve #1, the largest — operator-directed after the in-container scrape treadmill blocked every deploy window). The package mounts both routes + starts the cron at mount; the ENGINE CHAIN (python engine, oshal-jobhunter.js, both bot containers/registries/personas, the api-output data volume) stays core per ADR-093 interim. /api/profile-studio (ingest callback) stays — it belongs to the shared profile-studio feature, not the app.
 * 101 | maintainer@emeraldcoastsystemsgroup.com   | Mounted the inbound A2A gateway (BACKLOG Plan F, registerA2aGatewayRoutes next to /api/budgets): GET /.well-known/agent-card.json + POST /api/a2a are hard 404s unless A2A_GATEWAY_ENABLED=true and use A2A-native per-agent Bearer auth (never OIDC — external agents have no browser session); /api/a2a/agents credential management is requiresAuth + operator-only. message/send files a real ticket on the ADR-083 call-out rails under ownerSub 'a2a:<agentId>' — the controller never names a bot and never calls an LLM.
 * 102 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/storage: Storage carved to the oshal-applications store (ADR-085 Wave 2, "skill with a surface" — only the surface carves). The storage-target/storage-browse kernel skill, /api/files (framework Files tile + kernel downloadUrl contract), and the storage-assistant bot node stay core per ADR-093.
 * 103 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/gemini/auth (Plan E residual: gemini connect-state) next to the claude-code/codex auth mounts, factory-applied requiresAuth (claude-code-auth-routes pattern). Status-only by doctrine — the vendor's own CLI login runs host-side; no Google OAuth client/redirect is brokered here.
 * 104 | maintainer@emeraldcoastsystemsgroup.com   | Passed ctx.swarm.workItemRepository into createRemoteClientRoutes so the remoteTaskResult mesh subscriber can land remote-client task results on their originating work items (closes the unconsumed remote-client.task-result loop).
 * 105 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/presentations/sections: AI Office carved to the oshal-applications store (ADR-085 Wave 2, "skill with a surface" — only the surface carves). The deck-generation engine (@/features/presentation-generation, contracted kernel skill), the legacy Presentron proxy at /api/presentations, the storage-target save layer, and the deck-builder bot node stay core per ADR-093.
 * 106 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/home: Smart Home carved to the oshal-applications store (ADR-085 Wave 2). The home-bot node (container + registries + persona + oshal-smartthings.js + toolkit), the home-data volume, the smartthings/google-home connectors, and the scheduler's home-control branch (home-schedule-dispatch — the packaged route reaches it via @/app alias) stay core per ADR-093.
 * 107 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/social: the Social app carved to the oshal-applications store (ADR-085 Wave 2, "skill with a surface"). The communications-bot + social-writer nodes (containers + registries + personas), the inbox-ingest Signals engine (oshal_inbox_messages category=social), the linkedin/twitter/meta-business connectors, and the kernel-resident LinkedIn AI Content Assistant (/api/linkedin-assistant — retains its own no-post gate) stay core per ADR-093.
 * 108 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/feeds + dropped its import: the Feeds app SURFACE carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The feeds-indexing ENGINE (startFeedsIndexingCron + ensureFeedsSchema, retained below), the feeds-curator inline node (both registries), scripts/oshal-feeds.js + 045-feeds-platform.sql, the /feeds framework page (server-ui-assets + the default toolbar tile), and the 'slack' connector stay core per ADR-093.
 * 109 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/identity + dropped its import: the Identity Hub carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The identity-advisor inline node (both registries + persona), the connector hub it views (/api/connect/list + /api/connect/:provider/start + /utilities), connector-tenancy, and inline-bot-execution stay core per ADR-093.
 * 110 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/travel + dropped its import: the Travel surface carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The swarm-shared price ENGINE + fare-watch cron stay core in travel-farewatch (startTravelFareWatchCron retained below; it now ensures the shared travel_* schema at start), with scripts/oshal-duffel.js, the duffel connector + broker, migrations 050/051, and the travel-concierge node per ADR-093.
 * 111 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/camera + dropped its import: Camera Ops carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The camera ENGINE (src/features/camera), the standalone camera-node server, the camera-operator inline node (both registries + persona), and the default Camera Ops tile stay core per ADR-093; the packaged route mounts the same /api/camera (auth: service-or-oidc) so camera nodes keep heartbeating with the service secret.
 * 112 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/drone + dropped its import: Drone Ops carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The drone ENGINE (src/features/drone + its engine specs), the standalone drone-node server + DRONE_EMBEDDED_SIMS, the drone-operator inline node (both registries + persona), the concierge-store 'drone' prefix, and the default Drone Ops tile stay core per ADR-093 (ADR-099: drones ARE swarm nodes); the packaged route mounts the same /api/drone (auth: service-or-oidc) so drone nodes keep heartbeating with the service secret.
 * 113 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/sat + dropped its import: Sat Ops carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The sat ENGINE (src/features/sat-ops + its engine specs incl. the SatFleet liveness case, folded into sat-orbit-w3.spec), the standalone sat-node server, the engine smoke scripts + the scored ADCS evidence campaign (prove-sat-ops-campaign.ts — engine-only), the sat-operator inline node (both registries + persona), and the default Sat Ops tile stay core per ADR-093 (ADR-102: sats ARE swarm nodes); the packaged route mounts the SAME /api/sat (auth: service-or-oidc), so sat nodes keep heartbeating with the service secret and live evidence probes stay valid.
 * 114 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/pumpkin + dropped its import: Pumpkin carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The pumpkin ENGINE (src/features/pumpkin incl. the lazy self-healing ensureSchema), the /pumpkin full-screen projector framework page (server-ui-assets — carved apps keep their framework page mounts), the pumpkin-bot INLINE node ...054 (both registries + persona; rides api rebuilds), migration 084, the voice pipeline, and the default Pumpkin tile stay core per ADR-093; the packaged route mounts the same /api/pumpkin (auth: service-or-oidc) with the PUMPKIN_ALLOWED_SUBS/EMAILS input gate riding in the router.
 * 115 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/video + dropped its import: the Video Studio carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The video-series CONDUCTOR engine stays core per ADR-093 — series-{pipeline,orchestrator,dispatch,drive}.ts, the startSeriesReconciler call (kept, engine cron), the src/features/video-generation slice, migrations 066/067, and the video-director (…048) + screenplay-writer (…052) inline nodes in BOTH registries; the packaged route mounts the same /api/video (auth: oidc) and reaches the conductor via @/ aliases.
 * 116 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/gov-contracting + swapped its import for startGovContractingCron: the gov-contracting app carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The cron ENGINE (daily SAM scan + enqueueDraftsForUser in gov-contracting-cron.ts) stays core per ADR-093 and is now started at boot HERE (feeds precedent — the departing route factory was what started it); the vendored python engine (apps/gov-contracting/engine) + per-user stores (GOVCON_STORE_ROOT), the capture bots (registry + personas), and the govcon default tiles stay core; the packaged route mounts the same /api/gov-contracting (auth: oidc) and reaches the cron via @/ aliases.
 * 117 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/presentations + dropped its createPresentationRoutes import: retired the dead Presentron HTTP sidecar proxy (the presentron:8080 /execute+/health passthrough). The presentron RENDER path already moved to the in-repo deck engine (tool-executor-service handlePresentron → @/features/presentation-generation renderPptx), so the sidecar proxy had no live backend. The in-repo renderer + the presentron tool stay core; the packaged AI Office surface still owns /api/presentations/sections; the separate presentronServiceConfig→presentron-mcp MCP path (cline-runtime-config-sync) is untouched.
 * 118 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/vids + dropped its import: Vids Studio carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The packaged route mounts the same /api/vids with auth: service-or-oidc (the 2026-07-05 security posture preserved — in-container CLI tools authenticate with X-Service-Secret, browsers hit the OIDC wall). Stays core per ADR-093: the SHARED vids-operator remote-client desktop worker (packages/oshal-vids-operator) + BOTH registry entries + the kernel persona, the remote-client mesh it polls, scripts/oshal-vids.js, and migration 059.
 * 119 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/email + dropped the createEmailRoutes import: the Email Summarizer surface (the ADR-037 reference comms app) carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The packaged route mounts the same /api/email (auth: oidc). Stays core per ADR-093: the email-bot container + BOTH registry entries + the kernel persona, the TRIMMED routes/email-routes.ts (sendGmail with the 158fa008 header-injection fence + sendOutlookMail + summarizeGmailMetadata — notify-routes, jarvis-brief-cron, and the career-hunter/presentations store packages import it there), the gmail/outlook/twilio connectors + CLIs, the inbox-ingest Signals engine, the jarvis email delegate row, and the default email tiles.
 * 120 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/kalshi + dropped its import: Kalshi Prediction Markets carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The packaged route mounts the same /api/kalshi (auth: service-or-oidc) with the ADR-094 confirm/fail-closed order posture byte-identical (live gate off the DETECTED exchange, never a client flag, unless KALSHI_LIVE_ENABLED; every order/refusal audited to kalshi_orders). Stays core per ADR-093: the prediction-markets ENGINE (src/features/prediction-markets — connector-account-lookup real-imports probeKalshiAccount, D8-verified not orphaned), the kalshi connector + OSHAL_CRED_KALSHI broker key, the oshal-kalshi-* calibration/forward-test CLIs + config-seed/kalshi-calibration.json, migrations 074/075, and the tool-kalshi-home default tile.
 * 121 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/world + dropped its require: World Intelligence carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The packaged route mounts the same /api/world with auth: public — the EXACT kernel posture (machine-fed: WORLD_INGEST_TOKEN fail-closed writes, open shared-feed reads, ENABLE_WORLD_INTELLIGENCE 503 gate — all inside the router). Stays core per ADR-093: the Layer-B ENGINE (src/features/world-data incl. WORLD_APP_HTML — D8-verified NOT orphaned: jarvis-brief-sections + the trading assess/research/schedule dispatchers + strategy-lab-sim + world-schedule-dispatch real-import it), world-schedule-dispatch + its schedule-runtime branch, scripts/oshal-world.js, the world-analyst registry entry + ai-lab personas, the WORLD_INGEST_TOKEN compose env, and the tool-world-dashboard default tile.
 * 122 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted the FOUR trading surfaces (/api/trading/autopilot, /api/trading/lab, /api/trading-charts, /api/trading) + dropped their imports: the trading SURFACE carved to the oshal-applications store (ADR-085 Wave 3, "skill with a surface" — the last Wave-G carve, unblocked by the 72dcd734 engine extraction). The packaged routes mount the SAME paths with the SAME postures (ADR-085 D2): service-or-oidc for autopilot/lab/trading, public/self-guarded for trading-charts (chart lib open, /bars callerSub 401). The kernel-side ORDER PATH does not change: src/app/trading-engine.ts (placeDecisionOrder with the env-level live_blocked gate — TRADING_LIVE_ENABLED + explicit confirm), trading-schema.ts, all 8 dispatch/reconcile loops (the autopilot), the strategy-lab sim/ops/store + config-overrides + strategy-params + the equity/rotation/peaks stores, routes/trading-routes-helpers.ts (global-search + the engine import it), src/features/trading, the trading-bot + weather-bot containers + registries + personas, migrations 034/035/072, and every TRADING_* env/schedule pin stay core per ADR-093. The packaged surface reaches the engine back via @/ aliases (D8-verified NOT orphaned).
 * 123 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/spaces (requiresAuth) — ADR-111 Phase 1 Spaces app: upload a walkthrough video -> a 3D gaussian-splat reconstruction walked in the browser. The multipart upload carries its own multer parser, so no global-JSON-parser skip is added. Built in-repo first (ADR-099 sequencing); carves to the store later.
 * 124 | maintainer@emeraldcoastsystemsgroup.com   | Preserved exact signed bytes for connector webhooks by reserving /api/hooks for its route-local JSON verifier
 * 125 | maintainer@emeraldcoastsystemsgroup.com   | Served immutable /dist browser bundles as public static assets before OIDC, matching shared UI CSS/JS, so guest surfaces can load response-renderer.js without requiresAuth running before req.oidc exists.
 * 126 | maintainer@emeraldcoastsystemsgroup.com   | Remounted /api/camera with serviceSecretOr(requiresAuth) because the carved Camera Ops package route was absent, hiding real camera-node integration behind the embedded mock camera.
 * 127 | maintainer@emeraldcoastsystemsgroup.com   | Re-carved Camera Ops to the oshal-applications store: unmounted /api/camera + dropped the createCameraRoutes import. The packaged surface now carries the browser-webcam device path, so core no longer needs the route/surface; the camera ENGINE (src/features/camera) stays core per ADR-093 and the package imports it.
 * 128 | maintainer@emeraldcoastsystemsgroup.com   | Unmounted /api/spaces + dropped the createSpacesRoutes import: the Spaces SURFACE carved to the oshal-applications store (ADR-085, "skill with a surface"). The packaged route mounts the same /api/spaces (auth: oidc) from deployed-apps/spaces, incl. the /pair phone-pairing endpoint. Stays core per ADR-093: the reconstruction ENGINE + owner-scoped scan store (src/features/spatial-mapping — the pinned 'spatial-mapping' kernel skill), the spaces-operator inline concierge + BOTH registry entries, the GPU recon box (RECON_URL), and insertCliToken (@/app/routes/cli-token-routes, which the package imports). The historical core surface copies and binds were removed in SEQ 156.
 * 129 | maintainer@emeraldcoastsystemsgroup.com   | Carry validated packaged-bot harness/API selections into dynamic inline registry entries instead of forcing Claude Code.
 * 130 | maintainer@emeraldcoastsystemsgroup.com   | JSON 404 catch-all for unknown /api/* paths: unmatched API routes previously fell through to Express's default HTML "<!DOCTYPE" 404 page, which cockpit fetch handlers surfaced to the operator as `SyntaxError: Unexpected token '<'` (seen on the super-admin dev-console pane whenever a conditionally-mounted route was absent). Registered as the last /api middleware so all static mounts and the dynamic app-package dispatcher keep precedence. Guard: tests/api-json-404.spec.ts.
 * 131 | maintainer@emeraldcoastsystemsgroup.com   | Boot-window 503 for the /api fallback: the server listens BEFORE swarmAppService.autoLoadAllWithRetry() mounts store-package routes, so a cockpit surface loading mid-boot (live repro: /api/sat/app requested at 06:31:43Z, sat-ops route mounted 06:31:48Z) got a hard JSON 404 and sat on it until a manual reload. The final /api middleware is now createApiFallbackHandler(routes/api-fallback): 503 + Retry-After until auto-load settles (self-refreshing HTML splash for iframe navigations, JSON for fetch), then the exact prior JSON 404. Guards: tests/unit/api-fallback.spec.ts + tests/api-json-404.spec.ts.
 * 132 | maintainer@emeraldcoastsystemsgroup.com   | Security Center route audit gains the active-manifest route inventory: createSecurityRoutes now receives a getter flattening swarmAppService.getActiveManifests() routes[] so the auditor sees dynamically-mounted package routes (ADR-085 carves made the server.ts-only scan package-blind). Guard: tests/unit/route-audit.spec.ts.
 * 133 | maintainer@emeraldcoastsystemsgroup.com   | Update-check daemon wired: registerUpdateRoutes (public GET /api/version — the platform's first runtime self-identity — + auth-gated GET /api/updates) and startUpdateCheckCron (daily deployed-apps-vs-store + running-commit-vs-upstream check; detection only, UPDATE_CHECK_ENABLED=0 disables). Guard: tests/unit/update-check.spec.ts.
 * 134 | maintainer@emeraldcoastsystemsgroup.com   | Update-check completion: registerUpdateRoutes now receives swarmAppService.loadApp so the operator-gated POST /api/updates/apps/:name/apply can hot-reload a re-installed package (installer runs with repo/ref from the INSTALLED manifest, never the caller); new-update transitions notify the operator via the notification center.
 * 135 | maintainer@emeraldcoastsystemsgroup.com   | Registered app.get('/login', loginHandler) after the global authMiddleware: the stock express-openid-connect login route is disabled (routes.login=false in @/shared/middleware/oidc) because it hardcoded returnTo=baseURL — every login-restart path (callback retry, state-mismatch recovery, cockpit 401 guard) forgot the original URL, so /cockpit/?app=<name> deep links landed on the bare cockpit after recovery. Guards: tests/login-returnto.spec.ts + tests/unit/login-returnto.spec.ts.
 * 136 | maintainer@emeraldcoastsystemsgroup.com   | Root landing resolves HOST_APP_MAP (new host-app-map.ts) before falling back to LANDING_PATH, so a themed app subdomain (dnd.oshal.ai, trading.oshal.ai, littlemonsters.oshal.ai, ...) lands straight on its app instead of the generic ribbon. Unset = unchanged prior behavior. Guard: tests/unit/host-app-map.spec.ts.
 * 137 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS G3 + G9: needsOnboarding now delegates to the pure onboardingRequired predicate (new onboarding-gate.ts) — DISABLE_ONBOARDING_GATE only suppresses the per-user wizard and can no longer waive the "a model must be connected" requirement; a deliberately model-less box declares OSHAL_NO_AI=true instead (a warn log names the exact fix when the gate fires despite the flag). Registered registerReadinessRoutes (new routes/readiness-routes.ts): GET /api/readiness reports per-capability ok|off|fail because /api/health is liveness-only and was being read as readiness. Guards: tests/unit/onboarding-gate.spec.ts + tests/unit/readiness-report.spec.ts.
 * 138 | maintainer@emeraldcoastsystemsgroup.com   | Comment-only: retired the stale '/api/remote-clients hardening TODO = per-caller rate limiting' note - the limiter SHIPPED router-local in remote-client-routes.ts (seq 11: flag-gated OSHAL_RATE_LIMIT_REMOTE_CLIENTS, keyed per /:clientId, guard tests/unit/remote-client-auth.spec.ts), so the TODO was sending the next security wave to re-do finished work. No logic change.
 * 139 | maintainer@emeraldcoastsystemsgroup.com   | WEB HARDENING CLOSE-OUT (docs/security/SECURITY-HARDENING.md §4 - a tested CSP, an explicit express.json limit, per-route throttles). (1) CSP: cspFromEnv now DEFAULTS to the strict policy in non-blocking report-only mode instead of no header at all, so every response carries a policy and the collector below learns the real allowlist; enforcement stays OSHAL_STRICT_CSP=on, OSHAL_CSP=off is the kill switch. (2) The violation collector dedupes by directive|blockedUri|documentUri (shouldLogCspReport) - report-only on a cockpit full of inline scripts would otherwise log the same finding on every page load from every browser. (3) The global JSON parser moves to createGlobalJsonParser: the same 100kb bound and the same three reserved prefixes, now explicit, env-tunable (OSHAL_JSON_BODY_LIMIT) and unit-testable. (4) expensiveOpLimiter also mounts on /api/jarvis (the LLM cost surface named in the backlog) alongside /api/intake. Guard: tests/unit/web-hardening-csp-body.spec.ts.
 * 140 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 FR-E2): the /api/alerts mount now wires the pool-backed RcaSpendReader (routes/alertmanager-rca-spend.ts) into the intake's analyst budget gate — cost-ledger actuals meter auto-flow RCA dispatch; a pool-less run passes null and the gate is an explicit pass-through.
 * 141 | maintainer@emeraldcoastsystemsgroup.com   | Jarvis UX trio wiring: /api/voice now receives ctx (JVV-012 per-user TTS prefs endpoints + prefs-honoring synthesize), and /api/connect gains the liveness router (INSTALLER-GAPS G14 — the Connections badge live token check) on the same auth-gated mount.
 * 142 | maintainer@emeraldcoastsystemsgroup.com   | Global search grew the app/bot/connector result kinds: createGlobalSearchRoutes now receives swarmAppService.listApps as an injected, deliberately UNFILTERED lister (the features slice cannot reach the service, and AppsSearchSource owns the tested caller-visibility rule - pre-filtering here would make two filters where only one can be audited).
 * 143 | maintainer@emeraldcoastsystemsgroup.com   | Added GET /metrics (Prometheus text exposition, @/shared/observability), mounted with /health above the OIDC middleware. The oshal-api-health scrape target pointed at /api/health, which returns JSON — Prometheus cannot parse it, so the scrape FAILED every cycle, `up` was pinned to 0 and SwarmApiUnreachable fired forever on a healthy box (found in the 2026-08-01 live drill). A real exposition makes that target's `up` mean what the rule claims it means, and gives the container-health rules series the swarm itself guarantees.
 * 144 | maintainer@emeraldcoastsystemsgroup.com   | Operations Stream wiring: the Alertmanager webhook now receives the pool, so a delivery is LANDED durably before anything reads it and the route answers 202 after the commit (503 when landing fails, so the sender retries rather than losing the alert); a pool-less run keeps the previous in-memory path byte-for-byte. Mounted /api/ops/alert-pipeline (reads authenticated, every mutating route carrying requiresOperator on the route itself so a re-mount cannot widen it) and the two authenticated surfaces the intelligent-processing manifest registers as ribbon tools: /system-health (read-only) and /alert-pipeline-admin (operator-gated by its backing routes, rendering an honest operator-only panel on 403).
 * 145 | maintainer@emeraldcoastsystemsgroup.com   | Mounted /api/harvest (routes/harvest-routes.ts) — the harvest console's catalogue + closed-loop simulate call over the marine and ground slices. requiresAuth is passed into the factory (the budget-routes/trace-routes idiom) so the guard rides each route and a re-mount cannot widen it. Auth here is a CPU control, not a privacy one: simulateEnergyBudget integrates ceil(durationHours*3600/stepSeconds) steps SYNCHRONOUSLY on this process, so an anonymous unbounded run would wedge the controller's only thread — the route additionally caps integration steps and retained samples, not just the individual fields. Guard: tests/unit/harvest-routes.spec.ts.
 * 146 | maintainer@emeraldcoastsystemsgroup.com   | Carved /api/harvest and the marine + ground energy
 *                     |                             | slices OUT to the oshal-applications store repo (ADR-085,
 *                     |                             | Rule 0c). They were domain application code living in the
 *                     |                             | kernel: a tidal-site model and a soil-thermal model serve a
 *                     |                             | user doing a job — they are not swarm platform. @/shared/energy
 *                     |                             | went with them: after the carve NOTHING in core imported it but
 *                     |                             | its own barrel, so keeping it would have left an orphaned module
 *                     |                             | on a laptop-hosted control plane. Promote it back if a second
 *                     |                             | real consumer ever appears.
 * 147 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the verified principal issuer in AsyncLocalStorage so Ed25519 HTTP delegation binds the caller's full identity namespace instead of guessing from a potentially colliding subject string.
 * 148 | maintainer@emeraldcoastsystemsgroup.com   | Wire remote-client task settlement to atomic outboxId cost receipts so journal replay cannot double bill after a partial downstream failure.
 * 149 | maintainer@emeraldcoastsystemsgroup.com   | Supply the work-item repository to strict remote-task settlement publication so journal delivery waits for durable landing before compatibility mesh notification.
 * 150 | maintainer@emeraldcoastsystemsgroup.com   | Document Profile Studio's anonymous mount as one-use capability authenticated; the reusable service-secret callback contract was removed.
 * 151 | maintainer@emeraldcoastsystemsgroup.com   | Document SEC-01 immediate containment at the graph and Jarvis mounts: browser/PAT reads remain available while machine-only fleet-secret reads fail closed pending scoped delegation.
 * 152 | maintainer@emeraldcoastsystemsgroup.com   | Mount the durable SEC-01 legacy-shadow-enforce delegation gate on every user-scoped Graph and Jarvis route while retaining ordinary browser/PAT authentication.
 * 153 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: wire one PostgreSQL app-access service into dynamic package-route enforcement and the framework-owned operator assignment API.
 * 154 | maintainer@emeraldcoastsystemsgroup.com   | CORE-05: mount canonical package-smoke and bounded PAT live verification ahead of package-owned route dispatch.
 * 155 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile CSP inline documentation with the mounted default report-only policy; enforcement remains OSHAL_STRICT_CSP=on and OSHAL_CSP=off remains the explicit kill switch.
 * 156 | maintainer@emeraldcoastsystemsgroup.com   | Complete the Spaces carve cleanup by retiring the three unrouted core HTML copies and their local Compose bind mounts; installed package surfaces remain authoritative.
 * 157 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile ADR-067 connector-route documentation with the lazy marketplace gate: boot mounts two stable parameterized delegates, while deployment and caller enablement are checked on every request before a provider spec is loaded.
 * 158 | maintainer@emeraldcoastsystemsgroup.com   | Wire one lifecycle-scoped package Takeout registry into app activation and the generic authenticated archive route.
 * 159 | maintainer@emeraldcoastsystemsgroup.com   | Wire one confined deterministic package-schedule registry into the shared scheduler and manifest activation lifecycle.
 * 160 | maintainer@emeraldcoastsystemsgroup.com   | Multi-provider login (ADR-126): registered /login/:provider next to /login (same loginHandler — it dispatches by path/provider), and made the callback state-mismatch recovery provider-aware via loginRestartPathForCallbackPath so a failed /callback/microsoft restarts the Microsoft flow instead of the generic /login.
 */

require('dotenv').config();
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { serviceSecretOr, getCaller, isOperator, requiresOperator, hasValidServiceSecret } from '@/shared/middleware/authz';
import { runShutdownHooks } from '@/shared/services/shutdown-hooks';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import path from 'path';
import cookieParser from 'cookie-parser';
import { createChildLogger } from '@/shared/logger';
import { registerCodeServerBridgeRoutes, buildCodeServerRedirectUrl } from './routes/code-server-bridge-routes';
import { registerDebugRoutes } from './routes/debug-routes';
import { createAppContext } from './composition-root';
import { resolveHostLandingPath } from './host-app-map';
import { 
  createTaskRoutes, 
  createMessageRoutes, 
  createStreamRoutes, 
  createVoiceRoutes,
  createVisionRoutes,
  createToolRoutes,
  createInternalToolBridgeRoutes,
  createAgentProfileRoutes,
  createAgentToolRoutes,
  createRcaRoutes,
  createAgentStatusRoutes,
  createProcessLabRoutes,
  createWorkflowStudioRoutes,
  createWorkflowStudioAssistRoutes,
  createWorkflowRunRoutes,
  createBatchJobTelemetryRoutes,
  createOpenAiCodexOAuthRoutes,
  createClaudeCodeAuthRoutes,
  createGeminiAuthRoutes,
  createFacebookAuthRoutes,
  createUiProfileRoutes,
  createSwarmAppRoutes,
  createPackagedThemeCssFallback,
  createSwarmPackRoutes,
  createDemoAuthRoutes,
  createScheduleRoutes,
  createRemoteClientRoutes,
  createCheckpointRoutes,
  createTokenChaseRoutes,
  createOptimizeRoutes,
  createMemoryRoutes,
  createHelpRoutes,
  createCockpitRoutes,
  createTaskExplorerRoutes,
  registerCockpitStaticRoutes,
  registerUiSurfaceRoutes,
  registerLegacyEngineeringCompatRoutes,
  createAmbientListeningRoutes,
  createAmbientSpeakerRoutes,
} from './routes';
import { createVerificationRoutes } from './routes/verification-routes';
import { createInstallVerificationRoutes } from './routes/install-verification-routes';
// Manual auth routes removed — express-openid-connect handles /login, /callback, /logout
import { createConfigRoutes } from './routes/config-routes';
import { createProviderRoutes, listConfiguredProviders } from './routes/provider-routes';
import { onboardingRequired } from './onboarding-gate';
import { registerReadinessRoutes } from './routes/readiness-routes';
import { createConnectorsRoutes, createFacebookDataDeletionRoute } from './routes/connectors-routes';
import { createConnectorLivenessRoutes } from './routes/connector-liveness';
import { createByoLlmRoutes } from './routes/byo-llm-routes';
import { createFreeTierRoutes } from './routes/free-tier-routes';
import { createLlmPreferenceRoutes } from './routes/llm-preference-routes';
import { createTvPairingRoutes, createTvTokenAuthMiddleware } from './routes/tv-pairing-routes';
import { createCliTokenAuthMiddleware, createCliTokenRoutes } from './routes/cli-token-routes';
import { createLocalAuthRoutes, isLocalAuthEnabled } from './routes/local-auth-routes';
import { createApplicationAuthMiddlewareSet } from './middleware/application-auth';
import { createBudgetRoutes } from './routes/budget-routes';
import { registerA2aGatewayRoutes } from './routes/a2a-routes';
import { createTraceRoutes } from './routes/trace-routes';
import { createQueueDlqRoutes } from './routes/queue-dlq-routes';
import { createJarvisVoiceRoutes } from './routes/jarvis-voice-routes';
import { createTenantRoutes } from './routes/tenant-routes';
import { createNotifyRoutes } from './routes/notify-routes';
import { createPersonModelRoutes } from './routes/person-model-routes';
import { ensurePersonModelSchema } from '@/features/person-model';
import { startAmbientEnrichmentRuntime, startPersonModelMaintenanceRuntime } from './ambient-enrichment-runtime';
import { createApplyOperatorRoutes } from './routes/apply-operator-routes';
import { createApplyIngestRoutes } from './routes/apply-ingest-routes';
import { startApplyReaper, rehydrateApplyInFlight } from './apply-enqueue';
import { createProfileStudioIngestRoutes } from './routes/profile-studio-ingest-routes';
import { startGovContractingCron } from './routes/gov-contracting-cron';
import { registerUpdateRoutes, startUpdateCheckCron } from './routes/update-check-cron';
import { createSlackRoutes } from './routes/slack-routes';
import { startFeedsIndexingCron } from './routes/feeds-indexing';
import { createJudgeRoutes } from './routes/judge-routes';
import { createConnectorMarketplaceRoutes } from './routes/connector-marketplace-routes';
import { mountConnectorSpecRoutes } from './routes/connector-spec-routes';
import { mountConnectorActionRoutes } from './routes/connector-action-routes';
import { connectorWebhookIngressEnabled, mountConnectorWebhookRoutes } from './routes/connector-webhook-routes';
import { createGraphRoutes as createPersonalGraphRoutes } from './routes/personal-graph-routes';
import { createPersonalGraphIngestRoutes } from './routes/personal-graph-ingest-routes';
import { InMemoryGraphStore } from '@/features/personal-graph';
import { startTravelFareWatchCron } from './routes/travel-farewatch';
import { createTestLabRoutes } from './routes/test-lab-routes';
import { createTestLabGoldenRoutes } from './routes/test-lab-golden';
import { createPersonaEvalRoutes } from './routes/persona-eval-routes';
import { registerEvalWallRoutes } from './routes/eval-wall-routes';
import { createDevopsRoutes } from './routes/devops-routes';
import { createForgeRoutes } from './routes/forge-routes';
import { createFilesRoutes } from './routes/files-routes';
import { createGraphRoutes } from './routes/graph-routes';
import { startInboxIngestCron } from './routes/inbox-ingest';
import { createContentRoutes } from './routes/content-routes';
import { createLinkedInAssistantRoutes } from './routes/linkedin-assistant-routes';
// (trading route imports removed: the trading SURFACE carved to the oshal-applications store,
//  ADR-085 Wave 3 — the ENGINE stays kernel in app/trading-{engine,schema}.ts + the dispatch loops.)
import { createSecurityRoutes } from './routes/security-routes';
import { createJoinRoutes } from './routes/join-routes';
import { createJarvisRoutes } from './routes/jarvis-routes';
import { createJarvisBriefRoutes } from './routes/jarvis-brief-routes';
import { createChatChannelRoutes } from './routes/chat-channel-routes';
import { createUserModelRoutes } from './routes/user-model-routes';
import { createDevConsoleRoutes } from './routes/dev-console-routes';
import { superAdminEnabled } from '@/shared/middleware/superadmin';
import { createTakeoutRoutes } from './routes/takeout-routes';
import { createLogsRoutes } from './routes/logs-routes';
import { createAuditCaptureMiddleware, requireAdminConsoleAccess } from '@/features/governance';
import { createGuestSessionInjector, isGuestRequest } from '@/shared/middleware/guest-session';
import { createGuestGuard } from '@/shared/middleware/guest-guard';
import { guestCapabilities } from '@/shared/middleware/guest-capability-matrix';
import { createGuestRoutes } from './routes/guest-routes';
import { createRagRoutes } from './routes/rag-routes';
import { createGlobalSearchRoutes } from './routes/global-search-routes';
import { RagService } from '@/features/rag';
import { UIProfileService } from '@/features/ui-profile';
import { AppAccessService, SwarmAppService, SwarmAppRepository } from '@/features/swarm-apps';
// Manifest schedule registrar/deregistrar + per-user reconciler + nightly oshal-dev schedule —
// extracted verbatim to swarm-app-schedule-wiring.ts (1000-line cap decomposition).
import { createManifestScheduleRegistrar, createManifestScheduleDeregistrar, registerPerUserScheduleReconciler, registerNightlyDevDocsSchedule } from './swarm-app-schedule-wiring';
// Standalone HTML serving + UI asset/page-dir resolution helpers — extracted verbatim to
// server-ui-assets.ts; auth-callback/OIDC-recovery/onboarding helpers to server-auth-helpers.ts.
import { resolveExistingPath, sendHtmlResponse, readOptionalTextFile, resolveUiAssetPaths, resolveUiSurfacePages } from './server-ui-assets';
import { DEFAULT_OPENAI_CODEX_CALLBACK_PORT, redirectLegacyAuthRoute, extractQueryString, isLikelyOpenAiCodexCallback, resolveConfiguredOpenAiCodexCallbackPort, isOpenAiCodexCallbackPortRequest, hasAuthCallbackQuery, isOidcStateMismatchError, buildOidcLoginRestartPath, loginRestartPathForCallbackPath, isOnboardingCompleted } from './server-auth-helpers';
import { auditSwarmBotWiring } from '@/app/extensions/swarm/validate-swarm-wiring';
import { registerAppBots, unregisterAppBots } from '@/app/extensions/swarm/swarm-bot-registry';
import { manifestBotDefinition } from '@/app/extensions/swarm/manifest-bot-definition';
import { seedPersonaAuthorizations } from '@/features/tool-switch';
import { AgentProfileRepository } from '@/entities/agent';
import { createSwarmAppGateMiddleware } from './middleware/swarm-app-gate-middleware';
import { ManifestRouteMounterImpl } from './composition/manifest-route-mounter';
import { TakeoutSliceRegistry } from './takeout-slice-registry';
import { ManifestServiceRouteScheduleRegistry } from './manifest-service-route-schedule';
import { waitForBootstrapComplete } from './composition';
import { seedDemoData, shouldSeedDemoData } from '@/features/demo-mode';
import { createScheduleController } from './schedule-runtime';
import { registerSwarmExtensionRoutes } from '@/app/extensions';
import { startSeriesReconciler } from '@/app/series-orchestrator';
import { startVideoPump } from '@/app/series-pump';
import { startAmbientReviewRuntime } from './ambient-review-runtime';
import { createTicketRoutes } from './routes/ticket-routes';
import { createWorkspaceRoutes } from './routes/workspace-routes';
import { registerFastIntakeRoutes } from './routes/fast-intake-routes';
// Governance activation (Phase 0): mount the weak-spot-hardening scaffolding that
// shipped additive/off-by-default. These surfaces are read-only and gated by
// requiresAuth; rbacMiddleware inside them is a no-op until OSHAL_RBAC_ENFORCE=true.
import { registerAuditExportRoutes } from './routes/audit-export-routes';
import { registerDataLifecycleRoutes } from './routes/data-lifecycle-routes';
import { createPrivacyRoutes } from './routes/privacy-routes';
// registerEvalWallRoutes already imported above (line ~146).
import { registerLlmGovernanceRoutes } from './routes/llm-governance-routes';
// Trust hardening (additive): rate-limit presets. No-ops unless their env flags are on.
// internalMeshLimiter closes the no-XFF gap; expensiveOpLimiter caps intake/LLM per-IP.
// Strict CSP (staged): cspFromEnv() returns the non-blocking report-only policy by default and
// reports to /api/security/csp-report. OSHAL_STRICT_CSP=on enforces; OSHAL_CSP=off disables.
import {
  internalMeshLimiter,
  expensiveOpLimiter,
  shouldSkipGlobalRateLimit,
  cspFromEnv,
  cspMode,
  createGlobalJsonParser,
  createWorkloadDelegationMiddleware,
  shouldLogCspReport,
} from '@/features/security';
// RLS request-identity binding for the GUC-aware pool wrapper (canonical RLS path).
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
// Prometheus exposition for the swarm's own container-health rules (ADR-119).
import { PROMETHEUS_CONTENT_TYPE, renderRuntimeMetrics } from '@/shared/observability';
import { gucEnabled } from '@/shared/services/database/guc-pool';

// OpenAPI/Swagger imports
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const logger = createChildLogger({ module: 'server' });

/**
 * @description Default server port. Can be overridden via PORT env var.
 */
const DEFAULT_PORT = 3456;

// OpenAPI/Swagger configuration
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'OSHAL Control Plane API',
    version: '1.0.0',
    description: 'OpenAPI documentation for the OSHAL control plane API.',
  },
  servers: [
    {
      url: 'http://localhost:3456',
      description: 'Local development server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  security: [{ bearerAuth: [] }],
};

const swaggerOptions = {
  swaggerDefinition,
  apis: [
    path.resolve(process.cwd(), 'src/app/routes/*.ts'),
    path.resolve(process.cwd(), 'src/app/routes/**/*.ts'),
    path.resolve(process.cwd(), 'dist/app/routes/*.js'),
    path.resolve(process.cwd(), 'dist/app/routes/**/*.js'),
    path.resolve(__dirname, './routes/*.ts'),
    path.resolve(__dirname, './routes/**/*.ts'),
    path.resolve(__dirname, './routes/*.js'),
    path.resolve(__dirname, './routes/**/*.js'),
  ],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

/* Standalone HTML/file helpers (resolveExistingPath, sendHtmlResponse, readOptionalTextFile) live
 * in ./server-ui-assets; auth-callback + OIDC-recovery + onboarding helpers live in
 * ./server-auth-helpers (1000-line cap decomposition — verbatim moves). */

/**
 * @description Creates and configures the Express application with all routes.
 * @returns Configured Express app instance
 */
function createApp(): express.Application {
  const app = express();
  // Behind the Cloudflare tunnel (cloudflared forwards over http with
  // X-Forwarded-Proto: https), trust the proxy so req.secure/req.protocol reflect
  // the real https origin. Without this, express-openid-connect mis-sets the session
  // cookie's Secure flag and the cookie doesn't persist → intermittent login loop.
  // Harmless for direct localhost access (no X-Forwarded-* headers present).
  app.set('trust proxy', true);

  // ── Security headers ──────────────────────────────────────────────────────
  // helmet sets X-Content-Type-Options, frameguard, Referrer-Policy, HSTS, etc.
  // CSP: the strict policy ships in NON-BLOCKING report-only mode by DEFAULT (the cockpit
  // still uses inline <script>, and report-only cannot break a surface — it only reports what
  // would have been refused, to the collector below). OSHAL_STRICT_CSP=on enforces once the
  // inline scripts are nonced/externalised; OSHAL_CSP=off restores no-header-at-all. The
  // posture is logged at boot so an audit never has to infer it.
  app.use(helmet({ contentSecurityPolicy: cspFromEnv() }));
  logger.info({ cspMode: cspMode() }, 'Content-Security-Policy posture');

  // ── Rate limiting (public origin only) ────────────────────────────────────
  // Backstops brute-force / cost-abuse on internet traffic (which arrives through
  // cloudflared with an X-Forwarded-For header). Internal/localhost traffic — health
  // checks, bot/mesh calls, same-host requests — has no XFF and is skipped, so the
  // limiter never throttles the swarm itself. Generous cap for normal cockpit + SSE use.
  app.use(rateLimit({
    windowMs: 60_000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    skip: shouldSkipGlobalRateLimit,
  }));

  // Internal-mesh backstop (closes the no-XFF gap the global limiter skips). No-op
  // unless OSHAL_RATE_LIMIT_INTERNAL=on; cap is generous (5000/min/IP) so it only
  // catches a runaway internal caller, never normal swarm chatter. Tune via
  // OSHAL_RATE_LIMIT_INTERNAL_MAX / _WINDOW_MS.
  app.use(internalMeshLimiter);

  const ctx = createAppContext();
  const manifestServiceScheduleRegistry = new ManifestServiceRouteScheduleRegistry(ctx);
  const scheduleController = createScheduleController(ctx, manifestServiceScheduleRegistry);

  // Onboarding gate predicate, shared by the root redirect and the surface guards below.
  // Decision logic lives in the pure onboardingRequired (onboarding-gate.ts) — the
  // INSTALLER-GAPS G3 rule: DISABLE_ONBOARDING_GATE suppresses only the per-user wizard;
  // the "a model must be connected" requirement is waivable ONLY by OSHAL_NO_AI=true.
  // Fail-open on any error so the gate can never trap a user out of the app.
  const needsOnboarding = async (req: express.Request): Promise<boolean> => {
    try {
      const disableGateFlag = process.env.DISABLE_ONBOARDING_GATE === 'true';
      const noAiDeclared = process.env.OSHAL_NO_AI === 'true';
      const activeProvider = listConfiguredProviders().activeProvider;
      const hasActiveProvider = !!activeProvider && activeProvider !== 'noop';
      // Per-user seen-once state is only consulted when it can change the outcome
      // (provider active, wizard not suppressed) — keeps the flag path db-free.
      let onboardingCompleted: boolean | null = null;
      const userId = (req as any).oidc?.user?.sub;
      if (userId && hasActiveProvider && !disableGateFlag && !noAiDeclared) {
        onboardingCompleted = await isOnboardingCompleted(ctx.pool, userId);
      }
      const required = onboardingRequired({
        disableGateFlag,
        noAiDeclared,
        // Guests never onboard: onboarding exists to configure providers, which the guest
        // capability tier can't write (PUT /api/user/onboarding is Tier-B blocked), and every
        // guest sub is a fresh UUID — the gate would bounce every guest to /welcome forever.
        isGuest: isGuestRequest(req),
        hasActiveProvider,
        onboardingCompleted,
      });
      if (required && disableGateFlag) {
        logger.warn(
          { activeProvider: activeProvider ?? null },
          'Onboarding gate fired DESPITE DISABLE_ONBOARDING_GATE: no LLM provider is active. ' +
          'Connect a model, or set OSHAL_NO_AI=true if this deployment is deliberately model-less (INSTALLER-GAPS G3).',
        );
      }
      return required;
    } catch (err) {
      logger.warn({ err }, 'Onboarding gate check failed — treating as not required');
      return false;
    }
  };

  // Guards the main HTML app surfaces (cockpit, chat) so deep links / bookmarks can't skip
  // onboarding. Only the document paths are gated — asset sub-paths fall through untouched,
  // so there is no redirect loop on JS/CSS the wizard-bound page still needs.
  const surfaceOnboardingGuard: express.RequestHandler = async (req, res, next) => {
    try {
      if (await needsOnboarding(req)) {
        // Preserve the query string (notably ?app=) so a deep link into a focused app
        // (e.g. /cockpit/?app=little-monsters) routes through that app's branded onboarding.
        const qIdx = req.originalUrl.indexOf('?');
        const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
        logger.info({ path: req.path }, 'Surface guard — onboarding required, redirecting to /welcome');
        res.redirect(302, '/welcome' + qs);
        return;
      }
    } catch (err) {
      logger.warn({ err }, 'Surface onboarding guard failed — allowing through');
    }
    next();
  };

  // UI asset locations (api HTML surfaces, chat standalone bundle, auth patch scripts, fonts,
  // shared CSS) — resolution order + src-api-first rationale live with the code in
  // server-ui-assets.ts (verbatim extraction). Logged there for boot diagnostics.
  const {
    apiDir,
    distBundleDir,
    chatStandaloneFile,
    chatAssetsDir,
    uiLogicFile,
    uiProviderFieldsFile,
    uiProviderModelsFile,
    uiOpenAiCodexPatchFile,
    uiClaudeCodeAuthPatchFile,
    codiconFontsDir,
    sharedUiCssDir,
    sharedUiJsDir,
  } = resolveUiAssetPaths();

  // Global JSON body limit: explicit, env-tunable (OSHAL_JSON_BODY_LIMIT, default 100kb) and
  // unit-tested. The three reserved prefixes install their own parsers at their own mounts —
  // screenshots/base64 images need headroom, and signed webhooks must keep the exact bytes for
  // their HMAC verifier. See features/security/hardening/body-limits.ts.
  app.use(createGlobalJsonParser());

  // CSP violation collector (UNauthenticated on purpose — the browser posts these
  // and won't carry a session). No-op-ish: it just logs what the report-only CSP
  // flags so we can build the real allowlist before enforcing. Body uses the CSP
  // report content-types, which the default express.json() does not parse.
  app.post(
    '/api/security/csp-report',
    express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '64kb' }),
    (req, res) => {
      try {
        const body: any = req.body || {};
        const r = body['csp-report'] || body.body || body;
        const directive = r?.['violated-directive'] || r?.effectiveDirective;
        const blockedUri = r?.['blocked-uri'] || r?.blockedURL;
        const documentUri = r?.['document-uri'] || r?.documentURL;
        // Report-only fires on EVERY page load from EVERY browser, so log each distinct
        // finding once per process — an un-deduped collector buries real faults.
        if (shouldLogCspReport(`${directive}|${blockedUri}|${documentUri}`)) {
          logger.warn({ directive, blockedUri, documentUri }, 'CSP violation reported (first occurrence)');
        }
      } catch {
        /* never let a malformed report error the endpoint */
      }
      res.status(204).end();
    },
  );

  app.use(cookieParser());
  // Auth mode normally remains the wholesale LOCAL_AUTH-or-OIDC choice. The explicit
  // Entra/local migration pilot composes both behind that same contract: /login keeps the
  // invited-user form and offers Microsoft at /login/microsoft; /login/local is recovery.
  const {
    authMiddleware,
    requiresAuth,
    loginHandler,
    localLoginHandler,
    microsoftLoginHandler,
    microsoftLoginEnabled,
  } = createApplicationAuthMiddlewareSet(ctx.pool);
  const delegatedUserRouteAuth = createWorkloadDelegationMiddleware({
    pool: ctx.pool,
    fallback: serviceSecretOr(requiresAuth),
  });

  // Shared design-system CSS is a public static asset, like a font or favicon.
  // Mount it before OIDC so stylesheet requests never 302 to login and then fail
  // MIME validation under X-Content-Type-Options: nosniff.
  app.use('/shared/ui/css', express.static(sharedUiCssDir, {
    index: false,
    redirect: false,
    setHeaders: (res, filePath) => {
      if (/\.css$/i.test(filePath)) {
        res.type('text/css');
      }
      // no-store, not no-cache: Cloudflare's Browser Cache TTL rewrites the header on anything
      // cacheable (measured: origin no-cache -> edge max-age=14400), which pinned shared design
      // CSS in every browser for four hours after a deploy. See cockpit-static-routes.ts.
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    },
  }));

  // Shared surface JS (surface-theme.js) — the theme bootstrap every standalone surface loads.
  // MUST mount here, BEFORE OIDC, for the same reason as the CSS above: past the auth middleware a
  // request 302s to /login, and the browser then rejects the HTML response as a script — leaving
  // the surface with no data-theme and, because theme files have no :root fallback, no colours at
  // all. It only reads a theme id from localStorage and sets an attribute; nothing sensitive.
  app.use('/shared/ui/js', express.static(sharedUiJsDir, {
    index: false,
    redirect: false,
    setHeaders: (res, filePath) => {
      if (/\.js$/i.test(filePath)) {
        res.type('application/javascript');
      }
      // no-store for the same measured reason as the CSS mount above. This one carries
      // surface-reading.js, so a stale copy is precisely the "the text is still too small"
      // report — on standalone surfaces like Jarvis, which sit outside the cockpit service
      // worker's scope and therefore have no second line of defence against the HTTP cache.
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    },
  }));

  // Browser-only bundles contain no user data and must remain reachable before identity resolution.
  // Guest surfaces import these modules after navigation; gating here runs requiresAuth before OIDC
  // or the guest injector has populated req.oidc and turns a harmless static GET into a 500.
  app.use('/dist', express.static(distBundleDir));

  // Serve ui-logic.js for Phase 1 config UI
  app.get('/ui-logic.js', requiresAuth, (_req, res) => {
    logger.info('GET /ui-logic.js');
    // Order matters: catalog data (fields, then models) precedes the core logic so the
    // declarations land in the same order they held inside the pre-split ui-logic.js.
    const providerFields = readOptionalTextFile(uiProviderFieldsFile);
    const providerModels = readOptionalTextFile(uiProviderModelsFile);
    const baseLogic = readOptionalTextFile(uiLogicFile);
    const openAiOauthPatch = readOptionalTextFile(uiOpenAiCodexPatchFile);
    const claudeCodeAuthPatch = readOptionalTextFile(uiClaudeCodeAuthPatchFile);
    const combinedScript = [providerFields, providerModels, baseLogic, openAiOauthPatch, claudeCodeAuthPatch]
      .filter((value) => value.length > 0)
      .join('\n\n');

    if (!combinedScript) {
      logger.error(
        { uiLogicFile, uiProviderFieldsFile, uiProviderModelsFile, uiOpenAiCodexPatchFile, uiClaudeCodeAuthPatchFile },
        'UI logic script could not be loaded',
      );
      res.status(500).send('Failed to load UI logic');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('application/javascript').send(combinedScript);
  });

  // Serve OpenAPI JSON and Swagger UI
  app.use('/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
  app.get(['/api-docs', '/api-docs/'], (_req, res) => {
    logger.info('GET /api-docs - redirecting to /docs');
    res.redirect(302, '/docs');
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // Health endpoint (public, no auth required) — used by Docker healthcheck
  // Placed BEFORE OIDC middleware to ensure healthcheck works without any auth setup
  app.get('/health', (_req, res) => {
    logger.info('GET /health');
    res.json({ status: 'ok' });
  });

  // Prometheus scrape target (public by design, same class as /health — process liveness,
  // start time, CPU and RSS only; no user data, no config, no secrets). This is what the
  // ADR-119 container-health rules key on: /api/health returns JSON, which Prometheus cannot
  // parse, so the oshal-api-health target was permanently `up=0` and SwarmApiUnreachable was
  // a permanent false alarm (found in the 2026-08-01 live drill). Placed with /health, above
  // the OIDC middleware, so a scrape never redirects to a login.
  app.get('/metrics', (_req, res) => {
    res.type(PROMETHEUS_CONTENT_TYPE).send(
      renderRuntimeMetrics({ runtime: 'swarm', instance: process.env.BOT_NAME || 'oshal-api' }),
    );
  });

  // Branding config — UI reads this to display the correct product name
  app.get('/api/branding', (_req, res) => {
    res.json({
      name: process.env.SERVICE_NAME || 'OSHAL',
      displayName: process.env.SERVICE_DISPLAY_NAME || process.env.SERVICE_NAME || 'OSHAL',
      title: process.env.SERVICE_TITLE || `${process.env.SERVICE_DISPLAY_NAME || process.env.SERVICE_NAME || 'OSHAL'} Control Plane`,
    });
  });

  // Callback-port root handling — when a bot owns the callback port, requests hitting /
  // on that port should be treated as auth redirect plumbing rather than the primary app surface.
  app.get('/', (req, res, next) => {
    if (!isOpenAiCodexCallbackPortRequest(req)) {
      next();
      return;
    }

    if (hasAuthCallbackQuery(req)) {
      if (isLikelyOpenAiCodexCallback(req)) {
        const redirectTo = `/api/openai-codex/oauth/callback${extractQueryString(req.originalUrl)}`;
        logger.info({ callbackPort: resolveConfiguredOpenAiCodexCallbackPort(), redirectTo }, 'Routing callback-port root request to OpenAI Codex callback handler');
        res.redirect(302, redirectTo);
        return;
      }

      redirectLegacyAuthRoute(req, res, '/callback');
      return;
    }

    logger.info({ callbackPort: resolveConfiguredOpenAiCodexCallbackPort() }, 'Serving informational root response on callback listener port');
    res.status(200).type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OSHAL Auth Callback</title></head><body><h1>OSHAL auth callback listener</h1><p>This port is reserved for authentication redirect handling.</p></body></html>');
  });

  // OIDC middleware (global) — uses mock mode when MOCK_OIDC env var is set
  app.use(authMiddleware);

  // /login is registered here (the stock express-openid-connect route is disabled via
  // routes.login=false) so a ?returnTo=<same-origin path> survives the IdP round-trip.
  // Every path that restarts a login — the callback token-exchange retry, the
  // state-mismatch restart, the cockpit's 401 auth-lapse guard — funnels through here;
  // the stock route dropped returnTo, stranding ?app= deep links on the bare cockpit.
  app.get('/login', loginHandler);
  // Entra/local migration pilot: bare `/login` remains the combined invited-user page.
  // `/login/local` is its cookie-clearing recovery alias, while the exact Microsoft route
  // starts Entra. Register both before the generic provider route.
  if (localLoginHandler) {
    app.get('/login/local', localLoginHandler);
  }
  if (microsoftLoginHandler) {
    app.get('/login/microsoft', microsoftLoginHandler);
  }
  // Provider-suffixed login entries (/login/google, /login/microsoft, …): same handler —
  // it resolves the provider from the path. The chooser page on bare /login links here.
  if (!microsoftLoginHandler) {
    app.get('/login/:provider', loginHandler);
  }

  // TV pairing token auth: when there is no interactive OIDC session but a valid `oshal_tv`
  // cookie is present (set by the Fire TV app after device pairing), inject an authenticated
  // req.oidc so requiresAuth + the GUC identity below resolve the paired user. See
  // routes/tv-pairing-routes.ts and ADR-047 (Fire TV surface can't do Google login in a WebView).
  app.use(createTvTokenAuthMiddleware(ctx.pool));
  // Personal access tokens (swarm-cli login): Bearer oshal_pat_… → authenticated req.oidc,
  // same injector shape as the TV token. Mounted here so requiresAuth, RLS identity, and
  // operator checks all see the token's owner.
  app.use(createCliTokenAuthMiddleware(ctx.pool));

  // Guest mode (ENABLE_GUEST_MODE, default off): when there is no real OIDC/TV
  // session and a valid signed `oshal_guest` cookie is present, inject a per-browser
  // guest identity so anonymous visitors can look around without a Google login.
  // Mounted before the GUC block so the guest sub is stamped into oshal.current_sub
  // and the guest is naturally row-isolated. Real sessions always win (no-op).
  app.use(createGuestSessionInjector());

  // Automatic traceability: record every mutating + sensitive /api request to the append-only
  // audit trail (actor, action, resource, allow/deny, duration). Mounted after identity resolution
  // (OIDC / TV token / guest) so the actor sub is known, and before the route mounts so it wraps
  // them. Complements the opt-in emitAuditEvent call sites; never blocks or breaks a request.
  // Opt out with OSHAL_AUDIT_AUTOCAPTURE=false.
  app.use(createAuditCaptureMiddleware(ctx.pool));

  // RLS request-identity: stash the caller's sub + operator flag in AsyncLocalStorage so the
  // GUC-aware pool wrapper (guc-pool.ts) stamps oshal.current_sub / oshal.is_operator on each
  // query's connection. Mounted unless OSHAL_DB_GUC=off. Placement is load-bearing (repo-audit
  // 2026-07-05): after identity resolution (authMiddleware / TV token / guest injector) so the
  // OIDC user is populated, after audit-capture (which is a system-context append-only writer),
  // and BEFORE every /api route mount below — otherwise a route that mounts above this line runs
  // with no request identity and fails open to trusted-operator context (RLS-bypassed). The
  // tv-pairing + jarvis-voice routes used to mount above it. See docs/governance/RLS-RUNBOOK.md
  // and the static guard in tests/unit/identity-middleware-ordering.spec.ts.
  if (gucEnabled()) {
    app.use((req, _res, next) => {
      runWithRequestIdentity(
        {
          sub: getCaller(req).sub,
          principalIssuer: getAuthenticatedPrincipalIssuer(req),
          isOperator: isOperator(req) || hasValidServiceSecret(req),
        },
        () => next(),
      );
    });
  }

  // Pairing endpoints: start/poll are public (the TV isn't signed in yet); approve + the /tv
  // approval page are requiresAuth (the user signs in normally in a real browser).
  app.use(createTvPairingRoutes(requiresAuth, ctx.pool));
  // Jarvis voice surfaces: the Fire TV view (/api/jarvis/tv) + the phone push-to-talk remote
  // (/api/jarvis/remote). Thin views over the existing Jarvis ask/history endpoints — the phone
  // is the mic, the TV shows + speaks the answer (ADR-047 phone-as-mic model).
  app.use(createJarvisVoiceRoutes(requiresAuth));

  // Guest lockdown (the actual security): for guest requests only, deny Tier-C apps
  // entirely and block mutations on read-only apps. Mounted after identity resolution
  // and before every /api route mount (including the serviceSecretOr ones), so a guest
  // cannot reach a write handler by any path. No-op for real users. See
  // shared/middleware/guest-capability-matrix.ts for the tier list.
  app.use(createGuestGuard());

  // Public guest entry: the /guest landing page + POST /api/guest/start|end.
  app.use(createGuestRoutes(ctx.pool));

  // Facebook OAuth callback alias — the FB app registers /auth/facebook/callback;
  // forward (preserving ?code&state) to the connectors handler that exchanges + stores.
  app.get('/auth/facebook/callback', (req, res) => {
    const qs = req.originalUrl.split('?')[1] || '';
    res.redirect(302, `/api/connect/facebook/callback${qs ? `?${qs}` : ''}`);
  });

  // Facebook Data Deletion Request callback (Meta requirement) — ungated, FB calls it.
  const fbDelete = createFacebookDataDeletionRoute(ctx);
  app.post('/auth/facebook/data-deletion', express.urlencoded({ extended: false }), fbDelete.post);
  app.get('/auth/facebook/data-deletion', fbDelete.page);

  // Public legal pages (required by Meta + other OAuth providers).
  app.get('/privacy', (_req, res) => res.sendFile(path.join(apiDir, 'privacy.html')));
  app.get('/terms', (_req, res) => res.sendFile(path.join(apiDir, 'terms.html')));

  // Public, surface-level technology explainer for the website (ungated marketing page).
  const serveTechnology = (_req: express.Request, res: express.Response) =>
    res.sendFile(path.join(apiDir, 'technology.html'));
  app.get('/technology', serveTechnology);
  app.get('/how-it-works', serveTechnology);

  // Legacy auth aliases for old UI pages still using /auth/login|logout|callback
  app.get('/auth/login', (req, res) => redirectLegacyAuthRoute(req, res, '/login'));
  app.get('/auth/logout', (req, res) => redirectLegacyAuthRoute(req, res, '/logout'));
  app.get('/auth/callback', (req, res) => {
    if (isLikelyOpenAiCodexCallback(req)) {
      const redirectTo = `/api/openai-codex/oauth/callback${extractQueryString(req.originalUrl)}`;
      logger.info({ legacyPath: req.originalUrl, redirectTo }, 'Routing /auth/callback to OpenAI Codex callback handler');
      res.redirect(302, redirectTo);
      return;
    }

    redirectLegacyAuthRoute(req, res, '/callback');
  });

  // User info endpoint (works in both real and mock OIDC modes)
  app.get('/api/user', requiresAuth, (req, res) => {
    const user = (req as any).oidc?.user ?? null;
    logger.info({ user: user?.preferred_username }, 'GET /api/user');
    res.json({ authenticated: true, user });
  });

  // Auth-state probe for the cockpit profile widget — UNGATED so it always returns
  // 200 (no login redirect) and reports the real session. Reflects the live OIDC
  // session in production and the injected mock session under MOCK_OIDC. This is
  // what makes the header show "Signed in as <you>" + a working Sign Out.
  app.get('/api/auth/user', (req, res) => {
    const oidc = (req as any).oidc;
    const authenticated = !!(oidc && typeof oidc.isAuthenticated === 'function' && oidc.isAuthenticated());
    const guest = isGuestRequest(req);
    res.json({
      authenticated,
      user: authenticated ? oidc.user : null,
      mode: guest ? 'guest' : isLocalAuthEnabled() ? 'local' : process.env.MOCK_OIDC === 'true' ? 'demo' : 'oidc',
      guestMode: guest,
      // Capability snapshot so the cockpit can gray the right tiles. Only meaningful
      // for guests; present always so the frontend can read it unconditionally.
      capabilities: guest ? guestCapabilities() : null,
    });
  });

  // Serve static files from src/api directory (public assets only, if needed)
  // app.use(express.static(apiDir)); // Removed: static files are now protected

  // Explicitly protect main UI files
  app.get('/chat.html', requiresAuth, (req, res) => {
    logger.info('GET /chat.html (authenticated) - redirecting to /chat');
    res.redirect(302, '/chat');
  });
  
  // New OSHAL chat page (standalone version with inlined code)
  app.get('/chat', requiresAuth, surfaceOnboardingGuard, (req, res) => {
    logger.info('GET /chat (authenticated) - new OSHAL chat UI');
    sendHtmlResponse(res, chatStandaloneFile, '/chat');
  });
  app.use('/chat-assets', requiresAuth, express.static(chatAssetsDir));
  app.get('/index.html', requiresAuth, (req, res) => {
    logger.info('GET /index.html (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'index.html'), '/index.html');
  });
  app.get('/ui.html', requiresAuth, (req, res) => {
    logger.info('GET /ui.html (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'ui.html'), '/ui.html');
  });

  // Operations Stream surfaces, both registered as ribbon tools by the
  // intelligent-processing manifest. System Health is read-only for any authenticated caller;
  // Pipeline Admin is operator-only, enforced by every route it calls rather than by this mount —
  // the page itself renders an honest operator-only panel on a 403.
  app.get('/system-health', requiresAuth, (req, res) => {
    logger.info('GET /system-health (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'system-health.html'), '/system-health');
  });
  app.get('/alert-pipeline-admin', requiresAuth, (req, res) => {
    logger.info('GET /alert-pipeline-admin (authenticated)');
    sendHtmlResponse(res, path.join(apiDir, 'alert-pipeline-admin.html'), '/alert-pipeline-admin');
  });

  // Root route - requires auth, then lands on the deployment's home surface.
  // Bare / lands on the plain cockpit (operator decision 2026-07-07): the framework ribbon
  // shaped by the user's authorizations. An explicit ?app=<name> in any URL is always
  // respected (RibbonNav reads it per page load) — only the no-app default changed. Set
  // LANDING_PATH to point a single-app deployment elsewhere, e.g.
  // LANDING_PATH=/cockpit/?app=little-monsters. A themed subdomain (dnd.oshal.ai,
  // trading.oshal.ai, ...) is resolved from HOST_APP_MAP first — see host-app-map.ts;
  // LANDING_PATH stays the single-host fallback when no host entry matches.
  app.get('/', requiresAuth, async (req, res) => {
    const landingPath = resolveHostLandingPath(
      process.env.HOST_APP_MAP,
      req.hostname,
      process.env.LANDING_PATH || '/cockpit/',
    );
    // First-run gate: every user sees onboarding once, and a working LLM is mandatory.
    if (await needsOnboarding(req)) {
      const qIdx = req.originalUrl.indexOf('?');
      const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
      logger.info('GET / (authenticated) - onboarding required, redirecting to /welcome');
      res.redirect(302, '/welcome' + qs);
      return;
    }
    logger.info({ landingPath }, 'GET / (authenticated) - redirecting to landing');
    res.redirect(302, landingPath);
  });
  
  // Swarm debug surface route — protected by OIDC
  app.get('/ui', requiresAuth, (req, res) => {
    logger.info('GET /ui (authenticated) - swarm debug surface');
    const swarmDebugFile = resolveExistingPath([
      path.resolve(__dirname, '../api/swarm-debug.html'),
      path.resolve(process.cwd(), 'src/api/swarm-debug.html'),
    ]);
    sendHtmlResponse(res, swarmDebugFile, '/ui');
  });

  // Welcome/onboarding page (served WITHOUT the onboarding gate, else it would loop).
  // Resolve from dist first, then the verbatim src (tsc doesn't copy the wizard's html/js/css
  // into dist, and src/pages/welcome is bind-mounted for hot-swap), so the assets are found.
  const welcomeDir = resolveExistingPath([
    path.resolve(__dirname, '../pages/welcome'),
    path.resolve(process.cwd(), 'src/pages/welcome'),
  ]);
  app.use('/welcome', requiresAuth, express.static(welcomeDir));

  // Engineering/ops page list + directory resolution extracted verbatim to
  // server-ui-assets.ts (resolveUiSurfacePages) — same pages, same order.
  registerUiSurfaceRoutes({
    app,
    requiresAuth,
    serveHtml: sendHtmlResponse,
    pages: resolveUiSurfacePages([requireAdminConsoleAccess()]),
  });

  // Cockpit UI — serve static assets and index.html from src/pages/cockpit (active development source)
  const cockpitDir = resolveExistingPath([
    path.resolve(__dirname, '../pages/cockpit'),
    path.resolve(process.cwd(), 'src/pages/cockpit'),
    path.resolve(__dirname, '../../any-bot/ui-cockpit'),
  ]);
  const uiEnhancedDir = path.resolve(__dirname, '../../any-bot/ui-enhanced');
  // Gate ONLY the cockpit document entry (not its asset sub-paths) so a deep link to the
  // cockpit still routes a not-yet-onboarded user to /welcome. Registered before the static
  // handler; falls through via next() when onboarding isn't required.
  app.get(['/cockpit', '/cockpit/'], requiresAuth, surfaceOnboardingGuard);
  registerCockpitStaticRoutes({
    app,
    requiresAuth,
    cockpitDir,
    uiEnhancedDir,
    codiconFontsDir,
    sharedUiCssDir,
    sharedUiJsDir,
  });

  // Legacy engineering compatibility routes — serves legacy HTML pages and API stubs
  registerLegacyEngineeringCompatRoutes({
    app,
    requiresAuth,
    ctx,
  });
  registerCodeServerBridgeRoutes(app, requiresAuth);

  // Fast intake route — direct OpenAI API for 1-3s ticket creation from natural language.
  // Auth-gated because the route spawns codex and creates approved tickets; without auth
  // (authRequired:false at the OIDC layer leaves routes open by default) anonymous callers
  // could burn LLM budget + flood the queue.
  // Cost backstop: expensiveOpLimiter is a no-op unless OSHAL_RATE_LIMIT_EXPENSIVE=on
  // (left OFF by default — 30/min/IP would throttle the AI Test Lab's burst intake;
  // enable + tune OSHAL_RATE_LIMIT_EXPENSIVE_MAX once the swarm's burst profile is known).
  app.use('/api/intake', expensiveOpLimiter);
  // /api/jarvis is the other named cost surface in the hardening backlog: every turn is an LLM
  // call, and it is reachable by any signed-in user (plus the trusted-service identity). Same
  // flag-gated preset — a no-op unless OSHAL_RATE_LIMIT_EXPENSIVE=on, so merging changes nothing.
  app.use('/api/jarvis', expensiveOpLimiter);
  registerFastIntakeRoutes(app, requiresAuth, ctx.ticketService as any);

  // Extended health endpoint with stats (public). NB: this is LIVENESS only — it says
  // the process is up, not that the box can think/hear/speak. Capability status lives
  // at /api/readiness below (INSTALLER-GAPS G9); runbooks should gate on that.
  app.get('/api/health', (_req, res) => {
    logger.info('GET /api/health');
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      streaming: ctx.streamManager.getStats(),
    });
  });

  // Per-capability readiness (llm / bots / credentials / voice / db) — public, coarse,
  // 503 when any advertised capability has nothing behind it. Consumed by
  // scripts/oshal-verify.sh and the customer runbooks.
  registerReadinessRoutes(app, ctx);

  // API status endpoint (returns output dir, write mode, and encryption status)
  app.get('/api/status', requiresAuth, (_req, res) => {
    const outputDir = process.env.CONFIG_OUTPUT_DIR || './output';
    const encrypted = !!process.env.ENCRYPTION_KEY;
    logger.info({ outputDir, encrypted }, 'GET /api/status');
    res.json({
      success: true,
      outputDir,
      writeMode: 'split',
      encrypted,
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Swarm Applications Framework bootstrap (must come BEFORE any
  //     manifest-owned route mount so the gate middleware runs first) ───
  // Instance lives for the full process lifetime; used by the gate, the
  // REST routes, the UI profile route, and autoloaded on boot.
  // Framework-scope schedule bridge + ADR-085 P0 teardown — extracted verbatim to
  // swarm-app-schedule-wiring.ts (factories return the same closures wired here).
  const manifestScheduleRegistrar = createManifestScheduleRegistrar(manifestServiceScheduleRegistry);
  const manifestScheduleDeregistrar = createManifestScheduleDeregistrar(manifestServiceScheduleRegistry);
  const appAccessService = new AppAccessService(ctx.pool);
  const takeoutSliceRegistry = new TakeoutSliceRegistry(ctx);
  const swarmAppService = new SwarmAppService(
    ctx.pool,
    new SwarmAppRepository(ctx.pool),
    new AgentProfileRepository(ctx.pool),
    ctx.runtimeToolRegistrationService,
    // Seed each app bot's persona allowed_tools → agent_tools so the framework injects the
    // tool usage into the bot's prompt (e.g. career-advisor gets career_database). The bot's
    // OWN persona path is passed so it seeds from its persona, not the api's project-manager.
    (agentId: string, personaFile?: string) => seedPersonaAuthorizations(ctx.pool, agentId, personaFile),
    manifestScheduleRegistrar,
    // ADR-085 P1: lets an installed app package mount its OWN compiled-JS routes at activation
    // (flag-gated on APP_PACKAGE_DYNAMIC_ROUTES → no-op by default, hardcoded mounts below still apply).
    new ManifestRouteMounterImpl(app, requiresAuth, ctx, appAccessService),
    manifestScheduleDeregistrar,
    // ADR-085: packaged bots join the ACTIVE bot registry as inline-concierge entries
    // (container oshal-api, port 3010; validated manifest runtime or legacy Claude default)
    // so they resolve for dispatch/harness-override and the boot wiring audit passes with
    // ZERO hand-edits to the static registry files. Retracted on deactivate.
    {
      register: (appName, bots) => registerAppBots(appName, bots
        .filter((b): b is typeof b & { agentId: string } => typeof b.agentId === 'string' && b.agentId.length > 0)
        .map(manifestBotDefinition)),
      unregister: (appName) => unregisterAppBots(appName),
    },
    // ADR-085 §5 + ADR-091: RAG collection impact/teardown — lazy RagService so
    // construction order doesn't matter (RagService is built later in boot).
    {
      list: () => new RagService().listCollections(),
      deleteCollection: (name: string) => new RagService().deleteCollection(name),
    },
    takeoutSliceRegistry,
  );
  // Per-user "polls" (connector-scoped manifest schedules) + the nightly oshal-dev
  // docs-quality schedule (ADR-081, gated on OSHAL_DEV_OWNER_SUB) — extracted verbatim
  // to swarm-app-schedule-wiring.ts; both run at this exact point in boot as before.
  registerPerUserScheduleReconciler(swarmAppService, ctx.pool);
  registerNightlyDevDocsSchedule();

  // CORE-05 installer verifier. Exact kernel route mounted before the package gate/dispatcher so
  // no installed manifest can shadow the postflight authority. App smokes accept the deployment
  // service secret; the spend-bearing /live child additionally requires an operator PAT.
  app.use(
    '/api/install-verification',
    serviceSecretOr(requiresAuth),
    createInstallVerificationRoutes(ctx, swarmAppService),
  );

  // Gate middleware — 503s requests to any path claimed by a swarm-app
  // manifest whose owning app is currently inactive. Framework paths
  // (paths no manifest claims) pass through untouched.
  app.use(createSwarmAppGateMiddleware(swarmAppService, appAccessService));

  // Node Pool Mode (phase0) — register /node/* endpoints when running as a pool node.
  // Opt-in via env, so this is inert on the normal controller/bot-node runtime.
  if (process.env.NODE_POOL_MODE === 'true') {
    const { createNodePoolRoutes, createNodePoolState } = require('./routes/node-pool-routes');
    const nodePoolState = createNodePoolState();
    app.use('/node', createNodePoolRoutes(nodePoolState));
    logger.info({ nodeId: nodePoolState.nodeId }, 'Node pool mode active — /node/assign, /node/release, /node/status registered');

    // Store state on app for SwarmAgentWorker wiring (Phase 1.4)
    (app as { __nodePoolState?: unknown }).__nodePoolState = nodePoolState;
  }

  // Protected API routes
  app.use('/api/providers', requiresAuth, createProviderRoutes());
  // Bring-Your-Own-LLM connector (any API, any LLM) — mounted ahead of the generic
  // connectors router so /any-llm/{save,test,models} resolve here, not /:provider/*.
  app.use('/api/connect/any-llm', requiresAuth, createByoLlmRoutes(ctx));
  // Free-tier LLM connect + rotation (ADR-064) — the user's own free tiers across many
  // providers, rotated. Mounted ahead of the generic connectors router so /free-tier/*
  // (and /free-tier/openrouter/oauth/*) resolve here, not /:provider/*.
  app.use('/api/connect/free-tier', requiresAuth, createFreeTierRoutes(ctx));
  // Default brain (ADR-127): which connected provider runs THIS caller's work. Owner-scoped —
  // every handler reads the authenticated sub and never accepts a subject parameter.
  app.use('/api/settings/llm-default', requiresAuth, createLlmPreferenceRoutes(ctx));
  // Connectors / Utilities hub — per-user provider authorization (Gmail, etc.)
  app.use('/api/connect', requiresAuth, createConnectorsRoutes(ctx));
  // Live connection health (INSTALLER-GAPS G14): GET /api/connect/liveness probes whether the
  // provider will actually HONOR the stored grant (forced refresh / account read, cached ≤15min)
  // so the Connections screen's "connected" badge stops trusting a bare DB row.
  app.use('/api/connect', requiresAuth, createConnectorLivenessRoutes(ctx));
  // Slack personal feed — live read of the caller's own channels/DMs via the 'slack' connector token.
  app.use('/api/slack', requiresAuth, createSlackRoutes(ctx));
  // (Feeds app /api/feeds surface carved to the app store, ADR-085 Wave 3 — the packaged
  //  route mounts on install. The feeds-indexing ENGINE (startFeedsIndexingCron, below),
  //  the feeds-curator inline node, the /feeds framework page, and the 'slack' connector
  //  stay framework-resident per ADR-093.)
  // Tenant (household) management — shared connection ownership (ADR-042).
  app.use('/api/tenants', requiresAuth, createTenantRoutes(ctx));
  // (/api/home is no longer hard-mounted: Smart Home carved to the oshal-applications store,
  //  ADR-085 Wave 2 — the package mounts it, auth: oidc in its manifest. The home-bot node,
  //  home-data volume, and the scheduler's home-control branch stay core per ADR-093.)
  app.get('/utilities', requiresAuth, (_req, res) => {
    sendHtmlResponse(res, path.join(apiDir, 'utilities.html'), '/utilities');
  });
  // ADR-064 — "Run for free" walkthrough: connect your own free AI tokens across providers.
  app.get('/free-models', requiresAuth, (_req, res) => {
    sendHtmlResponse(res, path.join(apiDir, 'free-models.html'), '/free-models');
  });
  app.use('/api/openai-codex/oauth', createOpenAiCodexOAuthRoutes(requiresAuth));
  app.use('/api/claude-code/auth', createClaudeCodeAuthRoutes(requiresAuth));
  // Gemini connect-state (Plan E residual) — status-ONLY: the vendor's own CLI login runs
  // host-side (Connect-AI.bat / `gemini` once); we never broker Google OAuth. The Utilities
  // tile polls this until the host login's ~/.gemini/oauth_creds.json (mounted ro) appears.
  app.use('/api/gemini/auth', createGeminiAuthRoutes(requiresAuth));
  app.use('/api/facebook-auth', createFacebookAuthRoutes(requiresAuth));
  // (/api/email is no longer hard-mounted: the Email Summarizer surface carved to the
  //  oshal-applications store, ADR-085 Wave 3 — the installed package's manifest mounts it
  //  (auth: oidc). The comms machinery stays core per ADR-093: the email-bot container +
  //  both registries + persona, the sendGmail/sendOutlookMail + summarizeGmailMetadata
  //  machinery in routes/email-routes.ts, the gmail/outlook/twilio CLIs, and inbox-ingest.)
  // (/api/career-hunter is no longer hard-mounted: Career Hunter carved to the
  //  oshal-applications store, ADR-085 Wave 3 #1 — the installed package's manifest mounts it
  //  (auth: service-or-oidc) and /api/career-hunter/graph (oidc). The ENGINE CHAIN stays core
  //  per ADR-093: apps/career-hunter python engine, oshal-jobhunter.js wrapper, both bot
  //  containers + registries + personas, and the 9.8GB store on the api-output volume.)
  app.use('/api/apply-operator', requiresAuth, createApplyOperatorRoutes(ctx));
  // Box callback — service-secret authed (no OIDC), like /api/lora ingest. Its own json parser at
  // 12mb: POST /shot carries a base64 screenshot per progress beat, which the default ~100kb limit
  // rejects with a 413 the worker cannot act on.
  app.use('/api/apply', express.json({ limit: '12mb' }), createApplyIngestRoutes(ctx));
  // The durable job-apply queue's in-flight registry + 30-min watchdog are PROCESS MEMORY, so a
  // restart (deploy / crash / the stack watchdog recreating containers) strands whatever was mid-
  // submission in in_process_build — the queue manager only ever dispatches `approved`. This sweep
  // returns sufficiently-stale ones to the queue so an overnight drain survives restarts.
  // Order matters: rehydrate FIRST so a submission that is still live on the desktop keeps holding
  // the per-user in-flight slot (otherwise the very next poll dispatches a second job onto the same
  // Chrome), then start the sweep that recovers whatever the node never reported.
  void rehydrateApplyInFlight(ctx).finally(() => startApplyReaper(ctx));
  app.use('/api/profile-studio', createProfileStudioIngestRoutes(ctx)); // desktop callback: one-use dispatch capability, no OIDC/fleet secret
  // (/api/gov-contracting is no longer hard-mounted: the gov-contracting app carved to the
  //  oshal-applications store, ADR-085 Wave 3 — the package mounts it, auth: oidc in its
  //  manifest. The gov-contracting-cron ENGINE (started below — the daily SAM scan +
  //  enqueueDraftsForUser), the vendored python engine (apps/gov-contracting/engine) +
  //  per-user stores, the capture-specialist/coordinator inline nodes + kernel personas,
  //  and the govcon default tiles stay core per ADR-093.)
  // (/api/social is no longer hard-mounted: the Social app carved to the oshal-applications
  //  store, ADR-085 Wave 2 — the package mounts it, auth: oidc in its manifest. The comms-bot
  //  + social-writer nodes, the inbox-ingest Signals engine (oshal_inbox_messages), the
  //  linkedin/twitter/meta-business connectors, and the kernel-resident LinkedIn AI Content
  //  Assistant at /api/linkedin-assistant (its own no-post gate) stay core per ADR-093.)
  app.use('/api/devops', requiresAuth, createDevopsRoutes(ctx, apiDir));
  app.use('/api/forge', requiresAuth, createForgeRoutes(apiDir)); // Bot Forge — front door for agentic swarm injection (codex-packer engine)
  app.use('/api/files', requiresAuth, createFilesRoutes(ctx, apiDir));
  app.use('/api/judge', requiresAuth, createJudgeRoutes(ctx));  // shared LLM-judge/grading service — quality-judge concierge (a0…0053)
  // /api/storage now mounts from the storage app package (ADR-085 carve; auth: oidc in its manifest).
  // ADR-045 #2 — caller-scoped graph (replaces the retired external graph endpoint). The outer
  // SEC-01 gate keeps OIDC/PAT authoritative, accepts route-bound durable bearer delegation,
  // observes legacy machine calls in shadow, and removes fleet-secret user assertion in enforce.
  app.use('/api/graph', delegatedUserRouteAuth, createGraphRoutes());
  // PAT management (mint/list/revoke/whoami). serviceSecretOr: a browser session manages its
  // own tokens; the trusted-service secret may bootstrap-mint but ONLY for an operator sub and
  // ONLY a time-boxed token (cli-token-routes.ts) — the old "not an escalation, the secret
  // implies full impersonation" reasoning was retired because bots hold the secret and are
  // injectable. swarm-cli login --secret uses this (operator only).
  app.use('/api/cli-tokens', serviceSecretOr(requiresAuth), createCliTokenRoutes(ctx.pool));
  // LOCAL_AUTH flows (ADR-117): /invite + /logout pages, login/accept/bootstrap, and the
  // operator-or-trusted-service user administration API. Mounted below the GUC stamp so
  // admin reads ride the caller's RLS identity; the public legs are the front door and
  // gate nothing. Only present in LOCAL_AUTH mode — in OIDC/mock modes these paths keep
  // their prior behavior (express-openid-connect owns /logout; /invite does not exist).
  if (isLocalAuthEnabled()) {
    app.use(createLocalAuthRoutes(ctx.pool, { microsoftLogin: microsoftLoginEnabled === true }));
  }
  // Cost-governance — spend budgets (oshal_budgets) + spend reads. requiresAuth-gated; the
  // factory scopes cross-user reads/writes to the operator allowlist internally.
  app.use('/api/budgets', createBudgetRoutes(requiresAuth, { pool: ctx.pool }));
  // Harvest console — the illustrative site/soil catalogue + one closed-loop simulate call over
  // the marine and ground slices. Stateless (no pool: the budget is pure arithmetic), but the
  // factory applies requiresAuth per-route because the integration loop is synchronous on this
  // process — an anonymous caller could otherwise burn the controller's only thread.
  // Inbound A2A gateway (BACKLOG Plan F): whole surface 404s unless A2A_GATEWAY_ENABLED=true;
  // the well-known card is public-by-spec, POST /api/a2a uses per-agent Bearer (A2A-native,
  // NOT OIDC), /api/a2a/agents is requiresAuth + operator-only. message/send files a REAL
  // ticket on the ADR-083 call-out rails — the controller never names a bot, never calls an LLM.
  registerA2aGatewayRoutes(app, requiresAuth, {
    pool: ctx.pool, ticketService: ctx.ticketService, messageStore: ctx.messageStore,
  });
  // Run-trace — read-model that assembles one ticket's execution waterfall (phases -> bot
  // executions -> per-LLM-call cost) from already-persisted rows. requiresAuth-gated; per-ticket
  // ownership (owner_sub; operator sees any) is enforced inside TraceService, no existence leak.
  app.use('/api/trace', createTraceRoutes(requiresAuth, { pool: ctx.pool }));
  // Queue dead-letter queue — operator list + requeue over oshal_queue_dlq (migration 081).
  // requiresAuth + requiresOperator inside the factory; the quarantining DeadLetterService
  // instance lives in the swarm extension — this factory builds a list/requeue-only sibling
  // over the same DB state.
  app.use('/api/queue/dlq', createQueueDlqRoutes(requiresAuth, { pool: ctx.pool, ticketService: ctx.ticketService }));
  // Notification preference center — self-scoped per-topic routing (own Gmail / own Twilio /
  // Telegram-when-token-lands / none) + quiet hours. Factory applies requiresAuth per-route.
  app.use('/api/notify', createNotifyRoutes(ctx, requiresAuth));
  startInboxIngestCron(ctx); // cron: capture all new mail (timestamped, categorized) into the store
  startFeedsIndexingCron(ctx); // cron: index each connected user's Slack messages into feed_messages
  startGovContractingCron(ctx); // cron: gated daily SAM.gov capture scan + draft enqueue (no-op unless GOVCON_CRON=1)
  // Update-check daemon — public /api/version + auth-gated /api/updates + operator-gated
  // per-app apply (re-install from the package's own source: + hot-reload via loadApp), then
  // the daily apps-vs-store + core-vs-upstream check (UPDATE_CHECK_ENABLED=0 disables).
  registerUpdateRoutes(app, requiresAuth, {
    loadApp: (manifestPath, scopeMeta) => swarmAppService.loadApp(manifestPath, scopeMeta),
  });
  startUpdateCheckCron(); // cron: daily update check (no DB access, network = 2 anonymous GitHub reads/day)
  app.use('/api/content', requiresAuth, createContentRoutes(ctx, apiDir));
  // LinkedIn AI Content Assistant — social north-star: draft on social-writer → quality-judge
  // score → one refine under SOCIAL_JUDGE_BAR → human approve/publish (ADR-036 accountable bots).
  app.use('/api/linkedin-assistant', requiresAuth, createLinkedInAssistantRoutes(ctx, apiDir));
  // /api/youtube-kids is no longer hard-mounted: Kid Lens was carved out to the
  // oshal-applications store (ADR-085 Wave 1) — its route dynamic-mounts from the installed
  // package via ManifestRouteMounter when the app is installed + active.
  // /api/finance is no longer hard-mounted: Finance was carved out to the oshal-applications
  // store (ADR-085 Wave 1 finale) — its route dynamic-mounts from the installed package. The
  // finance-analyst REAL bot-node (compose service + local registry + persona + oshal-plaid.js)
  // stays framework-resident as the ADR-093 interim operator fragment.
  // The four trading surfaces (/api/trading/autopilot, /api/trading/lab, /api/trading-charts,
  // /api/trading) are no longer hard-mounted: the trading SURFACE carved to the
  // oshal-applications store (ADR-085 Wave 3, "skill with a surface"). The package mounts the
  // SAME paths with the SAME postures (ADR-085 D2): service-or-oidc for autopilot/lab/trading
  // (so the trading_* operator tools / Jarvis / the regression CLI keep reaching the book via an
  // internal service call), public/self-guarded for trading-charts (chart lib is a public MIT
  // asset; /bars self-gates via callerSub 401). The ENGINE + AUTOPILOT stay core per ADR-093:
  // app/trading-{engine,schema}.ts (placeDecisionOrder's live_blocked gate untouched), the 8
  // dispatch/reconcile loops, routes/trading-routes-helpers.ts, src/features/trading, the
  // trading-bot + weather-bot nodes, migrations, and every TRADING_* env/schedule pin.
  // (/api/kalshi is no longer hard-mounted: Kalshi Prediction Markets carved to the
  //  oshal-applications store, ADR-085 Wave 3 — the package mounts the same /api/kalshi with
  //  auth: service-or-oidc, preserving the ADR-094 posture: handlers self-gate via callerSub,
  //  orders confirm-gated + demo exchange unless KALSHI_LIVE_ENABLED, audited to kalshi_orders.
  //  The prediction-markets ENGINE stays core per ADR-093.)
  // (/api/vids is no longer hard-mounted: Vids Studio carved to the oshal-applications
  //  store, ADR-085 Wave 3 — the package mounts the same /api/vids with auth:
  //  service-or-oidc, preserving the 2026-07-05 security posture (in-container
  //  vids_generate / creative_* CLI tools reach it with X-Service-Secret; browsers hit
  //  the OIDC wall). The SHARED vids-operator desktop worker, the remote-client mesh it
  //  polls, and scripts/oshal-vids.js stay core — ADR-093.)
  // Security Center — the swarm's self-security app (ADR-055). The controller runs the active
  // scanners (committed secrets, unauthenticated routes, vulnerable deps) + the runtime/ledger/
  // audit detectors and stores findings; the inline security-analyst bot triages each into a
  // real/false-positive verdict with an attack scenario + fix (ADR-036). Findings escalate to
  // 'security-finding' tickets. OPERATOR-ONLY: findings map the platform's own weak points
  // (secret locations/previews, ungated routes), so basic users must never reach any of it —
  // the whole mount (page included) sits behind requiresOperator. Manifest scope: operator
  // hides the app from the non-operator catalog/ribbon; this gate is the real boundary.
  // The route auditor also walks the ACTIVE app manifests' routes[] (ADR-085 dynamic mounts are
  // invisible to its server.ts scan) — flattened here to the auditor's plain shape so
  // features/security never imports features/swarm-apps (FSD same-layer rule).
  app.use('/api/security', requiresAuth, requiresOperator, createSecurityRoutes(ctx, apiDir,
    async () => (await swarmAppService.getActiveManifests()).flatMap((m) =>
      (m.routes ?? []).map((r) => ({ appName: m.name, mountPath: r.mountPath, auth: r.auth, requiresAuth: r.requiresAuth })))));
  // Add a computer — mints a join code (OSJOIN1.*) so another machine can attach as a worker
  // node long after the installer printed the original one. OPERATOR-ONLY: a join code embeds
  // REMOTE_CLIENT_SHARED_SECRET in plaintext and anyone holding it can register a node that
  // receives dispatched work, so it is exactly as sensitive as the secret. Same gate, same
  // reason as /api/security above.
  // requiresAuth only: POST /enroll is self-service (a user attaching their OWN computer is not an
  // administrative act, and owner-scoped dispatch keeps that node reachable only by them). The two
  // secret-bearing endpoints — the surface and GET /code, which carries REMOTE_CLIENT_SHARED_SECRET
  // — self-gate to operator inside the router.
  app.use('/api/join', requiresAuth, express.json(), createJoinRoutes(apiDir, ctx.pool));
  // /api/payments is no longer hard-mounted: Payments was carved out to the
  // oshal-applications store (ADR-085 Wave 1) — its route dynamic-mounts from the
  // installed package via ManifestRouteMounter. The @/features/payments adapter slice
  // stays core (kernel skill — finance imports its Stripe half).
  // (/api/identity is no longer hard-mounted: the Identity Hub carved to the
  // oshal-applications store (ADR-085 Wave 3) — its route dynamic-mounts from the
  // installed package via ManifestRouteMounter. The identity-advisor inline node and
  // the connector hub it views (/api/connect/*, /utilities) stay core per ADR-093.)
  // Jarvis — the unified assistant over every app. Classifies the user's message, delegates to
  // the accountable specialist bot(s) via BotNodeClient (cost lands per-bot in chat_tasks), and
  // synthesizes one answer; data-apps are handed off with a deep link (ADR-050). requiresAuth-gated.
  // Ambient listening is explicit opt-in and text-only. The owner-scoped store rejects raw audio,
  // applies retention, and emits review proposals without creating reminders/tasks automatically.
  // The specific ambient path stays ahead of the general Jarvis router.
  startAmbientReviewRuntime(ctx.pool);
  // ADR-100 Phase 1: person-model recall. Specific path mounted BEFORE the general ambient routers.
  // Ensure the schema at boot (not just lazily on first recall) so the new owned tables participate
  // in data-lifecycle export/delete discovery immediately.
  void ensurePersonModelSchema(ctx.pool).catch(() => { /* logged inside; recall re-ensures lazily */ });
  app.use('/api/jarvis/ambient/person', requiresAuth, createPersonModelRoutes(ctx));
  // ADR-100 Phase 2: micro-batch enrichment sweeper — OFF by default (OSHAL_AMBIENT_ENRICH), inert until enabled.
  startAmbientEnrichmentRuntime(ctx);
  // ADR-100 Phase 2: daily person-model retention purge — always on (pure SQL, no LLM).
  startPersonModelMaintenanceRuntime(ctx.pool);
  app.use('/api/jarvis/ambient', requiresAuth, createAmbientSpeakerRoutes(ctx));
  app.use('/api/jarvis/ambient', requiresAuth, createAmbientListeningRoutes(ctx));
  // Morning brief claims ONLY GET /brief + /brief.html with per-route user auth and passes every
  // other Jarvis path through to the later SEC-01 gate (the ambient routes use the same ordering).
  app.use('/api/jarvis', createJarvisBriefRoutes(requiresAuth, ctx));
  // Same durable SEC-01 gate as Graph. Legacy reads retain immediate containment in every mode;
  // enforce also removes the compatibility fleet secret from Jarvis actions.
  app.use('/api/jarvis', delegatedUserRouteAuth, createJarvisRoutes(ctx, apiDir));
  // Vision describe (the visual analog of /api/voice/transcribe): base64 images exceed the global
  // 100kb JSON cap, so this mount is excluded from the default parser above and carries its own
  // 12MB one. serviceSecretOr(requiresAuth): browser session OR the trusted-service identity.
  app.use('/api/vision', express.json({ limit: '12mb' }), serviceSecretOr(requiresAuth), createVisionRoutes(ctx));
  // Spaces (ADR-111) carved to the oshal-applications store (ADR-085) — /api/spaces now mounts from
  // the installed `spaces` package (deployed-apps/); the spatial-mapping engine stays a kernel skill.
  // Chat channels: "message your swarm on Telegram." Mounted WITHOUT a blanket auth guard — the
  // public Telegram webhook (secret-verified) is reachable while the link/list/unlink endpoints
  // apply requiresAuth individually inside the router. Inbound messages run on the accountable
  // Jarvis bot (cost in chat_tasks); the controller only does channel I/O.
  app.use('/api/channels', createChatChannelRoutes(ctx, requiresAuth));
  // Haven user model (ADR-079): the caller's OWN durable model — view/teach/forget facts +
  // pull-based proactive suggestions. Strictly caller-scoped by OIDC sub; requiresAuth-gated.
  app.use('/api/user-model', requiresAuth, createUserModelRoutes(ctx));
  // Developer Console (ADR-077) — super-admin-gated platform diagnostics. Mounted ONLY when
  // the capability is explicitly enabled, so a deployment that never opts in returns 404 for
  // the ENTIRE surface: no route existence, no config/enable-state disclosure, and no
  // authenticated-reachable write path. requiresAuth is the outer wall; the super-admin
  // double-gate (dedicated allowlist, fail-closed) is enforced per-route inside. Read-only.
  if (superAdminEnabled()) {
    app.use('/api/dev-console', requiresAuth, createDevConsoleRoutes(ctx));
  }
  // Takeout ingestion spine — unzip a Google Takeout archive (browser upload or Dropbox
  // pickup) and route active manifest-contributed slices. requiresAuth.
  app.use('/api/takeout', requiresAuth, createTakeoutRoutes(ctx, takeoutSliceRegistry));
  // /api/education is no longer hard-mounted: Little Monsters was carved out to the
  // oshal-applications store (ADR-085) — its routes dynamic-mount from the installed
  // package via ManifestRouteMounter when the app is installed + the flag is on.
  // (/api/purchasing is no longer hard-mounted: Purchasing carved to the oshal-applications
  //  store, ADR-085 Wave 2 #5 — the installed package's manifest mounts it (auth:
  //  service-or-oidc). The shop-concierge bot-node quadruple stays core per ADR-093; the
  //  packaged route still shells scripts/oshal-walmart.js from the image.)
  // (/api/eats is no longer hard-mounted: Eats carved to the oshal-applications store,
  //  ADR-085 Wave 2 #4 — the installed package's manifest mounts it (auth: service-or-oidc).
  //  The eats-concierge bot-node quadruple stays core per ADR-093; the packaged route still
  //  shells scripts/oshal-uber.js from the image.)
  // (/api/pumpkin is no longer hard-mounted: Pumpkin carved to the oshal-applications store,
  //  ADR-085 Wave 3 — the installed package's manifest mounts it (auth: service-or-oidc), with
  //  the PUMPKIN_ALLOWED_SUBS/EMAILS input gate riding in the router. The pumpkin ENGINE
  //  (src/features/pumpkin), the /pumpkin projector framework page (server-ui-assets), and the
  //  pumpkin-bot INLINE node ...054 (rides api rebuilds) stay core per ADR-093.)
  // (/api/rides is no longer hard-mounted: Rides carved to the oshal-applications store,
  //  ADR-085 Wave 2 #3 — the installed package's manifest mounts it (auth: service-or-oidc).
  //  The rides-concierge bot-node quadruple stays core per ADR-093.)
  // (/api/spotify is no longer hard-mounted: Spotify carved to the oshal-applications store,
  //  ADR-085 Wave 2 #2 — the installed package's manifest mounts it (auth: service-or-oidc).
  //  The spotify-concierge bot-node quadruple stays core per ADR-093.)
  // (/api/movies is no longer hard-mounted: Movies & TV carved to the oshal-applications store,
  //  ADR-085 Wave 2 #1 — the installed package's manifest mounts it (auth: oidc). The
  //  movies-concierge REAL bot-node (movies-bot container + registries + personas + toolkit)
  //  stays core as the ADR-093 interim operator fragment.)
  // (/api/drone is no longer hard-mounted: Drone Ops carved to the oshal-applications store,
  //  ADR-085 Wave 3 — the installed package's manifest mounts it (auth: service-or-oidc), so
  //  drone nodes keep heartbeating with the service secret. The drone ENGINE
  //  (src/features/drone), the standalone drone-node server + DRONE_EMBEDDED_SIMS, and the
  //  drone-operator inline node stay core per ADR-093; ADR-099: drones ARE swarm nodes.)
  // Camera Ops: carved to the oshal-applications store (ADR-085 Wave 3). The installed package's
  //  manifest mounts the SAME /api/camera (auth: service-or-oidc) so camera-node heartbeats keep the
  //  service secret and browsers use OIDC. The camera ENGINE (src/features/camera) stays core per
  //  ADR-093 — the package imports it via @/; the package surface now carries the browser-webcam path.
  // (/api/sat is no longer hard-mounted: Sat Ops carved to the oshal-applications store,
  //  ADR-085 Wave 3 — the installed package's manifest mounts the SAME /api/sat (auth:
  //  service-or-oidc), so sat nodes keep heartbeating with the service secret and live
  //  evidence probes stay valid. The sat ENGINE (src/features/sat-ops), the standalone
  //  sat-node server, and the sat-operator inline node stay core per ADR-093; ADR-102:
  //  sats ARE swarm nodes. Every embeddable engine is a simulator by construction.)
  // ADR-067 connector marketplace: audited catalog + deployment-level enable/disable.
  // Per-user credentials still resolve through the broker at execution time.
  app.use('/api/connectors', requiresAuth, createConnectorMarketplaceRoutes(ctx));
  // ADR-065/067 connector spec routes: mount two stable parameterized delegates (read + action),
  // not one route per catalog entry. OFF by default — set CONNECTOR_SPEC_ROUTES=on to enable.
  // Every request checks deployment + caller marketplace enablement before loading the exact
  // provider spec; caller credentials resolve through the broker only after those gates pass.
  // Additive + parallel to the bespoke routes above (e.g. /api/travel) — they are unaffected.
  if (process.env.CONNECTOR_SPEC_ROUTES === 'on') {
    mountConnectorSpecRoutes(app, ctx, requiresAuth, { providerGate: ctx.connectorMarketplaceService });
    // Connector write-action tier: POST /api/connectors/:id/actions/:action — opt-in `actions`
    // blocks in connector.yaml, approval-gated (428 confirm rail) + audited (connector_action_audit).
    // Deliberately behind the SAME gate: the write tier is never on where the read tier is off.
    mountConnectorActionRoutes(app, ctx, requiresAuth, { providerGate: ctx.connectorMarketplaceService });
  }
  // ADR-065 connector webhook ingress: POST /api/hooks/:provider/:event (signature-verified, deduped,
  // -> swarm ticket). Machine-to-machine (no OIDC). OFF by default — set CONNECTOR_WEBHOOKS=on.
  if (connectorWebhookIngressEnabled()) {
    mountConnectorWebhookRoutes(app, ctx);
  }
  // ADR-066 personal knowledge graph (end-to-end): ingest a connector's data into a user-owned graph
  // then query it. POST /api/personal-graph/ingest/:provider -> pull+ingest+reverberate; GET
  // /api/personal-graph/* -> stats/nodes/neighbors. In-memory store (process-lifetime; Postgres store
  // via migration 057 is the persistence upgrade). OFF by default — set PERSONAL_GRAPH_ROUTES=on.
  if (process.env.PERSONAL_GRAPH_ROUTES === 'on') {
    const personalGraphStore = new InMemoryGraphStore();
    app.use('/api/personal-graph/ingest', requiresAuth, createPersonalGraphIngestRoutes({ pool: ctx.pool, store: personalGraphStore }));
    app.use('/api/personal-graph', requiresAuth, createPersonalGraphRoutes({ store: personalGraphStore }));
  }
  // (/api/travel is no longer hard-mounted: the Travel surface carved to the
  // oshal-applications store (ADR-085 Wave 3) — its route dynamic-mounts from the
  // installed package via ManifestRouteMounter. The swarm-shared price engine + the
  // fare-watch cron below, the duffel connector/CLI, and the travel-concierge node
  // stay core per ADR-093.)
  startTravelFareWatchCron(ctx); // cron: re-price active fare watches, grow the swarm price DB, flag drops
  // AI Test Lab nightly golden loop (ADR-063 §nightly): headless via serviceSecretOr so the
  // host-side nightly runner can drive it with X-Service-Secret. Mounted BEFORE the auth-gated
  // /api/test-lab so /api/test-lab/golden/* resolves here first.
  app.use('/api/test-lab/golden', serviceSecretOr(requiresAuth), createTestLabGoldenRoutes(ctx));
  // AI Test Lab — black-box E2E runner (ADR-063): drives the real endpoints + Jarvis, per-tool + coupled scenarios. requiresAuth-gated.
  app.use('/api/test-lab', requiresAuth, createTestLabRoutes(ctx));
  // Persona regression evals (golden-task gate): run ai-lab/persona-evals suites through the
  // active provider lane; structural assertions always graded, semantic rubrics skipped-with-notice
  // under noop. Operator-gated (real-lane runs spend tokens; the router re-gates internally too).
  app.use('/api/persona-evals', requiresAuth, requiresOperator, createPersonaEvalRoutes(ctx));
  // Eval Wall (ADR-063 §eval-wall): the green-wall dashboard — success rate, cost, latency,
  // retries, quality, security posture over the persisted eval_runs history. requiresAuth-gated.
  registerEvalWallRoutes(app, ctx, requiresAuth);
  app.use('/api/config', requiresAuth, createConfigRoutes());
  app.use('/api/logs', requiresAuth, createLogsRoutes(ctx));
  registerSwarmExtensionRoutes(app, requiresAuth, ctx.swarm);
  app.use('/api/tasks', requiresAuth, createTaskRoutes(ctx));
  app.use('/api/stream', requiresAuth, createStreamRoutes(ctx));
  // ctx → per-user TTS provider/voice prefs (JVV-012) ride the same auth-gated mount.
  app.use('/api/voice', requiresAuth, createVoiceRoutes(ctx));
  // Swarm application REST + UI profile surfaces (gate middleware + instance
  // already set up before the app-owned route mounts).
  app.use('/api/swarm/apps', requiresAuth, createSwarmAppRoutes(swarmAppService, appAccessService));
  app.use('/api/swarm/packs', requiresAuth, createSwarmPackRoutes(swarmAppService));
  // ADR-085 packaged skins: surfaces authored against core skins request
  // /cockpit/css/themes/<id>.css. The cockpit express.static mount (registered earlier)
  // serves core themes; on a miss this serves an ACTIVE package's bundled ui/<id>.css so
  // carved-out apps keep the legacy contract (little-monsters' 18 iframe surfaces).
  app.get('/cockpit/css/themes/:file', requiresAuth, createPackagedThemeCssFallback(swarmAppService));
  // Gate the first autoload pass on migration completion: on a clean DB it otherwise races
  // migration 022 (swarm_applications) and logs ~40 self-healing ERROR lines. Bounded — on
  // timeout/failed bootstrap autoload proceeds and its own retry wrapper self-heals.
  // Background boot DB work — auto-load manifests, audit bot wiring, demo seed — runs with NO
  // request identity. Stamp it as trusted SYSTEM (runWithSystemIdentity) so it keeps operator
  // visibility once OSHAL_DB_GUC_STRICT denies the "no context" case: seedDemoData writes the
  // FORCE-RLS tickets/workspaces tables, which an identity-less run would be starved from.
  // Boot-window truth for the final /api fallback: the server listens BEFORE this auto-load
  // chain mounts store-package routes (an ~18s gap on a real boot), so "no route matched" is
  // not yet "not found" — a package surface like /api/sat/app may be seconds from mounting.
  // The fallback answers 503 until this flips (2026-07-24 sat-ops boot-window 404 report).
  // Hard time cap as a safety valve: on a box where the DB never comes up, the bounded
  // bootstrap wait + autoload retries can hold this window open for minutes — after the cap
  // the fallback answers real 404s regardless, so a broken dependency can't 503 /api forever.
  let packageRoutesSettled = false;
  const bootWindowDeadline = Date.now() + Number(process.env.OSHAL_API_BOOT_WINDOW_MS ?? 180_000);
  void runWithSystemIdentity(() => waitForBootstrapComplete().then((migrated) => {
    if (!migrated) logger.warn('Swarm app auto-load proceeding without confirmed DB bootstrap completion');
    return swarmAppService.autoLoadAllWithRetry();
  }).then(async () => {
    // Package routes are as mounted as they will get: the final /api fallback may now answer
    // a hard 404 instead of the boot-window 503 (see createApiFallbackHandler below). Flipped
    // BEFORE the wiring audit + demo seed — those don't mount routes.
    packageRoutesSettled = true;
    // Fail-loud guard: a manifest bot with no endpoint-registry entry compiles green but throws at
    // execute time (the "compiles-but-fails" trap). Audit after load so any gap is screamed at boot.
    await auditSwarmBotWiring(swarmAppService);
    // Demo-mode seeding runs AFTER manifests load so per-row dynamic UIs
    // (class icons) register against the same in-memory tool registry
    // that the LM manifest just populated.
    if (shouldSeedDemoData()) {
      const summary = await seedDemoData(ctx.pool);
      logger.info({ summary }, 'Demo-mode seed summary');
    }
  }).catch(err => {
    // Fail open to real 404s: autoLoadAllWithRetry has exhausted its retries, so routes that
    // aren't mounted now are not coming — a permanent 503 here would mask genuine misses.
    packageRoutesSettled = true;
    logger.error({ err }, 'Swarm app auto-load failed during boot (non-fatal)');
  }));
  app.use('/api/ui', requiresAuth, createUiProfileRoutes(new UIProfileService(), swarmAppService));

  // Demo auth routes — ONLY in MOCK_OIDC mode. In production OIDC deployments
  // express-openid-connect owns /login and /logout, and we must NOT leak the
  // fabricated "Alex" identity from createDemoAuthRoutes via /api/auth/user.
  if (process.env.MOCK_OIDC === 'true') {
    app.use('/', createDemoAuthRoutes());
  }

  // Layer 1 Tools Framework routes
  // Internal bots register their UI surfaces here with X-Service-Secret (no OIDC session);
  // external callers still hit the OIDC wall. serviceSecretOr falls through to requiresAuth.
  // ADR-085 D11: the 4th arg is the manifest-ownership port. These routes are reachable by any
  // signed-in user and every bot node (serviceSecretOr), and POST /runtime/register +
  // DELETE /runtime/:toolName would otherwise repoint or delete a tool an ACTIVE app owns —
  // a second write door straight past manifest ownership. Now they 409, naming the owning app.
  app.use('/api/tools', serviceSecretOr(requiresAuth), createToolRoutes(
    ctx.toolController,
    ctx.runtimeToolRegistrationService,
    ctx.pool,
    (toolName) => swarmAppService.manifestToolOwner(toolName),
  ));
  // Claude Code MCP tools bridge: list/execute a bot's swarm-registered tools (scripts/oshal-tools-mcp.mjs).
  app.use('/api/tools', serviceSecretOr(requiresAuth), createInternalToolBridgeRoutes(ctx));
  app.use('/api/tools/verify', requiresAuth, createVerificationRoutes(ctx.verificationController));
  app.use('/api/agents', requiresAuth, createAgentProfileRoutes(ctx.agentProfileController));
  app.use('/api/agents', requiresAuth, createAgentToolRoutes(ctx.agentToolController));
  app.use('/api/agents', requiresAuth, createAgentStatusRoutes(ctx.pool));

  // Governance activation (Phase 0): audit export + posture, eval green-wall, LLM
  // budget/quota status. All read-only and behind requiresAuth. Controls stay
  // permissive until their enforce flags are set (OSHAL_RBAC_ENFORCE / OSHAL_LLM_BUDGETS).
  registerAuditExportRoutes(app, ctx, requiresAuth);
  // Data lifecycle: per-user export + two-step delete, mounted at /api/me
  // (segment-bounded — does not shadow /api/memory). Always auth-gated.
  registerDataLifecycleRoutes(app, ctx, requiresAuth);
  app.use('/api/privacy', requiresAuth, createPrivacyRoutes(ctx));
  // registerEvalWallRoutes already mounted above (line ~1095).
  registerLlmGovernanceRoutes(app, ctx, requiresAuth);
  // NOT wrapped in requiresAuth on purpose: this route has its own fail-closed
  // authorizeRemoteClient gate (valid OIDC session OR REMOTE_CLIENT_SHARED_SECRET
  // bearer). Wrapping it in requiresAuth would reject the bearer path that remote
  // bot-nodes use. Per-caller rate limiting is SHIPPED router-local (remote-client-routes.ts
  // seq 11): flag-gated OSHAL_RATE_LIMIT_REMOTE_CLIENTS (default off — flip deliberately,
  // a legit fleet's heartbeats share this path), keyed on the /:clientId segment, never the
  // NATed IP. Guard: tests/unit/remote-client-auth.spec.ts.
  // Higher json limit here so node task-complete bodies with screenshots (screen.capture) aren't
  // rejected with 413. Scoped to this router only (the global parser above skips these paths).
  app.use('/api/remote-clients', express.json({ limit: '25mb' }), createRemoteClientRoutes({
    // Backs POST /:clientId/token/rotate (per-node worker-plane credentials, hardening #7).
    pool: ctx.pool,
    meshCommunicationService: ctx.swarm.meshCommunicationService,
    runtimeRegistryService: ctx.swarm.runtimeRegistryService,
    orchestrator: ctx.orchestrator,
    // Task-result landing: the journal outbox awaits this repository directly;
    // remoteTaskResult mesh delivery is a compatibility notification, not the durability boundary.
    workItemRepository: ctx.swarm.workItemRepository,
    // ADR-036 cost capture for leaf-node LLM tasks (apply / linkedin / any dispatchBrowserTask):
    // a completed/failed codex.exec run is metered into chat_tasks attributed to its accountable bot.
    recordCostOnce: ctx.swarm.costTrackingService
      ? (outboxId, event) => ctx.swarm.costTrackingService!.recordCostOnce(outboxId, event)
      : undefined,
  }));
  app.use('/api/v1/agent', requiresAuth, createScheduleRoutes(scheduleController));
  // Debug/observability routes (WS1: runtime trace analyzer)
  // Auth-gated — trace responses include workspace paths, file content,
  // and persona/handoff details. Same sensitivity as other admin APIs.
  registerDebugRoutes(app, requiresAuth);
  // RAG routes (ChromaDB integration)
  const ragService = new RagService();
  app.use('/api/rag', requiresAuth, createRagRoutes(ragService, ctx.memoryService, ctx.pool));
  // Global search — one caller-scoped box over the caller's OWN swarm data
  // (tickets / chat history / personal vault / permission-aware RAG). Shares the
  // /api/rag RagService instance so both surfaces rank identically.
  // listApps is injected (not imported inside the route) because a features slice may not reach
  // SwarmAppService; it is passed UNFILTERED on purpose - AppsSearchSource owns the tested
  // caller-visibility rule, and pre-filtering here would make two filters where one is auditable.
  app.use('/api/search', requiresAuth, createGlobalSearchRoutes(ctx, ragService, apiDir, {
    listApps: () => swarmAppService.listApps(),
  }));
  // (/api/presentations is no longer mounted: the legacy Presentron HTTP sidecar proxy was
  //  retired — its presentron:8080 backend is gone and the render path moved to the in-repo
  //  deck engine. The packaged AI Office surface owns /api/presentations/sections.)
  // RCA analysis routes — analysis runs on the rca-specialist bot via ctx
  // (executeBotOrInline budget gate); honest 501/503 when disabled/unreachable.
  app.use('/api/rca', requiresAuth, createRcaRoutes(ctx));
  app.use('/api/process-lab', requiresAuth, createProcessLabRoutes(ctx));
  app.use('/api/workflow-studio', requiresAuth, createWorkflowStudioRoutes({ pool: ctx.pool }));
  // Talk-to-build concierge: POST /api/workflow-studio/chat runs the reason-only workflow-assistant
  // bot (051) via the orchestrator and saves the graph it emits, so the canvas redraws as the
  // operator describes it. Standard concierge transport (like movies/spotify). See docs/building-a-bot.md.
  app.use('/api/workflow-studio', requiresAuth, createWorkflowStudioAssistRoutes(ctx));
  // Run history + run inspector (studio Runs panel): GET /runs (owner-scoped) + GET /runs/:runId.
  // Read-only view over workflow_runs / workflow_run_steps recorded by the graph dispatch worker.
  app.use('/api/workflow-studio', requiresAuth, createWorkflowRunRoutes({ pool: ctx.pool }));
  // Batch Job runtime/resource telemetry: read-only report over oshal_batch_job_runs.
  app.use('/api/batch-jobs', requiresAuth, createBatchJobTelemetryRoutes({ pool: ctx.pool, apiDir }));
  // (/api/presentations/sections is no longer hard-mounted: AI Office carved to the
  //  oshal-applications store, ADR-085 Wave 2 — the package mounts it, auth: oidc in its
  //  manifest. The legacy Presentron HTTP sidecar proxy at /api/presentations has been
  //  retired — dead backend, render path moved in-repo.)
  // (/api/video is no longer hard-mounted: the Video Studio carved to the oshal-applications
  //  store, ADR-085 Wave 3 — the package mounts it, auth: oidc in its manifest. The series
  //  CONDUCTOR engine stays core: series-{pipeline,orchestrator,dispatch,drive}.ts, the
  //  video-generation slice, and the reconciler below — ADR-093.)
  // Video-series render reconciler: as each episode finishes on the node, mark it `rendered` and
  // advance its series (dispatch the next, or finish). Only ever progresses work already past the
  // approval gate — it never authorizes new spend.
  startSeriesReconciler(ctx);
  // The joke-shorts pump: the driver that keeps the same conductor producing. Off unless
  // VIDEO_PUMP_ENABLED=true, and each show is opt-in again through its own enrollment — an
  // automated production loop is never on by default. It refuses to touch the render node while
  // the nightly recap (or anything else) owns it.
  startVideoPump(ctx);
  // /api/lora is no longer hard-mounted: LoRA Studio was carved out to the oshal-applications
  // store (ADR-085 Wave 1) — its split mounts (public self-guarded /api/lora/ingest + oidc
  // /api/lora) dynamic-mount from the installed package via ManifestRouteMounter.
  app.use('/api/checkpoints', requiresAuth, createCheckpointRoutes(ctx));
  app.use('/api/optimize', requiresAuth, createOptimizeRoutes(ctx));
  app.use('/api/token-chase', requiresAuth, createTokenChaseRoutes(apiDir, ctx));
  app.use('/api/memory', requiresAuth, createMemoryRoutes(ctx));
  // In-product help: docs/guides rendered for the signed-in user. Auth-gated like every other
  // surface — the guides describe operator-gated screens, so they are not anonymous-callable.
  app.use('/api/help', requiresAuth, createHelpRoutes());

  // Internal ticketing system routes
  app.use('/api/tickets', requiresAuth, createTicketRoutes(ctx));
  app.use('/api/workspaces', requiresAuth, createWorkspaceRoutes(ctx));

  // Cockpit API routes (projects, tickets, metrics) — mounted first so ticket-store-backed
  // hierarchy takes priority over the task-explorer fallback
  const cockpitApiRouter = createCockpitRoutes(ctx);
  app.use('/api/v1', requiresAuth, cockpitApiRouter);

  const taskExplorerApiRouter = createTaskExplorerRoutes(ctx);
  app.use('/api/v1', requiresAuth, taskExplorerApiRouter);

  // Intake assistant routes (conversational ticket creation)
  if (ctx.ticketService) {
    const { createIntakeAssistantRoutes } = require('./routes/intake-assistant-routes');
    app.use('/api/v1/intake', requiresAuth, createIntakeAssistantRoutes(ctx.ticketService));
  }

  // Prometheus Alertmanager webhook -> incident ticket intake (swarm self-healing).
  // Machine-to-machine: mounted WITHOUT requiresAuth; self-guards via ALERT_WEBHOOK_TOKEN.
  // ADR-119 P3: the FR-E2 analyst budget gate reads its actuals from the cost ledger via
  // the pool-backed reader; a pool-less run wires null and the gate passes through.
  if (ctx.ticketService) {
    const { createAlertmanagerRoutes } = require('./routes/alertmanager-routes');
    const { createPoolRcaSpendReader } = require('./routes/alertmanager-rca-spend');
    app.use('/api/alerts', createAlertmanagerRoutes(ctx.ticketService, {
      rcaSpend: ctx.pool ? createPoolRcaSpendReader(ctx.pool) : null,
      // With a pool the webhook LANDS the delivery before anything reads it and answers 202 after
      // the commit (503 when the landing fails, so the sender retries). Without one it keeps the
      // in-memory path exactly as before, so a pool-less run is unchanged.
      pool: ctx.pool ?? null,
    }));
  }

  // Operations Stream read + admin surface. Reads are open to any authenticated caller; every
  // mutating route additionally carries requiresOperator on the route itself, so re-mounting this
  // line cannot silently widen it.
  if (ctx.pool) {
    const { createOpsPipelineRoutes } = require('./routes/ops-pipeline-routes');
    app.use('/api/ops/alert-pipeline', createOpsPipelineRoutes({ pool: ctx.pool, requiresAuth }));
  }

  // Inbound SMS webhook (Twilio replies) -> POST /api/sms/inbound. Machine-to-machine: mounted
  // WITHOUT requiresAuth; self-guards with the Twilio request signature (X-Twilio-Signature vs
  // TWILIO_AUTH_TOKEN) and 503s when that token is unset, so it is disabled-by-default and safe to
  // mount unconditionally, mirroring the Alertmanager + connector-webhook ingresses.
  {
    const { createSmsInboundRoutes } = require('./routes/sms-inbound-routes');
    app.use('/api/sms', createSmsInboundRoutes());
  }

  // Personal-Intelligence surface (ADR-058) — the per-user vault. Start-param gated inside the
  // factory (ENABLE_PERSONAL_INTELLIGENCE); auth-walled so ownerSub comes from the session.
  {
    const { createPersonalRoutes } = require('./routes/personal-routes');
    app.use('/api/personal', requiresAuth, createPersonalRoutes());
  }

  // (/api/world unmounted: World Intelligence carved to the app store, ADR-085 Wave 3 —
  //  the package mounts the same path with the same public/self-guarded posture; the
  //  world-data ENGINE + world-schedule-dispatch stay core, ADR-093.)

  // SSE streaming endpoint for cockpit real-time updates
  app.get('/streaming', requiresAuth, (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : 'unknown';
    logger.info({ sessionId }, 'SSE cockpit streaming connection opened');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId, timestamp: Date.now() })}\n\n`);
    const heartbeat = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`); }
      catch (e) { clearInterval(heartbeat); }
    }, 30000);
    req.on('close', () => { clearInterval(heartbeat); });
  });

  // Internal queue-manager/bot-node dispatch uses the same message route as the cockpit chat path.
  // Browser users still go through OIDC; trusted service calls must present SWARM_SERVICE_SECRET.
  app.use('/api', serviceSecretOr(requiresAuth), createMessageRoutes(ctx));

  // ── Onboarding, Config Health, What's New, Swarm Presets ──
  const { createConfigHealthRoutes } = require('./routes/config-health-routes');
  const { createOnboardingRoutes } = require('./routes/onboarding-routes');
  const { createWhatsNewRoutes } = require('./routes/whats-new-routes');
  const { createSwarmPresetRoutes } = require('./routes/swarm-preset-routes');
  app.use('/api', requiresAuth, createConfigHealthRoutes(ctx));
  app.use('/api', requiresAuth, createOnboardingRoutes(ctx));
  app.use('/api', requiresAuth, createWhatsNewRoutes());
  app.use('/api', requiresAuth, createSwarmPresetRoutes(ctx));

  // ── Haven Home Assistant ──
  const { createHavenRoutes } = require('./routes/haven-routes');
  app.use('/api', requiresAuth, createHavenRoutes(ctx));

  // The legacy monitoring-platform graph/OpenSearch proxy routes + pipeline snapshotter
  // were archived (that product integration is retired). They were already disabled
  // here; re-wire from the archive only if that integration is ever brought back.

  // Unknown /api/* paths must answer JSON, never Express's default HTML "<!DOCTYPE" 404 page —
  // every cockpit fetch parses /api responses as JSON, so an HTML 404 surfaces to the operator
  // as `SyntaxError: Unexpected token '<'` (the super-admin dev-console pane hit exactly this
  // when a dev-console route was unmounted). Registered as the LAST /api middleware: every
  // static mount above wins, and dynamically-installed app-package routes still win because
  // their dispatcher middleware (ManifestRouteMounterImpl, constructed earlier in createApp)
  // sits earlier in the chain. During the boot window (before swarm-app auto-load settles)
  // the handler answers 503 + Retry-After instead — with a self-refreshing HTML splash for
  // browser/iframe navigations — so a cockpit surface that loads mid-boot (the 2026-07-24
  // /api/sat/app report) self-heals instead of sitting on a hard 404.
  const { createApiFallbackHandler } = require('./routes/api-fallback');
  app.use('/api', createApiFallbackHandler(() => packageRoutesSettled || Date.now() >= bootWindowDeadline));

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const oidcLoginRestartBase = loginRestartPathForCallbackPath(req.path);
    if (oidcLoginRestartBase && isOidcStateMismatchError(error)) {
      const restartPath = buildOidcLoginRestartPath(req.query.state, oidcLoginRestartBase);
      logger.warn(
        { err: error, path: req.path, method: req.method, restartPath },
        'OIDC callback state mismatch detected; restarting login',
      );
      res.redirect(302, restartPath);
      return;
    }

    logger.error({ err: error, path: req.path, method: req.method }, 'Unhandled Express error');
    const status = (error as any)?.status ?? (error as any)?.statusCode ?? 500;
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(status).json({ error: message });
  });

  logger.info('Express app configured');
  return app;
}

/**
 * @description Starts the Express server on the configured port.
 */
function startServer(): void {
  const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const app = createApp();
  const callbackPort = resolveOpenAiCodexCallbackPort(port);

  listenOnPort(app, port, 'primary');

  if (callbackPort !== null) {
    listenOnPort(app, callbackPort, 'openai-codex-callback');
  }
}

/**
 * @description Resolves the optional OpenAI Codex callback listener port.
 * Uses OPENAI_CODEX_CALLBACK_PORT when provided, otherwise defaults to 1455.
 *
 * @param primaryPort - Primary OSHAL app port used for normal UI/API traffic
 * @returns Callback port number, or null when callback listener should be skipped
 */
function resolveOpenAiCodexCallbackPort(primaryPort: number): number | null {
  const rawPort = process.env.OPENAI_CODEX_CALLBACK_PORT ?? String(DEFAULT_OPENAI_CODEX_CALLBACK_PORT);
  const parsedPort = parseInt(rawPort, 10);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    logger.error({ rawPort }, 'Invalid OPENAI_CODEX_CALLBACK_PORT; skipping callback listener');
    return null;
  }

  if (parsedPort === primaryPort) {
    logger.info({ parsedPort }, 'OpenAI Codex callback listener uses primary app port; secondary listener skipped');
    return null;
  }

  return parsedPort;
}

/**
 * @description Starts an HTTP listener for the shared Express app on a specific port.
 *
 * @param app - Express application instance
 * @param port - Port number to bind
 * @param role - Listener role label used for structured startup logs
 */
function listenOnPort(app: express.Application, port: number, role: string): void {
  const srv = app.listen(port, () => {
    logger.info({ port, role }, 'OSHAL control plane server listening');
  });
  // Bound the HTTP-layer timeouts so a slow/stuck client socket can't pin a worker. headersTimeout
  // must exceed requestTimeout; keepAliveTimeout sits just under a typical 60s upstream idle so the
  // proxy (cloudflared) closes idle connections, not the server mid-request.
  srv.requestTimeout = 30000;
  srv.headersTimeout = 35000;
  srv.keepAliveTimeout = 61000;
}

/* Code-server bridge routes extracted to ./routes/code-server-bridge-routes.ts */

if (require.main === module) {
  /* ── Process-level crash guards ──────────────────────────────────────────
   * Node 15+ terminates on unhandled promise rejections with NO output, so
   * without these the control plane dies silently after a stray rejected
   * Redis call, an SSE write-to-closed-socket, or any other unawaited async
   * error.  The behaviour is unchanged; it now lives in one shared installer
   * so every long-running runtime gets the same guarantee — bot-node-server,
   * which owns all LLM execution, had none of this until 2026-07-27.
   * ───────────────────────────────────────────────────────────────────── */
  installProcessCrashGuards('swarm-controller');

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM — shutting down');
    // schedule-runtime.ts already registered once('SIGTERM') which suppresses
    // Node's default terminate action.  Drain the shutdown hooks (db pool, queue
    // manager — see @/shared/services/shutdown-hooks) then exit; the timer stays
    // as the force-exit backstop so `kill <pid>` always works.
    void runShutdownHooks().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });

  process.on('SIGINT', () => {
    logger.info('Received SIGINT — shutting down');
    void runShutdownHooks().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });

  process.on('exit', (code) => {
    // This fires synchronously just before the process exits — useful for
    // post-mortem diagnosis even when the trigger was an unhandled signal.
    logger.info({ exitCode: code }, 'Process exiting');
  });

  startServer();
}

export { createApp, buildCodeServerRedirectUrl };
