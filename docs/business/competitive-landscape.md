# OSHAL competitive landscape (mid-2026)

> Strategy artifact. Where OSHAL sits against the field, what's defensible, what's catch-up,
> and how to compete. Companion to [ADR-049 (aggregation-platform thesis)](../adr/049-oshal-as-aggregation-platform.md),
> [ADR-067 (connector marketplace + dynamic tool loading)](../adr/067-connector-marketplace-and-dynamic-tool-loading.md),
> and [ADR-047 (edge bot-node / Home Assistant)](../adr/047-smart-home-edge-agent.md).
>
> Sources are linked inline. Competitor facts are as of ~June 2026 and move fast — re-verify before
> using in an external deck.

> Active closure plan: Competitive Score Closure Plan (2026-06-22)
> turns these gaps into the execution queue for closing every below-competitor
> product-functionality score.

## The core insight: two axes, two completely different competitive pictures

OSHAL is judged on two different questions, and they give opposite answers. Conflating them is how
you either overstate the moat or panic about the crowd.

| Axis | The question | The field | OSHAL's position |
|---|---|---|---|
| **Substrate** | "Who else is a vendor-neutral, multi-*harness*, self-hosted orchestration platform?" | **Thin** — genuinely rare | **Moat.** Nobody else treats the agent *framework* as swappable + owns the user's keys/data |
| **Functionality** | "Who else lets me talk to it and it does my stuff?" | **Brutally crowded** — dozens, incl. Amazon/Google/Apple/OpenAI | **Wedge, not lead.** "Does stuff" is now a free, commoditized feature |

**The whole strategy follows from this:** don't *sell* on the functionality axis (you lose to free Alexa),
sell on the ownership/neutrality wedge — and use the substrate moat as the *reason the wedge is credible*.

---

## Axis 1 — Substrate (the developer/platform view): a thin field, and your moat

### The map

| Category | Players (2026) | Where they beat us | Where we beat them |
|---|---|---|---|
| **Agent frameworks (OSS)** | LangGraph (34.5M dl/mo), CrewAI (5.2M), AutoGen, Mastra, OpenAI Agents SDK | Maturity, ecosystem, community | Single-framework libraries; we're the **framework-neutral platform layer** above them |
| **Self-hosted agent platforms (OSS)** | Dify, Flowise, Onyx/Ontheia, n8n-AI | GUI authoring, MCP-native tools, RBAC, polish | Harness-neutrality, bot-owns-domain, cost optimization, packer |
| **Self-hosted multi-LLM chat (OSS)** | Open WebUI (139k★), LibreChat (22k★), AnythingLLM (54k★) | Community scale, polish, RAG depth | They're chat+read; we *act* on accounts + run swarms + capture cost |
| **Workflow automation** | Zapier (8000 apps / 40k actions via MCP), n8n (1100+, Commons Clause), Activepieces (450+, MIT), Make, Lindy | **Connector breadth, 20–170×** | Zapier isn't self-hosted/data-owning; none own the LLM-routing/cost layer or run real swarms |
| **Paid enterprise** | OpenAI (AgentKit / Frontier / Connector Registry), MS Copilot Studio, Salesforce Agentforce, Google Agentspace, AWS Bedrock AgentCore, IBM watsonx | Distribution, trust, scale, compliance | **Structural lock-in is their weakness** — a vendor can't route off its own models; a CRM can't hand you your data |

### Scorecard

| Axis | OSHAL | Best OSS | Best paid |
|---|---|---|---|
| Model neutrality | ✅ | ✅ (LibreChat) | ⚠️ locked |
| **Harness neutrality** | ✅ **unique** | ❌ | ❌ |
| **Cost/quality optimization (Token Chase)** | ✅ **unique** | ❌ | ❌ (anti-margin for them) |
| Connectors that *act* on user accounts | ✅ | ⚠️ (Zapier, not self-hosted) | ✅ (vendor-scoped) |
| **Connector breadth** | ⚠️ 46 audited entries; marketplace core built; OpenAPI import; 1 enabled locally; 1 live read pass | ✅ n8n 1100 / Zapier 8000 | ✅ huge |
| Data/key ownership + self-host | ✅ | ✅ (Open WebUI, Dify) | ❌ |
| Multi-agent swarm depth | ✅ | ⚠️ (lib-level) | ⚠️ |
| GUI workflow authoring + runtime | ⚠️ talk-to-build canvas + a **real** graph runtime (branches, concurrent parallel, ai-decision, approval gates, durable/resumable execution, agent-cluster steps) as of 2026-07; still behind mature canvases on polish/breadth | ✅ | ✅ |
| MCP-native (server-side) | ⚠️ API connector path is server-side; MCP still harness-side | ✅ (Onyx, LibreChat) | ✅ |
| Enterprise hardening (tenancy/RBAC/scale) | ❌ gates open | ⚠️ (Onyx RBAC) | ✅ |
| Maturity / community | ❌ (1 operator) | ✅ (100k+ ★) | ✅ |

**2026-06-22 connector note:** ADR-067 now includes browse/enable/disable/remove, audit-refresh
quarantine, cockpit controls, and OpenAPI draft import. The remaining gap is still breadth proof:
only 1 credentialed live read has passed, with a near-term gate of 5 brokered or credentialed
read-only connector passes.

**Read:** we win decisively on three hard-to-copy axes and lose on four that are *catch-up*, not *reinvent*.

---

## Axis 2 — Functionality (the user view): a crowded field, and your wedge

"Talk to it, it does your stuff, you don't manage it" is the **personal/ambient AI assistant** race —
the hottest, best-funded arena in tech in 2026.

| Who | What it does | The catch |
|---|---|---|
| **Alexa+** (Amazon) | All-US Feb 2026; agentic, multi-step, **100k+ devices**, books Uber/OpenTable/Ticketmaster; **free w/ Prime** / $20/mo | Amazon cloud + models; your data is theirs; monetizes toward Amazon |
| **Gemini for Home** (Google) | Agent Mode plan+execute, 50k+ devices, free / $10 premium | Google walled garden |
| **Siri / Apple Intelligence** | On-device + Private Cloud Compute; **privacy pitch** | ~1,000 HomeKit devices; locked to Apple; not self-hostable |
| **ChatGPT / Copilot / Meta AI / Perplexity** | Connectors, memory, voice, agent/task mode, shopping actions | Vendor cloud + model lock |
| **Personal-agent startups** | **Lindy** (400k paying users, 1,600 integrations), **Manus**, **Genspark**, **Ohai** (family logistics), Martin | "fastest-growing startup category of 2026 … raised billions before proving it works" |
| **Home Assistant + local LLM** (OSS) | Talk to it, controls your home, **fully local** (Whisper+Piper+Ollama+Qwen3), no cloud accounts, own all data | Home-device-centric; weak on broad SaaS/digital-life orchestration |

**Sobering truth:** "does stuff when you talk to it" is now a **free, commoditized feature**. We cannot
win that race on capability, device count, hardware, polish, or zero-setup against Amazon and Google.

### Where OSHAL actually fits

The user's own phrase — *"you don't have to worry about it"* — is the trade: with Alexa you don't worry
about it **because you don't control it**. Same sentence. OSHAL's functional identity is the inverse:

> **"The assistant that does your stuff, but you own it."** Your keys, your data, your choice of model
> *and* framework, self-hostable, acting on *your* accounts (not herded into a vendor's ecosystem),
> with cost you can see and control.

Closest neighbor isn't Alexa — it's **Home Assistant**: OSS, local, you-own-it, the people who already
refuse to hand their home to Amazon. But HA stops at *devices*. **OSHAL = Home Assistant's ownership
ethos extended to your whole digital life — email, finance, work, social, home — with real multi-agent
reasoning behind it.** ADR-047 *embeds HA Core* as the device engine, so HA is ally + component, not
pure competitor.

### Functional gaps to even be in the "talk to it" conversation

Today OSHAL is functionally closer to **"self-hosted ChatGPT-with-connectors + a swarm"** than to
Alexa+. The ambient layer is missing:

- **Voice / always-on / hardware presence** — giants live in speakers/phones/cars; OSHAL is type-to-it
  in a cockpit. Voice + edge surfaces are ADR-047 **roadmap, not built**.
- **Zero-setup** — giants are zero-config; OSHAL needs connectors/keys/self-host. The literal price of
  ownership: a disadvantage for mass consumers, an advantage only for those who value control.
- **Proactivity / ambient awareness** — giants push "anticipates you"; OSHAL is mostly request→response.

ADR-047 (edge bot-node embedding HA Core + thin voice surfaces) is exactly the plan that turns
"self-hosted assistant app" into "ambient assistant you own." Until it ships, the honest external
framing is *self-hosted personal-agent platform*, not *ambient assistant*.

---

## The moats — lean in, never dilute

1. **Harness-neutrality.** Every competitor bet on one framework; we bet on the abstraction *over*
   frameworks. As frameworks commoditize, value moves up to the router — us.
2. **Token Chase (cost/quality optimization across process × tool × provider).** No incumbent can
   build this — routing a customer to a cheaper *competitor's* model is anti-margin for
   OpenAI/MS/Salesforce/Amazon. Structurally exclusive to a neutral player. See ADR-046.
3. **Bot-owns-domain + acting connectors + self-host.** Chat-over-your-data (Open WebUI/LibreChat) or
   act-but-hold-your-tokens-in-their-cloud (Zapier) — only we do *act-on-your-own-accounts,
   self-hosted, with cost capture*.
4. **The packer factory.** A whole business process → one self-contained bot (persona + manifest + KB).
   A distribution/authoring moat none of the OSS platforms have.

## The gaps — and how to close each

1. **Connector breadth (46 vs 1100–8000).** Don't out-build Zapier — **inherit breadth via MCP.**
   Zapier's MCP server alone = 40k actions; the MCP ecosystem is hundreds of servers. Promote MCP from
   harness-side-only to a first-class **server-side** path, so a marketplace entry can be *any* MCP
   server. Plus ADR-067 mass-import (OpenAPI / Nango-reference / Activepieces-MIT, API-key-first):
   46 → thousands by *adoption*, not authoring. **Highest-leverage gap-closer.**
   2026-06-22 status: ADR-067 marketplace is built past the first slice: audited catalog,
   browse/enable/disable/remove API, audit-refresh quarantine, lazy enabled-provider route/tool
   loading, cockpit Connectors surface, and OpenAPI draft import via `npm run connectors:import-openapi`.
   Authenticated Cockpit proof now renders the Connectors surface and reaches the marketplace API with
   46 entries. The credentialed breadth gap remains: only Jira is enabled locally and only 1
   credentialed smoke pass exists; the near-term gate is 5 read-only passes, preferably through brokered
   per-user creds.
2. **MCP-native parity.** Same work as #1; the table-stakes axis where Onyx/LibreChat/Activepieces
   already are.
3. **Enterprise hardening (the disqualifiers).** Activate RLS, hosted/scaled deploy, RBAC, audit.
   Doesn't *win* deals; its absence *loses* every enterprise eval to Agentforce/Copilot Studio. Largely
   "turn on what's built" — days to weeks. (See the readiness gates in [BACKLOG.md](../BACKLOG.md).)
4. **GUI authoring.** Don't fight Dify/n8n on the canvas — **leapfrog with the packer**: conversational
   "describe your process → get a bot" instead of drag-and-drop nodes.
5. **Maturity / community.** Gated by the **OSS release + license choice.** Live lesson: n8n's Commons
   Clause restricts redistribution; **Activepieces' true MIT is why its community contributes freely.**
   Community connectors are the only way to ever close the breadth gap — so the license posture
   *directly governs* whether that gap closes. Decide deliberately.
6. **Ambient/voice layer (functional).** Ship ADR-047 (edge agent + voice surfaces) to make the Alexa
   comparison literal.

## Strategic conclusion

- **Target segment:** people who want the functionality *without the ownership tax* — privacy/sovereignty-
  conscious power users, the Home Assistant/self-hosting crowd, prosumers, SMBs, and regulated/enterprise
  that legally *can't* put data in Amazon's or OpenAI's cloud. There, free-but-walled is a
  *disqualifier*, not a win.
- **Positioning:** lead with the user benefit (own it / control it / see the cost); back it with the
  architecture moats (neutrality, self-host, Token Chase). Never lead with "does stuff" — that's free.
- **Build discipline:** every roadmap item must *deepen a moat* or be the *cheapest possible parity*
  (adopt MCP, import connectors, turn on built infra). Parity work must not consume the budget that
  belongs to the moat. The failure mode to avoid: becoming "another self-hosted Dify."

---

### Sources

- [Firecrawl: best open-source agent frameworks 2026](https://www.firecrawl.dev/blog/best-open-source-agent-frameworks)
- [OpenAgents: frameworks compared (2026)](https://openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared)
- [Dust: enterprise agent builder platforms 2026](https://dust.tt/blog/top-ai-agent-builder-platforms-enterprises)
- [VentureBeat: OpenAI Workspace Agents](https://venturebeat.com/orchestration/openai-unveils-workspace-agents-a-successor-to-custom-gpts-for-enterprises-that-can-plug-directly-into-slack-salesforce-and-more)
- [Smartbridge: Agentforce vs Copilot Studio 2026](https://smartbridge.com/salesforce-agentforce-vs-microsoft-copilot-studio-2026-comparison/)
- [n8n vs Zapier 2026 (Hatchworks)](https://hatchworks.com/blog/ai-agents/n8n-vs-zapier/)
- [Activepieces: n8n vs Zapier](https://www.activepieces.com/blog/n8n-vs-zapier)
- [AnythingLLM vs Open WebUI vs LibreChat 2026](https://runaihome.com/blog/anythingllm-vs-open-webui-vs-librechat-2026/)
- [Onyx: OpenWebUI alternatives](https://onyx.app/insights/openwebui-alternatives)
- [Alexa+ vs Gemini 2026 (The Ambient)](https://www.the-ambient.com/versus/alexa-plus-vs-gemini/)
- [Alexa vs Google vs Siri 2026](https://therobowire.com/voice-assistant-comparison-alexa-google-siri-2026/)
- [AI agents for solo founders raise billions (TechTimes)](https://www.techtimes.com/articles/317073/20260524/ai-agents-solo-founders-genspark-manus-devin-raise-billions-before-proving-it-works.htm)
- [Lindy](https://www.lindy.ai/) · [Complete list of AI assistants 2026](https://www.usecarly.com/blog/complete-list-ai-assistants-2026/)
- [Home Assistant local voice LLM 2026](https://www.privacysmarthome.com/guides/build-local-voice-assistant-whisper-ollama-home-assistant-2026/) · [home-llm (GitHub)](https://github.com/acon96/home-llm)
