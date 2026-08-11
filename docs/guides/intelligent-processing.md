# Intelligent Processing (Self-Healing Queue) — user guide (as-built)

Open **`/cockpit/?app=intelligent-processing`** and click the pulse icon labeled
**Intelligent Processing** at the top of the ribbon. The same screen is served directly at
**`/intelligent-processing`** if you want to bookmark it on its own. The app's ribbon also carries
**System Health** (top, readable by any signed-in user) and **Pipeline Admin** (bottom, operator-only
— the ribbon entry appears for everyone, but its data refuses a non-operator) — separate screens,
described elsewhere.

This screen is the queue of health problems the swarm has noticed about **itself**. Prometheus
watches the swarm's own containers, and each alert it raises becomes a ticket that shows up here as
one row per distinct issue.

**The watching half is opt-in, and it is off in a default bring-up.** Prometheus, Alertmanager and
cAdvisor ship as a separate monitoring overlay that a normal stack start does not launch, and the
receiver that turns an alert into a ticket is fail-closed on the bearer token
**`ALERT_WEBHOOK_TOKEN`** — with no token set it rejects every alert that arrives. Until an operator
brings that overlay up with a token configured, this screen is correctly and permanently empty.

**Not everything parks here.** Where a ticket lands is decided per alert rule, and the rule wins over
the deployment default:

- An alert rule carrying an `intake: auto` label opens its ticket already **`approved`** and flows
  straight into RCA analysis — nobody promotes it, and it never appears in the default Backlog view.
  The shipped worker-fleet container-health rules (`SwarmContainerDown`,
  `SwarmContainerRestartLoop`, `SwarmContainerHighMemory`, `SwarmContainerHighCPU`) all carry it.
- Every other alert falls through to the deployment default **`ALERT_DEFAULT_INTAKE`** — shipped as
  `backlog` in the local compose stack — and **parks here waiting for you**.
- An auto-flowing alert can still land in backlog anyway: when the RCA spend budget is exhausted the
  intake downgrades it to `backlog` rather than starting work it cannot pay for.

Your job on this screen is to read what is parked and decide what deserves to be worked.

## What you see

Top to bottom, the screen has three regions.

**Header bar** — the title *Intelligent Processing / Self-Healing Queue*, then two live counters on
the right:

| Counter | What it counts |
|---|---|
| `N` **backlog** | Rows in the current view whose newest ticket is still in `backlog` — the work waiting on you. |
| `N` **shown** | Rows currently rendered (groups, not tickets). |

**Controls row** —

- **Status** dropdown. Chooses which tickets are fetched. Defaults to *Backlog (parked)*. Changing
  it reloads the table immediately.
- **Refresh** button. Re-fetches now. The table also refreshes by itself every 20 seconds.
- **updated HH:MM:SS** — when the table last redrew.
- On the right, the standing note: *Grouped by alert fingerprint — one row per distinct issue.*

**The table** — seven columns: **Severity**, **Alert**, **Target**, **Status**, **Count**,
**Last seen**, **Action**. Rows are sorted worst severity first. When the view has nothing in it the
column headers stay and *No tickets in this view.* appears below them. A network failure prints its
message in place of the rows; an API refusal looks the same as an empty view.

### Columns

| Column | What it shows |
|---|---|
| **Severity** | The colored chip — the alert's own `severity` label. Alert intake always stamps one (`warning` when the alert itself omitted it), so in practice this is the alert's severity; the ticket's priority is only a fallback for a row with no alert metadata at all. |
| **Alert** | The alert rule's name, e.g. `SwarmContainerDown`. Falls back to the ticket title if the alert name is missing. |
| **Target** | The thing the alert is about — the container/instance the alert identified. Reads `unknown-target` when the alert named none. |
| **Status** | The current state of the **newest** ticket in that group. See the status table below. |
| **Count** | How many tickets in the current view share that alert fingerprint. Outlined in orange when it is above 1. |
| **Last seen** | How long ago the newest ticket in that group was opened: minutes under an hour (`45m`), hours under a day (`6h`), then days (`8d`). |
| **Action** | **Promote to approval** when the newest ticket is in `backlog`; a dash otherwise. |

### Severity chips

The chip color and the row order both come from the severity label:

| Severity label | Chip | Sort position |
|---|---|---|
| `critical`, `urgent` | red | first |
| `warning`, `high`, `major` | orange | second |
| `minor`, `medium` | yellow | third |
| `info`, `low` | blue | fourth |
| anything else | plain (no color) | last |

### Grouping and the Count column

Rows are grouped by **alert fingerprint** — the identity of the underlying problem — so the same
issue is always one row. This is why a storm cannot fill the screen with duplicates.

Two separate things keep the count down, and it helps to know which is which:

- **Before the ticket exists:** a repeat firing of an alert that already has an open ticket does not
  open a second ticket. The intake folds it onto the existing ticket and bumps that ticket's
  occurrence tally. Related alerts (same target, or a dependency-connected one inside the
  correlation window) attach to the open incident as members instead of opening siblings.
- **On this screen:** the **Count** column counts tickets sharing a fingerprint. So `1` is the
  normal, healthy number even for an alert that has fired hundreds of times. A count above 1 means
  more than one ticket exists for that fingerprint — typically the problem came back after the
  earlier ticket had already closed or aged out.

**Last seen** follows the same logic: it is the age of the newest ticket in the group, not the
timestamp of the last time the alert fired. A row reading `8d` with a count of `1` means one ticket
was opened eight days ago and has been sitting since.

## Statuses

The **Status** column prints the ticket's actual state. These are the ones this queue produces:

| Status | What it means for you |
|---|---|
| `backlog` | **Parked.** The alert opened a ticket and stopped there. Nothing is investigating it and nothing has been changed. It waits here until a person promotes it. This is where an alert lands unless its own rule opted into auto-flow. |
| `approved` | Queued for the pipeline — either because you promoted it, or because the alert rule opted into auto-flow at intake. The pipeline polls this state. |
| `in_process_discovery` | An RCA bot is actively working the ticket. This is the only in-flight state this pipeline writes — note it is **not** the bare `in_process` the dropdown filters on (see the caution under the dropdown table). |
| `customer_action` | **The investigation finished and is waiting on a human.** The ticket carries a disposition: `proposed_solution` (a fix was proposed — approve or close it) or `human_action_needed` (the RCA needs you to do or decide something). Nothing has been applied. |
| `escalated` | The pipeline could not settle it, or an automated step failed and handed it to a person. |
| `complete` | Closed out — the investigation produced no actionable proposal, or an auto-applied fix was verified healthy. |
| `dead_letter` | **Quarantined.** Dispatch failed repeatedly (the retry ceiling is `QM_MAX_ATTEMPTS`, default three cycles), so the queue stopped retrying. Terminal until an operator requeues it. |

`approval_required` is not a state this pipeline produces — the dropdown offers the view, but the
incident RCA workflow never parks a ticket there, so it is normally empty for this queue.

The **Status dropdown** is a different, smaller list — it is the set of views you can fetch, not the
set of states a ticket can be in:

| Dropdown option | Shows |
|---|---|
| **Backlog (parked)** — default | Tickets in `backlog`. |
| **Approval Required** | Tickets in `approval_required` — normally empty here, since this pipeline does not use that state. |
| **Approved** | Tickets queued for the pipeline that have not started yet. |
| **In Process** | Tickets in the bare `in_process` state — **not** tickets this pipeline is working. See the caution below. |
| **Complete** | Closed tickets. |
| **All** | Every Intelligent Processing ticket, regardless of state. |

**Caution — "In Process" does not show work in flight.** Each option filters on that exact status
string, and an RCA ticket under investigation carries `in_process_discovery`, not `in_process`. The
**In Process** view will therefore look empty while a ticket is actively being worked. Use **All**
and read the Status column to follow a promoted ticket.

There is no dropdown option for `customer_action`, `escalated`, or `dead_letter`. Once a promoted
ticket reaches one of those states, **All** is the view that shows it.

## What you can do

**Read the queue.** Land on the screen and you are looking at everything parked in backlog, worst
severity first. Scan the Severity and Target columns to see what is unhappy, and Last seen to see
how long it has been that way.

**Change the view.** Pick a different value in the Status dropdown to see promoted or finished work.
**All** is the only view that shows work in flight, and the only one that shows tickets that have
come back from the pipeline waiting on you.

**Promote a row into the pipeline.** This is the one action on the screen.

1. Find the row you want worked. The **Promote to approval** button appears when that row's newest
   ticket is in `backlog`.
2. Click it. The button reads *Promoting…* while it works, then the table reloads.
3. What actually happened: that single ticket moved from `backlog` to `approved`. **Nothing was
   restarted, stopped, or changed on any container.**
4. From there the pipeline picks the ticket up on its next poll and runs the incident RCA workflow —
   an RCA worker investigates, a reviewer checks the write-up, and if the reviewer asks for changes
   the worker gets **one** revision pass before the ticket is finalized either way. Both of those
   bots run in opt-in containers that a default bring-up does not start; with them missing the
   ticket escalates instead of being investigated.
5. The ticket comes back as `customer_action` (a proposal, or a request that you act) or
   `escalated`. Switch the Status dropdown to **All** to find it, and act on it from the cockpit
   ticket surface.

Promote acts on the **newest** ticket in the group. If Count is above 1, the older tickets sharing
that fingerprint stay where they are.

**Cross-check before you promote.** *System Health* on the same ribbon shows what is firing right
now and where each alert reached in the pipeline, which is the fastest way to tell a live problem
from a stale one.

## Why rows sit in backlog for days — and why that is correct

The deployment default is to park. Any alert whose rule does not opt into auto-flow follows
`ALERT_DEFAULT_INTAKE` — shipped as `backlog` in the local compose stack — so the alert opens a
ticket, the ticket parks, and it stays parked until a person promotes it. An alert sitting at `8d`
in this queue is the design working, not a stuck job or a failed bot.

The reason for the friction is cost and blast radius: auto-flowing every alert into investigation
would spend analyst budget unattended on noise. So the deployment gets a dial instead of a leap of
faith — the per-alert `intake:` label decides first, the deployment default catches everything else,
and a spend gate can push an auto-flowing alert back into backlog when the budget is gone.

**Telling the two apart matters, because they mean different things.** A row that parked because its
rule never asked for auto-flow is simply waiting for you. A row that parked because the spend gate
stopped it carries an `analysis-skipped:budget` marker — that one *wanted* to investigate itself and
was refused on cost, so nothing has looked at it yet and it will keep waiting no matter how long you
leave it. Both look identical in the Status column; only the marker distinguishes them. Promoting
overrides the spend gate for that ticket, so if the budget-skipped rows are the ones you care about,
promote them deliberately rather than waiting for the queue to drain itself.

The container-health rules that ship with the monitoring overlay (container down, restart loop, high
memory, high CPU) *do* carry `intake: auto` — so on a deployment running those rules, a backlog row
for one of them is usually the spend gate, not the default.

What auto-flow does and does not buy: an auto-flowed ticket gets *analysis* without a human, and it
still stops at the human gate before anything is changed. The only path that changes a container
without a person is the bounded auto-apply described below, and that is off by default.

## What this screen does NOT do

- **It never touches a container.** Promote changes one ticket's status. It does not restart, stop,
  rebuild, or reconfigure anything.
- **It does not auto-promote.** Nothing on this screen moves a ticket out of backlog on its own. (A
  ticket can still start life `approved` and skip this screen entirely — that decision is made by
  the alert rule at intake, not here.)
- **Unattended remediation is off by default.** Bounded auto-apply — where an approved-class
  proposal executes without a human — is governed by the environment flag **`SELF_HEAL_AUTO_APPLY`,
  default `false`**, and the shipped compose stack leaves it `false`. With it off, proposals stop at
  the human gate. Even when a deployment turns it on it stays narrow: restarting a non-core worker
  container and nothing else, at most once per incident within the consolidation window, under a
  swarm-wide hourly cap (**`SELF_HEAL_APPLY_HOURLY_CAP`**, default three), and the ticket closes only
  after the target is observed healthy again inside the verification window
  (**`SELF_HEAL_VERIFY_TIMEOUT`**). Core infrastructure is refused outright regardless of the flag.
  The restart itself is carried out by an opt-in container that a default bring-up does not start —
  if it is absent, turning the flag on changes nothing except that failed applies escalate.
- **There are no other buttons.** No approve, close, reject, cancel, comment, or reassign. Anything
  beyond promoting is done from the cockpit ticket surface.
- **Rows are not clickable.** There is no drill-down panel, no link to the ticket, and no alert
  detail on this screen. To read the alert body, labels, and RCA output, open the ticket in the
  cockpit ticket workbench.
- **No search, sorting, or paging controls.** The sort is fixed to severity order, and the Status
  dropdown is the whole filter.
- **It shows Intelligent Processing tickets and nothing else.** Other incident and build work does
  not appear here.
- **It does not configure alerting.** Which alerts exist, what they watch, which of them are allowed
  to open a ticket at all, and which ones auto-flow instead of parking here are all set outside this
  screen.
- **It cannot rescue the control plane.** If the platform API itself is down, no ticket can be
  opened for it — recovering the core services is a job for a watchdog outside the swarm.

## If something looks wrong

**The table is empty even though I know alerts are firing.**
Three likely causes, in the order worth checking. First, the alert may never have reached the
platform at all: the monitoring overlay is not part of a default bring-up, and the receiver rejects
every alert while `ALERT_WEBHOOK_TOKEN` is unset — ask your operator whether the overlay is running
with a token configured. Second, the default view is *Backlog (parked)*, and an alert rule carrying
`intake: auto` never passes through backlog; switch to **All**. Third, alert-born tickets are owned
by a machine identity, and the ticket list scopes a non-operator account to its own tickets, so a
regular signed-in user sees an empty queue here even when it is full — sign in with an operator
account. Note that the screen shows the plain empty state rather than an error when the API refuses
the request, so "empty" and "not allowed to see it" look identical here.

**I promoted a row and it disappeared.**
That is the expected result. The row left `backlog`, and the default view shows backlog only. Switch
the Status dropdown to **Approved** or **All** to follow it — do not use **In Process**, which
filters on a state this pipeline never writes.

**A ticket came back and I cannot find it anywhere.**
Finished RCA tickets land in `customer_action` or `escalated`, and neither has its own dropdown
option. **All** is the view that shows them. The Status column will tell you which one it is.

**I promoted a row and it went straight to `escalated` without any investigation.**
The RCA worker and reviewer run in opt-in containers that a default bring-up does not start. With no
worker reachable the dispatch fails and the ticket escalates rather than hanging. Ask your operator
to bring the incident bots up before promoting more rows.

**I clicked Promote and the row still says backlog.**
The button does not display errors — it reloads the table at whatever the ticket's real status is.
The usual cause is not having access to that ticket, which the API answers as if the ticket were not
there. Open the ticket from the cockpit ticket surface to confirm, and check you are on an operator
account.

---

Design rationale, the autonomy ladder, and the drill results behind the gated remediation posture:
[ADR-119](../adr/119-autonomous-health-ticket-processing.md). Operator wiring for the monitoring
stack — bringing the overlay up, setting the webhook token, and the intake knobs:
[the self-healing runbook](../runbooks/self-healing-monitoring.md).
