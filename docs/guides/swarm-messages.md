# Swarm Messages — user guide (as-built)

Open **`/cockpit/`** and click the speech-bubbles icon labeled *Swarm Messages* in the pinned tray at
the bottom of the ribbon. To go straight to one bot without the cockpit around it, open
**`/swarmbot/chat?agentId=<the bot's id>`** — that is the same conversation screen as a full page,
and it is where the *Chat* link on each bot in **Settings → Bots** lands. That page has no bot picker
of its own: the `agentId` in the URL decides which bot you are talking to.

This is where you talk to a named bot and read back the conversations you have already had with the
swarm. You pick which bot you are talking to, type to it, and its answer comes back in the same
thread. The left of this view is your conversation history and the pane beside it is a read-only
transcript; the live conversation lives in the cockpit's right-hand chat rail.

## What you see

The screen has two halves — a conversation list and a reading pane — plus the cockpit's right-hand
chat rail, which is the part you actually type into. The rail is not always open; see *Opening it*
below.

### Conversation list (left)

- **Search conversations…** — filters the list as you type, matching the conversation's title and
  text and the bot's name.
- **+ New** — resets the chat rail on the right to a fresh conversation. A toast confirms
  *"New chat opened in the right rail"* — but that toast appears whether or not the rail is open, so
  if the rail is collapsed nothing will look like it happened.
- **The list** — one row per conversation, newest activity first. Each row shows a round avatar with
  the bot's first initial, the **bot's name**, a one-line preview of the most recent message, and how
  long ago it was last touched. Click a row to open it. This is every conversation thread you own —
  including threads the swarm opened for a ticket, not only the ones you typed into.

### Conversation detail (right of the list)

Before you pick anything this pane reads *Select a conversation or start a new one*. Once you click a
row it shows:

- **Conversation with `<bot name>`**, and a meta row: the conversation's short id, the message count,
  when it was last updated, and its status.
- **Focus in Right Rail** — loads this conversation into the live chat rail so you can continue it.
  It does not change the **Choose a bot** dropdown, and it does not force the rail open: whichever
  bot is selected in that dropdown is the one that answers your next message in the thread.
- **Delete** — permanently removes the conversation. There is no undo and no confirmation step.
- **The transcript** — the last 20 messages, each labeled *You* or the bot's name, each truncated to
  200 characters. This is a reading view; you cannot type here.

### The chat rail (right edge of the cockpit)

This is the live conversation, and it is the part that actually sends messages.

**Opening it.** The rail collapses to zero width when nothing has opened it, and it has no reopen tab
of its own. It is open when you already have a live conversation in this browser tab, when you use
**Chat with bot** from a ticket, and — on a phone, where it is a slide-up sheet — from the **Agents**
button in the header. The chevron in its header collapses it again. If you cannot get it back, the
full page **`/swarmbot/chat?agentId=<the bot's id>`** is the same conversation and always opens. The
rail is also switched off for as long as a Jarvis view is on screen, because Jarvis is its own chat
surface.

- **Chat** header with **New** (starts a fresh thread and opens the rail) and a chevron to collapse it.
- **Choose a bot** — the dropdown directly under the header. **This is who you are talking to.**
  Changing it swaps the whole rail onto that bot: the previous thread is set aside, and the bot's own
  last conversation is restored if it has one, otherwise a new thread starts.
- Below that sits the bot workspace itself, with the bot's name as its title, a row of context tags,
  a status line, the message area, and the composer.

### The bot workspace toolbar

The tags on the left of the toolbar report the bot you selected:

| Tag | What it tells you |
|---|---|
| Provider | The provider this bot is configured to reason with. Reads *Inherited runtime* when the bot has none of its own and takes the deployment's. |
| Model | The model id set on this bot. Reads *Inherited model* when nothing is pinned. |
| Connection | *Idle* before a bot is chosen, *Connecting…* while the live event stream opens, *Connected* once it is up, *Guest* for a signed-out visitor. |
| Auth | Whether this bot's provider still needs a sign-in — see the table further down. |

The buttons on the right of the toolbar. They are icons with no text — hover one to see the name used
here:

| Button | What it does when clicked |
|---|---|
| **Sign In** / **Sign Out** | Appear only for a bot whose provider exposes a sign-in flow on this screen — OpenAI Codex and Claude Code. On a Codex bot the hover label reads *Sign In For All Codex Bots*. Sign In opens the provider's sign-in in a popup, then polls for up to three minutes until it reports success. |
| **Settings** | Opens the in-place *Settings* panel for this bot — see *Change a bot's settings* below. |
| **Tool Controls** | Lists every tool registered for this bot with a per-tool permission dropdown (`auto` / `ask` / `off`) and whether it is installed. Changing a dropdown saves immediately. **↻** reloads the list. |
| **History** | Lists this bot's recent tasks with title, status, and timestamp. **Load Conversation** on any row reopens it in the rail. |
| **Knowledge Base** | Opens the shared knowledge window — upload documents and search what the bot can retrieve. See *Give a bot documents* below. |
| **AI Office** | Leaves this screen for the AI Office surface (decks, docs, and sheets) at `/cockpit?app=presentations`. AI Office is a separate app, not part of the base install — on a deployment without it you land on the ordinary cockpit instead. |
| **Packs** | Opens the packs studio in a window over the chat — view the flow a bot scoped for you, download it, or deploy it. It only ever shows your own packs, and it is empty until a packer bot has built one for you. |
| **Open in new window** | Reopens the current conversation as its own browser window, outside the cockpit. |

Under the toolbar is a single **status line**. It narrates what is happening — *Booting…*, *Sending
message through `<bot>`…*, *Connected to `<bot>`.*, *Task status: …* — and turns to an error tone when
a send or a load fails.

### Message area and composer

- Assistant replies render as bubbles with the bot's name above them. Fenced code, tables, and charts
  in a reply are rendered; if that renderer is unavailable the reply still shows as plain text.
- Each assistant bubble carries a small **speaker** button — click it to have the reply read aloud.
  It uses the platform voice when one is configured and falls back to your browser's built-in voice.
- While the bot is working, a line reads *`<bot>` is thinking…*.
- The composer is one text box — placeholder *"Tell this bot what to work on."* — and a **Send**
  button. An empty thread shows *"This bot is ready. Start the next swarm conversation from here."*

## What you can do

**Choose who you are talking to.** Use the **Choose a bot** dropdown. By default it lists the bots
that are live in the swarm. When you have a swarm app focused (a `?app=` in the cockpit URL), it lists
that app's own declared bots instead, so you are picking from that app's team rather than the whole
fleet. If the bot you had selected last time is no longer live, the rail switches to one that is and
tells you so in a toast.

**Send a message.** Type in the composer and press **Send**. Your message appears immediately, the
status line says it is going through, and *`<bot>` is thinking…* holds the place until the answer
arrives. The answer comes back over the live stream as one finished message, not word by word.

**Continue an old conversation.** Click it in the list and press **Focus in Right Rail**, or use
**History** in the workspace toolbar and press **Load Conversation**.

**Open a ticket by asking for one.** Talking to the **project-manager** bot in plain language —
"create a ticket for…", "open a ticket…", "file a ticket…" and similar phrasings — creates a real
ticket, already approved and queued for the swarm to pick up on its next cycle, moves the
conversation onto a new thread tied to that ticket, and the status line confirms
*"Ticket `<id>` created and linked to a dedicated PM thread."* From then on that thread is the
ticket's conversation. Other bots do not do this; their threads stay conversations.

**Change a bot's settings without leaving the chat.** **Settings** opens a panel with Bot Name,
Project URL, Selector Skills, Provider, Status (`active` / `paused` / `disabled`), Model, Theme
Preference, a read-only Runtime line, and a *Bulk Configure Guard* checkbox that excludes this bot
from fleet-wide configuration runs. **Save** applies it. **Open Advanced Config** leaves the chat for
the full bot configuration page. The two buttons above Save — **Configure All Unset Bots** and
**Configure All Eligible Bots** — apply the fields you filled in as a template across the swarm, so
treat them as fleet-wide actions, not per-bot ones.

**Give a bot documents.** **Knowledge Base** opens a window with three panels. *Upload Knowledge*
takes files by drag-and-drop or **Browse Files** (PDF, DOC, DOCX, TXT, Markdown, HTML); they stay
queued until you press **Upload To Target**, and **Clear Queue** empties the queue. *Target Knowledge
Scope* decides where they land — **General Swarm Knowledge** (shared, retrievable across the swarm) or
**Specific Swarm Member** plus a bot from the *Swarm Member* dropdown (that one bot's own collection).
The *Resolved Target* and *Resolved Collection* cards show exactly where the next upload will go.
*Search Current Target* searches whichever scope is selected, so you can confirm what actually
landed.

**Change what a bot is allowed to use.** **Tool Controls** sets each tool to one of three modes:

| Mode | Meaning |
|---|---|
| `auto` | The bot may use this tool without asking. |
| `ask` | The bot must ask before using it. |
| `off` | The tool is not available to this bot. |

## Conversation status values

The status shown in the conversation detail meta row is the underlying task's lifecycle state:

| Status | Meaning |
|---|---|
| `created` | The thread exists but no work has started on it. |
| `active` | Open and in use. |
| `processing` | The bot is working on the current turn. |
| `waiting_for_input` | The bot asked you something and is waiting for your reply. |
| `paused` | Held, not currently progressing. |
| `completed` | Finished. |
| `failed` | Ended on an error. |
| `cancelled` | Stopped deliberately before finishing. |

## Provider sign-in states

The **Auth** tag reflects the provider on the selected bot:

| What the tag reads | What it means |
|---|---|
| `checking` / *Checking authentication…* | The status is still being read. |
| *Auto (Global Config)* | This bot inherits the provider set in global Settings; there is nothing to sign into here. |
| *Not signed in* | A sign-in flow exists for this provider and has not been completed. **Sign In** is shown. |
| *Signed in* (with the account, and for Claude Code the method) | Completed. **Sign Out** is shown. |
| *Claude CLI unavailable* | The Claude CLI is not installed on this machine; sign-in is not offered. |
| *No inline auth flow for `<provider>`* | This provider has no sign-in step on this screen. Configure it from the bot's config page instead. |

One caveat worth knowing before you use those buttons: an OpenAI Codex sign-in is **shared across
every Codex-configured bot in this runtime** — you complete it once, and signing out removes it for
all of them.

## What this screen does NOT do

- **The composer takes text only.** There is no photo, camera, or file-attachment control in the
  message box. Documents reach a bot through the **Knowledge Base** window, as retrievable knowledge
  — not as an attachment on one message. If you want to hand a photo or a document to an assistant
  inside the conversation itself, that is [Jarvis](jarvis.md), not this screen.
- **It does not show you what a conversation cost.** Cost is captured per turn against the bot you
  selected — every thread is owned by exactly one bot, and its token and dollar totals accumulate on
  that thread. What you see in the cockpit is the aggregate: the **$** figure in the status bar along
  the bottom of the cockpit is your accumulated spend across your own conversations, refreshed every
  half minute, and hovering it shows daily and bucket spend against their limits. There is no
  per-message or per-conversation price on this screen, and the status bar is not shown on a phone.
- **A bot set to a local CLI provider will not answer.** Unattended local CLI execution
  (Cline, Codex CLI, Claude Code, Gemini CLI) fails closed by design; a send to such a bot comes back
  as *"…unattended execution is disabled: select a hosted provider or an audited OSHAL brokered
  sandbox"*. The Sign In button for those providers still works, but signing in does not lift the
  block — change the bot's Provider in **Settings** to a hosted one. The one exception is a
  deployment the operator has deliberately put in demo mode (`DEMO_MODE`), where the operator's own
  turns are allowed to run one; nobody else's are, on any deployment.
- **Guests can read, not chat.** An anonymous demo visitor gets the shell with the composer disabled
  and the placeholder *"Guest sessions are read-only"*, plus a sign-in link. Signing in creates your
  workspace and the composer becomes live.
- **A deployment can be installed with no AI at all.** When the operator sets `OSHAL_NO_AI=true`,
  every send is refused with *"AI features are disabled on this deployment. Connect a model or remove
  OSHAL_NO_AI=true."* Reading existing history still works.
- **You only see your own conversations.** History requests for a thread you do not own return
  nothing found, and naming a bot you are not entitled to use is refused rather than run.
- **It is not the assistant that decides for you.** This screen sends what you typed to the bot you
  picked. Choosing the bot is your job here — that is the difference from [Jarvis](jarvis.md), which
  takes a request in plain language, works out which specialist owns it, and hands it off for you.
  Jarvis also takes photos and documents in the conversation and speaks its answers; Swarm Messages
  is the direct line to one named bot.

## If something looks wrong

**"The rail says *Select a swarm bot* and nothing happens when I type."** No bot is selected. Pick one
from the **Choose a bot** dropdown above the workspace; the rail hydrates on its own once you do. A
direct `/swarmbot/chat` URL with no `agentId` shows the same message and has no dropdown to fix it —
add `?agentId=<the bot's id>`, or reach the page from the *Chat* link in **Settings → Bots**.

**"There is no chat rail on the right."** It is collapsed, and it has no reopen tab. Open a ticket and
use **Chat with bot**, or go straight to **`/swarmbot/chat?agentId=<the bot's id>`** as a full page.
On a phone the **Agents** button in the header opens it as a sheet. A Jarvis view also hides it for
as long as it is on screen.

**"The conversation I just had isn't in the list."** The list on the left loads once when you open the
view — it does not follow the live rail. Switch away and back (or reload) to pick up new threads. The
newest activity sorts to the top.

**"Live stream disconnected."** The status line says so, and it means the push connection dropped, not
that your conversation was lost. Everything already said is stored; reload the page (or reload the
thread from **History**) and the transcript comes back with the stream reconnected.

**"I changed the bot in the dropdown and my conversation vanished."** It did not — each bot keeps its
own thread. Switching bots parks the previous conversation and restores that bot's last one *for this
browser tab*. Switch back and it returns, and it is also in the conversation list and under
**History**.

**"The Provider tag says *Inherited runtime* — which model am I actually using?"** That bot has no
provider or model pinned to it, so it uses whatever the deployment is configured with. Open
**Settings** in the workspace toolbar and set Provider and Model explicitly if you want it fixed.

**"The reply came back but the bubble looks like raw text with backticks in it."** The rich renderer
did not load. The conversation is intact and readable — it has fallen back to plain text on purpose
rather than showing you a broken bubble. Reloading the page usually restores it.

---

For the design rationale behind bots owning their own conversations, cost, and domain state, see
[ADR-036](../adr/036-bot-owned-application-architecture.md); for how the routing assistant differs,
see [ADR-050](../adr/050-unified-assistant-route-orchestrator.md).
