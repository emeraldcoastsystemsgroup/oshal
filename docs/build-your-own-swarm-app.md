# Build Your Own Swarm App in 10 Minutes

OSHAL is a **seed**: the core platform (cockpit UI, auth, RAG, queue, cost tracking,
multi-provider/multi-harness LLM execution) is generic and stays untouched. You build a
new app by **dropping in a declarative manifest** — not by forking the core. This tutorial
builds a tiny "Helpdesk" app from scratch so you can see every moving part.

> The flagship example, [Little Monsters](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/little-monsters) (a K-12 study — now an ADR-085 store package
> companion), is exactly this pattern at full size: one manifest + persona YAMLs + a tools
> directory + migrations, with **zero changes to OSHAL itself**. There are 30 example apps in
> [swarm-apps/](../swarm-apps/) — all the same core. They range from this kind of single-bot
> ticket-routing app up to "data apps" that also declare their own `routes[]` + `migrations[]`
> and an inline reason-only bot (e.g. Intelligent Trades, Finance, Security Center, Payments,
> Shopping, World Intelligence).

## What you'll build

A `helpdesk` app: one bot ("triage-agent") that handles `helpdesk` tickets, with its own
ribbon icon in the cockpit. ~15 lines of YAML, no code.

## Prerequisites

The stack running locally (see the [README quickstart](../README.md#quick-start)). The zero-keys
path works for this tutorial:

```bash
FORCE_LLM_PROVIDER=noop MOCK_OIDC=true docker compose -f docker-compose.oshal-local.yml up -d
# cockpit at http://localhost:35457
```

## Step 1 — Write the persona

A persona YAML is the bot's full system prompt + quality gate. Create
`ai-lab/bot-personas/triage-agent.yaml`:

```yaml
name: triage-agent
role: helpdesk/triage
perspective: |
  You are a helpdesk triage agent. For each ticket: classify severity (P1–P4),
  identify the affected system, propose the first diagnostic step, and write a
  short, friendly acknowledgement for the requester. Always end with a
  HANDOVER.md summary block (Status / Findings / Next Steps).
```

## Step 2 — Write the app manifest

Create `swarm-apps/helpdesk.yaml`. This is the whole app:

```yaml
name: helpdesk
displayName: Helpdesk
description: Triage incoming helpdesk tickets with a single self-gating bot.
version: 1.0.0
status: active          # active | inactive
suite: ai-productivity  # ADR-097: the ONE catalog shelf this app lives on — pick by who it's
                        # for, not by which tools it uses (unknown values fail the load)

bots:
  - agentId: 11110000-0000-0000-0000-000000000001
    name: triage-agent
    persona: ai-lab/bot-personas/triage-agent.yaml
    role: helpdesk/triage
    capabilities: [triage, classification, acknowledgement]

# UI: one ribbon icon that focuses the cockpit on this app
ui:
  static:
    - toolName: helpdesk-queue
      label: Helpdesk
      icon: codicon codicon-inbox
      iframeUrl: /api/tickets?ticketType=helpdesk
      section: top

# Route tickets of this type through a single self-gating worker (no separate reviewer)
ticketType: helpdesk
workflow:
  name: Helpdesk Triage
  pipeline: helpdesk
  workerBot: triage-agent
  phases: [intake, triage, delivery]

# Focus mode: when /cockpit?app=helpdesk is opened, hide the framework chrome
ribbon:
  hideFrameworkItems: [chat, calendar, addressbook, operations]
  defaultView: helpdesk-queue
```

That's the entire app. Bots, ticket routing, and a branded cockpit surface, declared.

## Step 3 — Load it

Manifests in `swarm-apps/` are auto-loaded at controller boot. Either restart the api, or
load it live without a restart:

```bash
curl -X POST http://localhost:35457/api/swarm/apps/load \
  -H 'Content-Type: application/json' \
  -d '{"path":"swarm-apps/helpdesk.yaml"}'
```

## Step 4 — See it

Open **http://localhost:35457/cockpit?app=helpdesk**. You get:
- the cockpit rebranded to **Helpdesk** (header + browser tab),
- a single **Helpdesk** ribbon icon (the framework chrome hidden),
- a `triage-agent` bot live in the swarm.

Create a `helpdesk` ticket and it routes to your bot:

```bash
curl -X POST http://localhost:35457/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"title":"Printer on 3rd floor is down","description":"Users cannot print","ticketType":"helpdesk"}'
```

To retire the app, delete `swarm-apps/helpdesk.yaml` (it flips inactive on next load) or:

```bash
curl -X PATCH http://localhost:35457/api/swarm/apps/helpdesk/toggle \
  -H 'Content-Type: application/json' -d '{"active":false}'
```

## What the manifest can declare (full surface)

| Block | What it contributes |
|---|---|
| `suite` | The app's ONE primary catalog shelf ([ADR-097](adr/097-app-suites-primary-categorization.md)): `ai-productivity` \| `ai-knowledge` \| `ai-finance` \| `ai-creative` \| `ai-home` \| `ai-engineering`. Groups the `/applications` catalog; never derived from tool categories |
| `bots[]` | Swarm agents (each with a persona; optional `harnessType`/provider) |
| `foundation.persona` | A shared persona layered under every bot in the app |
| `tools` / `toolsDir` | Tool implementations the bots can call (auto-discovered from a directory) |
| `ui.static[]` | Hardcoded ribbon icons (each routes to an `iframeUrl`) |
| `ui.dynamic` | One ribbon icon **per DB row** (e.g. one per class/project) |
| `routes[]` | App-owned Express routes (gated; 503 when the app is inactive) |
| `migrations[]` | SQL applied idempotently on first load |
| `workflow` | Ticket-type → pipeline routing (worker bot, phases, optional reviewer) |
| `uses` | Kernel SKILLS (importable modules) the app calls — e.g. `deck-generation`, `rag`, `voice` ([ADR-090](adr/090-skills-as-first-class-packages.md)). Fail-closed against the closed `KernelSkillId` set |
| `skillProfiles` | Domain PATTERNS for profileable capabilities the bot performs — e.g. `summarize: { pattern, instructions, sections }` ([ADR-090 addendum](adr/090-skills-as-first-class-packages.md)). Teaches a generic capability the app's domain (class notes vs meeting notes); a capability is NOT a kernel module, so its keys are the capability vocabulary, never a `uses:` id. Resolved at dispatch, composed into the bot prompt (cost stays on the bot) |
| `voice` | TTS/STT provider selection (or `swarm-default`) |
| `theme` / `sharedCss` | Per-app theming |
| `ribbon` | Focus-mode visibility (`hideFrameworkItems`, `defaultView`) |

See [docs/swarm-apps-framework.md](swarm-apps-framework.md) for the complete reference, and
[the little-monsters package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/little-monsters) for a production-scale
manifest that uses every block.

### Example: a "data app" that owns routes + migrations + a reason-only bot

The Helpdesk tutorial above is the minimal shape (one bot, ticket routing, a ribbon icon). A
larger class of apps also owns server-side state and HTTP routes. [Security Center](../swarm-apps/security.yaml)
(ADR-055) is a compact example of that shape:

- `bots[]` — a single `security-analyst` that is **reason-only** (it triages findings; it does
  not act). Because it only reasons, it runs inline on the api container rather than as a
  separate bot-node container.
- `routes[]` — declares `mountPath: /api/security`. The path is authoritative for the gate:
  when the app is toggled inactive, `/api/security/*` returns 503. (The Express mount itself is
  still hardcoded in `server.ts` under framework Phase 1 — `module`/`factory` are informational.)
- `migrations[]` — declares `scripts/migrations/039-security-center.sql`. Migrations are
  informational in Phase 1 (the framework bootstrap applies SQL at boot); the security routes
  also self-heal their schema via `ensureSchema`.
- `workflow` — a single-worker `security` pipeline: a `security-finding` ticket routes to
  `security-analyst`.

As-built scope: Security Center runs deterministic scanners (committed secrets, unauthenticated
routes, vulnerable dependencies) plus runtime/ledger/audit threat detection, the analyst triages
each finding, and one click escalates a finding to a tracked ticket. It does **not** auto-remediate
(no key rotation, no code edits) — the operator acts on the assessment.

[Intelligent Trades](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/trading) (ADR-052/053 — carved to the app store per ADR-085) follows the same
routes + migrations + inline-bot shape; it is paper-only by default, with live execution gated
behind `TRADING_LIVE_ENABLED` and an explicit confirm.

### The wiring the manifest does NOT do (compiles-but-fails checklist)

The manifest declares intent, but for a `routes[] + inline bot` app three things live in core
code, **not** in the YAML. Skip one and the build is green while the feature fails at runtime —
this has bitten trading (`cd922ee`) and security alike. For any app with an inline bot + a route:

1. **Register the bot in the endpoint registry** —
   [`src/app/extensions/swarm/swarm-bot-registry-local.ts`](../src/app/extensions/swarm/swarm-bot-registry-local.ts).
   `createRegistryEndpointResolver()` reads it; without an entry, `BotNodeClient.execute(agentId, …)`
   cannot resolve the bot, so any LLM action (e.g. "Assess") throws at runtime even though it
   compiles. Inline reason-only bots use `port: 3010, container: 'oshal-api', harnessType:
   'claude-code'` (mirror `finance-analyst` / `trading-analyst`).
2. **Mount the route in `server.ts`** — `app.use('/api/<app>', requiresAuth, create<App>Routes(ctx, apiDir))`.
   Route mounting is compile-time under framework Phase 1, so a deployed server needs a **rebuild**
   to pick up a new route; the manifest `routes[]` block only drives the inactive-gate, it does not
   create the mount.
3. **Add the surface to the cockpit profile** — [`config-seed/profiles/oshal-framework.json`](../config-seed/profiles/oshal-framework.json).
   The default unified home renders the curated profile, so an app whose surface is not listed there
   never appears in it (even though the manifest `ui.static[]` is valid).

Also: pick a **collision-free `agentId`** (grep the existing ids first) and keep persona +
manifest + registry id identical. The `little-monsters` manifest exercises every manifest block;
`security` / `trading` exercise the three core-code steps above.

## Going further

- **Build a real data app, addon by addon** (its own routes, tables, native surfaces, vendored
  engine): the [addon-developer-guide.md](addon-developer-guide.md) is the per-addon-type recipe
  (tool, bot, workflow, surface, connector), how to bind them into one manifest and import it, and
  exactly which pieces are hot YAML vs which need a code change + rebuild.
- **Give the bot an external account** (Gmail, a SmartThings hub, a GCP project): follow
  the connector → CLI → tool kit → bot recipe in
  [connector-backed-apps.md](connector-backed-apps.md). The email, smart-home, and cloud
  bundles are working reference implementations.
- **Generate an app from an interview** instead of writing YAML: the `codex-packer` bot
  ([ai-lab/bot-personas/codex-packer.yaml](../ai-lab/bot-personas/codex-packer.yaml))
  interviews an operator and emits a packed app (persona + manifest + KB).
- **Add a new LLM harness** (a different CLI/provider): extend `HarnessType` and register a
  factory — see [docs/adr/033-multi-harness-execution-framework.md](adr/033-multi-harness-execution-framework.md).
- **Ground a bot in your docs**: drop PDFs/text into a RAG collection and have the persona
  cite them (the Little Monsters tutor does exactly this).
