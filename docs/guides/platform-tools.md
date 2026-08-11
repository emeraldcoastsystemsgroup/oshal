# Platform tools — user guide (as-built)

These six tools sit together in the **bottom section of the cockpit ribbon** on a plain
**`/cockpit/`**: **Search**, **Run Trace**, **Budgets**, **Notifications**, **My Data**, and —
for an operator — **Dead Letters**. Each also opens directly in its own browser tab:

| Ribbon label | Direct URL | Who sees it on the ribbon |
|---|---|---|
| **Search** | `/api/search/ui` | anyone signed in |
| **Run Trace** | `/api/trace/app` | anyone signed in |
| **Budgets** | `/cockpit/tools/budgets.html` | anyone signed in |
| **Notifications** | `/cockpit/tools/notify.html` | anyone signed in |
| **My Data** | `/cockpit/tools/my-data.html` | anyone signed in |
| **Dead Letters** | `/cockpit/tools/dlq.html` | pinned for an operator account |

When you open the cockpit focused on one app (`/cockpit/?app=<name>`), these tools normally leave the
rail — they collapse behind a single **Settings** entry (an app can ask to keep them pinned instead,
and a few do). Clicking it opens a card grid: *Your workspace* (Settings, Notifications, My Data,
Budgets) and *Platform* (Search, Run Trace, Dead Letters and the other platform surfaces). Clicking a
card switches the cockpit to that tool.

They are the platform's own housekeeping screens rather than any one app's: find something you own,
see where a ticket's time and money went, see the spend caps in force, choose where messages reach
you, take your data out or delete it, and — as an operator — deal with tickets the queue gave up on.

## Search — "where is that thing?"

One box over your own swarm data. Type a query, press **Enter** (or click **Search**).

**What you see, top to bottom:** the title **Search**; a line explaining the scope; the search box
(placeholder *Search tickets, chats, knowledge…*) with a **Search** button; a row of filter chips;
a status line that starts as *Type a query and press Enter*; then the grouped results.

The chips are built from the stores the server actually registered, so the row reflects this
deployment. Clicking a chip toggles it on (it turns the accent colour) and re-runs the query
immediately if the box has text. With no chips lit, every store is searched.

| Group | What it matches | Clicking a result opens |
|---|---|---|
| **Tickets** | Title and description of tickets you own | the cockpit with that ticket selected and its detail pane loaded |
| **Chat history** | Titles of your conversations and the message text inside them | that conversation, rehydrated |
| **Apps** | Installed app name, display name and description | the cockpit shaped by that app |
| **Bots** | Bot name, role and capability tags | the cockpit with that bot selected |
| **Connections** | Your connected accounts by provider, account email, label and status | your connections page, scrolled to that provider's card |
| **Personal data** | Labels and attribute values in your personal vault | nothing — the row says why |
| **Knowledge base** | Documents and chunks you are permitted to read | nothing — the row says why |

Each result row carries the title, a snippet with your term in context, a small pill naming the
result kind, the group name, and a timestamp when the record has one. A row with no link is dimmed
and states its reason in italics rather than being silently unclickable: knowledge-base results have
no per-document screen to open, and personal-vault entities are encrypted with no browse surface.

After a search the status line reads, for example, *17 results in 240 ms — Tickets 9 · Chat history
5 · Bots 3*. Those per-group counts are what each store returned before the merged list was capped.

**The one thing to do with it:** type a fragment of a ticket or conversation title and click the
result. You land on the record, not on an unfiltered list.

Scope, plainly: tickets are matched on your ownership, chat messages are reached only through your
own conversations, connections are filtered to your account (and no token column is ever read), apps
show the public ones plus your own, bots are filtered to what your role can reach, and knowledge-base
results pass the same permission filter the Knowledge search uses. A query is capped at 200
characters and this surface asks for 30 results (the server will not return more than 50).

## Run Trace — "where did this ticket's time and money go?"

Enter a ticket id (a UUID) and click **Trace**. Adding `?ticketId=<uuid>` to the URL fills the box
and loads it straight away, so a trace link can be shared or bookmarked.

**What you see:** the title **Run Trace** and a one-line description; the ticket-id box with the
**Trace** button; then, once loaded, a meta line (*ticket type · status · id*), four total tiles, and
the waterfall. The footer states the rule: read-only, you can trace tickets you own, an operator can
trace any ticket.

| Tile | What it counts |
|---|---|
| **Total cost** | The sum of the recorded per-call costs for this ticket, to six decimal places |
| **Tokens** | Tokens accumulated by the bot executions linked to the ticket |
| **LLM calls** | How many model calls were recorded against it |
| **Wall time** | From ticket creation to the latest recorded activity |

The waterfall is one row per span, in time order, each with a coloured dot, a bar positioned across
the ticket's own time window, and a right-hand meta string of *duration · cost · tokens · model*
(each part appears when it was recorded).

| Row kind | Where it comes from | Read it as |
|---|---|---|
| **phase** (indigo) | The ticket's status transitions | how long the ticket sat in each state |
| **bot** (blue) | One per bot execution linked to the ticket | which bot did the work, and what that execution cost |
| **llm-call** (green) | One per recorded model call | the individual call, its model and its price |

**The one thing to do with it:** open a ticket that cost more than you expected and look for the
single widest bar or the largest per-call cost. That row is the answer.

Nothing here re-runs. Every row is assembled from what was already written down while the work ran,
so a trace is cheap and repeatable. Older records may carry no token count or duration on an
`llm-call` row; those parts are left out rather than shown as zero. On a narrow phone screen the
meta column is hidden and the bars remain.

## Budgets — "what caps apply, and how close am I?"

A read-only view of the spend caps the platform enforces. **This screen never changes a cap.**

**What you see:** the title **Budgets** and a short description; a **Spend window** dropdown (*last
1 h*, *last 24 h (the daily cap window)*, *last 7 d*, *last 30 d*) and a **Reload** button; a status
line; an explanation banner if you are not an operator; the **Caps** table; the **Enforcement trail**
table for operators; and two honesty notes at the foot.

Changing the window reloads immediately.

| Caps column | Meaning |
|---|---|
| **Scope** | What the cap is attached to: `user`, `app` or `ticket` |
| **Key** | The account, app ticket type or ticket id the cap applies to |
| **Daily cap** | The configured daily ceiling in dollars |
| **Spend in window** | Spend over the window you chose. A **—** means the spend store could not be read — unknown, never "$0.00" |
| **Used** | A bar and percentage of cap. Green under 80%, amber from 80%, red at 100% or over |
| **Breach** | `hard` — a definitive breach stops dispatch on that scope and writes a row to the enforcement trail. `soft` — work continues, and the breach is written to the server log only: it never reaches the trail and never raises an alert (the pill's tooltip on screen says it is recorded and alerted — it is not) |
| **State** | `enabled` — the cap is checked. `disabled` — saved but enforcing nothing |
| **Owner** | `operator` — set for you, and not changeable from your account. `self` — you set it |
| **Updated** | When the cap last changed |

The **Enforcement trail** (operators) is the append-only record of what enforcement actually did:
*When, Action, Scope, Key, Spend, Cap, Detail*. Every row it can contain today is a `halt` — either a
hard cap exceeded or the runaway kill switch, with the reason in **Detail**. Soft breaches are not
written here at all, so an empty trail means nothing was *stopped*, not that nothing was exceeded.
Repeat rows for the same scope and action are suppressed inside a cooldown window
(`OSHAL_BUDGET_EVENT_COOLDOWN_MIN`, default 30 minutes) so one sustained breach does not flood the
table or your phone.

**The runaway kill switch.** Separately from any dollar cap, the platform counts how many times one
ticket has been executed recently. When that count reaches the threshold the queue refuses to
dispatch that ticket regardless of spend, a `halt` row lands in the trail with the reason
`runaway-halt`, and an alert goes out on the deployment's operator channel (under the same cooldown
as the trail). The defaults are 25 executions in 30 minutes, tunable without a restart through
`OSHAL_BUDGET_RUNAWAY_MAX` and `OSHAL_BUDGET_RUNAWAY_WINDOW_MIN`. The refusal is re-decided every
poll cycle rather than latched: the ticket stays in the approved state, so once the loop cools off —
or the threshold is raised — it resumes on its own with no operator surgery. This is the guard
against a ticket that loops on itself; it applies to queued ticket work, and it is not something you
enable or click.

**The one thing to do with it:** leave the window on *last 24 h* — that is the window the daily cap
is compared against — and read the **Used** bar. That percentage is what enforcement sees.

If you are not an operator you see your own cap — one row, or the empty-table message when nobody has
set one for you — and a banner saying so; the deployment-wide snapshot and the enforcement trail are
operator surfaces, gated on the operator allowlist (`OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`).

## Notifications — "where does each kind of message reach me?"

Your own routing, per topic. Which credential carries a message depends on the channel: email always
goes out through your own connected Google account; a text prefers your own connected Twilio and
falls back to the deployment's; voice and Telegram are always carried by the deployment's credential
to a destination you supply (your number, your chat id). The channel table below says which is which
— the screen's own intro claims every send uses your own account, and that is true only of email.

**What you see:** the title **Notifications**; a status line (*N saved topic pref(s)*); a banner
naming your **Default channel** and what happens to topics you have not configured; the **Saved
topics** cards; an **Add a topic** card; and a footer stating two limits honestly.

Each topic card shows the topic name with an **enabled** / **muted** pill, the last-saved time, and
five fields: **Channel**, **Quiet from (hour)**, **Quiet until (hour)**, **SMS destination**,
**Telegram chat id**. Below them is an **Enabled** checkbox (unticking keeps the routing saved but
mutes the topic), then **Save**, **Send test**, and a result line.

| Channel | What has to be true for it to deliver |
|---|---|
| **email** | You have a connected Google account that granted send permission; the message goes to that mailbox |
| **sms** | A destination number is saved. Your own connected Twilio is used when you have one; otherwise the deployment's Twilio carries it |
| **voice** | A destination number is saved and the deployment's Twilio is configured — it calls you and speaks the message |
| **telegram** | The deployment has a bot token configured **and** you saved your chat id |
| **none** | Shown as *none (mute this topic)* — an explicit "do not notify me" |

Quiet hours take a start and an end hour (0–23) or neither; a window that wraps past midnight is
fine. The hours are read in US Central time (America/Chicago), not your browser's timezone — there
is no per-user timezone field, so shift the numbers if you live elsewhere. A phone number must be in
international form, for example `+15551234567`.

To add a topic, type the exact name the thing that notifies you uses — there is no catalog to pick
from — choose a channel, and click **Create topic pref**. Names are stored lowercase and accept
`a-z 0-9 _ -`, up to 64 characters, starting with a letter or digit.

**The one thing to do with it:** click **Send test** on the topic you care about before you rely on
it. It sends for real and reports what the router actually did — *Delivered via email. id …*, or
*NOT delivered.* with the reason: quiet hours, channel unavailable, no connected account. It never
shows success for a send that did not happen.

## My Data — "give me everything you hold, or delete it"

Both actions are scoped to your signed-in account by the server; the subject is taken from your
session, never from anything the page sends.

**What you see:** an **Export** card, then a red-bordered **Delete** card, and — after a delete runs —
a **Result** section.

**Export.** Click **Download my data (JSON)**. You get one file: a manifest listing which stores were
read, how many rows each returned and which failed, plus a section per store. It is built on demand
and can be large. Nothing is previewed first, because generating a preview would mean generating the
whole export twice.

**Delete, step 1.** Click **Show me what would be deleted**. Nothing is destroyed. You get a plan
table and a confirmation box:

| Plan column | Meaning |
|---|---|
| **Store** | The store being considered |
| **Delete** | `deleted` — rows keyed to you are removed. `export-only` — retained by design (append-only audit trails and security floors) and **not** deleted |
| **Note** | Why, when the store declares a reason |

Underneath, a second table headed *These stores are NOT covered by the delete pass and will still
hold data afterwards* lists each uncovered store, what it holds and why it is not covered. Read it:
a successful delete never implies those were touched.

The confirmation box restates that confirming runs immediately and cannot be undone, and shows an
expiry — the confirmation is good for about fifteen minutes, after which you request a new plan.
**Delete my data now** also raises a browser confirmation; **Cancel** discards the plan and its token.

**Delete, step 2 — the Result section.** A summary line: when it ran, how many stores were deleted,
how many were retained as export-only, how many failed, and whether the retained audit row was
written. Then a table of *Store, Outcome, Rows, Detail*, where Outcome is `deleted`, `skipped` or
`failed`. Then the uncovered-store list again.

**The one thing to do with it:** run **Show me what would be deleted** and read the uncovered-store
list before you delete anything. That list is what you would need to clear by hand.

## Dead Letters — "which tickets did the queue give up on?"

An operator screen over the quarantine table. If your account is not on the operator allowlist the
page renders a plain **Operator only** panel explaining why, which is the expected answer rather than
a fault.

**What you see:** a checkbox *Also show tickets still accumulating attempts (not yet quarantined)*, a
**Reload** button and a **Download JSON export** link; three tiles — **Entries shown**,
**Quarantined**, **Already requeued**; a status line; then the table. Ticking the checkbox widens
both the table and the export.

| Column | Meaning |
|---|---|
| **Title** | The ticket's title, or *(ticket row gone)* when the ticket itself no longer exists |
| **Ticket type** / **Ticket status** | The ticket's own type and current state |
| **Attempts** | Failed cycles counted against it so far |
| **State** | `quarantined` — the queue stopped retrying. `accumulating` — still inside the retry budget, shown because the checkbox is ticked |
| **Reason** | Why it was quarantined: a dispatch-attempt ceiling, or an escalation loop |
| **Last error** | The most recent failure text |
| **Last failure** | When it last actually broke |
| **Quarantined** | When the queue gave up — a different instant from the last failure |
| **Requeued** | When it was last released, and by whom |

**The one thing to do with it:** fix the underlying cause, then click **Requeue** on that row. Requeue
resets the attempt counter and releases the ticket back to the approved state so the swarm picks it
up again, recording you as the actor. Each row reports its own outcome: *Released back to the queue*,
or the real reason — no dead-letter row for this ticket, the ticket is not in a releasable state (it
may already be running), or the store is unavailable.

A ticket lands here after it fails a set number of dispatch or system-escalation cycles
(`QM_MAX_ATTEMPTS`, default 3). At that point operators are alerted on the topic `queue-dlq` — which
is a topic you can route for yourself on the **Notifications** screen. The table lists the most
recent 200 entries.

## What these tools do NOT do

- **Search does not search your files.** There is no file index, and a search must not walk storage
  providers on every keystroke — the file browser lists providers live instead. Storage is absent
  from the chips for that reason.
- **Search never returns another person's tickets, conversations or connections** — those three are
  scoped to your own account for every caller, an operator included. What an operator additionally
  sees is platform configuration: apps and bots that are withheld from a basic user, and
  knowledge-base content their permissions cover.
- **The Personal data group answers nothing unless the personal-data service is switched on**
  (`ENABLE_PERSONAL_INTELLIGENCE`). When it is off the store is skipped cleanly rather than faked.
- **Run Trace needs a ticket.** It is built from records linked to a ticket id, so work that was never
  recorded against a ticket does not appear, and there is no search-by-title box — paste the id.
- **Run Trace never re-runs a call** and never writes anything.
- **Budgets is read-only.** There is no control here — or on any other cockpit screen — to create,
  edit, enable or disable a cap: caps are written through the budgets API, and a cap whose **Owner**
  reads `operator` cannot be changed from your own account at all.
- **An empty Caps table is not proof that nothing is capped.** Budget checking deliberately fails
  open: when the store cannot be read the answer is "unknown", and the empty table cannot distinguish
  "no caps configured" from "the caps could not be read".
- **Notifications has no list of the topics that exist.** It shows the preferences you saved. An empty
  list means you have saved none, not that nothing will notify you. A topic you have not configured
  resolves first to a saved topic named exactly `default` when you have one — quiet hours and all —
  and only otherwise to the banner's default channel. Saving one `default` topic is therefore how you
  route everything you have not named individually.
- **Telegram does nothing without a deployment bot token** (`TELEGRAM_BOT_TOKEN`). A text needs either
  your own connected Twilio or the deployment's (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER`); **voice has no personal tier at all** — it is the deployment's Twilio or
  nothing.
- **My Data cannot show you your data without generating something.** There is no read-only listing of
  your stores or the coverage gaps — both arrive only with a delete plan — and it cannot show past
  exports or deletions at all.
- **Self-service deletion refuses operator accounts** (deleting the operator would orphan the
  deployment), and is unavailable when the deployment has no signing secret configured
  (`SESSION_SECRET`), because an unsigned confirmation would be forgeable. The retained audit row of
  a deletion survives it on purpose.
- **Dead Letters is operator-gated at every route** — listing, export and requeue
  (`OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`). Requeue re-triggers real swarm work.
- **None of these appear on a student or kiosk rail**, and on a focused app they sit behind the
  **Settings** entry rather than on the rail unless that app asks for them back.

## If something looks wrong

**The tool is not on my ribbon.**
Open the cockpit without an app (`/cockpit/`) and look at the bottom of the rail. If you are focused
on an app, click **Settings** — the tools are registered, just not pinned, and the card grid reaches
them. **Dead Letters** is pinned for operator accounts; on other accounts open it by URL and read the
panel it renders. A student or kiosk rail carries no platform tools at all.

**Search found nothing, but I know the record exists.**
Check three things in order. First, whether a chip is lit — a lit chip narrows the search to that
store. Second, whether the thing is one of the kinds this box covers: files in storage are not
indexed. Third, whether it is yours: search answers over your own tickets, conversations and
connections. One store failing does not fail the whole search — it contributes nothing quietly — so
if a whole group you expected is missing, re-run the query with only that chip lit to see whether it
returns anything at all.

**Run Trace says "No trace is available for that ticket (missing, or not yours)".**
That single message covers three cases on purpose, so a ticket id can never be probed for existence:
the id does not exist, it is not a valid ticket id, or it belongs to someone else. Copy the id from
the ticket itself rather than typing it. If the ticket is yours and recent, the trace may simply have
no spans yet, which is a different message: *No spans recorded for this ticket yet*.

**Budgets shows a dash instead of a number.**
A dash means the spend could not be read — unknown, not zero. Hovering it says so. The cap row itself
is still real; the spend figure for that window is missing. Reload, and if it persists the spend store
is having trouble.

**Send test reported "NOT delivered".**
Read the rest of the line — that is the router's real answer, not a generic failure. The usual reasons
are quiet hours in force for this topic, no connected account for the channel you picked, or a channel
this deployment has not configured. Fix the named cause and test again.

**Requeue answers "the ticket is not in a releasable state".**
The ticket is not in a state the queue can release from — it may already be running or have been moved
on by hand. Reload the table to see its current ticket status before trying again. A *no dead-letter
row* answer usually means someone else already released it.

---

For the design rationale behind enforced spend caps and the runaway kill switch, see
[ADR-104](../adr/104-cost-governance-budgets-and-runaway-kill-switch.md); for how the trace waterfall
is reconstructed from already-persisted records, see
[ADR-107](../adr/107-run-trace-read-model-observability.md).
