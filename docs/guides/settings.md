# Settings — user guide (as-built)

Open the cockpit at **`/cockpit/`** and click the gear icon labeled **Settings** at the bottom of the
left ribbon. Two other paths land on the same screen: the profile modal's **Open Settings Page**
button, and the header's **Knowledge (RAG)** icon, which opens Settings already switched to the
**Knowledge** tab. That header icon is desktop-only — below roughly 640px wide it is hidden, so on a
phone reach the same place through the ribbon and click the **Knowledge** tab. There is no separate
URL for Settings — the cockpit keeps the active screen out of the
address bar, so you cannot bookmark a tab directly. In a focused app (`/cockpit/?app=<name>`) the
framework Settings entry leaves the rail and the gear opens a hub page, also titled **Settings**,
where **Settings** appears as a card under *Your workspace*; a student/kiosk rail
(`?student=1` / `?kiosk=1` / `?view=student`) has no Settings entry at all.

Settings is where you pick your cockpit theme, see and edit the shared runtime configuration
(provider, model, service endpoints), review each bot's profile and tools, add documents to the
swarm's knowledge base, and connect your external accounts. Much of what it shows is
deployment-wide rather than personal — the section below tells you which is which, because
attempting to save the shared parts without operator rights fails.

## What you see

A row of four tabs across the top, then the body of whichever tab is active. **Global Settings** is
the default.

| Tab | What lives there |
|---|---|
| **Global Settings** | Shared runtime configuration: provider/model, integrations, service endpoints, plus your theme and this browser's cost counters. |
| **Bot Settings** | One card per bot, with an inline profile editor and per-tool approval modes. |
| **Knowledge** | Add documents to the swarm's vector knowledge, see what is retrievable, and test a search. |
| **Connections** | The Utilities & Connectors page embedded in place — your account, your default brain, and external account connections. |

### Global Settings

Sections appear in this order.

**Config Ownership** — three cards (Global OSHAL Config, Per-Agent Profile, Per-Agent Tools) that
name which route owns which slice of configuration, with a short guidance block underneath. This
section is absent unless you have operator rights, because the contract it reads is operator-gated.

**Swarm Runtime** — a one-line heading that frames everything below it as shared, not personal.

**Cost Controls** — two cards, **Daily Spent** and **Bucket Spent**, each showing a dollar figure and
either `of $N limit` or `No limit set`. Below them, **Daily Spending Limit ($)** (resets at midnight)
and **Bucket Spending Limit ($)** (runs until exhausted). **Save Limits** stores both and flashes
*Saved!*; **Reset Bucket to $0** asks for confirmation, then zeroes the bucket counter and leaves
daily spending untouched. All of this lives in your browser's local storage, not on your account —
see the boundaries section.

**Provider And Model** — three fields:

| Field | What it does |
|---|---|
| **Agent Provider** | Dropdown of the providers this deployment knows about. Changing it reloads the model list below and rechecks the Codex sign-in badge. On save it is written as both the plan-mode and act-mode provider in the shared configuration. |
| **Agent Model** | Dropdown of that provider's models. On save it is written as both the plan-mode and act-mode model, so the pair stays consistent. |
| **Shared API Key** | Password field for the shared runtime key. It is stored in the shared secrets envelope; when the page loads it back it shows `[REDACTED]`, not the real value. |

**OpenAI Codex Authentication** — a status badge plus **Sign In** and **Sign Out** buttons, each
shown when it applies. The badge reads `Signed in as <email>`, `Not signed in`, `Checking
authentication...`, or an error message. These controls are inactive unless **Agent Provider** is set
to `openai-codex`; with any other provider the badge reads *OpenAI Codex auth inactive for this
provider* and both buttons stay hidden. Sign In opens a popup (or redirects the tab if the popup is
blocked) and then polls for up to three minutes, toasting *OpenAI Codex sign-in complete* or *OpenAI
Codex sign-in timed out*.

**Swarm Integrations** — four shared fields: **Git Repository URL**, **Git Token**, **Plane Workspace
URL**, and **Redis Connection**. Like the API key, the token comes back redacted after a reload.

**Shared Service Runtimes** — starts with a live health card headed **RAG Runtime**:

| Card badge | Meaning |
|---|---|
| **Connected** | The vector store answered; shared swarm knowledge is reachable. |
| **Unreachable** | The vector store did not answer from the current runtime. |
| **Unknown** | No health check has completed yet this session. |

Below it: **RAG Service Endpoint**, **Default Swarm Collection**, **RAG Embedding Provider**, **RAG
Embedding Model**, and **Code Server Workspace Root**. Then a row of actions — **Refresh Runtime
Status** (re-probes and replaces the health card), **Open Full Config Admin** (opens the standalone
config screen scrolled to its RAG section), and two links that stay hidden unless the server confirms
you are a super-admin: **Manage swarm apps** and **Add a computer (remote node)**. A third link,
**Get oshal on your devices**, is there for everyone and opens the same page as the ribbon's
**Get oshal** entry — see [Get oshal on your devices](./devices.md).

**Operator Preferences** — your theme picker and three approval toggles.

Theme buttons apply instantly on click, highlight the active one, and are remembered in this browser.
They are not part of the Save Settings action. The header's theme button cycles the same list.

| Theme | Theme | Theme |
|---|---|---|
| Midnight | Daylight | Ocean |
| Sakura | Forest | Gray |
| Black | Light Blue | Aurora |
| Graphite | Amber | |

Under **Auto-Approve** sit three switches: *Safe commands (ls, cat, etc.)*, *File reads*, and *File
writes*. They are saved with the rest of the page — read the boundaries section before you rely on
them.

**Save Settings** — the button at the foot of the tab. It writes the provider/model pair, the shared
API key, the four integration fields, the code-server workspace root, and the three auto-approve
switches to the shared configuration, and the four RAG fields to the shared RAG runtime
configuration, then re-probes health and toasts *Settings saved*. Theme and cost limits are not part
of it; they save on their own.

### Bot Settings

One card per bot, showing an avatar initial, the bot's name, and a meta line of `role · provider ·
online`/`offline`. Parts the swarm does not report are left out, so a card can read as little as
`AI Agent`. Online cards are visually marked. Each card carries three actions:

| Action | What clicking it does |
|---|---|
| **Chat** | Opens that bot's chat surface. |
| **Edit** | Expands an inline editor inside the card (see below). |
| **Config** | Opens the standalone config screen scrolled to this bot's section. |

If no bots loaded, the tab shows **No agents loaded** instead of cards.

**Edit** loads the bot's profile and tool list, then shows a **Bot Profile** block — **Name**,
**Project URL**, **Theme Preference**, **Selector Skills** — with a **Save Profile** button and an
**Open Full Config** link. Under it, one row per registered tool: the tool's name, an approval-mode
dropdown, and a **Verify** button whose result prints beside it (`Verifying...`, then the reported
status or `Error: <message>`).

| Approval mode | Meaning |
|---|---|
| **Auto** | The tool is available without a per-use prompt. |
| **Ask** | The tool prompts before it is used. |
| **Off** | The tool is not available to this bot. |

Changing the dropdown saves immediately and toasts `Auth mode updated for <tool>: <mode>`.

The two halves of the editor are gated differently, and the difference is easy to misread. The **Bot
Profile** block loads for any signed-in user, but **Save Profile** requires operator rights and
toasts *Failed to save bot profile: Operator privilege required* without them. The tool rows require
operator rights just to *load*, and that failure is silent: without them the editor opens with the
profile fields and simply no tool rows underneath, not an error. A **Failed to load tools: …**
message in place of the whole editor means the bot's profile could not be read at all — a different
problem from missing rights.

### Knowledge

**Knowledge (RAG)** — an intro line and a status line that reports the result of your last ingest.

**Add Knowledge** — pick a target scope, then supply content:

| Target scope | Where the document lands |
|---|---|
| **General swarm knowledge** | The shared collection every bot can retrieve from. |
| **Specific bot** | One bot's own collection. Choosing this reveals a **Swarm member** dropdown; the collection name shown updates as you pick. Ingesting before you pick one is refused with *Choose a swarm member before ingesting bot-specific knowledge.* |
| **Private to me** | Your own collection. You and operators can retrieve it. |

Whichever scope is selected, a *Target collection* line names the collection the next ingest will
land in. Below the scope: a **Files** picker (PDF, DOC/DOCX, TXT, Markdown, HTML, JSON, or CSV — up
to 20 files, 50 MB each) with an **Ingest Files** button, and an **Or paste text** area with an
optional title field and an **Ingest Text** button. Each ingest reports how many files or chunks landed in which collection,
then refreshes the inventory below.

**Knowledge Visibility** — a **Refresh** button, six count tiles (Documents, Collections, Chunks,
Swarm, Per-bot, and either *Yours* or *Private*), and expandable groups listing what you can see:
general swarm knowledge, one group per bot that has its own documents, and private documents. Each
row shows the title, its collection, its source, and its chunk count and ingest time. The description
line above tells you which view you are in: an operator sees every collection and owner; anyone else
sees shared swarm knowledge, each bot's knowledge, and their own private documents.

**Test Retrieval** — type a question and press **Search** (or Enter). Results come back as cards
showing a relevance score, the collection the hit came from, and a text preview. The search runs
under your own permissions, so it is a real check of what you can retrieve.

### Connections

This tab embeds the Utilities & Connectors page in a frame. Its sections, in order: **Your account**;
**Bot LLM access**, which holds **My default brain** (the provider that runs your work) alongside
tiles for **Claude Code (Anthropic)**, **OpenAI Codex (ChatGPT)** and **Gemini (Google)**; **Free
model lanes**; **LLM providers**; and **Your
accounts**, the connector catalog with a *Connecting as* selector for personal versus household, a
search box, and a status filter (All status / Connected / Ready / Needs setup).

**My default brain** offers these choices, each marked available or not based on what you have
already connected:

| Option | When you can pick it |
|---|---|
| **Automatic** | Always. Uses your own key first, then whatever the deployment offers. |
| **Claude Code (this machine's login)** | Gated and off by default — see below. |
| **OpenAI Codex (this machine's login)** | Gated and off by default — see below. |
| **My own endpoint** | Once you have connected an OpenAI-compatible endpoint and key on this page. |
| **My free tiers** | Once at least one free lane is connected and not cooled down. |

The two "this machine's login" options are **off unless the deployment runs in demo mode**: they
require `DEMO_MODE` to be enabled *and* your account to be listed in `OSHAL_OPERATOR_SUBS`. On any
deployment without both, they are listed but unselectable, and their own detail line says so —
*Available only to the operator of a deployment running in demo mode.* Assume they are unavailable
unless you set up the box yourself.

Picking an option you cannot use is refused with a message rather than silently accepted, and the
choice is scoped to you — it does not change anyone else's default.

## What you can do

**Change your theme.** Global Settings → Operator Preferences → click a theme button. It applies at
once and is remembered the next time you open the cockpit in this browser. You do not need to press
Save Settings, and you do not need operator rights.

**Set your own default AI provider.** Connections tab → **My default brain** → pick an available
option. This is the per-user control; it is separate from the deployment-wide **Agent Provider** on
the Global tab.

**Connect an external account.** Connections tab → find the connector under **Your accounts** → use
its connect action. Use the *Connecting as* selector first if the connection should belong to a
household rather than to you personally.

**Add reference material the swarm can use.** Knowledge tab → choose a target scope → upload files or
paste text → **Ingest Files** / **Ingest Text**. Then type a question into **Test Retrieval** and
press Search to confirm the new material actually comes back.

**Change the shared provider and model** (operator). Global Settings → Provider And Model → pick a
provider, pick a model, press **Save Settings**. The pair is written for both plan and act modes at
once.

**Sign in to OpenAI Codex from the cockpit.** Set **Agent Provider** to `openai-codex` first — the
buttons stay hidden otherwise — then press **Sign In** and complete the popup. The badge flips to
*Signed in* on its own. The credential this stores is scoped to your own signed-in session, so this
one action does not need operator rights even though the provider dropdown beside it is a shared
setting you may not be able to save.

**Point the swarm at a different vector store** (operator). Global Settings → Shared Service Runtimes
→ edit **RAG Service Endpoint** and the embedding fields → **Save Settings** → **Refresh Runtime
Status** and confirm the card reads **Connected**.

**Review or retune one bot** (operator). Bot Settings → **Edit** on the bot's card → adjust the
profile fields and press **Save Profile**, or change a tool's dropdown to Auto/Ask/Off (which saves
on change). Use **Verify** to check a tool reports healthy. Without operator rights you can open the
editor and read the profile, but the tool rows will not be there and Save Profile is refused.

## What this screen does NOT do

- **It is not a personal settings page.** Everything on the Global tab except the theme and the cost
  counters is deployment-wide shared configuration. Reading and writing it requires operator rights,
  which are an explicit allowlist (`OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`) set by whoever
  runs the deployment. With an empty allowlist nobody is an operator. Without those rights the text
  fields render blank, the Config Ownership section is absent, and pressing Save Settings toasts
  *Settings save failed: Operator privilege required*. The Agent Provider and Agent Model dropdowns
  are the exception: they still list what the deployment offers, because the provider catalog is not
  operator-gated — so a populated dropdown is not evidence that you can save it.
- **It will not save the shared configuration when encrypted secret storage is unconfigured.** If
  `ENCRYPTION_KEY` is not set on the server, the main configuration route refuses both reads and
  writes; the provider, key and integration fields load empty and saving reports
  `encrypted_secret_storage_required`, even for an operator. The four RAG fields travel on a
  different route that has no such requirement, so they can persist while the toast still calls the
  whole save a failure — re-open the tab to see what actually landed.
- **The Auto-Approve toggles do not currently gate anything.** They save with the page, but no part
  of the platform reads them today. Per-bot, per-tool approval is the Auto/Ask/Off dropdown on the
  **Bot Settings** tab; that one is read.
- **Cost Controls are a browser counter, not an enforced budget.** The limits and the spent totals
  live in this browser's local storage (shared across its tabs, not per tab), reset the daily figure
  when the date changes, and vanish if you clear site data or switch browsers. The spent figures
  only advance when a cockpit call reports its cost back to this page, so they are not the
  deployment's real spend and will often read `$0.0000`. Nothing is blocked when a limit is reached
  from this screen. Enforced spend caps are a separate surface — the **Budgets** entry on the ribbon.
- **There are no notification preferences here.** Per-topic channels, quiet windows and destinations
  live on the **Notifications** ribbon entry (the bell icon), not in Settings.
- **Secrets are never shown back to you.** The Shared API Key and Git Token fields come back as
  `[REDACTED]` after a reload. Typing over them saves a new value; leaving the redacted text in place
  saves that literal text, so clear the field if you do not mean to change it.
- **Knowledge has no delete.** You can ingest and inspect documents here; removing them is not part
  of this screen. Reserved platform collections also refuse writes from anyone who is not an admin.
- **Bot provider/model is not edited here.** The Bot Settings inline editor covers name, project URL,
  theme preference and selector skills. Per-bot provider and model live behind the **Config** link on
  each card, where the Provider picker is disabled for a bot whose provider is pinned by the
  deployment — the note beside it explains which rule pinned it. Provider and Model are pinned
  independently, so the Model picker can stay editable under a pinned provider.

## If something looks wrong

**The text fields on the Global tab are blank and Save fails.** Two causes look identical. Either you
are not on the operator allowlist (the toast says *Operator privilege required*), or the server has
no encryption key configured (the toast says `encrypted_secret_storage_required`). The page loads
without erroring in both cases because it falls back to empty values rather than blocking; the toast
on save is what tells them apart. The provider and model dropdowns stay populated either way.

**A bot's Edit panel opens but has no tool rows.** Loading the tool list needs operator rights and
fails quietly, so an empty list and a bot with genuinely no registered tools look the same. Save
Profile will also be refused. The card itself, the Chat link and the Config link still work — you are
seeing the bot, not its control plane. A **Failed to load tools: …** banner in place of the whole
editor is the other failure: the bot's profile could not be read, and the message after the colon is
the reason.

**The OpenAI Codex Sign In button is missing.** It appears when **Agent Provider** is set to
`openai-codex` and you are not already signed in. With another provider selected, the section reads
*OpenAI Codex auth inactive for this provider* and both buttons stay hidden by design. Change the
provider dropdown first; you do not have to save before signing in.

**The RAG health card says Unreachable, or ingest fails.** The vector store is not answering from the
runtime. Press **Refresh Runtime Status** to confirm it is not a stale reading, then check the **RAG
Service Endpoint** value. Until it reports **Connected**, ingest and Test Retrieval have nothing to
talk to.

**I changed the theme and it went back on another machine.** The theme is stored per browser, not on
your account. Set it again there. The same is true of the cost limits and the ribbon pin.

**I opened Settings expecting the Knowledge tab and got Global.** The header's Knowledge icon carries
a one-shot hint that selects the Knowledge tab; it is consumed on arrival, so opening Settings any
other way afterwards lands on Global. Use the header icon again, or click the **Knowledge** tab.

---

Design rationale for the per-user default brain and the demo-mode provider ladder is in
[ADR-127](../adr/127-demo-mode-cli-brain-and-user-provider-preference.md).
