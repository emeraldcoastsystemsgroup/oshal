# Tickets — user guide (as-built)

Open **`/cockpit/`** and click **Tickets** — the tag icon in the pinned tray at the bottom of the
left ribbon, alongside Calendar, Swarm Messages and Settings. A bare `/cockpit/` opens whichever
screen the install's ribbon is configured to open on (the shipped configuration opens Jarvis), so
Tickets is normally one click away rather than the first thing you see. Two URL shortcuts:
`/cockpit/?ticket=<ticket-id>` opens the board with that one ticket already selected, and
`/cockpit/?app=<app-name>` opens the same board narrowed to that app's kind of work.

A ticket is how you ask the swarm to do something and how you watch it happen. You describe the
work, put the ticket in the state that means "go", and a bot picks it up on the next queue sweep.
Everything the bot then does — its messages, the files it wrote, what it spent, the phases it moved
through — comes back on that same ticket.

## What you see

The screen is a list on the left and a detail pane on the right, with a drag handle between them
(drag it to give either side more room).

### Toolbar (top of the list, left to right)

| Control | What it does |
|---|---|
| **Search tickets...** | Filters the visible rows as you type. Matches the subject, the `#` number, the assignee, the project, and the description — and it matches on subtasks too, in which case the parent row stays visible so you can drill in. |
| Status dropdown | Which lifecycle states to show. Opens on **Active**. Values are explained in [Statuses](#statuses) below. |
| Queue dropdown | Starts as *All Projects* and re-labels itself **All Queues** once the page loads, listing the apps currently active on this install. Picking one re-fetches the list for that queue. |
| Type dropdown | **All Types / Build / Incident / Intelligent Processing**. Re-fetches the list for that kind of work. A `?app=` in the URL wins over this dropdown. |
| **+** (*Create Ticket*) | Opens the Create Ticket dialog. |
| **folder+** (*Manage Projects*) | Opens the Project Manager dialog. |
| Grouping dropdown | **No Grouping / Group by Date / Group by Status / Group by Project**. Group headers start collapsed; click one to open it. |

### List columns

The header row is clickable — click a heading to sort by it, click the same heading again to flip
the direction. It sorts by date, newest first, until you change it. The small ▼ printed next to
*Subject* is fixed decoration; it does not move to the column you are actually sorting by.

| Column | Meaning |
|---|---|
| ⬤ | Status dot, coloured by lifecycle state. A **▶** chevron appears to its left when the ticket has subtasks; click the chevron to expand them inline. |
| **Subject** | The ticket title, plus an *N subtasks* badge when it has children. The small line underneath is `assignee · #number · status`; it reads `unassigned` until a bot is on it. |
| **Cost** | Money recorded against this ticket and its subtasks. `--` means nothing has been measured yet, not $0.00. |
| **Date** | Relative time since the last update (falling back to creation). |

On a brand-new install the list reads *No tickets yet* with a **Create your first ticket** button.
If you have tickets but a filter hides them all, you get *No tickets found* instead.

### Detail pane

Nothing is selected at first — the pane reads *Select a ticket to view details*. Click a row and it
fills in, top to bottom:

- **Header** — the `#` number and a status pill; the title; then assignee, created, updated and
  total cost. If bots have billed work to this ticket, a **Contributing Bots** row lists each one
  with its share of the spend.
- **Project controls** (root tickets only) — a *Project: …* badge, a dropdown of known queues, a
  **New project name** box, and an **Apply Project** button. On a subtask this is replaced by a note
  saying the project is inherited from the root ticket.
- **Parent Ticket #…** button — on a subtask, jumps up to its parent.
- **Escalated Ticket Guidance** panel — only on an escalated ticket; see
  [Handle an escalated ticket](#handle-an-escalated-ticket).
- **Action row** — a state dropdown (the current state plus the states it is allowed to move to),
  **Respond**, and, on root tickets, **Delete**. A subtask instead carries a note that deletion and
  workspace management stay with the parent.
- **Tabs**, then the tab body.

### Tabs

| Tab | What is in it |
|---|---|
| **Feed** | The conversation and event stream, newest first: the five most recent entries, a *Show N older messages* fold, and a *Subtask Activity* section grouping rolled-up child entries by subtask. A reply box sits at the bottom. The small dot on the tab label is the live connection: grey while connecting, green when the stream is attached, amber while it retries. The dot reports the connection only — new entries are **not** drawn into an open feed today; reselect the ticket to pull in what has happened since (see [Watch progress](#watch-progress)). |
| **Process** | The status history as a vertical timeline — each transition with who made it and when, interleaved with worker events (*Worker started*, *Worker heartbeat*, *Worker finished*, *Worker failed*) that carry the agent, the phase and round, and the elapsed time. If the server cannot supply detailed history it says **Compatibility mode** and infers the milestones from the activity already loaded. |
| **Description** | The ticket description, rendered, plus a **Subtasks (N)** list you can click through. |
| **Work Artifacts** | The files in the ticket's workspace. **Open in Code Server** opens the whole folder; clicking a file opens that file. The path is printed next to the button. A subtask shows a note when it is sharing its parent's workspace. |
| **RCA & Remediation** | Incident-type tickets only. It tells you where the incident bot writes its RCA report, impact assessment and remediation steps — the `deliverables/` folder in the ticket workspace, reachable from Work Artifacts. |
| **Cost** | Total Cost, Tokens, Requests and Top Model tiles, then a **Cost by Bot** table (bot, provider, requests, input/output/total tokens, estimated cost) and a **Cost by Model** table. Every figure is `--` until measured usage exists. |
| **Run Trace** | The execution waterfall for this ticket, embedded, with a span count and an **Open full waterfall** link. Empty until the ticket has actually run. |

## Ticket types

The type decides which workflow runs, which bot answers, and which tabs you get.

| Type | What it runs |
|---|---|
| **Build** | Software construction. The ticket goes through planning and is decomposed into subtasks, which appear under it and run in turn. The Create Ticket dialog labels this *Build — software construction (7-phase swarm)*. |
| **Incident** | Investigation and root-cause analysis. The dialog labels this *Incident — investigation + RCA (2-bot pipeline)*. This is the type that gets the RCA & Remediation tab. |
| App-contributed types | An installed app can register its own type (**Intelligent Processing** is one of the built-in ones) with its own worker bot and workflow. These are normally created by the app itself rather than typed in here — see the boundary note in [What this screen does NOT do](#what-this-screen-does-not-do). |
| Chat | Not something you file. Starting a direct chat with a bot opens a tracking row in the **Chat** queue so the conversation is on the board. It is never dispatched and never runs a workflow; closing the chat completes it. It shows in the list as **Backlog**. |

## Statuses

Every ticket sits in one lifecycle state. The pill in the detail header, the dot in the list and the
status dropdown all use the same vocabulary.

| Status | What it means |
|---|---|
| **Backlog** | Captured, not queued. Nothing will pick it up in this state. |
| **Approved** | The "go" state. The queue sweep takes tickets from here. |
| **Phase 0 - Discovery & Planning** | A bot has it and is working out what the job is. |
| **In Process - Design** | Design work in progress. |
| **In Process - Build** | The main build phase. Subtasks of a build ticket dispatch once the parent is here. |
| **In Process - Deploy / Test / Release** | Later phases of the same run. |
| **Approval Required** | The workflow stopped and wants a decision from you before it continues. A ticket you file as **Incident** also starts here rather than in Backlog — it waits for you to approve it. |
| **Customer Action** | Parked waiting on something from outside the swarm. |
| **Escalated** | Automation gave up or was stopped. The ticket sits outside the queue until you de-escalate it. |
| **paused** | Held deliberately. Nothing dispatches while it is paused. |
| **Complete** | Finished. |
| **Cancelled** | Abandoned. |

The status dropdown's first two entries are filters over that list rather than states of their own:

| Filter | Shows |
|---|---|
| **All Status** | Everything. |
| **Active** | Everything except Complete and Cancelled. This is the default, which is why a finished ticket seems to vanish. |
| Any named status | Just that bucket. **In Progress** covers every `In Process - …` phase at once (Phase 0 included). |

There is no *paused* entry in that dropdown — a paused ticket shows under **Active** and **All
Status**.

## How work reaches a bot

You never pick the bot. Routing does, from the ticket's type.

1. A background sweep runs on a fixed cadence — every 60 seconds normally, every 30 in a
   development-mode install; `QUEUE_POLL_INTERVAL_MS` overrides it.
2. Each sweep looks for tickets in **Approved** and claims up to five at a time. If five are already
   running, that sweep is skipped and yours waits for the next one.
3. The ticket's type selects the workflow: build tickets go to the build/decomposition pipeline,
   incident tickets to the incident pipeline, an app's type to that app's worker bot.
4. The ticket moves through its phases, the assignee fills in, and the Feed and Process tabs start
   filling. A build ticket's subtasks are created underneath it, and they only start dispatching
   once the parent reaches **In Process - Build**.
5. If a dispatch fails, the ticket returns to **Approved** and is retried on a later sweep. After
   repeated failures it stops being retried: it is escalated, or quarantined outright once it passes
   the failed-cycle ceiling (`QM_MAX_ATTEMPTS`, default 3). A quarantined ticket is undispatchable
   until an operator releases it, and this list has no state of its own for it — it renders as
   **Backlog**, so a ticket that keeps sitting in Backlog after you approved it is the symptom to
   look for.
6. If a workflow is registered as auto-start, its tickets are promoted from Backlog to Approved
   automatically. Nothing else leaves Backlog on its own.

Priority is recorded on the ticket and travels with the work, but the queue does not run
high-priority tickets ahead of others.

## What you can do

### Create a ticket (Quick Form)

1. Click **+** in the toolbar. The dialog opens on the **Quick Form** tab.
2. Fill in **Title** (required) and **Description**.
3. Pick a **Type** — the field is labelled *Type (determines workflow)*.
4. Pick a **Priority**: Low / Medium / High. **Do not pick Critical** — it is offered in the dropdown
   but the ticket store rejects it, and the dialog closes as if it worked while nothing is saved.
   Use High.
5. Click **Create Ticket**.

A **Build** ticket lands in **Backlog** and will not run until you move it to Approved — see
[Start the work](#start-the-work). An **Incident** ticket lands in **Approval Required** instead:
same idea, it waits for you, and you move it to Approved the same way.

### Create a ticket (Intake Assistant)

1. Click **+**, then the **Intake Assistant** tab.
2. Answer the questions in the box — what the goal is, what kind of outcome and level of effort you
   want, whether there is a repo, what the success criteria are, whether credentials are needed,
   what the risks are, how urgent it is, and where you want review stages.
3. Type `done` (or click **Done — Summarize**) at any point and it summarizes what it has.
4. Click **Create Ticket** to submit.

An intake-created ticket is filed as a **Build** ticket in **Approved**, so it is already in the
queue when it appears. (If you answer "critical" to the urgency question the submit fails with an
error — answer high instead.)

### Start the work

Select the ticket, open the state dropdown in the action row, and choose **Approved**. A toast
confirms the move and the list row updates immediately. The next queue sweep picks it up; give it up
to a minute before assuming nothing happened.

### Watch progress

**The screen does not refresh itself.** The status pill, the list row and the feed are drawn once,
when you select the ticket. Nothing the bot does afterwards redraws them — click the row again (or
leave Tickets and come back) to pull in the current state. The dot on the **Feed** tab shows the
live stream is connected, but it does not insert new entries into the open feed.

Once you have refreshed:

- The status pill and the list row show the phase the ticket is in.
- **Feed** carries the conversation and the *Status changed → …* entries.
- **Process** is the audit trail: every transition, who caused it, and the worker start/heartbeat/
  finish events with phase, round and elapsed time.
- **Run Trace** shows the same run as a cost waterfall once spans exist.

### Reply on a ticket

Type in the **Reply to this ticket...** box at the bottom of the Feed tab and click **Send Reply**
(or press Ctrl+Enter / Cmd+Enter). **Respond** in the action row jumps you to that box. Your message
is posted to the ticket thread and appears immediately in the feed.

### Open what the bot produced

Go to **Work Artifacts**. Click a filename to open that file, or **Open in Code Server** to open the
folder. A bot reply that mentions a `deliverables/`, `output/` or `data/` folder also gets an
**Open … folder** button directly in the feed entry, provided the ticket has a workspace path
recorded.

### Move a ticket into a project

On a root ticket, either pick an existing entry in the project dropdown or type a name into **New
project name**, then click **Apply Project**. The whole ticket tree moves; subtasks inherit it. Use
**Group by Project** to see the result.

### Handle an escalated ticket

An escalated ticket shows the **Escalated Ticket Guidance** panel above the actions. It gives you
the recorded reason under *Why it escalated*, an *Attempt snapshot* when retry counts exist, and a
numbered *Next steps* list tailored to the reason — a routing or transport problem also gets an
**Open Redis Visibility** link. When the blocker is cleared, click **De-escalate to Approved** and
the ticket re-enters the normal queue.

### Pause, cancel or delete

**paused** and **Cancelled** are options in the state dropdown wherever the lifecycle allows them;
both stop the ticket being dispatched, and a cancelled ticket can be sent back to Backlog later.
**Delete** (root tickets only) asks for confirmation, naming the subtask count it will take with it,
and cannot be undone.

## What this screen does NOT do

- **A reply does not re-run the bot.** *Send Reply* records your message on the ticket thread. It
  does not hand the message to the assigned bot for a new turn. To get more work done, move the
  ticket back into the queue (Approved) or raise a new one.
- **The Quick Form only files Build or Incident tickets.** Its Type dropdown is extended at load
  time with the ticket types of the active apps, but the create call behind the form records
  *Incident* when you choose Incident and *Build* for every other choice. Tickets for an app's own
  workflow are meant to be created by that app.
- **You cannot choose the bot.** There is no assignee control. The assignee shown is whoever routing
  gave the work to.
- **There are no bulk actions.** Status, project moves and deletion are one ticket at a time.
- **The list is not an unbounded archive.** The board is built from your 200 most recently created
  tickets, and at most 500 rows are drawn after filtering.
- **It shows your own tickets.** There is no control on this screen for seeing other people's work.
- **Work Artifacts needs a code workspace to point at.** *Open in Code Server* goes to the code
  server configured by `CODE_SERVER_URL`; without one running, the link will not resolve. If the
  file listing itself is unavailable, the tab still offers the folder link plus a **Retry inventory**
  button.
- **RCA & Remediation is a pointer, not a report viewer.** It tells you which workspace folder the
  incident deliverables are in; there is no in-cockpit RCA rendering today. The tab is hidden
  entirely on non-incident tickets. (Its text says "open the Workspace tab" — the tab is the one
  labelled **Work Artifacts**.)
- **An unfinished Intake Assistant interview is not durable.** Sessions are held in memory, so an API
  restart loses an interview you have not submitted.
- **Synthetic `loop-…` tickets are refused** when the install sets `REJECT_LOOP_TICKETS=true`, but
  that guard sits on the ticket API a stale browser tab posts to — not on this screen's Create
  Ticket dialog. A `loop-…` title typed here is filed like any other.

## If something looks wrong

**"I created a ticket and nothing is happening."** A Build ticket from the Quick Form starts in
**Backlog** and an Incident one in **Approval Required**; nothing dispatches from either. Move it to
**Approved** and wait for the next sweep (up to a minute) — then click the row again, because the
screen does not redraw on its own. If it goes to Approved and comes straight back, look at the
Process tab: repeated dispatch failures roll it back, and after the ceiling it is escalated or
quarantined (a quarantined ticket shows here as Backlog).

**"I clicked Create Ticket and no ticket appeared."** The most common cause is **Priority: Critical**
— that value is rejected on save and the dialog closes anyway. Re-create the ticket with High.

**"My ticket disappeared."** Three usual causes, in order of likelihood: the status filter is on
**Active**, which hides Complete and Cancelled; the URL carries `?app=…`, which pins the list to
that app's ticket type and ignores the Type dropdown; or the queue/search filter no longer matches.
If a ticket you had open is filtered out, the detail pane says *Current selection is outside the
active filters* rather than showing you hidden work.

**"Cost shows `--`."** That means no usage has been measured for this ticket yet — it is not the
same as zero. It stays `--` until model-backed work actually runs and reports.

**"The Feed stopped updating."** It never updates on its own — an open feed is a snapshot from when
you selected the ticket. Reselect the ticket to reload the timeline. The dot beside the *Feed* tab
label only reports the stream connection (amber means it is retrying). If the detail pane itself
failed to load you will get *Live activity is unavailable right now* with a **Retry detail** button
instead of a blank pane.

**"Project Manager says 'No projects yet' even though projects exist."** The list area in that
dialog does not render the current project set. Creating a project there still works, and the
reliable way to put a ticket in a project is the **New project name** box plus **Apply Project** on
the ticket itself.

---

For the design rationale behind bot-owned domains and why work is dispatched to an accountable bot
rather than run in the UI, see
[ADR-036 — bot-owned application architecture](../adr/036-bot-owned-application-architecture.md).
