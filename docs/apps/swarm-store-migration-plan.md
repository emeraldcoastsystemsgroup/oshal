# Swarm store-migration plan — completing the ADR-085 reset

**Status: EXECUTING — Wave 1 ✅ done, Wave 2 ✅ done, Wave 3 in progress (career-hunter opener
carved 2026-07-18). Eleven apps carved so far (+ the `little-monsters`/`hello-oshal` proofs); see
the carve log. Operator go 2026-07-17: "start breaking applications out of core into the add-ons
repo, small, one at a time". Wave 0 closed 2026-07-14 (556cb467; only optional D7 remains). Carve
log:**

| # | App | Carved | Notes |
|---|---|---|---|
| 1 | `brand-graphics` | 2026-07-17 | First Wave-1 carve + first packaged **CLI tool** — added the `{packageDir}` cliCommand token (loader-substituted before registration; rip `20288653`, store `3a4922a`, tag `appstore-v0.6.0` — hashes recorded 2026-07-18 by the parity audit, they were omitted at carve time). Rip = manifest + persona + local-registry block + `scripts/oshal-brand.js`; no routes/tables/container. Live-proven: install→boot 50/0→activate (bot registered, executor persisted with the concrete package path, ribbon+workflow up, persona seeded)→deactivate teardown clean. Two latent bugs surfaced+fixed: the CLI called `authHeaders()` it never defined (ReferenceError on every call; unnoticed — app shipped inactive), and `seedBotAuthorizations` resolved personas cwd-only so EVERY packaged bot seeded 0 tools (55335ee8). Depends on `vids` (core-satisfied until Wave 2). |
| 2 | `youtube-kids` | 2026-07-17 | First carve with **routes + a lazy-DDL table** (rip `53c1e3ad`, store `6a1c388`, tag `appstore-v0.7.0`). Package = manifest + persona + 2 compiled route modules (`src-routes` adapted: standard `(ctx)` factory, surface served from `ctx.appPackageDir`/tools — portrait-studio pattern) + dashboard HTML. No migrations: `ensureYoutubeKidsSchema` creates `oshal_youtube_activity` lazily with owner RLS at the chokepoint (table stays in place; 0 live rows at carve = no data step). Rip also **decoupled the Takeout spine** (kernel keeps `takeout-ingest`/`takeout-routes` app-agnostic with ZERO slices; the youtube handler left with the app — package-contributed slice registration is the reconnect gap), dropped the compose ro-mount of the HTML (would have become a phantom dir), the queue-classification ticketType literal (LM precedent), the Test Lab smoke, and the governance/spec kid-lens entries. App was already retired+inactive since 07-16 → ships at that parity. Live-proven end-to-end incl. an LLM brief + `chat_tasks` cost row under a0…0043 (PAT auth; toggled back to inactive parity after). |
| 4 | `payments` | 2026-07-17 | **Cleanest carve yet** (rip `9fdbdc43`, tag `appstore-v0.9.0`; store `329e83a`): no bots/tools/CLI/container/registry blocks/barrel export — manifest + one OIDC route + surface. **`@/features/payments` stays CORE** (documented kernel skill: finance imports its Stripe half; the package imports the merchant half via the alias — revisit when finance carves last). Core-remaining relative imports rewritten to `@/app/routes/...` (connectors-routes, connector-tenancy). Rip: guest Tier-C literal (manifest `guestTier: blocked`), framework-profile tile, compose ro-mount, Test Lab smoke, fullcatalog label, schema-governance/spec entries; guest-tier contract spec re-fixtured payments→`workflow-studio` (kernel-resident — D5); evidence generators surgically updated (merchant no-charge probe dropped, finance's keeps the scorer regex matching; audit-proof module row dropped; competitive-score payments-sandbox check reads an untouched doc — verified). **Deploy trick minted: pre-stage the package into the deployed-apps VOLUME via a helper container** (`docker run -v <vol>:/ws alpine` + cp) — direct docker-cp to the old api hits the dead ro-mount of the just-deleted HTML, and volume-staging BEFORE the first post-rip boot closes the carve-#3 orphan-deactivate window: payments came up **ACTIVE at boot, zero toggles**. Live-proven: providers list (both rails not-connected/sandbox), surface 200 from the package dir, `POST /charge` without confirm → 428 `no-charge` from the packaged route. 0 rows = no data step. |
| 11 | `career-hunter` | 2026-07-18 | **Wave-3 opener and the LARGEST carve** (rip `72f49822` 43 files −6,075 LOC; store `92faf9c`, tag `appstore-v0.16.0`; operator-directed after the in-container scrape treadmill — cron catch-up-on-start re-fired a fresh multi-hour scrape on EVERY api recreate, blocking every deploy window all day). **The APP carves (~5,300 LOC: 9 route modules incl. the CRON, 10 surfaces + css, manifest with both bots + 9 CLI tools + 10 tiles, migrations 031/077/082 + NEW 090-career-rls closing the audit RLS gap on digest/score settings, persona COPIES for the registrar, 4 specs, 2 smokes); the ENGINE CHAIN STAYS core per ADR-093 interim** (8.5k-LOC python engine, oshal-jobhunter.js wrapper — packaged routes + both bots shell it at /app — toolkits, both bot containers + registries + core personas, and the 9.8 GB SQLite store on the api-output volume; VERIFIED pg backup `oshal-career-backup-verified-2026-07-18.sql`; engine-in-package = the D1 follow-up). Firsts: **stage-committed carve** (stage 1 = `3fc762e1` morning-brief decouple: `career-brief-bridge` resolves the INSTALLED package's module skip-if-absent + `digest-resend-guard` shared across the boundary); **`callerSub` extracted to kernel** (apply-operator + notify imported it from the carving module — generic OIDC resolver, `caller-sub.ts`); **PARITY DOCTRINE applied at carve time** (tiles/jarvis-row/welcome STAY; agent_ids backfills from workerBot; chatBot advisor flows from the manifest) — the first carve done entirely under the audit's rules. Evidence generators: competitive-score reads the carve log; ease-of-use career sources tolerant with a package-manifest mirror; flagship drops the career domain. Cron conversion deferred honestly: the packaged cron keeps its bespoke volume-marker catch-up (a manifest `schedules:` block can't express killed-run recovery — noted for the schedules framework). **FULL suite 2652/2652 — the first completely green run of the day.** |
| 10 | `purchasing` | 2026-07-18 | **The biggest concierge carve** (rip `bb52bf5b`, store `849bab8`, tag `appstore-v0.15.0`). Firsts: **two surfaces** (shopping-chat + shopping-dashboard) + a separate **purchasing.css** (dashboard loads `/api/purchasing/purchasing.css`, packaged route serves all three from `ctx.appPackageDir`) → **drop the manifest `sharedCss:` field** (validator rejects the core path; the surface references the css by its own route URL, so the field is redundant in a package); **8 tables / 3 platform migrations** (035/037/038 → package, idempotent; 036 bot seed stays core); **app-owned functions split out of a CORE test** — the walmart-catalog action-policy fns (`walmartFallbackMetadata`/`walmartCatalogAllowsActions`/`enforceWalmartCatalogActionPolicy`) are defined in purchasing-routes with no core importer, so they carve, and their blocks moved from core's `oshal-walmart-cli.spec.ts` (which keeps the framework-resident CLI tests) to the package's `walmart-catalog-policy.spec.ts`. Nothing else vendors; `oshal-walmart.js` + walmartProvider/walmartToolKit/purchasingTools.js stay core (bot's chain); `walmart` stays a platform connector. **Deleted the now-obsolete `tool-surface-light-theme.spec.ts`** — every surface it asserted (payments/eats/rides/shopping) has carved, leaving an empty describe vitest rejects. Decouple also hit a SCRIPTED test-lab scenario (the "gift for Jason" find+checkout flow). Full `test:unit` gate (Explore-agent decouple sweep first). Owner-RLS at the packaged chokepoint (5th). 0 rows ×8 = no data step. Deploy pre-staged beside eats; both live-verify at the next scrape-quiet recreate. |
| 9 | `eats` | 2026-07-18 | **The full-validation carve** (rip `1c0fb5f7`, store `2f649fc`, tag `appstore-v0.14.0`). Rides twin: service-or-oidc, shells the framework-resident `oshal-uber.js` (stays core — eats-bot shares it), nothing vendors (all imports core-shared), 7 tables all 0 rows, 3 ribbon tiles (the "custom ribbon" is just 3 `ui.static` entries). Bot quadruple + `manifest-worker-connector-scope` eats→uber + `ConciergeStore` 'eats' prefix + the shared `concierge-store.test.ts` fixture all STAY core; `uber` stays a platform connector. Owner-RLS at the packaged chokepoint (4th fresh-DB-gap fix). **Running the FULL unit suite here (not the filtered runs the #2/#3 carves used) surfaced two spec gaps the spotify + rides carves had silently left: `tool-surface-light-theme.spec.ts` still read the ripped `rides-app.html`/`rides-routes.ts`, and `flagship-route-backed-tools.spec.ts` still `readFileSync`'d the ripped `spotify.yaml`/`rides.yaml` (ENOENT). Both fixed in this commit — LESSON: run the WHOLE `test:unit`, never a filtered subset, as the carve gate.** Independent reds found + triaged (NOT eats): `surface-glass-assets` flagged @sat-ops' new `sat-ops.html` (fixed separately, `2fcdbf43`); `route-schema-validate-only` is app-role grant drift on jarvis/presentations columns (columns exist in the DB; environmental, filed for the DB-bootstrap owner). 0 rows ×7 = no data step. Deploy pre-staged, rides the next scrape-quiet recreate. |
| 8 | `rides` | 2026-07-18 | **The no-vendor carve** (rip `9e1dbcb4`, store `48b617f`, tag `appstore-v0.13.0`). Everything rides-routes imports is core-shared (`concierge-reply`/`concierge-store`/`inline-bot-execution`/agent-management) → alias imports only, nothing vendors; the packaged route still shells the framework-resident `oshal-uber-rides.js` from the image (the rides-bot uses it too — CLIs shared with a core bot stay core). **New rip class minted: ISOLATED-SERVER Playwright specs** — `app-surface-clickthrough` (rides test), `app-surface-validation` (rides requirements map), `app-theme-matrix` (rides row) assert package-only surfaces against a test server that installs no packages → they rip with the app. Self-guarded LIVE steps (walkthrough deep-rides, zzz-enhanced/zzz-actions) STAY — they skip on tile absence and exercise the packaged app when installed; that's the pattern going forward. Guest decouple hit a second structure: `GUEST_NOTATIONS` message map (not just the tier list). Bot quadruple stays core (ADR-093; 043 seed stays). Owner-RLS at the packaged chokepoint (3rd instance of the fresh-DB gap). 0 rows ×4 = no data step. **Deploy: pre-staged beside spotify — both ride the next announced recreate window.** |
| 7 | `spotify` | 2026-07-18 | **First packaged `service-or-oidc` mount (D2 exercised on a package)** (rip `39f57031`, store `ddc63bc`, tag `appstore-v0.12.0`). Package = manifest (auth mode carried verbatim from the D2-reconciled core manifest, five route-backed framework tools incl. approval-gated build-playlist, `guestTier: blocked`, `connectors: [spotify]`) + spotify-routes + surface + idempotent 046 migration + app-owned parse specs. **Vendoring counter-example minted:** `spotify-client.ts` looked like the tmdb-client twin but the platform spotify connector runtime (`src/app/connectors/spotify/`) imports it → shared-slice rule → **stays core**, packaged routes resolve `@/app/routes/spotify-client` from dist, and its `normTrack` specs stay in core's envelope test (which now covers only shared/core modules). ALWAYS grep for second importers before vendoring a route sibling — tsc catches it, but only after the rip. Service callers keep resolving through `getTrustedServiceUserSub` (already alias-imported — nothing to adapt). Same fresh-DB RLS gap as movies → owner-RLS at the packaged chokepoint. Bot quadruple stays core (ADR-093; migration 047 bot seed stays). 0 rows ×4 = no data step. **Deploy deferred to the next announced recreate window** (career scrape running + @drone-ops holding a pending rebuild) — package pre-staged in the volume so it comes up ACTIVE whenever that recreate happens; old baked routes serve /api/spotify until then (no outage window). |
| 6 | `movies` | 2026-07-18 | **Wave-2 opener** (rip `bd891acf`, store `ca9e49f`, tag `appstore-v0.11.0`; operator per-wave go recorded in COLLABORATE 13:15Z). Package = manifest (oidc mount, `guestTier: blocked` request, `connectors: [tmdb]` runtime allow-list) + movies-routes + **vendored `tmdb-client.ts`** (first app-owned `src/app/routes/` *sibling module* carved — vendoring applies to route-layer siblings, not just feature slices) + surface via `ctx.appPackageDir` + idempotent 048 migration + the movies-owned pure-logic specs (moved out of core's shared `concierge-envelope.test.ts`; `tmdb-client-runtime.spec` retired with the source). **Bot quadruple stays first-party core** (ADR-093 interim, finance precedent): movies-bot container, BOTH registry blocks, worker+foundation personas, `moviesToolKit.js` + `oshal-tmdb.js`, and migration 049 (bot seed) — so `docs/building-a-bot.md`'s worked example stays valid. **Security fix minted by the carve:** the five `movies_*` tables were policy-less on a fresh DB between lazy creation and a 060 re-run — packaged `ensureMoviesSchema` now appends `buildOwnerRlsPolicyStatements` per table (A1.2 chokepoint). Decouple: profile tile, jarvis row, welcome category, guest Tier-C literal, Test Lab smoke, five live-spec tile lists, route-audit map, governance schema validator, utilities.html TMDB launcher (hardcoded cross-app links 404 when the target isn't installed — connector pages must not deep-link apps). queue-classification needed NO edit (ticketType self-resolves — first carve where that literal never existed). 0 rows in all five tables = no data step. |
| 5 | `finance` | 2026-07-18 | **Wave-1 FINALE — and the first carve finished by a relief session** (rip `adf991e9`, store `b55df41`, tag `appstore-v0.10.0`). @store-wave1's claim stalled mid-rip after the night's index turbulence (the server.ts unmount got swept into a foreign commit `c8eb548f`, the four file deletions were restored by the repair, and the decouple edits sat uncommitted ~10 h) — leaving live Finance a DEAD tile (unmount deployed, package never installed): **finishing the carve was also the service restore.** Firsts: (1) the app's BOT deliberately stays core — ADR-093 interim tier keeps the finance-analyst quadruple (compose `finance-bot` container + local-registry block + persona + `oshal-plaid.js`) as the operator-applied first-party fragment; the manifest declares NO bots and `workerBot: finance-analyst` resolves via the static registry. (2) **D8 exercised for real:** the rip removed `@/features/payments`' last core importer, so `payments` became the 11th contracted kernel skill (shared registry + build anchor + kernel-skills spec) — both the finance and payments packages resolve it from dist; post-build image grep is part of the deploy gate. (3) Guest coupling stayed kernel-side by design: guest-demo-seed is skip-if-absent and savepoint-fenced (`9c63c45e`, landed by the guest agent mid-carve in live cross-session coordination) so a missing package can't roll back the demo tickets. No migrations (three `oshal_finance_*` stores are lazy-DDL with owner RLS at the package chokepoint); `oshal-finance-backup-verified-2026-07-17.sql` VERIFIED before anything; tables stayed in place. Theme fixed `evergreen`→`forest` (validator catch). Deploy = volume pre-stage (carve-#4 trick) + announced rebuild + full oshal-up, market-closed (Saturday) per plan. |
| 3 | `lora` | 2026-07-17 | First **split-mountPath auth** package + first **vendored feature slice** (rip `bb203324`, tag `appstore-v0.8.0`; store `d827590`). Package = manifest (ACTIVE parity, `guestTier: blocked` request) + persona + 3 compiled modules (router + vendored `lora-train-dispatch` + vendored `scorecard` = the whole `src/features/lora-studio` slice) + surface + the idempotent 058 migration (moved out of core `scripts/migrations/`). Auth: `/api/lora/ingest` = `auth: public` + x-service-secret self-guard (box callback URL byte-identical; loader's own comment names this the sanctioned shape), `/api/lora` = `oidc`. Rip decoupled: route-audit allow-list entry, hardcoded guest Tier-C literal, framework-profile static tile, fullcatalog live expectation, MAIN-registry bot block (**surgical by NAME — agentId a0…0049 is ALSO trading-research-analyst in the local registry**). Box comfyui-edge scripts stay core (shared with Video Studio). Verified `oshal-app-backup.sh` dump (1+5+5 rows) before the carve; tables stayed in place and the real character data read back through the packaged route post-deploy. **Gotcha minted: the rip→install window orphan-deactivates the DB row** (active flag survives manifest upserts by design) — one PAT toggle restores; on THIS host lora is back ACTIVE. Suite-count spec floor made carve-aware (≥30) in the same commit. |

Little Monsters proved the full loop (tags `appstore-v0.3.0` → `v0.5.0`): carve an app out of
core, publish it as a store package, install it back, and it *works* — routes, schema,
dependencies, privacy, theme. This plan finishes the job: **every application becomes a store
package; the swarm ships as kernel only.**

Reference implementation & procedure source: the LM carve-out
([ADR-085](../adr/085-remote-app-packages-and-registries.md), store repo
`github.com/emeraldcoastsystemsgroup/oshal-applications`, `little-monsters/BUILD.md`).

---

## 1. Where we are (measured 2026-07-18, after Wave 1 + Wave 2 + the career-hunter Wave-3 opener)

Counts are measured against the tree, not hand-carried (CLAUDE.md anti-drift rule 2 — re-run the
measurements before quoting these).

| Metric | Count |
|---|---|
| App manifests in `swarm-apps/` (baked) | **34** |
| — kernel-resident, never carve (§2) | 6 (`jarvis`, `oshal-engineering`, `oshal-dev`, `security`, `workflow-studio`, `codex-packer`) |
| — new apps built after this plan, not yet triaged (§6) | 6 (`camera`, `drone`, `kalshi`, `person-model`, `pumpkin`, `sat-ops`) |
| — carveable, wave already assigned (§6) | 22 |
| Apps already carved to the store repo | **11** (+ `little-monsters`, `hello-oshal` proofs) |
| Hard-mounted `/api/*` route groups in `server.ts` | **107** |
| Bot-node containers in compose | **27** |
| Migrations in `scripts/migrations/` | **72** |
| Env-gated cron starters (the "$90-class" residue) | **4** (gov-contracting, travel-farewatch, feeds-indexing, inbox-ingest — career-hunter's cron carved with its package) |
| Python engines under `apps/` | 2 (career-hunter's engine stays core per ADR-093; gov-contracting) |

> **Why routes/migrations *rose* since 2026-07-10 (69→107, 64→72) despite eleven carves:** the six
> new apps below (`camera`/`drone`/`kalshi`/`person-model`/`pumpkin`/`sat-ops`) landed baked into
> core and added server-mounted routes + schema faster than carving removed them. Per ADR-085, new
> apps should ship as store packages from the start rather than baking in and queuing for a later
> carve — otherwise the carve backlog refills as fast as it drains.

---

## 2. The kernel line — what NEVER carves

**Three tiers, not two** (operator correction 2026-07-11 — the original draft omitted the skills
tier, which would have broken carves):

### Tier 0 — Platform
- Ticket/queue system + WorkflowPipelineRegistry + dispatcher
- The app loader, App/Tool registries, installer, route mounter, migration runner
- Auth (OIDC/RLS core/authz/guest middleware), the connector **broker**, cost capture (`chat_tasks`)
- Cockpit shell + framework ribbon + theme engine
- Baseline bots: `project-manager`, `queue-bot`, `general-bot` (+ mesh/heartbeat infra)
- Security Center *platform* scanners

### Tier 0b — Kernel SKILLS (shared capabilities apps CALL but never own)

**This is already load-bearing and uncontracted:** the carved little-monsters package requires
`@/features/presentation-generation` and `@/features/voice-providers` at runtime today. Skills are
the kernel's package-facing API.

| Skill | Feature | Why kernel |
|---|---|---|
| **TTS / STT (voice)** | `voice-providers`, `voice` | Pluggable-vendor registry (CLAUDE.md: never hardcode a TTS vendor). LM + Jarvis + ambient all call it. |
| **Notifications** | `notifications` | notifyAll fan-out across transports (email/Telegram/WhatsApp/Discord) — any app may notify. **⚠ currently PRUNED from dist — see D8.** |
| **RAG / knowledge** | `rag` | Chroma abstraction; multiple apps ground on corpora. |
| **Storage targets** | storage-target layer | Dropbox/GitHub/local abstraction (ADR-041). |
| **Deck generation** | `presentation-generation` | Already called by LM's package. |
| **Graph** | `graph`, `personal-graph` | Engine-agnostic connector (ADR-045). |
| **Scheduling** | `scheduling` | Manifest schedules register/tear down through it. |
| **Memory / user model** | `memory`, `user-model`, `personal-data` | Cross-app user state. |
| **Tool registry + harness/LLM layer** | `tool-registry`, `llm-provider` | The aggregation thesis itself (ADR-049). |
| **Media generation** | `video-generation`, `visual-response` | Vendor-abstracted; several apps use. |

**The rule:** a **skill** is a capability with a *provider abstraction and no domain of its own*
(it exists to make a vendor swappable). An **app** is a *domain + a surface*. If ≥2 apps would
need it, or it wraps swappable vendors → kernel skill; apps declare `uses:`, never bundle it.

**Corollary — "skills with a surface".** A few registered *apps* are really a kernel skill plus a
UI: `presentations` (engine = kernel `presentation-generation`; the app is the deck-builder bot +
surface) and `storage` (kernel storage-target layer + the Storage Assistant surface). **When these
carve, only the SURFACE carves — the engine stays kernel.** Consequence: LM's
`dependencies.apps: [presentations]` is mis-declared (it depends on the always-present *skill*, not
the app) — correct it to a `uses:` when D8 lands.

### Tier 1 — APM
Monitoring baked into the bot image; auto-covers every installed app.

**Kernel-RESIDENT apps** (functionally apps, but they ARE the platform — never carved.
**✅ SIGNED OFF by the operator 2026-07-13**, together with the Tier-0b skills list above and the
"skills with a surface" rule — presentations/storage carve their UI only, engines stay kernel):

| App | Why it stays |
|---|---|
| `jarvis` | Route-layer orchestrator (ADR-050) — coupled to chat/queue/catalog internals |
| `oshal-engineering` | The build swarm (7 bots) — the platform's own dev capability |
| `oshal-dev` | ADR-081 platform-dev specialist — superadmin-gated, owns its repo clone |
| `security-center` | Operator/platform security surface |
| `workflow-studio` | Design-time authoring + the /publish path that MINTS packages |
| `codex-packer` (Forge) | The bot factory that authors packages — the store's authoring arm |

Everything else carves.

---

## 3. The resource ledger — what "all accounted for" means

Every carve must disposition **all thirteen classes**. This is the checklist the per-app
inventory agent fills in (the LM classification pass, formalized):

| # | Resource class | Disposition rule | Learned-the-hard-way notes |
|---|---|---|---|
| 1 | **Routes** | Hard mounts in `server.ts` → package `src-routes/` (alias imports) → `oshal-app build` → `routes/*.js` | `serviceSecretOr(requiresAuth)` routes (jarvis, purchasing, graph callers) need the Wave-0 auth-mode field — the mounter only knows plain requiresAuth today |
| 2 | **Cron starters inside route factories** | Convert to manifest `schedules:` — the toggle + teardown (v0.5.0) then govern them; **kill the env flags** (`GOVCON_CRON` etc.) | This closes the $90 vector for the 5 remaining cron apps — schedules die with the toggle now |
| 3 | **Tools** | `any-bot/server/services/tools/<app>/` → package `tools/`; framework tool-registry entries → manifest `tools:`; asset paths → `OSHAL_APP_PACKAGE_DIR` | LM: 42 files; sendFile paths must go package-dir-aware in `src-routes` |
| 4 | **Bots + personas** | Registry entries (BOTH files) + persona YAMLs → manifest `bots:` + `personas/` | agentId ownership is exclusive (upserts clobber `base_capabilities` whole-array) |
| 5 | **Bot CONTAINERS** | 37 compose services can't ship in a package — see §5 decision D1 | The single biggest open design item |
| 6 | **Security objects** | `requiresAuth` per route (manifest, default-on ✓); **accessRoles (ADR-087) → needs a manifest field (Wave 0)**; guest-capability tier → manifest field (Wave 0); RLS policies on owned tables ride the owned migrations; shared RLS migrations get `to_regclass` guards (060 pattern, proven); secrets NEVER in packages (broker stays kernel); store installs stay operator-gated | The LM 060 scrub is the template |
| 7 | **Tables + migrations** | Owned migrations → package (+ `uninstall.sql`); shared migrations referencing owned tables → guard; `app_package_migrations` tracks (built); **pg_dump owned tables BEFORE the drop, restore into the fresh schema after reinstall** | LM's data is still in backup, not restored — restore is part of DONE, not an afterthought |
| 8 | **Schedules** | Manifest `schedules:` — registration (built) + teardown (built v0.5.0) | Per-user instances tear down too |
| 9 | **Cockpit/client** | Ribbon via manifest ✓; skins via package `ui/*.css` + `themeCssUrl` ✓ (v0.5.0); Jarvis catalog auto-discovers from `swarm_applications` ✓; app-specific cockpit-side JS (lm-concierge class) → package `ui/` — **core has no package-client-JS loader; keep such logic inside the app's own iframes** or accept the gap | RibbonNav/welcome/theme-manager literals must go per app |
| 10 | **Tests** | App specs → package `tests/`; shared specs re-fixtured — **pick a PERMANENT kernel fixture** (hello-oshal installed in CI) so we stop re-pointing every wave | swarm-apps-framework.spec currently fixtures gov-contracting — will break at its carve |
| 11 | **Docs** | App docs → package `docs/`; extract PLATFORM knowledge first (the wslrelay lesson); fix every doc link (`node scripts/docs-link-check.js`) | |
| 12 | **Dependencies** | Declare `dependencies:` in the manifest; resolver handles installed→core→store; end-state needs shared targets (presentations, world-data) packaged too | Dependents may carve before their deps (core satisfies) |
| 13 | **Features: kernel SKILL vs app-owned** | Decide per feature: a **Tier-0b kernel skill** (§2) stays in core and the package `@/features/*` imports it (guaranteed by D8's barrel); an **app-owned** feature must be **VENDORED into the package** (google-calendar lesson — `tsconfig.server.json` prunes any feature core no longer imports). ChromaDB collections, per-bot output volumes, per-app `.env` keys → inventoried per app (env keys → manifest `settings:` where user-facing) | The silent killer of carve N+1. **Post-carve check: grep the built image for every `@/features/*` the package requires.** |

---

## 4. The proven per-app procedure (the LM playbook, generalized)

1. **Claim** in COLLABORATE.md (shared files, containers, deploy windows).
2. **Inventory** — an Explore-agent classification pass filling the §3 ledger with file:line
   precision (LM's found 7 extra migrations + a Jarvis coupling the manifest never declared).
3. **Preserve-first** — copy EVERYTHING into the store subproject (`src-routes/`, `tools/`,
   `migrations/` + `uninstall.sql`, `personas/`, `ui/`, `docs/`, `tests/`); vendor
   core-unreferenced features; move personal/PII files OUT of both repos.
4. **Package** — manifest superset (deps/settings/visibility/theme/schedules), alias imports in
   `src-routes`, `oshal-app build`, `oshal-app validate` → 0 errors.
5. **Rip core** — delete owned files; DECOUPLE shared code (no app literals left behind); guard
   shared migrations; scrub cockpit/tests/scripts/docs; convert cron starters → schedules.
6. **Validate offline** — tsc 0, full vitest green, exhaustive grep sweep, image build with
   zero app symbols inside.
7. **Data** — **`bash scripts/oshal-app-backup.sh <prefix> <out.sql>` (NEVER a bare pg_dump)**
   → drop via `uninstall.sql` → reinstall from store → migrations recreate schema →
   **restore the data** → row-count parity check.
   **⚠ INCIDENT (2026-07-12, the reason the script exists):** the LM pre-carve-out backup
   of 07-10 was taken as an RLS-subject role — pg_dump hit FORCE ROW LEVEL SECURITY on
   `lm_classes`, wrote its error INTO the dump, and the truncated file looked plausible.
   The drop proceeded; the pre-reset LM data was lost (surviving material/lecture FILES
   were salvaged from the workspace volume to `c:/Projects/oshal-lm-recovered-2026-07-13/`).
   The script dumps as the in-container superuser and FAILS LOUDLY on embedded errors or
   any live-vs-dump row-count mismatch. A backup that doesn't end with "VERIFIED" must
   never precede a drop.
8. **Deploy + live-verify** — api recreate (announced, market-closed window), boot log shows
   discover/migrate/mount, HTTP + browser check (human-testability gate).
9. **Tag** (`appstore-vX.Y.Z`) + COLLABORATE release + store `marketplace.json` entry.

Rollback at every step: per-wave git tag + per-app DB dump + `baseline-pre-appstore-2026-07-09`.

---

## 5. Wave 0 — framework gaps to close BEFORE mass-carving

| ID | Gap | Why it blocks |
|---|---|---|
| **D1** | **✅ DECIDED 2026-07-13 — [ADR-093](../adr/093-packaged-app-runtime-placement.md).** Staged tiers, minimum framework change (operator's steer): (c) inline-concierge for reason-only bots (exists) · (b) operator-applied compose fragment for heavy bots (INTERIM, first-party only) · (a) node pool = TARGET with its own future go/no-go. Per O5, same tiers govern skill-declared infra. | Wave 1 unblocked |
| D2 | Manifest `auth:` per route (`oidc` \| `service-or-oidc`) so serviceSecretOr routes can carve | Wave 2+ apps use it |
| D3 | Manifest bot `accessRoles` (ADR-087) so packaged internal bots stay out of Jarvis's world | Security parity |
| D4 | Manifest `guestTier` (replaces guest-capability-matrix literals) | Security parity |
| D5 | Permanent CI fixture: install `hello-oshal` in the test bootstrap; re-fixture shared specs ONCE | Stops per-wave spec churn |
| D6 | ~~LM data restore from the 07-10 dump~~ **CLOSED AS DATA LOSS (2026-07-12):** that dump was RLS-truncated (embedded pg_dump error; 3 tables, 7 synthetic rows) — the pre-reset rows are unrecoverable. Surviving files salvaged to `c:/Projects/oshal-lm-recovered-2026-07-13/`; current state has a VERIFIED backup (`oshal-lm-backup-verified-2026-07-13.sql`). Replacement gate: ledger #7 uses `scripts/oshal-app-backup.sh` and its VERIFIED output is a hard precondition for every wave's drop step | The restore procedure must be proven before Wave 1 relies on it — and the backup must be provably complete first |
| D7 | (Optional, high leverage) `install-remote` API endpoint + cockpit Discover surface | Installs without a terminal |
| **D8** | **Kernel-skills contract (HIGH — silent-breakage AND security class).** See [ADR-090](../adr/090-skills-as-first-class-packages.md) + the derived [skill-registry.md](skill-registry.md). **Finding: the kernel API already exists — it is `AppContext`** (apps reach capabilities via `ctx.*` far more than via imports), and it hands **20 apps a raw `ctx.pool`** — unrestricted DB access, which a third-party store package must never get. So D8 = formalize AppContext (stable package-callable contract vs platform internals; scoped facade instead of the raw pool), not invent a new barrel. Plus the original pruning problem: Today a feature reaches `dist/` only if some *core* file happens to import it (`tsconfig.server.json` excludes `src/features/**`). So the kernel's package-facing API is accidental: **`notifications` is ALREADY pruned** — the first app package that calls notifyAll fails at mount, exactly as `google-calendar` did. Fix: (a) a **kernel-skills barrel** core always imports (guarantees compilation into dist), (b) explicit `tsconfig.server.json` includes for those feature paths, (c) a documented **stable API surface** listing the Tier-0b skills packages may `@/features/*` import, (d) a **CI guard** asserting every declared skill is present in the built image, (e) correct LM's `dependencies.apps: [presentations]` → skill `uses:`. | Every wave depends on it; without it each carve risks silently pruning a skill a *later* package needs |

---

## 6. The waves (provisional — each app's Step-2 inventory finalizes its wave)

**Wave 1 — light apps** (concierge-bot + manifest, few/no owned server routes):
`brand-graphics, capture-crm, cloud, lora, vids, youtube-kids, job-apply, finance, payments,
identity, devops (facade)` + retire-or-store the probe/smoke workflow YAMLs.
*Watch:* `daily-trade-recap` LOOKS light but drives the live 5PM pipeline — treat as Wave 3.

**Wave 2 — single-surface apps with routes** (+ interim container model from D1):
`eats, movies, rides, spotify, purchasing, storage, home, creative-studio, video,
presentations` (shared dependency target — carve mid-wave, dependents already resolve to core),
`travel` (+farewatch cron→schedule), `feeds` (+indexing cron→schedule), `social`,
`email-summarizer` (+inbox-ingest cron→schedule).

**Wave 3 — heavy / multi-bot / engine apps:**
`career-hunter` (Python engine + cron + 807k-posting data store), `gov-contracting` +
`federal-capture` (engine + cron + SAM pipeline; carve as a pair), `intelligent-operations`
(4 bots + RAG collections), `intelligent-processing`, `daily-trade-recap` (live pipeline).
Engines ship IN the package (`engine/`); runtime needs python3 on the node — part of D1's
container answer.

**Wave 4 — LAST, live-money + deep-shared (extra soak, market-closed only):**
`world` (trading depends on its feed; `world-schedule-dispatch` lives in `src/app/` — real
decoupling work), `intelligent-trades` (**the LIVE autopilot runs here — nothing moves without
a dedicated safety plan: watchdog checks green, TRADING_HALT drill, paper-parity soak after**).

**Apps built AFTER this plan — awaiting Step-2 triage (PROPOSED, needs operator sign-off):**
Six apps landed in `swarm-apps/` after the wave list above was drawn and have no carve disposition
yet. Proposed homes below; each still needs its own §4 Step-2 inventory to finalize its wave.

| App | Proposed home | Rationale |
|---|---|---|
| `pumpkin` | **Wave 1** (light) | Prop app; agent runs inline on the api, no own container — a manifest + surface carve like `brand-graphics`. |
| `kalshi` | **Wave 3** (finance data) | ADR-094 prediction markets; paper-only today (Phase 2 blocked on the operator's Kalshi account). Escalate to Wave 4 if it goes live-money. |
| `camera` | **Wave 3** (device node) | GoPro control; ships a standalone `camera-node` (clones the drone-ops device-node stack) → heavy tier, ADR-093 container question applies. |
| `drone` | **Wave 3** (device node) | ADR-099 drones-as-swarm-nodes; conductor + device nodes + live-retask → heavy tier; carve once the device-node runtime is settled. |
| `sat-ops` | **Wave 3** (device node) | ADR-102 satellites-as-swarm-nodes; session-bound nodes + orbital sim → heavy tier, same D1 container dependency. |
| `person-model` | **Kernel skill — likely NOT a carve** | ADR-100 ambient person model is cross-app user state; it belongs with the Tier-0b `user-model`/`personal-data`/`memory` skills (§2), not a package. If anything carves, only a thin consent/recall SURFACE does. **Operator decision needed.** |

**Definition of done (whole plan):** `swarm-apps/` contains zero *carveable* application manifests
(the six kernel-resident apps in §2 keep theirs by design); a fresh clone + `oshal-up` boots the
kernel with an empty carveable ribbon; `oshal-app install <everything>` rebuilds today's swarm;
every app's data restored; all 4 remaining env-gated crons gone (schedules under toggle control);
107 hard mounts → ~0 carveable app mounts in `server.ts`.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Trading autopilot disruption (Wave 4) | Market-closed windows only; watchdog green before/after; TRADING_HALT rehearsed; paper-parity soak |
| Data loss at schema drop | pg_dump BEFORE every drop (proven), restore is a done-criterion (D6 proves it), backups outside git |
| Silent feature pruning (ledger #13) | Post-carve image grep for every `@/features/*` the package requires |
| Shared-index collisions (multi-agent tree) | Stage+commit+push tight, stray-guard before every commit (twice bitten this week) |
| Fresh-install breakage from shared migrations | `to_regclass`/IF-EXISTS guards (060 pattern) + a fresh-DB boot test per wave |
| Spec churn | D5 permanent fixture first |

**Estimate:** LM (hardest single app so far) ≈ one long session including framework building.
With the framework now built: Wave 0 ≈ 1 session (D1 ADR + D2–D6), Wave 1 ≈ 1–2 sessions
(batchable), Wave 2 ≈ 2–3, Wave 3 ≈ 2–3, Wave 4 ≈ 1–2 with soak. **~8–11 working sessions.**

---

*Next action when approved: Wave 0 — starting with the D1 bot-container ADR and the D6 LM data
restore. Nothing executes before that approval.*
