# Building & registering a bot the right way

This is the canonical how-to for adding a new bot to the OSHAL swarm. It exists because the
registry/compose/persona wiring was spread across ADRs and code comments, and "just register it
inline" kept producing bots that aren't real swarm participants. Read this before adding a bot.

## The rule: a bot takes one of exactly two forms

A bot must be a **registered swarm node**, reached the standard way. There are two sanctioned forms.
Pick by what the bot *does* — do not invent a third (no bespoke "run it from one route" shortcut).

| | **A — Dedicated any-bot-swarm node** | **B — Concierge node (inline on the api)** |
|---|---|---|
| Runs in | its own container (`BOT_RUNTIME=bot-node`) | the api container, via `ctx.orchestrator` |
| Reach it via | `BotNodeClient.execute()` → `http://<container>:5000/api/swarm-execute`, and the `/chat` path | the app's **`POST /chat`** route (orchestrator brain), and the `/chat` path |
| Use when | the bot **shells out** (codex CLI tools, `scripts/oshal-*.js`), controls external devices/APIs, owns a heavy per-user store, or needs its own LLM provider | the bot is **reason-only** / lightweight — a brain over data the api assembled, no shell-out |
| Examples | `email-bot`, `home-bot`, `cloud-ops-bot`, `jarvis-bot` | `movies-concierge`, `spotify-concierge`, `travel-concierge`, `workflow-assistant` |
| Cost capture | `recordCost` → `chat_tasks` under the bot's `agentId` | same |

Both forms are **first-class swarm participants** — registered, selectable in `/chat`, cost-tracked.
The only difference is where the LLM runs. `claude-code-as-root` cannot shell out, so any bot that
needs a shell **must** be Form A on a `codex-cli` (or `cline`) harness.

## Credentials: everything is BYOK on the swarm default login

OSHAL does **not** bake a vendor API key per bot. Bots run **BYOK on the swarm default login** — the
host OAuth sessions mounted read-only into the runtime:

- `~/.claude` → Claude Code CLI  •  `~/.codex` → Codex CLI  •  `~/.gemini` → Gemini CLI

Default provider precedence is one server-owned rule, documented in
[ADR-034](adr/034-bidirectional-config-ownership-sync.md#1a-provider-and-model-precedence):

1. A registry `harnessType` other than the generic `cline` wrapper pins the provider. A per-bot
   provider write is rejected because it would have no effect; a compatible model remains writable.
2. For `cline` or a bot without a pinned harness, the per-agent Postgres record wins.
3. The registry `apiType` is the next fallback.
4. `FORCE_LLM_PROVIDER` / global config is the deployment default and first-boot seed.

The Config Admin UI renders the API's `effectiveProvider`, `providerSource`, and precedence reason;
it does not re-derive the rule in browser code. A registry-read failure disables provider mutation
instead of assuming the highest tier is absent. An explicitly authorized **per-request**
`byoLlmConnection` is a separate ephemeral rail for runtimes that support it: it never rewrites the
bot default (see [ADR-058 / byo-llm](../src/app/routes/byo-llm-routes.ts)). Do **not** add a vendor key
to a bot's env to "make it work"; that leaks credentials and bypasses the ownership model.

## agentId rules

- A v4-style UUID, unique across the registry. Boot runs `validatePersonaIdentities()`
  ([swarm boot](../src/app/extensions/swarm/index.ts)) and **exits(1)** on a duplicate `agentId` or
  `name`. The persona YAML `agent_id` must match the registry entry.
- Registry id **must equal** the manifest id for app-contributed bots (the
  [build-your-own-swarm-app](build-your-own-swarm-app.md) "compiles-but-fails" rule).

## Which registry?

`getActiveRegistry()` ([swarm-bot-registry.ts](../src/app/extensions/swarm/swarm-bot-registry.ts))
returns the lean **local** registry by default, or the fuller canonical `SWARM_BOT_REGISTRY`
when `SWARM_REGISTRY=full`. **Add your bot to both** files
([swarm-bot-registry.ts](../src/app/extensions/swarm/swarm-bot-registry.ts) and
[swarm-bot-registry-local.ts](../src/app/extensions/swarm/swarm-bot-registry-local.ts)) or it will be
missing in one profile.

## Should Jarvis see it? (`accessRoles`, ADR-087)

By default every registered bot is discoverable and callable by every caller, **including Jarvis**
(app catalog + the queue call-out on jarvis-sourced tickets). If the bot is internal machinery,
privileged, or otherwise not something the assistant should reach, declare
`accessRoles: ['operator', 'swarm']` on the registry entry — see
[ADR-087](adr/087-access-roles-jarvis-visibility-scoping.md). Omit the field for normal
user-facing domain bots. The same model scopes CLI tools out of Jarvis's auto tool-feed via
`TOOL_CATALOG` in [jarvis-routes.ts](../src/app/routes/jarvis-routes.ts).

---

## Form A — add a dedicated any-bot-swarm node

1. **Registry (both files).** Give it its own `container` (NOT `oshal-api`) and a unique host `port`:
   ```ts
   {
     agentId: 'a9000000-0000-0000-0000-0000000000NN',
     name: 'calendar-bot',
     port: 3099,
     container: 'calendar-bot',
     role: 'productivity/calendar',
     capabilities: ['calendar-sync', 'event-management'],
     harnessType: 'codex-cli',   // codex/cline can shell out; claude-code-as-root cannot
     apiType: 'openai-codex',
   }
   ```
2. **Compose service** in [docker-compose.oshal-local.yml](../docker-compose.oshal-local.yml) — copy an
   existing bot (e.g. `home-bot`). Inherit `<<: *bot-common` and `<<: *bot-env`; set `BOT_NAME`,
   `AGENT_ID`, `BOT_PERSONA_FILE`, `AGENT_CAPABILITIES`, optional `FORCE_LLM_PROVIDER`/`FORCE_LLM_MODEL`
   override, the auth-volume anchors (`*codex-auth-volume` / `*claude-auth-volume` = the swarm login),
   and an own output/data volume. `depends_on` redis + db + oshal-api healthy.
3. **Persona** `ai-lab/bot-personas/<name>.yaml` — `name`, `role`, `agent_id` (matches registry),
   `perspective` (system prompt), `capabilities`, `routing_keywords`, `selector_descriptor`,
   `authorizations` for the tools it may call.
4. **Tool CLI** (if it shells out) — `scripts/oshal-<provider>.js`, reading the caller's brokered token
   (`OSHAL_CRED_*` / `.oshal-cred-*`), like [scripts/oshal-gmail.js](../scripts/oshal-gmail.js).
5. **Reach it** — `BotNodeClient.execute(agentId, {...})` from the app route (use
   [`executeBotOrInline`](../src/app/routes/inline-bot-execution.ts) so it works in both forms). The
   node heartbeats to `oshal:runtime-agent:{agentId}` every 30s and resolves to `http://<container>:5000`.

## Form B — add a concierge node (inline, reached via /chat)

This is the right form for a **reason-only** bot. Worked example:
[`workflow-assistant`](../ai-lab/bot-personas/workflow-assistant.yaml) (Workflow Studio, ADR-039) and
`travel-concierge` in the store-side Travel package.

1. **Registry (both files)** with `container: 'oshal-api'`:
   ```ts
   {
     agentId: 'a0000000-0000-0000-0000-000000000051',
     name: 'workflow-assistant',
     port: 3010,
     container: 'oshal-api',                 // inline → orchestrator runs the brain
     role: 'workflow/orchestration-specialist',
     capabilities: ['workflow-design', 'process-architecture'],
     harnessType: 'claude-code',
     apiType: 'claude-code',
   }
   ```
   No compose service is needed (it runs in the api container, on the swarm default login).
2. **Persona** `ai-lab/bot-personas/<name>.yaml` — same shape as Form A. For a reason-only bot, pin a
   strict **output contract** in the perspective (e.g. workflow-assistant emits one validated
   `workflow-graph` JSON block and calls no API) so the surface can parse it deterministically.
3. **`POST /chat` route** — the standard concierge transport. Resolve the caller `sub`, broker any
   tool creds, run the brain, persist to the app's own store, return the result:
   ```ts
   const result = await executeBotOrInline(ctx, botClient, AGENT_ID, {
     text: prompt, taskId: `myapp-${sub}`, workspaceFolderId: `myapp-${sub}`,
     agentId: AGENT_ID, agenticMode: true, direct: true, userSub: sub, creds,
   });
   // parse result.response, persist to the app store, return it
   ```
   See the store-side `travel-routes.ts` (`router.post('/chat', ...)`) and
   [workflow-studio-assist-routes.ts](../src/app/routes/workflow-studio-assist-routes.ts) for the two
   shapes (concierge-envelope vs. a typed store like the Workflow Studio definition store).
4. **Surface** — the cockpit page/panel calls `POST /api/<app>/chat`. Reasoning runs on the
   accountable bot, so cost lands in `chat_tasks` under its `agentId` (ADR-036).

---

## New-bot checklist

- [ ] Unique `agentId` (UUID) + `name`; persona `agent_id` matches.
- [ ] Registered in **both** `swarm-bot-registry.ts` and `swarm-bot-registry-local.ts`.
- [ ] Form A: compose service added (image, `BOT_*` env, auth-volume anchors, depends_on). Form B:
      `container: 'oshal-api'`, no compose service.
- [ ] Persona YAML present; reason-only bots pin a strict output contract.
- [ ] Reached via `BotNodeClient`/`executeBotOrInline` and a `POST /chat` route — **not** a one-off
      bespoke endpoint.
- [ ] No vendor API key added to the bot's env — it runs BYOK on the swarm default login.
- [ ] `npx tsc --noEmit` clean; boot does not fail `validatePersonaIdentities()`.
- [ ] A human can exercise it from `localhost` with `MOCK_OIDC=true`.

## See also

- [ADR-019 — per-bot container architecture](adr/019-per-bot-container-architecture.md)
- [ADR-033 — multi-harness execution framework](adr/033-multi-harness-execution-framework.md)
- [ADR-036 — bot-owned application architecture](adr/036-bot-owned-application-architecture.md)
- [ADR-039 — bot-driven workflow authoring](adr/039-bot-driven-workflow-authoring.md) (concierge worked example)
- [build-your-own-swarm-app.md](build-your-own-swarm-app.md) — app manifests that contribute bots
