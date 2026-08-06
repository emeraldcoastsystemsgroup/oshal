# OSHAL Backlog

This file contains only unfinished or externally blocked outcomes. Completion history belongs in the relevant ADR, runbook, package README, release note, or evidence record; when an item closes, remove it from this queue.

Framework, kernel, shared-service, security-boundary, and orchestration work belongs in this repository. Application-owned work belongs in [`oshal-applications`](https://github.com/emeraldcoastsystemsgroup/oshal-applications); core entries below retain only a framework dependency or a concise pointer to the owning package.

Every item has an observable **Done when**. Live-proof requirements cannot be closed from unit results alone.

## Promotion, deployment, and regression proof

### Rides map and fare follow-ups
- **Remaining:** install the merged [`rides`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/rides) package; decide optional OSRM/Valhalla and Google Maps billing paths; make geocode/tile configuration operator-owned and the normalized-address cache durable.
- **Done when:** the live package serves vendored Leaflet and reports `provider: "osm"`; keyless routing is either backed by `OSHAL_ROUTING_URL` or explicitly accepted as straight-line-plus-factor; any Google browser key is referrer-restricted; restarts do not repeat cached geocodes.

### Guest Jarvis turn and public demo card
- **Remaining:** promote merged guest-write support from a quiet, current `main`, then restore only the OSHAL Assistant guest card after production verification.
- **Done when:** deploy parity is green, the running container contains `guestSpendsModel`, a real guest can start a session, create a task, and post a message with a 200 response, and the restored public card passes the same anonymous flow.

### Alert-triage A1/A2 containment drill
- **Remaining:** deploy the current alert-triage implementation and exercise A1 approval, A2 autonomous containment, refusal, and rollback against the live ticket path.
- **Done when:** one dated drill records correct transitions and audit fields for all four legs, with no restart, privilege widening, or unapproved mutation. See [ADR-119](adr/119-autonomous-health-ticket-processing.md).

### Strategy Studio and Bot Forge conversational parity
- **Remaining:** run a real Studio design/refine/apply/revert cycle; add edit-in-place for an existing Forge pack if commissioned; reconcile the `codex-packer`/`self-healing-bot` agent-name drift.
- **Done when:** two refinements update one strategy row through a live LLM session, Forge re-emits the same pack rather than a duplicate, and registry/DB integrity reports no unexplained name mismatch.

### Nightly tasks still launched from the ADR-115 archive
- **Remaining:** make keepalive, recap, Kalshi, and signal launchers self-locating, repoint their actual Task Scheduler actions to this trunk, and explicitly retain or relocate the private Evidence-Nightly job.
- **Done when:** each movable task test-runs from `C:\Projects\oshal`, its scheduler action names that path, and Evidence-Nightly is documented at an intentional private location. See [ADR-115](adr/115-clean-trunk-branch-strategy.md).

### Scheduled Local CI unattended proof
- **Remaining:** inspect an unprompted 23:30 scheduler run; do not substitute a manual launch.
- **Done when:** its log names `archive-ref=origin/main`, records the exact fetched SHA, and Task Scheduler's result equals the completed gate's exit code. See [ADR-090](adr/090-github-actions-to-local-ci.md).

### `deploy.yml` persistent-target disposition
- **Remaining:** replace runner-local "deployment" with a real persistent target, or rename the workflow to image/build validation and remove deployment claims.
- **Done when:** a successful deploy job changes a durable environment and passes a post-deploy health/parity check, or no workflow/documentation describes ephemeral-runner validation as deployment.

### CI Playwright red-baseline retirement
- **Remaining:** root-cause the specs outside the current green ratchet and separate product defects, fixture/auth defects, and intentionally unsupported cases.
- **Done when:** every spec uses the configured origin, each unsupported case has an explicit disposition, and the complete CI Playwright job is green without retry-dependent success.

### Dev-console `/work` under Linux user-namespace remapping
- **Remaining:** make the ADR-077 sandbox scratch mount writable to remapped container users without widening host access beyond the per-run directory.
- **Done when:** a GitHub-Actions-equivalent userns-remap container writes inside `/work`, cannot escape it, and the focused sandbox/security guards pass. See [ADR-077](adr/077-self-developing-platform-and-super-admin-dev-console.md).

### Remote-client full-suite flake
- **Remaining:** test the module-level registry and rate-limiter state leads in the auth spec; isolate file state or serialize only the affected specs if needed.
- **Done when:** the full unit suite passes 20 consecutive runs with no remote-client timeout; any serialization is local and documented, not a global concurrency reduction.

### Tree-walk guard stability
- **Remaining:** complete two additional fully provisioned unit runs after the local timeout fix; environmental database/harness failures do not count.
- **Done when:** `npm run test:unit` is green three consecutive times with both repository-separation and no-dev-secret-fallback guards enabled and no global timeout increase.

### CI secret-scanner remote mutation proof
- **Remaining:** use a disposable branch to plant the scanner's sanctioned test secret, observe the remote failure, remove it, and rerun.
- **Done when:** linked CI evidence shows fail-then-pass caused by that fixture and no real credential enters Git history.

### Build-phase escalation golden run
- **Remaining:** execute the current escalation workflow through its real provider/tool boundary from a clean fixture and retain its trace and artifacts.
- **Done when:** one repeatable live run exercises every escalation phase without manual state repair and records caller identity, tool results, cost, and terminal outcome.

### Inline-bot deployed identity smoke
- **Remaining:** run the inline path once as a restricted user and once as an operator, recording identity at the authorization boundary.
- **Done when:** the restricted caller never inherits service/operator privilege, the operator succeeds, and the live trace matches the identity guards.

### Registry installer fresh-machine trial
- **Remaining:** exercise the codebase-free GHCR installer on a clean Docker-only machine with enough memory for the batched bring-up.
- **Done when:** `oshal-install.sh` reaches a signed-in cockpit, required services heartbeat, and one ticket round-trips without a source checkout; expected missing developer-only assets are documented.

### Installer runtime-proof gaps
- **Remaining:** add manifest-declared per-app smoke, explicit `OSHAL_NO_AI=true` UI states, and an opt-in PAT-backed `oshal-verify.sh --live` generation check.
- **Done when:** a deliberately broken package fails by name, every surface class renders an honest no-AI state, and a configured deployment returns a non-stub live response.

### Public prebuilt-image fast path
- **Remaining:** at launch, publish versioned images, make the installer pull them by default with a local-build fallback, and reduce the image where practical.
- **Done when:** a clean machine reaches a working cockpit without compiling locally and the documented timing includes the actual image download. This is distinct from the private-registry trial above.

### Docker Desktop port-forward wedge
- **Remaining:** identify an upstream Docker Desktop fix or a supported host-network/reverse-proxy workaround for the Windows localhost forwarding failure.
- **Done when:** the documented recovery or supported topology survives repeated API/container restarts without the host port becoming unreachable while the container remains healthy.

### Dev-box disk reclamation
- **Remaining:** inspect then drop the confirmed orphan restore database and extend the scoped cleanup path for reclaimable OSHAL images/volumes; never use a bare global Docker prune.
- **Done when:** exact pre/post disk figures are recorded, the intended orphan only is removed, and all active swarm volumes and databases pass health checks afterward.

### Real-boundary regression doctrine
- **Remaining:** add the integration-boundary corollary to `CLAUDE.md` and audit specs that stub the same database, resolver, image config, or gateway whose failure they claim to prevent.
- **Done when:** each identified boundary fix has at least one guard using the real seam, beginning with ticket/store gateways and aliased module resolution, and the audit has explicit dispositions.

### Legacy product-name archival disposition
- **Remaining:** classify old names under `docs/archive`, top-level `archive`, and release collateral as intentionally historical or rewrite them; regenerate current evidence still using retired names.
- **Done when:** current docs/evidence use sanctioned naming and every retained legacy occurrence is clearly marked historical.

## Security, tenancy, and trust boundaries

### ADR-087 access-role deferred layers
- **Remaining:** add per-user Jarvis visibility overrides, sandbox enforcement for restricted tools, manifest declarations, and the small cleanup items listed in [ADR-087](adr/087-access-roles-jarvis-visibility-scoping.md).
- **Done when:** user-specific hide/show cannot affect another user, scoped tools remain denied at execution as well as discovery, unknown manifest roles fail load, and role behavior is covered end to end.

### Two-tier tenant provisioning
- **Remaining:** implement manifest-selected isolated-database and shared-database provisioning; the shared tier first needs a tenant-scoped service identity rather than the current operator-equivalent system context.
- **Done when:** `provision-tenant.sh <name> --tenancy=isolated|shared` renders the correct namespace/database policy and a two-tenant proof blocks cross-tenant database and row access. See [ADR-035](adr/035-multi-tenant-saas-foundation.md) and [ADR-076](adr/076-tenant-aware-rls-and-least-privilege-db-role.md).

### Production Vault hardening
- **Remaining:** replace the local dev root-token server with persistent storage, TLS, unseal/recovery operations, AppRole/OIDC, backup, and documented rotation.
- **Done when:** a non-local deployment runs without a root token in application config, survives restart/unseal, and completes authenticated issue/use/revoke with audit evidence. See [ADR-040](adr/040-devops-vault-swarm.md).

### Vault cloud secrets engines
- **Remaining:** configure one real AWS STS or Kubernetes secrets engine with operator-owned credentials and a least-privilege role.
- **Done when:** the role issues a short-TTL credential, a real read succeeds, revocation makes reuse fail, and no standing cloud key is stored by a bot.

### Multi-user ephemeral privileged runtime
- **Remaining:** security-review and build a per-task, short-lived privileged runtime with tmpfs credentials, caller scoping, revocation, and residue inspection.
- **Done when:** two-user adversarial tests prevent cross-user credential/process access, a real privileged task uses only a brokered short-TTL credential, and teardown leaves no reusable secret. See [ADR-040](adr/040-devops-vault-swarm.md).

### App access tiers Phase 2
- **Remaining:** implement `oshal_app_access`, explicit-deny-wins resolution, operator assignment UI/API, route-boundary method enforcement, and manifest validation.
- **Done when:** deny returns 403 on every method, viewer writes fail, editor/admin defer to package capabilities, unknown tiers fail load, and ten kernel manifests plus intelligent-sales declare access. See [ADR-118](adr/118-app-access-tiers.md).

### Kernel-versus-app bot boundary
- **Remaining:** define kernel membership by agent ID, deploy migration 099's least-privilege `oshal_bot` role, rotate the shared-box password, and operationalize `OSHAL_OPERATOR_SUBS` denial review.
- **Done when:** kernel boot cannot dispatch to an unregistered app agent, a real bot DSN has neither superuser nor RLS-bypass, two-user RLS passes, and legitimate operator/queue paths remain allowed.

### Inline controller bot isolation
- **Remaining:** move Codex-harness inline bots out of the controller, remove unnecessary `DATABASE_URL` inheritance, and attack each deployed harness for controller and cross-user secrets.
- **Done when:** no controller-resident bot can read platform credentials or another user's tokens, and all required work runs through a dedicated least-privilege runtime.

### Bot-endpoint delegated identity
- **Remaining:** carry the initiating signed identity and entitlement through bot-to-bot calls; service-secret re-entry must not upgrade user work.
- **Done when:** a deployed restricted-user Jarvis call is denied before ticket/model/tool execution while an authorized operator path succeeds with an attributable audit trail.

### Own-data live database evidence
- **Remaining:** move the real export/delete and two-user isolation specs into the nightly evidence path using provisioned Postgres rather than loopback stores.
- **Done when:** competitive own-data gates link current database-backed pass evidence and fail when ownership/RLS mutations are introduced.

### Strict database identity (`OSHAL_DB_GUC_STRICT`)
- **Remaining:** inspect the remaining warn-mode audit sites, wrap intentional system work explicitly, then remove the Compose `warn` pin.
- **Done when:** the live stack runs `deny`, all normal flows pass, identity-less queries fail closed, and break-glass `off` remains documented but unused.

### Connector tenant-isolation documentation sync
- **Remaining:** update [connector tenant isolation](architecture/connectors-tenant-isolation.md) to describe the current caller identity, broker routing, and cross-user guards rather than the retired pre-implementation state.
- **Done when:** documentation matches executable behavior and links the current isolation tests without claiming runtime work remains.

### Spaces package dependency guard
- **Remaining:** protect the published Spaces package's undeclared imports of `@/features/drone` and `@/app/routes/cli-token-routes`, either through general package-dependency validation or targeted built-image assertions.
- **Done when:** CI fails before release if a required framework module would be pruned, and [ADR-090](adr/090-skills-as-first-class-packages.md) records the chosen contract.

### Biometric privileged-access module
- **Remaining:** if commissioned, define pluggable face/voice enrollment and challenge providers whose signed result can satisfy a high-privilege endpoint condition, with a non-biometric fallback.
- **Done when:** an enrolled user can unlock one protected bot/app, replay and cross-user challenges fail, and devices without camera/mic have a documented safe path.

### Platform SaaS account migration (paused by operator)
- **Remaining:** when unpaused, recreate platform-owned services under `maintainer@emeraldcoastsystemsgroup.com`, re-mint/re-consent credentials, and record the YouTube relinking flow; personal brokerage accounts remain out of scope.
- **Done when:** every platform credential traces to an ECSG-owned or explicitly demo-only account, old accounts are drained/closed as appropriate, the relinking video is published, and Twilio A2P is completed on the ECSG account.

## Workflow, agent, and model runtime

### ADR-045 graph-tier residuals
- **Remaining:** decide/build RCA-persona graph use, add `subgraph()` if still needed, and make store-package graph dependencies explicit through `uses:` or an ADR-backed alternative.
- **Done when:** each residual is implemented or explicitly rejected in [ADR-045](adr/045-two-tier-graph-database-and-connector.md), and package validation makes the graph dependency visible before activation.

### Workflow Studio draft execution and branching
- **Remaining:** execute an unpublished draft through the production runtime and add a repeatable live graph-mode branching/parallelism spec.
- **Done when:** both paths use the same compiler/runtime and run-history model as published workflows, with guarded branch outputs and terminal state. See [ADR-039](adr/039-bot-driven-workflow-authoring.md).

### Agentic workflow authoring and streamed canvas events
- **Remaining:** give the builder bot a tool that emits node/bot/tool events into the canvas and produces either a packed manifest or reviewer-gated ticket workflow; the basic compile/publish path is already complete.
- **Done when:** one cockpit conversation visibly builds a valid graph, passes validation, and emits a runnable workflow without hand-editing JSON.

### Argo ticket execution and promotion
- **Remaining:** submit queue work as an Argo Workflow, run one real incident-RCA ticket in cluster, persist its cost marker, and wire the documented `dev -> main -> Argo CD` promotion.
- **Done when:** the ticket completes in an isolated Workflow with cost/output evidence and the promoted revision syncs automatically without local batch execution. See [ADR-078](adr/078-kubernetes-argo-batch-and-multi-tenant-proofout.md).

### BYO/free-tier tool-capable turns
- **Remaining:** make BYO and platform-free connections participate in the accountable agentic tool loop, or explicitly restrict them to chat-only with honest UI capability labels.
- **Done when:** a free/BYO bot completes a guarded tool task with caller identity and cost metadata, or every surface prevents selecting that lane for tool-required work.

### Token Chase free-provider lanes
- **Remaining:** feed health-qualified free-provider rotation into Token Chase's variant selector instead of relying on manual provider coercion.
- **Done when:** only currently eligible lanes are offered, the chosen provider/model is recorded, and a provider failure rotates or fails closed without silently spending on a paid platform key.

### All-local Ollama profile
- **Remaining:** recreate Compose services with a reachable `OLLAMA_HOST`, register a Cline-harness Ollama bot, add the `oshal-model` Kubernetes Service, and benchmark a real ticket.
- **Done when:** Compose and Kubernetes both resolve the local endpoint and evidence records a successful ticket, latency/throughput, and zero available cloud credentials. See [ADR-078](adr/078-kubernetes-argo-batch-and-multi-tenant-proofout.md).

### Local-LLM hardware decision
- **Remaining:** inventory the existing gaming-PC GPU and choose the $0/current, used-3090, large unified-memory, or later fleet tier; no purchase is implied by this item.
- **Done when:** the operator records a tier and, if hardware is selected, its OpenAI-compatible LAN endpoint passes the all-local ticket proof above.

### Gemini one-click harness login
- **Remaining:** register the ECSG Google OAuth client and implement start/callback/status/signout for Gemini Code Assist credentials; AI Studio key paste remains a separate existing path.
- **Done when:** a signed-in user completes Google consent and a Gemini-harness bot answers with the resulting credentials without pasting a key.

### A2A gateway productionization and interoperability
- **Remaining:** apply migration 089, enable the bounded public gateway, complete an inbound third-party task, and run the same contract against a second vendor; do not replace per-agent credentials with a global secret.
- **Done when:** an external agent card leads to a completed caller-attributed ticket with authorization/cost evidence and the cross-vendor round trip passes. See [ADR-109](adr/109-a2a-gateway-external-agents-join-the-swarm.md).

### OSHAL Node bot-initiated control
- **Remaining:** expose node MCP tools to eligible bots, route bot tool calls to the selected node, add per-action confirmation, and introduce a live scoped mount only before parallel same-folder writers are enabled.
- **Done when:** a user asks the orb to open Word and return a screenshot, an accountable swarm bot drives the node, the result renders inline, and shared-task artifacts remain available to the next round. See [ADR-114](adr/114-user-owned-remote-nodes.md).

### `bot-node` config broadcast parity
- **Remaining:** port the any-bot broadcast-up behavior into the default `bot-node` runtime.
- **Done when:** a default worker changes local config, the authoritative record reconciles it, and another subscribed instance receives the update without a restart. See [ADR-034](adr/034-bidirectional-config-ownership-sync.md).

### Push-on-dispatch provider/model enforcement
- **Remaining:** make execution honor the authoritative provider/model carried on the task envelope rather than re-resolving a different local default.
- **Done when:** a deliberately mismatched worker executes the dispatched provider/model, refuses unavailable authority, and records the effective source in its result.

### Bot bootstrap pull
- **Remaining:** on startup, pull the authoritative bot record when OSHAL is reachable and treat environment values only as first-boot seeds.
- **Done when:** stale local caches are overwritten by the current record, offline startup has a documented bounded fallback, and secrets never flow back through config broadcast.

### Bot runtime consolidation
- **Remaining:** choose one canonical implementation across `app.js`, `swarm-node.js`, and `bot-node-server.ts`; remove or explicitly demote the others.
- **Done when:** config, dispatch, result, heartbeat, and authorization behavior are covered once and no supported deployment silently omits a capability because it selected a different runtime.

### Embedded LLM tools as a formal tier
- **Remaining:** model provider-native embedded tools beside framework-registry and harness-native tools with per-agent policy and audit semantics.
- **Done when:** an agent can enable/disable a named embedded tool, denied use fails at execution, and the run trace identifies the tier and provider operation.

### LLM access precedence decision
- **Remaining:** choose registry-pinned harness/provider precedence or a guarded per-bot runtime override and document its threat/operational model.
- **Done when:** an ADR and [building-a-bot](building-a-bot.md) state one rule, UI/API report the same effective source, and unauthorized mutation fails closed.

### Bot-registry cross-variant consistency
- **Remaining:** reconcile the local-only promoted concierge registrations with the canonical registry, or document and guard an intentional authoritative split.
- **Done when:** every supported deployment variant resolves identical UUID/capability data for required bots and CI fails on unexplained drift.

## Connectors, channels, and external systems

### Connector marketplace live brokered reads
- **Remaining:** run at least five distinct credentialed connectors through caller-scoped broker resolution; loopback/captured-fetch fixtures do not qualify.
- **Done when:** five owning-user live reads succeed, cross-user credential substitution is denied, and audit evidence names caller, connector, action, and redacted outcome.

### Connector marketplace lazy route gating
- **Remaining:** replace eager boot mounting with a stable provider delegate/gate that reflects enable/disable changes safely under Express.
- **Done when:** a disabled route is 404 before and after an enable/disable cycle, enabling requires no process restart, and a 200-plus catalog adds no active execution footprint. See [ADR-067](adr/067-connector-marketplace-and-dynamic-tool-loading.md).

### Connector catalog curation
- **Remaining:** verify target-catalog icons and decide whether `riskLevel` is derived from action semantics or declared and audited in YAML.
- **Done when:** the curation report has no unreviewed favicon fallback for the target set and one documented risk rule is enforced by the catalog audit.

### `connectors-routes.ts` decomposition
- **Remaining:** mechanically split provider registry/credentials, OAuth ceremony, account operations, and response helpers without changing route behavior.
- **Done when:** each module stays below the repository threshold, route/auth/RLS tests remain green, and no provider acquires a new environment-global credential path.

### Email providers beyond Gmail
- **Remaining:** live-test Outlook/Microsoft 365 and Yahoo/IMAP through caller-owned connections and finish any provider-specific auth or pagination repair.
- **Done when:** a user connects each supported provider in Utilities and the email bot lists and summarizes that user's mail with cross-user denial proof. See [ADR-037](adr/037-communications-swarm.md).

### Social provider expansion
- **Remaining:** live-verify LinkedIn and X publish/read flows, then add Instagram/Threads and Mastodon only through reviewed connector/CLI adapters.
- **Done when:** each advertised provider connects, drafts, confirmation-gates outward publication, and writes a caller-scoped audit record; unsupported providers are not displayed as ready.

### LinkedIn Content Assistant queue workflow
- **Remaining:** carry the existing research/topic/draft foundation through the queue-backed review, approval, schedule, and publish phases.
- **Done when:** one `linkedin-content-post` ticket reaches a confirmation-gated publish with source citations, caller credentials, audit evidence, and a clean denial path.

### LinkedIn store-package publisher
- **Remaining:** route the Social package publisher through its declared connector action and the kernel's caller-scoped fail-closed audit path.
- **Done when:** audit commits before the provider call, audit failure prevents publication, and no-connection and approval-denial cases stay clean. Track package work in [`social`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/social).

### Subscription-driven social signals
- **Remaining:** define selector descriptors and connect watch registration to sensor polling and authenticated owner-lane `XADD`; current feed/workspace UI is already package-owned and complete.
- **Done when:** one caller-scoped subscription produces an auditable matched signal for that user's bot and another user cannot read the subscription, captured post, or stream event.

### Chat-channel adapter core
- **Remaining:** run dedicated node listeners for Telegram, Discord, and WhatsApp, map provider identities to users, dispatch accountable bot work, and return replies/proactive pushes.
- **Done when:** a linked user DMs a real task, the selected bot completes it, the reply returns in-channel, and unlinked/cross-user identities are denied and audited.

### Channel enable and bring-your-own configuration
- **Remaining:** add provider-specific enable cards, operator demo-bot configuration, and honest setup/review guidance for Telegram, Discord, and Meta/WhatsApp.
- **Done when:** each channel can be enabled/disabled without editing code, BYO secrets are brokered and masked, and the UI distinguishes ready, credential-needed, and provider-review states.

### Twilio policy, fallback, and inbound messaging
- **Remaining:** define topic/severity routing across SMS/voice/WhatsApp, add a non-Twilio email fallback, and authenticate/normalize inbound SMS through the channel adapter.
- **Done when:** policy guards choose the expected channel, email works with Twilio absent, forged webhooks fail, and an inbound message reaches the correct caller-scoped bot. See [Twilio channel guidance](channels/twilio.md).

### Communications bot live wrap-up
- **Remaining:** after ECSG Twilio/A2P configuration, run browser-originated SMS, voice, and fallback-email smokes; then exercise inbound SMS-to-Jarvis.
- **Done when:** all three outbound legs and one authenticated inbound reply work for a signed-in user with delivery/audit evidence and no secret in logs.

### Telegram notification mouthpiece
- **Remaining:** capture the operator chat ID, configure it beside the proven bot token, and send one real completion notification.
- **Done when:** a finished creative episode reaches the intended Telegram chat, another chat cannot subscribe itself, and delivery failure remains visible/retry-bounded.

### AI Office artifact delivery adapters
- **Remaining:** add Slack behind explicit confirmation, then Teams and Twilio link delivery when their credentials exist; preserve artifact ownership and expiry.
- **Done when:** a caller can deliver a generated PPTX/DOCX/XLSX through each enabled adapter, denial sends nothing, and recipients receive an owner-scoped expiring artifact. See [ADR-108](adr/108-office-delivery-adapters.md).

### Smart-home edge-agent Phase 1
- **Remaining:** run a laptop edge node embedding Home Assistant Core, aggregate existing ecosystems, expose only scoped capabilities, and keep Matter migration later.
- **Done when:** the operator controls at least one real LAN device through an accountable bot while another user/device cannot access it, and the node survives reconnect. See [ADR-047](adr/047-smart-home-edge-agent.md).

### Alexa-exclusive control path
- **Remaining:** defer until an Alexa-only device requires it; then register Login with Amazon and a certified Smart Home Skill under the business account.
- **Done when:** the certified skill controls that device through scoped user consent and revocation; devices reachable through the edge-agent path do not create duplicate integrations.

### Operator credential/configuration follow-ups
- **Remaining:** register Outlook under `maintainer@emeraldcoastsystemsgroup.com`, set real daily cost caps, and configure `SWARM_SERVICE_SECRET` so bot-node auth is fail-closed.
- **Done when:** Outlook reconnects and sends, at least one budget denial is proven, and unauthenticated `/api/swarm-execute` is rejected on the deployed stack.

## Shared product experience

### Shared response-renderer completion
- **Remaining:** add safe `oshal:map` and `oshal:doc` components, wire Jarvis/concierge/orb consumers to the registry, and finish the live Gmail, delayed-worker lifecycle, actions/forms, voice, attribution, and transcript decisions in [the acceptance plan](backlog/jarvis-voice-and-visuals.md).
- **Done when:** the same untrusted response renders safely and consistently across at least Jarvis, chat, and one app; provider-grounded blocks cannot be model-forged; every remaining acceptance-plan item has live evidence or an explicit disposition.

### Chat-to-surface bridge
- **Remaining:** finish cockpit-mediated `postMessage` routing, per-app event vocabularies, selection return to chat, and origin/schema/identity enforcement over the existing bridge foundation.
- **Done when:** in one reference app, bot output updates selectable UI state and the user's selection returns to the same conversation, while forged origins, unknown ops, and cross-user events fail. See [ADR-036](adr/036-bot-owned-application-architecture.md).

### Per-app workspace consolidation
- **Remaining:** apply Social's cohesive workspace pattern where Storage, Career, and other multi-surface packages still expose disconnected panels.
- **Done when:** each selected app presents one navigable workspace with its bot beside the active task and no duplicate ownership of the same action.

### Guide bots that operate their apps
- **Remaining:** after the bridge lands, give deck, storage, social, and other guide bots scoped surface operations rather than prose-only personas.
- **Done when:** one guide bot completes its app's primary task through validated UI operations, with user confirmation at every outward or destructive boundary.

### Combined home workspace
- **Remaining:** compose communication, social, career, storage, media, and home package surfaces into one switchboard without copying their business logic; resolve the manifest bot requirement cleanly.
- **Done when:** `/cockpit/?app=workspace` loads every enabled home app in one ribbon, preserves owner isolation, and routes each action/chat to the owning package. See [ADR-113](adr/113-switchboard-aggregation-surface-and-workspaces.md).

### OSHAL engineering-screen normalization
- **Remaining:** apply the cockpit design system and verify live data contracts for task explorer, queue/admin, mesh, ops, health, config, Redis, and RAG screens.
- **Done when:** each screen has a consistent loading/empty/error state and a browser test proving its displayed values match the backing API.

### Queue dashboards per-app isolation
- **Remaining:** scope legacy queue dashboards and packages without `ticketType` to an explicit app/workflow identity rather than a global queue.
- **Done when:** every app ticket/queue view shows only its declared work and a cross-app fixture proves no leakage.

### Apps page as a swarm catalog
- **Remaining:** show bundles, included providers, install/enable state, and live per-provider connection state rather than a flat tile list.
- **Done when:** `/applications` accurately distinguishes installed, available, connected, credential-needed, and unavailable bundles from registry/broker data.

### Consumer commerce native surfaces
- **Remaining:** keep Rides map/quote-first, Eats delivery/menu/cart-first, and Shopping address/search/cart-first while connecting each concierge through the shared state bridge.
- **Done when:** each package supports browse/search/scroll, chat-driven state, deterministic totals, confirmation-gated outward action, and a real mobile-width browser smoke. Track package UI in [`rides`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/rides), [`eats`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/eats), and [`purchasing`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/purchasing).

### Mobile pinned-header and single-scroll-child audit
- **Remaining:** apply the corrected flex/overflow pattern to calendar, workboard, settings, and any reported clipping surface; add a real narrow-viewport regression.
- **Done when:** primary controls stay visible, exactly the intended child scrolls at supported mobile widths, and the browser test catches the prior clipping shape.

### Jarvis hand-off experience
- **Remaining:** send task-complete email, verify hard-refresh focus, and replace the slow agentic decision turn with a lightweight tool-less decision that preserves exactly-once build dispatch.
- **Done when:** email and focus checks pass live and a build request is acknowledged within 20 seconds with one swarm execution and no abandoned duplicate turn.

### Jarvis media-input deployment proof
- **Remaining:** deploy and exercise PDF, Word, and image parsing through the real browser/provider path; private-RAG ingestion remains a separately commissioned feature.
- **Done when:** dated evidence shows every supported type reaches the intended parser/model, extracted text is not silently dropped, and another caller cannot access the attachment or derivative.

### Presentron chat and frontend contract
- **Remaining:** prove the no-provider/noop path reports unavailable rather than rendered, then reconcile any stale modal/API contract in the current frontend.
- **Done when:** production route and browser guards cover both paths, including render failure, stale job state, and artifact ownership. Track package UI in [`presentations`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/presentations).

## Token Chase

### Provider-backed optimization evidence
- **Remaining:** run the production replay/comparison path against a current live provider capture; demo/no-token routes are not acceptance evidence.
- **Done when:** dated evidence records baseline and variant output, determinism verdict, token/cost totals, quality score, provider/model, and keep/reject decision. See [ADR-046](adr/046-token-chase-checkpoint-replay-optimization.md).

### Workspace-bound checkpoint and tail replay
- **Remaining:** bind each frame to workspace commit, owner-store version, pinned reads, and tool schema; restore into an isolated worktree and replay the downstream tail with AES-GCM-preserving store state.
- **Done when:** no-edit replay reproduces artifacts/store version, genuinely live reads are marked non-replayable, and replay always runs on an accountable bot node rather than the controller.

### Token Chase debugger
- **Remaining:** expose the captured timeline with prompt/response inspection, rewind, hand-edit, and forward play; clearly mark non-replayable frames.
- **Done when:** an operator opens a finished run, edits the failing call, and replays the tail while preserving the original immutable baseline and audit trail.

### Variant-selection policy
- **Remaining:** build the task-class/query-type corpus and ship a lookup/heuristic before considering a trained selector.
- **Done when:** preselection beats always-baseline cost on held-out workflows at equal quality, with a reproducible comparison and safe fallback.

### Keep-winner/rebaseline and judge budget
- **Remaining:** allow a qualifying cheaper variant to become the next baseline and enforce a per-run judge-cost ceiling.
- **Done when:** promotion is explicit/audited, the next run uses the winner, quality regression rolls back safely, and judge calls stop at the configured budget.

## Career and job application

### Career scoring/tailoring bot-node migration
- **Remaining:** move per-posting score/match/tailor execution off the controller/API process into a dedicated Career worker with bounded concurrency, cancellation, heartbeat, caller identity, and package-owned configuration.
- **Done when:** a real Career bot-node completes the workflow, the controller performs no provider shell-out, worker loss terminates visibly, and two-user isolation/cost attribution pass. Track app ownership in [`career-hunter`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter).

### Apply recipe runner and learned cache
- **Remaining:** replay known Ashby/Greenhouse patterns without model turns, tune the Workday parse-correction grid live, and share a PII-free family recipe schema between the native runner and swarm apply operator; novel forms may fall back to vision and learn owner-scoped variants.
- **Done when:** five supported ATS families replay deterministically where a recipe exists, Gmail verification is polled, novel forms learn safely, and auto-submit remains separately opted in per family.

### Offline browser autofill smoke
- **Remaining:** with the stack stopped, copy the current Career bookmarklet and exercise one real Ashby and one real Greenhouse form in an already authenticated browser.
- **Done when:** allowed empty fields fill from the caller's profile while existing answers, demographics, uploads, hidden/honeypot controls, and Submit remain untouched, with screenshots recorded.

### Apply pipeline live repair/provenance proof
- **Remaining:** deploy package migrations 100/101 and kernel migration 116; record reaper/provenance pre/post counts; run one healthy final submit and one CAPTCHA/2FA pause through a real worker.
- **Done when:** the bounded reaper releases the historical raw claims, all 164 historical rows have explicit provenance with the 28 evidence-free rows still `unverified`, worker/state transitions are visible, and only retained confirmation-backed submission renders verified.

## Finance

### Finance package live verification
- **Remaining:** configure Plaid Sandbox and Stripe test credentials, install the [`finance`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/finance) package, then exercise link/sync/brief and one test ACH payment.
- **Done when:** the owning user sees grounded balances/holdings/spend, the payment audit/status reflect the test transfer, another user cannot read either, and no live-money key is present. See [ADR-048](adr/048-finance-aggregation-swarm.md).

### Finance post-v1 rails and governance
- **Remaining:** separately decide real A2A payouts, live-money compliance, broker trade execution, Plaid production access, household labels/sharing, and scheduled forecast/alert scope.
- **Done when:** each commissioned capability has its own approved regulatory/security contract and live or sandbox proof; selecting an unimplemented rail continues to fail loudly.

## Trading and market systems

### Queued paper-to-live parity features
- **Remaining:** implement and soak the market-wide gap-down entry filter, immutable per-position exit plan, and idle-cash yield sleeve in paper before any live promotion.
- **Done when:** paper and live share one guarded algorithm/config path, historical and shadow evidence records impact, and promotion requires the existing explicit confirmation. See [ADR-052](adr/052-stock-trading-swarm.md).

### Trading platform surface and engine expansion
- **Remaining:** add asset/sector mix and active stop/take-profit panels, default to the full supported universe, and design futures/intraday/long sleeves plus a roughly 200-symbol multi-market universe.
- **Done when:** the [`trading`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/trading) surface exposes allocations/exits for the actual engine universe and every added sleeve is paper-proven behind kernel risk gates.

### SK Hynix sleeve graduation
- **Remaining:** after reliable permanent-ticker history exists, remove the temporary core exemption and evaluate the position through the normal sleeve/risk model.
- **Done when:** the permanent symbol is used consistently, the position has ordinary data/stop/exit coverage, and no IPO-specific bypass remains without an explicit rule.

### IPO event-play design
- **Remaining:** keep the rejected generic pop-catcher closed; design only the distinct IPO-event sleeve with data availability, allocation, halt, spread, and same-day exit constraints.
- **Done when:** an ADR and replayable paper study define the event universe and risk gates, and no live order is possible before paper acceptance.

### Market-data stream decision
- **Remaining:** exhaust already-owned Alpaca/Schwab data and quantify the consolidated real-time quote gap before purchasing another feed.
- **Done when:** an ADR names the chosen real-time source, entitlement and staleness behavior are guarded, and one intraday backtest cites the exact feed and coverage.

### Kalshi calibration and demo paper fill
- **Remaining:** restudy ask-basis calibration with staleness, bounded randomized sampling, cluster-bootstrap intervals, regime/date splits, monotonic probability, fees, and multiplicity adjustment; then save a demo connection and fill/settle one paper order.
- **Done when:** the published calibration passes those gates and one caller-attributed paper trade records quote-at-signal, fill, settlement, and P&L. Track UI/package work in [`kalshi`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/kalshi).

### Trading watchdog hardening
- **Remaining:** add uncovered-position, buying-power/position-count/concentration, per-symbol hysteresis, live-bleed, empty-exec, quote volume/recency, shared working-status, and broker-number parsing checks.
- **Done when:** mutation guards and a paper/live-shadow drill prove each failure alerts once with correct recovery and no silently healthy infrastructure-check result.

### Futures extension layer
- **Remaining:** sweep ensemble exits and ATR-percent buffers; run the six-stage locked-winner optimizer with three-market OOS overlays; stabilize/extract real archives and verify Kibot/Schwab sources; add margin, Target-1, closure/roll rules, durable paper stops, fail-closed live adapter, contract risk semantics, and cockpit coverage.
- **Done when:** reproducible real-bar in-sample/OOS evidence exists, paper state/stops survive restart, contracts/margin/gaps render correctly, and any live order remains behind confirmation and risk gates. See [ADR-116](adr/116-futures-extension-layer.md).

## Video, character, and creative automation

### Video Series conductor live acceptance
- **Remaining:** with explicit spend approval and a working image/render node, submit a one-episode/two-scene series and use only create plus approve while the conductor advances every other stage.
- **Done when:** the series reaches `done` with a real Drive link and `ffprobe` confirms video/audio streams and acceptable silence, with no manual intermediate stage calls. See [ADR-082](adr/082-video-series-pipeline.md).

### Free ComfyUI storyboard provider
- **Remaining:** configure the GPU-box ComfyUI URL and a pinned storyboard workflow; do not retry ChatGPT/Codex subscription OAuth against the OpenAI Images API.
- **Done when:** a real storyboard request returns a generated image through the ComfyUI provider, failure is bounded/visible, and the conductor can consume it without Vertex spend.

### Video Series intro and season assembly
- **Remaining:** splice a reusable intro into each episode and add season-level ordering/stitching over completed episode artifacts.
- **Done when:** a multi-episode series emits independently playable intro-bearing episodes plus one correctly ordered season artifact with validated audio/video streams.

### Flow UI-automation video provider
- **Remaining:** if the accepted personal-use/ToS tradeoff remains, run Flow on a dedicated fixed-geometry host using recorded deterministic interactions and explicit UI-drift detection.
- **Done when:** the provider generates and downloads one clip into the pipeline and a changed UI fails clearly or escalates to the paid provider without hanging or accepting the wrong artifact. See [ADR-070](adr/070-multi-provider-video-generation.md).

### Vids Operator named-tool live proof
- **Remaining:** live-tune each Vids tool, cache located controls, expose scenario/tool mode in both UIs, convert scenarios to explicit tool sequences, and add LoRA/Studio bridges.
- **Done when:** the director builds a multi-element real Vids project by calling named tools, using screenshots only for verification, and repeated format cost is materially below free-form control. See [ADR-073](adr/073-vids-operator-scenario-library.md).

### Vids public-publish rail
- **Remaining:** in the [`vids`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/vids) package, separate explicit per-user publish/unpublish from the authenticated job API and issue revocable public artifact links.
- **Done when:** only the owner can publish/unpublish a finished artifact, anonymous access reaches only the published immutable file, and job/control routes remain authenticated.

### LoRA end-to-end GPU run
- **Remaining:** reconnect the GPU edge node, deploy current routes, and execute train, validate, score ingest, improve, and morning review on a real character.
- **Done when:** a real `.safetensors` file and owner-scoped scorecard/gallery record complete the loop without controller-local GPU work. See [ADR-071](adr/071-character-lora-studio.md).

### LoRA per-character generalization
- **Remaining:** replace hard-coded cyclops constants in box scripts and seed data with `oshal_lora_characters` configuration.
- **Done when:** a newly created character completes train/validate/improve without source edits or reused identity artifacts.

### LoRA automated curation judge
- **Remaining:** reuse CLIP/identity and structural checks to propose keep/reject before training while retaining human override.
- **Done when:** rejected off-identity/deformed candidates do not enter the training set and a labeled validation fixture measures false accept/reject rates.

### LoRA gallery image hosting
- **Remaining:** serve validation thumbnails over an authenticated mesh path or copy bounded thumbnails into owner storage.
- **Done when:** each scorecard cell displays its correct image, another user cannot fetch it, and expired/deleted runs lose access.

### LoRA autonomous overnight scheduling
- **Remaining:** add a real schedule trigger and replace any static ingest secret with short-lived scoped node authentication.
- **Done when:** enabling autonomous mode schedules the nightly loop, only the owning character runs, the morning-review ticket appears, and replayed/expired ingest credentials fail.

### Joke-shorts pump deferred work
- **Remaining:** add per-show destination opt-in/dry-run publishing, post-render mechanical quality review, shared recap/pump node lease, a declared Pumpkin bot, and an explicit external-persona manifest shape.
- **Done when:** nothing publishes without destination consent, bad episodes pause automatically, recap and pump cannot collide, Jarvis discovers Pumpkin, and the loader rejects orphan personas while accepting declared external copies. See [ADR-120](adr/120-joke-shorts-pump.md).

## Device, edge, spatial, and operations domains

### Drone physical payloads and peer coordination
- **Remaining:** prove a real approved MAVLink airframe/adaptor, authenticated drone-to-drone coordination, physical camera/video, ESC telemetry, and LED payload through the remote-node envelope; the Drone package carve is already complete.
- **Done when:** [`drone`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/drone) drives auditable capture/telemetry on a physical node and a multi-node mission self-realigns without bypassing geofence, approval, abort, or ownership gates. See [ADR-099](adr/099-drones-as-remote-swarm-nodes.md).

### Camera real-device follow-ups
- **Remaining:** add GoPro BLE AP/COHN provisioning, pinned self-signed CA handling, browser-playable preview transcoding, one second-brand adapter, and package the camera node; deploy/install the current package for a browser smoke.
- **Done when:** a real GoPro provisions and previews without disabling TLS verification, a Canon CCAPI or ONVIF device uses the same provider contract, and [`camera`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/camera) drives both without controller/surface changes.

### Sat-ops conjugate-convention covariance
- **Remaining:** build a synthetic direct-versus-conjugate 42-stream test for the MEKF anisotropic star-tracker covariance and correct the rotation if it is not convention invariant.
- **Done when:** both conventions place the 2/2/20-arcsec covariance on the same body axes and a forced-conjugate replay/live run has acceptance rates comparable to direct. See [ADR-102](adr/102-sat-ops-satellites-as-swarm-nodes.md).

### Spaces live reconstruction and capture expansion
- **Remaining:** deploy `spatial-recon-edge`, reconstruct a real room, add GoPro/personalized and commissioned WebRTC/pose guidance, ingest drone scans with sector patterns, and choose durable storage for 100MB-plus assets.
- **Done when:** one owner's real scan reaches a rendered reconstruction, capture actions are auditable, another user cannot access it, and large-binary retention has an implemented target. See [ADR-111](adr/111-spatial-mapping-3d-reconstruction.md).

### Spaces post-carve cleanup and documentation
- **Remaining:** delete dead core `src/api/spaces*.html` files and their Compose binds when uncontended, and remove the obsolete "re-sync from core" instructions in the [`spaces` README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/spaces/README.md); the package is already active/ready.
- **Done when:** no core Spaces surface/route source or bind remains, the installed package still loads and imports scans, and its README describes the actual package-owned source of truth.

### Native iOS Spaces scanner
- **Remaining:** generate the Xcode project, sign with a real Apple team/bundle ID, run on LiDAR hardware, and pair/upload PLY plus poses with a scoped token.
- **Done when:** a captured room imports into the owning user's Spaces surface, invalid/other-user tokens fail, and the first real Xcode build is clean.

### DevOps cockpit Phase 2+
- **Remaining:** discover topology from logged-in CLIs into the graph, add Connect-Vault and live traffic lights, discover/override Terraform and Kubernetes contexts, deploy NAT-friendly/push remote nodes, choose the bidirectional transport, and run specialist tasks with brokered credentials.
- **Done when:** a NATed node self-registers and round-trips work, topology is queryable/rendered, each connection reports a truthful reasoned state, and a specialist completes a real read/plan with a revoked short-TTL credential while apply/deploy stays human-gated. See [connectivity design](architecture/devops-cockpit-connectivity.md).

### Container-health collection without cAdvisor names
- **Remaining:** verify cAdvisor naming on supported Linux targets or adopt a Docker/agent collector whose OSHAL container identity is stable on Desktop and Linux.
- **Done when:** killing a real OSHAL container triggers the ADR-119 signal on every supported deployment class and a healthy container cannot be missed because its metric name differs.

### Bot-recreate thundering herd
- **Remaining:** jitter bot runtime-config pulls or size/protect the API database pool for simultaneous deploy recreation.
- **Done when:** recreating the full bot fleet causes no pool exhaustion, each bot receives config within a bounded window, and boot authentication/rate limits remain enforced.

### Operations and SecOps swarms
- **Remaining:** prove caller-scoped live reads for Dynatrace, ServiceNow, Datadog, and New Relic and retire the environment-global ServiceNow MCP; integrate the existing one-shot RCA engine; build the SecOps bot/store/surface; seed offline Trivy/FIPS assets and run a real self-scan.
- **Done when:** connector/RCA traces are caller-attributed, findings are encrypted and owner-isolated, security review passes, and a live enclave scan files auditable results without fetching an unapproved database. See [ADR-069](adr/069-operations-and-secops-connectors.md).

## Application-package follow-ups

### Kid Lens Takeout package registration
- **Remaining:** let an installed package contribute a Takeout slice without app literals in the kernel; move/confirm real-data, Dropbox, harvest privacy, YouTube scope, additional-lens, and multi-kid product work in the [`youtube-kids` README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/youtube-kids/README.md).
- **Done when:** installing the package registers its YouTube slice, uninstalling removes it, whole-archive upload routes correctly with owner isolation, and the package README is the canonical per-item product queue.

### Game Show core dependencies
- **Remaining:** auto-narrate the opening after the platform TTS speaker lease and install the package through the sanctioned registry installer rather than `docker cp`; app-local polish stays in the [`game-show` backlog](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/game-show/README.md).
- **Done when:** starting a show speaks or captions the open and `oshal-app install game-show --ref main` leaves provenance and survives redeploy. See [ADR-112](adr/112-game-shows-as-plugins.md).

### Payroll package backlog handoff
- **Remaining:** make the [`payroll` README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/payroll/README.md) the canonical queue for additional cited state/local tables, workweek overtime, protected identifiers, employee isolation, repayment/garnishment/deposit rules, benefits/payment traces, verified EFW2 2026, and enrolled filing/payment rails.
- **Done when:** each commissioned package item has primary-source citations where legally material, a focused calculation/isolation guard, and clean-tenant output evidence; core retains only shared framework dependencies. See [ADR-123](adr/123-payroll-app.md).

### Person-model Phases 2-4
- **Remaining:** implement consent-ledger enrichment, semantic recall, and person pages exactly as staged in [ADR-100](adr/100-ambient-person-model.md), preserving recall-only Phase 1 behavior until each gate passes.
- **Done when:** each ADR phase meets its own red-provable ownership, consent, provenance, deletion, and UX criteria without silently enriching people who have not opted in.

### Person-model fresh-database enable gate
- **Remaining:** apply the current migration chain to a database predating the feature and exercise enable/disable trigger paths.
- **Done when:** every object is created once, both trigger states behave correctly, rerun is idempotent, and no existing tenant data is exposed or rewritten unexpectedly.

### World Intelligence licensed outlet ratings
- **Remaining:** license Ad Fontes and/or AllSides, map the data with provenance, and replace placeholder bias/reliability seeds; this requires operator budget and license approval.
- **Done when:** every rating displayed in the World package is sourced to the licensed dataset/version and unknown outlets are represented as unknown rather than guessed. See [ADR-061](adr/061-world-intelligence-layer.md).

### Marketing Plan package (held)
- **Remaining:** when commissioned, register the existing strategy/sales/PR/brand personas as a package workflow and operator-reviewed surface rather than duplicating their logic.
- **Done when:** an installed package creates a scoped plan ticket, its real worker produces versioned artifacts, and every outward publication remains confirmation-gated.

### HTML5 Game Generator package (held)
- **Remaining:** when commissioned, use a dedicated bot-node to emit a self-contained CSP-safe browser game; do not depend on co-located GUI editor MCPs.
- **Done when:** one prompt produces a playable packaged game with bounded assets, no unsafe eval/network dependency, and browser/security regression coverage.

### Content atomizer, share cards, and judged A/B (held)
- **Remaining:** if released, build independently in this order: one-input atomization, branded share-card generation, then judge-scored A/B using the existing scheduler, notification, and judge services.
- **Done when:** each capability installs and runs separately, retains source/provenance and owner isolation, and publishing remains explicitly approved.

### AI Deal Finder integration decision
- **Remaining:** decide whether `C:\Projects\ai-dealfinder` joins as a bot, connector, app package, or external A2A service; do not rebuild its auction/foreclosure/real-estate domains inside the kernel.
- **Done when:** an ADR names ownership, auth/data boundary, installation, and lifecycle, and one read-only end-to-end flow proves the chosen integration.

## Provisioning and operator experience

### First-run provisioning wizard
- **Remaining:** extend `/welcome` through trusted store selection, package choice/install, invited users, and safe backup/secret defaults; third-party store URLs require an explicit trust design.
- **Done when:** a fresh LOCAL_AUTH admin completes or skips each re-enterable step, failures name the package, anonymous users cannot invoke installation, and an ADR prevents a typed store URL from gaining unchecked code execution. See [ADR-117](adr/117-local-auth-invited-users.md).

### `swarm-cli` zsh completion
- **Remaining:** execute the current completion in real zsh, covering sourced/autoloaded modes, command/state dispatch, and saved context completion.
- **Done when:** `zsh -n` and real tab completion pass for top-level commands, completion shells, token actions, and `--context`; append evidence to the existing 2026-07-12 proof or delete the unsupported script.

### Notification-preferences index-only work disposition
- **Remaining:** compare the preserved `wip/notification-prefs-20260801` tag to current notification/welcome code and either land only unique valid changes or explicitly abandon it.
- **Done when:** the decision is recorded, any retained behavior has tests/docs, and the temporary tag is deleted so it cannot be mistaken for pending work.
