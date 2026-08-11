# Security Center — user guide (as-built)

Open **`/cockpit/?app=security-center`**, or click the shield icon labeled *Security Center* on the
ribbon. The page itself is served at **`/api/security/`**. This screen is **operator-only**: you must
be signed in *and* your account must be listed in `OSHAL_OPERATOR_SUBS` or `OSHAL_OPERATOR_EMAILS`.
Non-operators do not see the app in the catalog or ribbon, and a direct request returns
`Operator privilege required`.

The Security Center scans the swarm platform itself and lists what it found. It looks for credentials
sitting in files, API routes mounted without an auth guard, dependencies with known advisories, odd
bot activity, odd money-ledger rows, and odd task-dispatch decisions. Everything it produces is a
**finding you read and act on** — the screen reports, it does not fix, block, or roll anything back.

## What you see

The page is two panels under a header, top to bottom.

**Header** — a shield badge, the title *Security Center*, and the **Run scan** button on the right.
Below it, one line describing the coverage.

**Scan scopes panel** — four checkboxes (all ticked by default), then a row of counter tiles, then a
last-scan line.

- The checkboxes choose which scopes **Run scan** will execute. Untick a scope to skip it. If you
  untick all four and press the button you get *Pick at least one scope.*
- **Run scan** runs the ticked scopes now, in the foreground. The button disables and reads
  *Scanning…* until the run finishes, then returns to *Run scan*. A failure pops a browser alert
  reading *Scan failed: …*; nothing is stored for that run beyond a scan record marked `error`, the
  tiles and list do not refresh, and the last-scan line shows that failed run until you scan again.
- The **counter tiles** are `open`, `critical`, `high`, `medium`, `low`, `info`. Each counts findings
  currently in the **open** status. Click a severity tile to filter the list below to that severity;
  click the `open` tile to clear the severity filter. The selected tile is outlined.
- The tiles and the category chips **always count `open` findings**, even while you are looking at
  another status. Switch the status chip to `resolved` and the tiles keep showing your open counts —
  the severity tile still filters the list you are looking at, it just isn't counting it.
- The **last-scan line** reads *Last scan: `<time>` · `<scopes>` · N findings (M new) · `<status>`*,
  or *No scan run yet.* "N findings" is how many hits that run produced in total; "M new" is how many
  of them the system had never seen before. `<status>` is `complete` for a run that finished and
  `error` for one that blew up.

**Findings panel** — two rows of filter chips, then the finding cards.

- **Status chips** — `open`, `triaged`, `resolved`, `ignored`, each with a count of every finding in
  that status. Exactly one is active; the list shows that status. The page opens on `open`.
- **Category chips** — *All*, *Secrets*, *Routes*, *Dependencies*, *Threats*, *Ledger*, *Audit*, each
  with a count of **open** findings in that category. Click one to narrow the list, *All* to clear.
- On both rows a chip at zero shows **no number at all** — a bare label means none, not unknown.
- **Finding cards**, worst severity first, then most recently seen. Each card carries a colored left
  edge and, in order: a severity pill, a category pill, the title, the plain-language detail, the
  location it came from (a file and line, a package name, an app name, a table, an agent id, or a
  task id), a monospace **evidence** block with the structured, redacted context, an **analyst
  verdict** block once you have assessed it, and the action buttons.
- When a filter matches nothing — including a fresh install where you have never run a scan — the
  list reads *No `<status>` findings* (plus *at `<severity>` severity* when a tile is selected).
- The list shows at most **200 findings** per filter combination. If a scope produces more than
  that, narrow with the severity tile or the category chip rather than scrolling.

Everything on this screen is **scoped to the signed-in operator**. Findings, their triage, and the
scan history are stored per account, so another operator's assessments and resolutions are not
visible here and yours are not visible to them.

## Scan scopes

| Checkbox | What that scan actually looks at |
|---|---|
| **Posture (secrets · routes · deps)** | Three checks in one. **Secrets:** walks the text files the API process can read under `SECURITY_SCAN_ROOT` (defaults to its working directory) matching credential signatures — AWS access key ids, private key blocks, OpenAI keys, Stripe live keys, GitHub/Slack tokens, Google API keys, Alpaca key ids, JWTs, and long opaque values assigned to secret-looking names. **Routes:** reads the server's mount table plus the active apps' declared routes and flags any `/api/*` mount that carries no auth guard and is not on the reviewed public-by-design list. **Dependencies:** runs `npm audit` and turns each advisory into a finding. |
| **Runtime threats** | Heuristics over the bot task ledger: 10 or more failed bot tasks in the last 24 hours, any single run costing more than $5 in the last 7 days, and any agent creating 50 or more tasks in the last hour. Those numbers are the defaults and are set by `SECURITY_FAILED_TASK_THRESHOLD`, `SECURITY_TASK_COST_USD`, and `SECURITY_AGENT_BURST_THRESHOLD`. |
| **Ledger anomalies** | Reads **your own** trading orders and shop purchase rows: an order with no linked decision behind it, a filled order above $2,000 notional, 5 or more rejected/canceled orders in 24 hours, and a purchase above $1,000. Thresholds: `SECURITY_BIG_ORDER_USD`, `SECURITY_REJECT_THRESHOLD`, `SECURITY_BIG_PURCHASE_USD`. If neither ledger exists on this install, the scope reports nothing. |
| **Access / audit** | Reads the dispatch trail for the last 7 days and flags tasks that routed to an agent with **zero** candidates evaluated, and tasks whose winning agent scored zero or below. This is the dispatch trail the platform records; per-resource access logging is not part of it. |

## Severities

Severity is assigned by the scanner that produced the finding. When you press **Assess**, the
analyst's calibrated severity replaces it, so a finding can move up or down after triage.

| Pill | What it means here |
|---|---|
| **critical** | Treat as an active exposure. A proven-committed live-looking credential, or a money order with no justifying decision behind it. |
| **high** | A real weakness that needs a fix: an `/api` route mounted with no auth guard, an app route declared public, a high-severity dependency advisory, a large live-money order, or a large runtime anomaly. |
| **medium** | Worth confirming, usually not an exposure on its own — a moderate advisory, a failure or reject spike, a task-cost outlier, a large purchase row, a dispatch with no candidate agents. |
| **low** | Informational signal: a low advisory, a low-fit dispatch, a large order on the paper book. |
| **info** | Recorded for completeness. Nothing to do unless context changes. |

Secret findings are deliberately de-escalated when the evidence is weaker: a hit in a file the
scanner could **not** prove is committed drops one level, and a hit in a file that looks like an
example, template, test, fixture, or Markdown drops two more. The evidence block tells you which
happened via its `committed` (true / false / null) and `exampleFile` fields.

## Statuses

| Status | Meaning | How it gets set |
|---|---|---|
| **open** | Untouched. This is where every new finding lands. | A scan produced it. |
| **triaged** | Someone has looked at it — the analyst assessed it, or you filed a ticket for it. | Set automatically by **Assess** or **Open ticket** when the finding was `open`. |
| **resolved** | Fixed or no longer present. | You pressed **Resolve**, or a posture re-scan stopped producing it (see below). |
| **ignored** | Accepted risk or a false positive you do not want to see again. | You pressed **Ignore**. |

Re-scanning refreshes findings in place rather than duplicating them, and it **never reopens**
anything you set to `triaged`, `resolved`, or `ignored`.

## What you can do

**Run a scan.** Tick the scopes you want and press **Run scan**. A posture scan shells `npm audit`,
which can take up to 90 seconds, so the whole run can sit at *Scanning…* for a minute or more. When it
finishes the tiles, chips, and list all refresh.

**Read a finding.** Open the list on `open`, worst first. The detail paragraph explains what was
matched and why it matters; the line beneath it tells you where to look; the evidence block gives the
structured facts. Secret values are never shown in full — evidence carries a masked preview
(`abcd…xyz (44 chars)`) and never the live value.

**Get an opinion.** Press **Assess** on a card. This runs the security-analyst bot on your account's
model provider — it is a real model call, one per press, billed and cost-attributed like any other
bot run, so **Re-assess** is not free. The bot reads that one finding and returns a verdict, which
appears as an *analyst verdict* block on the card:

- the header says *· confirmed* when it judged this a real threat, *· likely false positive* when it
  flagged it as one, and carries no suffix when it committed to neither;
- a one-sentence summary;
- an **attack** paragraph — who would exploit this and what they get — when the analyst supplied one;
- a **fix** paragraph — the smallest effective fix — when the analyst supplied one, with
  **(rotate AND scrub git history)** appended when it judged the secret needs purging from history,
  not just deleting from the file.

Assessing also sets the finding's severity to the analyst's calibrated value and moves an `open`
finding to `triaged`. The button then reads **Re-assess**; press it again to redo the triage. If the
model returns something the system cannot read as a verdict, the block appears saying *No assessment
returned.* and the scanner's own severity is kept — re-assess or judge it yourself.

**Escalate to a ticket.** Press **Open ticket**. That creates a ticket titled
`[security:<severity>] <finding title>` carrying the detail, the location, and — if you assessed
first — the recommended fix and attack scenario. Critical and high findings are filed ready to
dispatch; medium, low, and info are filed to the backlog for review. Filing also moves an `open`
finding to `triaged`, and the button disappears — a *ticket linked* pill takes its place, so a
finding can only ever carry one ticket. **Assess before you file** if you want the fix text in the
ticket.

**Close the loop.** **Resolve** marks it fixed, **Ignore** marks it accepted. Both remove it from the
`open` list. Switch the status chip to `resolved` or `ignored` to review them later; on those cards
**Resolve** and **Ignore** are replaced by a single **Reopen** that puts the finding back in `open`.
**Assess** and **Open ticket** stay available there.

**Review by slice.** Combine the chips and tiles: status chip picks the pool, category chip narrows
the kind, severity tile narrows the level.

## What this screen does NOT do

- **It does not remediate.** Nothing here rotates a key, edits a file, closes a route, blocks a
  request, or cancels an order. Findings are informational; every fix is done by you or by the ticket
  you file.
- **It does not scan on a schedule.** There is no background scanning, no polling, and no
  auto-refresh. The tiles and list only change when you press **Run scan** or take an action on a
  card.
- **It does not tell you which scanners could not run.** A check that could not execute — the
  dependency audit with no registry access, a ledger table that does not exist on this install, the
  route check on a deployment whose own source tree isn't under `SECURITY_SCAN_ROOT` — is recorded as
  unavailable with the scan, but the screen shows only counts. **A zero is not proof of "clean."**
- **It does not report every matching row.** The event-shaped checks report the worst or most recent
  handful per run — the top expensive runs and bursting agents, the largest orders and purchases, the
  most recent dispatch anomalies — not one finding per row. Treat those scopes as "here is what stood
  out", and go to the underlying app when you need the full list.
- **It has no supply-chain / container scan checkbox.** The scan engine has an image scope built on
  Trivy (CVEs, Dockerfile and compose misconfiguration, embedded secrets, with high-and-above hits
  auto-filing tickets at `TRIVY_TICKET_SEVERITY_FLOOR`), but the four checkboxes on this screen never
  request it, so pressing **Run scan** here does not run it.
- **It does not show your tickets.** This app's ribbon hides the framework Tickets view; a ticket you
  file from here lives in the normal ticket system under the `security-finding` type. Open it from
  the default cockpit.
- **It does not reach beyond this install.** Posture reads the tree the API process can see
  (`SECURITY_SCAN_ROOT`) — not your laptop, not another host, not other containers. Ledger findings
  cover your own rows.
- **It is not visible to normal users.** The operator gate is fail-closed: with
  `OSHAL_OPERATOR_SUBS` and `OSHAL_OPERATOR_EMAILS` both empty, nobody passes.

## If something looks wrong

**"Operator privilege required", or the app is missing from my ribbon.** The screen and its whole API
are gated to operator accounts, and the gate denies by default. Your signed-in subject or email has
to be in `OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS` on this deployment.

**The scan sits on "Scanning…" for a long time, or a scope comes back with zero.** The posture scan
shells `npm audit`, which is allowed up to 90 seconds before it gives up — a full run of a minute-plus
is normal. If that call cannot reach a registry, the dependency check reports itself unavailable, and
because this screen shows only counts, that looks identical to "no vulnerable packages." Same for a
ledger scope on an install with no trading or shop tables. When a scope's zero matters to you,
confirm it outside this screen rather than reading the tile as an all-clear.

**Findings I never touched moved to "resolved" after a re-scan.** That is intentional for the posture
scopes: secrets, routes, and dependencies describe the *current* state of the tree, so an open finding
a fresh successful scan no longer produces is treated as fixed. Runtime, ledger, and audit findings
describe events and are never auto-resolved. Click the `resolved` chip to see what moved, and
**Reopen** anything that should not have.

**Every secret finding says the git-tracked status is UNKNOWN.** The scanner proves "committed" by
asking git about the copy it scanned. When the scanned copy is not a git checkout — which is the case
when the platform runs from a built container image — that question cannot be answered, so the finding
says so plainly and drops a severity level rather than claiming the value is committed. Check the path
from a real checkout to settle it; if the value is real, rotate it either way.

**Assess changed the severity of a finding.** Expected — the analyst's calibrated severity replaces
the scanner's, in both directions, and the card's left edge and pill re-color to match. The verdict
is advisory; the scanner's evidence block above it does not change.

**A card button popped a *Failed: …* alert.** The action did not happen and the button resets to its
previous label — nothing is half-applied. **Assess** is the one that depends on an outside service:
it needs a working model provider on your account, so a provider that is unconfigured, out of credit,
or unreachable fails here first. **Open ticket**, **Resolve**, **Ignore**, and **Reopen** are local
and should only fail if the platform itself is unhealthy. Retry; if it persists, check your provider
settings before assuming the finding is broken.

---

Design rationale and the scanner/triage split are recorded in
[ADR-055](../adr/055-security-center.md).
