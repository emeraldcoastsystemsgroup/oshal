# Calendar — user guide (as-built)

Open **`/cockpit/`** and click **Calendar** (the calendar icon on the left ribbon). There is no
direct URL for the view itself, but the URL still shapes it: `/cockpit/?app=<app-name>` opens the
cockpit focused on one app, and the calendar then shows that app's work alone — provided that app's
ribbon includes Calendar, which an app is free to leave out.

The Calendar is a month grid over two things the swarm already has: the recurring tasks you have
scheduled for a bot, and your tickets. It is where you set up "run this prompt every weekday at
9:00", run one of those on demand, delete one, and jump from a day to the ticket that moved on it.

## What you see

### Toolbar (top of the screen)

| Control | What it does |
|---|---|
| **‹** / **›** | Steps back and forward one month. The month and year sit between them. Changing month clears any open day panel. |
| **All Bots** dropdown | Filters the grid to one bot. Each row reads *Display Name (bot-id)*, or just the bot id when the bot has no separate display name. A schedule matches on the bot it is assigned to; a ticket matches on its assignee. Pick **All Bots** to clear the filter. |
| **Schedule** | The plus-icon button at the right of the toolbar. Opens the **New Meeting** dialog (see [Create a scheduled task](#create-a-scheduled-task-for-a-bot)). |

### The month grid

Sun-to-Sat column headings, then the days. Days from the neighbouring months are dimmed and are not
clickable. Today's cell is outlined and its number is highlighted.

Each cell lists up to three events as a coloured dot with a short label; if there are more, the cell
ends with **+N more**. Hovering a label shows the full name. On a phone the labels are hidden and
the cells show the dots alone.

Click any day in the current month to open its detail panel below the grid. Click the same day again
(or the **✕** in the panel header) to close it.

### The day panel

The header is the full date — *Monday, August 10, 2026* — with a close button. Under it is one card
per event, or *No events on this date*.

**A scheduled task** renders as a meeting card: a coloured stripe, the title, then a row of three
facts — the clock time, how often it repeats, and the bot it is assigned to — then the prompt the
bot will be handed (shortened, and shown only when it differs from the title), then the raw cron
expression it was saved as. Two icon-only buttons sit in the card header; the names below are their
tooltips:

| Button | What it does |
|---|---|
| ▶ *Trigger now* | Runs this scheduled task immediately, without waiting for its next due time. A toast confirms *Schedule triggered*. |
| 🗑 *Delete* | Asks the server to delete the schedule — there is no confirmation step — then the grid and the open day redraw without it, and a toast reads *Schedule deleted*. Both buttons act on **your own** schedules; on a card the platform or an installed app owns, the server refuses and you get an error toast instead (see [What this screen does NOT do](#what-this-screen-does-not-do)). |

**A ticket** renders as a plain row: a status icon, the ticket name, how long ago it was last
touched, and an arrow icon (tooltip *Open ticket*) that switches you to the Tickets board with that
ticket selected. See the [Tickets guide](./tickets.md).

## What feeds this screen

| Event | Where it comes from | Which day it appears on |
|---|---|---|
| Scheduled task | The schedules you own, plus schedules the platform itself created with no owner. | The day it was created — and, while it is active, today's cell. |
| Ticket | Your own tickets — the most recent couple of hundred, top-level ones only. A ticket filed as a child of another ticket is not drawn separately. | Its creation day, and its last-updated day. |

Scoping follows the URL. With `?app=<app-name>` the screen loads that app's queue alone. On the
plain `/cockpit/` it loads everything you own and then keeps the items belonging to apps that are
currently active on this install.

## Colours

Four kinds of event, each with its own dot in the grid and its own icon in the day panel. The hues
below are the ones the default (Midnight) theme paints; the cockpit's other themes remap the same
four slots, so on the Amber or Forest theme a scheduled task is not blue. The icons in the day
panel do not change.

| Dot (default theme) / panel icon | Meaning |
|---|---|
| Blue / no icon — meeting card | A scheduled task. |
| Green ✓ | A ticket in a **Done** state. |
| Amber ↻ | A ticket in any working state — Backlog, Todo, In Progress, In Review, Paused, Approval Required, Customer Action. |
| Red ✕ | A ticket that is **Cancelled**, or whose state reads as a failure. |

## Repeat labels on a meeting card

| Label | Meaning |
|---|---|
| One-time | Fires once at the next matching date and time, then stops. |
| Daily | Every day at that time. |
| Weekdays | Monday to Friday at that time. |
| Weekly | That weekday, every week. |
| Monthly | That day of the month, every month. |
| Recurring | The card has no cron recorded, so the screen cannot say more than "it repeats". |

A card saved from **Custom cron…** is labelled by reading the cron fields, so it always lands on one
of the first five words even when the expression is more complicated than the word suggests. The
cron line printed at the foot of the card is the authoritative answer to "when does this run".

## What you can do

### Look at a day

Click the day. The panel opens underneath the grid with every event on it. Click the day again, or
the ✕, to close it.

### Narrow to one bot

Pick a bot from the **All Bots** dropdown. The grid redraws immediately and an open day panel
redraws with it. Events with no bot recorded drop out of view while a bot is selected.

### Create a scheduled task for a bot

**This flow is gated, and out of the box the gate is shut.** Two conditions have to hold before
*Assign To* and **Create** come alive, and neither is on by default:

- Some bot has the **agent-scheduler** tool set to **Auto**. Every bot ships with it **Off**, and
  *Ask* does not count — the runtime dispatches only for an *Auto* grant.
- **You are an operator on this install.** Reading and changing a bot's tool grants is restricted to
  the accounts listed in the `OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS` environment variables on
  the API (empty lists mean nobody). A non-operator's request for the bot's tools is refused, the
  calendar therefore counts zero scheduler-ready bots, and the dialog opens with *Assign To* and
  **Create** greyed out — with no way to fix it from this screen.

With both satisfied:

1. Click **Schedule**. The **New Meeting** dialog opens.
2. Fill it in:

| Field | Notes |
|---|---|
| **Title** | The name you will see on the card. |
| **Date** | Defaults to today. Used to derive the day for a one-time, weekly or monthly repeat. |
| **Time** | Defaults to the next quarter hour, and steps in 15-minute increments. |
| **Recurrence** | *Once (one-time task) / Every day / Weekdays (Mon–Fri) / Weekly / Monthly / Custom cron…*. Opens on **Weekdays**, not on *Once*. |
| **Cron Expression** | Appears only when you choose *Custom cron…*. Format is `minute hour day-of-month month day-of-week`. |
| **Assign To** | The bot that will run it. Lists the bots that currently have the agent-scheduler tool switched to **Auto**. When there are none it is disabled, still showing bot names, under the note *No bots have Agent Scheduler enabled*. |
| **Description** | The instruction the bot is given. Title and description are joined into one prompt (`Title: Description`), so be specific here — this is not a note. |
| **Generated Schedule** | Read-only preview of the cron your choices produce. It updates as you change the date, time or recurrence. |

3. Click **Create**. You need a title or a description — with neither, the dialog asks for one and
   stays open. On success the dialog closes, the calendar reloads, today's panel opens, and a toast
   reads *Schedule created*.

The time you pick is interpreted in your browser's own time zone, so 9:00 means your 9:00 rather
than the server's. A **Once** schedule pauses itself after it fires instead of coming back a year
later.

**Expect the new card not to appear on the grid.** The schedule is saved and will run, but this
dialog files it under a task type it generates for the occasion, and normally neither view of the
calendar draws that: the app-focused calendar lists only schedules whose task type is exactly that
app's queue, and the plain cockpit keeps only items belonging to a currently active app (an install
with no active apps at all filters nothing, and there it does show up). Treat the toast, not the
grid, as confirmation.

### Run a scheduled task now

Open the day the card is on and click **▶**. This dispatches the task straight away and does not
change its normal schedule. It works whether or not the background scheduler is running, but the
assigned bot still has to have **agent-scheduler** on **Auto** at that moment — if it was switched
off since the card was made, the trigger is refused.

### Delete a scheduled task

Open the day the card is on and click **🗑**. There is no confirmation.

### Jump to a ticket

Open the day and click the arrow icon (*Open ticket*) on the ticket row. The cockpit switches to
Tickets with that ticket selected and confirms with a toast.

## What this screen does NOT do

- **It is not connected to Google Calendar, Outlook, or any external calendar.** Nothing on this
  grid comes from a connected account, and nothing you create here is written out to one. Connecting
  a Google or Microsoft account elsewhere in the cockpit adds no events here.
- **No invitees, reminders, notifications, attachments, or all-day events.** "Meeting" is the shape
  of the card, not an invitation to people — a scheduled task is a prompt handed to a bot.
- **No editing.** A card can be triggered or deleted. To change a time, a recurrence or a prompt,
  delete the card and create it again. Pausing and resuming are not offered on this screen either.
- **No week or day view, and no drag-and-drop.** The grid is a month at a time and events are not
  movable.
- **It does not paint future occurrences.** A daily or weekly task appears on the day it was created
  and on today, not on every date it will eventually run.
- **Creating a schedule is gated twice — on the bot's tools and on your account.** If no bot has the
  **agent-scheduler** tool set to **Auto**, the *Assign To* dropdown and the **Create** button are
  disabled and the dialog says so. *Ask* is not enough — the runtime only dispatches for a bot whose
  grant is *Auto*, and every bot starts at *Off*. You change it in **Settings → Bot Settings**:
  expand the bot, find the `agent-scheduler` row in its tool list, and switch the dropdown to
  **Auto**. That screen — and the tool read the calendar performs to decide whether to enable
  **Create** — is restricted to operator accounts (`OSHAL_OPERATOR_SUBS` /
  `OSHAL_OPERATOR_EMAILS`), so for everyone else this dialog is read-only in practice. (The dialog's
  own hint says "Turn it on in Switch Framework first"; Bot Settings is where that list lives.)
- **Schedules only fire on their own when the install has the background scheduler running** —
  governed by the `ENABLE_AGENT_SCHEDULER` environment variable on the API container, which the
  standard local stack sets on. With it off, cards can still be created and **Trigger now** still
  works, but nothing runs at its due time.
- **Trigger and Delete work on your own schedules.** The grid also shows unowned schedules the
  platform created; acting on one is refused unless you are an operator (`OSHAL_ALLOW_LEGACY_UNOWNED`
  governs the non-operator case and is off by default), and a schedule an installed app's manifest
  owns is refused outright with *Schedule is managed by an active app manifest* — change the app, not
  the card. Either way you get an error toast and the card stays.
- **A run is not auto-approved.** When a scheduled task fires, its prompt goes to the bot with
  approval gates left on, so it can stop and wait for you rather than acting unattended.
- **It is not an operator view of everyone's schedules.** You see the ones you own, plus
  platform-owned ones that have no owner.

## If something looks wrong

**"Create is greyed out and it says no bots have Agent Scheduler enabled."** That is the gate
described above, and it has two halves. On an operator account: go to **Settings → Bot Settings**,
switch the `agent-scheduler` tool to **Auto** for the bot you want to schedule, then reopen the
Calendar so it re-reads the bots' tools — the check runs when the view loads, not when the dialog
opens. On a non-operator account the same message appears no matter how the bots are configured,
because the tool list itself is not readable to you; ask an operator to schedule it.

**"I created a meeting, the toast said it worked, and then it wasn't on the grid."** Expected. The
dialog files each schedule under a task type it generates on the spot, and neither view draws that:
the plain `/cockpit/` keeps only items belonging to apps that are active on this install, and an
app-focused cockpit lists only schedules whose task type is exactly that app's queue. The schedule
exists and will still run at its due time — this screen just has no row for it. Schedules that an
app or the platform declares are the ones the grid is built to show.

**"My daily task shows on today only — where are the rest of the month's runs?"** That is the
intended behaviour. An active schedule is drawn on the day it was created and on today. The card's
repeat label and cron are how you confirm when it will actually run.

**"A day looks empty but I know something happened."** Four things to check, in order: the **All
Bots** filter (a selected bot hides everything not attributed to it), the month you are on, the day
itself — a ticket lands on its creation day and its last-updated day, not on every day it was
worked — and whether the ticket is a child of another ticket or older than the couple of hundred the
screen loads, neither of which is drawn.

**"Nothing loaded at all."** The grid draws even when a data source is unavailable, so an entirely
empty month with no error usually means the schedule or ticket data could not be fetched rather than
that there is nothing to show. Reload the cockpit; if it is still bare, the API is the place to look.

For how apps declare their own recurring jobs and how a queue is scoped, see
[the swarm-apps framework](../swarm-apps-framework.md).
