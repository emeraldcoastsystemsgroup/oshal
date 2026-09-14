# Agent ids claimed by more than one application

Measured on the operator's box 2026-09-14, against the api container started `2026-09-14T06:46:14Z`
(image `oshal-bot:latest`). Every number below was produced by a query or a log count reproduced in
this document; none is carried over from a summary.

## What this is, in one paragraph

`swarm_applications.agent_ids` was built as an **association** column — the loader fills it so
Jarvis's catalog, mesh `BID_REQUEST` fan-out, selector composition and competency ranking can find
an app's bot ([`swarm-app-repository.ts`](../../src/features/swarm-apps/services/swarm-app-repository.ts),
`upsert`). Association is legitimately many-to-many: three packages in the creative bundle really do
share one accountable bot. The ADR-149 ownership reader
([`application-execution-ownership.ts`](../../src/app/application-execution-ownership.ts)) reads the
same column as an **ownership** column, and ownership must be one-to-one — so it raises
`Ambiguous package ownership` whenever a bot id resolves to more than one app name. Twelve ids do.

## Timeline — what has been true for how long

This is the part to read before anything else, because the shape of the fix makes it easy to
misread as a new break.

| when | commit | state of every `kind:'bots'` ownership read |
|---|---|---|
| before 2026-09-10 | — | no reader; nothing gated |
| 2026-09-10 23:57 CDT | `0cfe4d9b` | reader lands, binding a text parameter against a `UUID[]` column |
| 2026-09-11 09:53 CDT | `c18f057a` | protected-result gating starts calling it — **every** read raises `operator does not exist: text = uuid`, `canReadProtectedResult` swallows it to `false`, nothing is logged |
| 2026-09-14 01:27 CDT | `086832cf` | comparison fixed (`::text[]`) and the swallowed failure is now logged |

So from 2026-09-11 to 2026-09-14 **every** agent id refused, silently. Since the fix, a uniquely
owned id resolves and is readable (this is what un-broke Jarvis, whose
`a0000000-0000-0000-0000-000000000050` resolves to exactly one app), and a multiply-claimed id
raises `Ambiguous package ownership`, which the caller still turns into the same refusal it was
already giving.

**The refusal for these twelve ids is not new and tonight's deploy did not cause it.** What is new
is that it is now visible in the log, and that every other id started working. Nothing about
trading, career or creative surfaces got worse at 06:46Z; a three-day-old silent refusal became a
named one.

## Reproducing the census

SQL over stdin — inline quoting through `sh -c` breaks on this box.

```bash
cat > /tmp/q.sql <<'SQL'
select agent, count(*) as apps, string_agg(app, ', ' order by app) as owners from (
  select distinct agent, app from (
    select unnest(agent_ids)::text as agent, app_name as app from oshal_authorization_applications
    union all
    select unnest(agent_ids)::text as agent, name as app from swarm_applications
  ) u
) d group by agent having count(*) > 1 order by count(*) desc, agent;
SQL
docker exec -i oshal-local-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|"' < /tmp/q.sql
```

The union matters: the reader reads both ownership tables, so a collision can be produced by either.
Here it is not — running the same query against `swarm_applications` alone returns the identical
twelve rows, and `oshal_authorization_applications` (78 rows) adds none.

The `tool_names` half of the same reader is **clean**: the same query over `tool_names` returns zero
rows, so no tool name is claimed by two applications.

## The census — 12 ids, complete

The "owner" column is not a judgement call: `agents.metadata.manifestApp` is stamped by the loader
and every one of these twelve agents carries exactly one such stamp and is `status=active`.

| agent id | bot | stamped owner | claimants | class |
|---|---|---|---|---|
| `a0000000-…-0002` | code-developer | oshal-engineering | **5** — cluster-probe, durable-probe, oshal-engineering, smoke-parallel-2, smoke-parallel-flow | a |
| `b00e0000-…-0001` | vids-operator | vids | **4** — creative-studio, daily-trade-recap, video, vids | c |
| `a0000000-…-0016` | rca-specialist | intelligent-operations | 3 — intelligent-operations, intelligent-processing, issue-rca | c + d |
| `b0000000-…-0001` | communications-bot | switchboard | 3 — email-summarizer, social, switchboard | c |
| `e0000000-…-0100` | incident-remediation-bot | intelligent-operations | 3 — incident-remediation, intelligent-operations, issue-rca | d |
| `a0000000-…-0003` | code-reviewer | oshal-engineering | 2 — oshal-engineering, test-gate-flow | a |
| `a0000000-…-000b` | incident-response-bot | intelligent-operations | 2 — intelligent-operations, issue-rca | d |
| `a0000000-…-0045` | identity-advisor | identity | 2 — identity, trading | **b** |
| `a0000000-…-0051` | workflow-assistant | workflow-studio | 2 — smoke-published-flow, workflow-studio | a |
| `b00f0000-…-0001` | drone-operator | drone | 2 — brand-graphics, drone | **b** |
| `c1de0000-…-0001` | capability-ideator | capability-ideator | 2 — capability-ideation, capability-ideator | a |
| `cb000000-…-0001` | career-hunter | career-hunter | 2 — career-hunter, job-apply | c |

Classes: **a** = throwaway Workflow Studio publish artifact · **b** = carve mistake, a manifest
pinned a uuid it does not own (ADR-085) · **c** = deliberate alias, two names sharing one
accountable bot on purpose · **d** = stale row for a manifest that no longer exists.

## Evidence per class

### (a) Throwaway Workflow Studio publish artifacts — 5 of the 12

`cluster-probe`, `durable-probe`, `smoke-parallel-2`, `smoke-parallel-flow`, `smoke-published-flow`,
`test-gate-flow` and `capability-ideation` are confirmed throwaways **from their install shape, not
their names**:

- They are loose `*.yaml` files directly under `/app/workspace-shared/deployed-apps/`, not package
  directories — `ls -la /app/workspace-shared/deployed-apps/*.yaml` lists exactly eight (the seven
  above plus `night-smoke-flow`, which claims no colliding id). Every real store package instead has
  a directory with `oshal-app.yaml` **and** a `.oshal-install.json` naming the `oshal-applications`
  repo, ref and sha; none of these eight has one.
- Their stored manifests have only `{displayName, name, scope, ticketType, workflow}` (plus
  `description`) — no `bots:`, no `version` (all sit at `0.0.0`), no `suite:`, no `source`.
- Their `workflow.processDefinition.nodeGraph` is the Studio's own emitted shape, and the bot they
  bind is a core-platform bot by name: `agentBinding: "code-developer"`, `"code-reviewer"`,
  `"workflow-assistant"`, `"capability-ideator"`.
- `scope=person`; `cluster-probe`, `durable-probe`, `smoke-parallel-2`, `smoke-parallel-flow` and
  `test-gate-flow` carry `owner_sub` NULL, and `smoke-published-flow` carries `mock-user-001` — a
  test identity, not a person.

They claim their id through the ADR-085 carve-parity branch in `upsert`: an app with no `bots:` has
`workflow.workerBot` resolved by NAME against the `agents` table. Referencing a core bot in a
published workflow is therefore enough to become a claimed owner of it.

### (b) Carve mistakes — a manifest pinned a uuid it does not own

Both are the shape `scripts/swarm-app-bot-integrity-check.sh` was written for (its header records
the original: portrait-studio reusing drone-operator's id).

- **`trading` → `a0000000-…-0045`.** Its stored manifest declares one bot named `trading-analyst`
  with `agentId: a0000000-0000-0000-0000-000000000045`. The live `trading-analyst` agent is
  `a0000000-…-0046`, stamped `manifestApp=intelligent-trades`; `…-0045` is `identity-advisor`,
  stamped `manifestApp=identity`. So the manifest pinned the wrong uuid and `identity` later took
  it. `trading` is `status=inactive`, `version 1.0.0`, `manifest_path /app/swarm-apps/trading.yaml`
  — **a path that exists neither in the tree nor in the running image**; `swarm-apps/` holds exactly
  ten manifests in both, and `trading.yaml` is not among them (ADR-136 renamed the cockpit app to
  `intelligent-trades`). Last updated 2026-08-11.
- **`brand-graphics` → `b00f0000-…-0001`.** Its manifest declares a bot *named* `brand-graphics`
  with `agentId: b00f0000-0000-0000-0000-000000000001` — which is `drone-operator`, stamped
  `manifestApp=drone`. No agent named `brand-graphics` exists. `brand-graphics` is
  `status=inactive`; its `.oshal-install.json` pins `oshal-applications` sha `a0cb92f3`.

### (c) Deliberate aliases — two names, one accountable bot, on purpose

These are not mistakes, and the integrity check already calls two of them out as intentional.

- **communications-bot `b0000000-…-0001`** — `switchboard`, `social` and `email-summarizer` each
  declare it explicitly, by the same id, in their own `bots:` array. All three are installed store
  packages with install records.
- **vids-operator `b00e0000-…-0001`** — `vids` and `creative-studio` each declare it in `bots:`;
  `video` declares it as its third bot alongside `video-director` (`…-0048`) and `screenplay-writer`
  (`…-0052`); `daily-trade-recap` picks it up through `workflow.workerBot: vids-operator`.
- **career-hunter `cb000000-…-0001`** — `career-hunter` declares it; `job-apply` has no `bots:` and
  binds `workflow.workerBot: career-hunter` (pipeline `job-apply`). The integrity check names this
  one: "job-apply rides career-hunter".
- **rca-specialist `a0000000-…-0016`** — `swarm-apps/intelligent-processing.yaml` line 65 declares
  `workerBot: rca-specialist` with no `bots:` of its own; `intelligent-operations` owns it.

### (d) Stale rows for manifests that no longer exist

`issue-rca` and `incident-remediation` are both `status=inactive` with `manifest_path` under
`/app/swarm-apps/`, and neither file exists in the tree or the image. `issue-rca` declares all three
of `intelligent-operations`' bots at the identical ids — it is that app's pre-carve predecessor,
last updated 2026-06-18, the same minute `intelligent-operations` was loaded. `incident-remediation`
declares `incident-remediation-bot` at `intelligent-operations`' id, last updated 2026-06-18.

## Blast radius

### The mechanism

`canReadProtectedResult` ([`src/shared/protected-results/index.ts`](../../src/shared/protected-results/index.ts))
answers, for a task with no recorded protected executions and no durable results — the ordinary case:

```ts
if (!executions.length && !durable) return !(task.agentId && authority && await authority.isProtectedAgent(task.agentId));
```

`isProtectedAgent` calls the ownership reader. On `Ambiguous package ownership` it throws, the
function's own `catch { return false; }` takes it, and the caller sees a plain "not readable". Four
surfaces consume that answer:

| caller | effect of `false` |
|---|---|
| `ticket-routes.ts:163` (`GET /api/tickets` listing) | the ticket is **silently dropped from the list** — no log line names the drop |
| `ticket-routes.ts:80` (`GET /api/tickets/:id`) | `404 Ticket not found`, with a `Ticket access denied` warn |
| `src/app/routes/jarvis-result-access.ts` | the Jarvis thread/result is refused |
| `src/app/routes/protected-result-persistence.ts` | `protected_result_unavailable` on write-back |

### What is actually firing

Since the 06:46:14Z boot, `docker logs oshal-local-api | grep -c 'application execution ownership
read failed'` = **682**, and **all 682** carry `"message":"Ambiguous package ownership"` — zero
type errors remain, which is the fix working. Every stack is the same one: `isProtectedAgent` →
`canReadProtectedResult` → `Promise.all` → `ticket-routes.js:150`, i.e. the ticket listing.

Only **6 of the 12** ids appear:

| agent id | refusals since boot | tickets on that id | `chat_tasks` on that id |
|---|---|---|---|
| `b0000000-…-0001` communications-bot | 206 | 2 (operator-owned) | 196 |
| `cb000000-…-0001` career-hunter | 204 | 4 (operator-owned) | 107 |
| `a0000000-…-0003` code-reviewer | 102 | 7 (4 unowned, 3 operator) | 43 |
| `c1de0000-…-0001` capability-ideator | 68 | 0 | 2 |
| `b00e0000-…-0001` vids-operator | 68 | 0 | 8 |
| `a0000000-…-0016` rca-specialist | 34 | 0 | 163 |

(4542 tickets in total; the listing indices in the stacks run past 2400, so these are operator
`scope=all` listings.)

### The three the operator asked about

- **`career-hunter` / `job-apply` — LIVE, and the largest real one.** 204 refusals since boot, and
  the four tickets behind them are operator-owned, so they are being dropped from the operator's own
  ticket list right now and would 404 if opened by id. 107 `chat_tasks` sit on the same bot. This is
  also class (c): the sharing is deliberate and correct, which is why it cannot be fixed by removing
  a squatter.
- **The creative cluster (`vids-operator`, with `daily-trade-recap`) — LIVE but small.** 68 refusals
  since boot, zero tickets and 8 `chat_tasks`. Recap runs are refused at the protected-result
  boundary, but there is no ticket backlog behind it.
- **`identity` / `trading` — no measured impact today, and not inert either.** `a0000000-…-0045`
  produced **zero** of the 682 refusals; it carries 0 tickets and 1 `chat_task`. But
  `identity-advisor` is an active bot inside an active, installed package, so any protected read for
  it refuses the moment one happens. Stated plainly: nothing of the operator's is being lost on this
  id today, and the fix for it is the cheapest of the twelve (`trading` is inactive, its manifest
  file is gone, and it never legitimately owned that uuid).

### Genuinely inert

`a0000000-…-0002`, `a0000000-…-000b`, `a0000000-…-0051`, `b00f0000-…-0001` and `e0000000-…-0100`
produced zero refusals since boot. `…-0002`'s 38 tickets all carry `owner_sub` NULL, so a
non-operator listing (hard-scoped to `ownerSub = callerSub`) never puts them in `candidates`.
`…-0051`'s single ticket belongs to `mock-user-001`. `b00f0000-…-0001` and `e0000000-…-0100` have no
tickets. They are still real ambiguities and would refuse if read — they simply are not being read.

Nothing here reaches the trading surfaces: `intelligent-trades` owns `trading-analyst`
(`a0000000-…-0046`) uniquely and does not appear in the census.

## What the integrity check says

`bash scripts/swarm-app-bot-integrity-check.sh` — **RESULT: PASS**, exit 0. Every active app's
primary bot is registered and active; nothing is BROKEN. It lists 13 advisory REVIEW findings, which
are the same collisions seen from the other direction (an app whose `agent_ids[1]` is stamped to
another app), and it is explicit that some are intentional shares. It does not see `identity`/
`trading` or `intelligent-operations`/`issue-rca`, because it only inspects `agent_ids[1]` of
**active** apps and both squatters there are inactive. That gap is why this census queries the whole
array across both ownership tables.

## Proposed resolution — not performed

The resolution is not a single sweep, because the twelve are three different problems and only one
of them is "delete the squatter".

1. **Classes (a) and (d) — 7 ids** — uninstall the seven loose publish artifacts and the two stale
   rows. No app loses a bot: every one of them is *borrowing* a core bot it never declared.
2. **Class (b) — 2 ids** — `trading` and `brand-graphics` pinned uuids they do not own. `trading`'s
   manifest no longer exists anywhere, so its row is the whole artifact; `brand-graphics` needs its
   `bots[0].agentId` corrected in the store repo and reinstalled.
3. **Class (c) — the rest** — these are correct as designed and must not be "fixed" by editing
   manifests. Either the reader stops treating an association column as an ownership column, or
   ownership is declared separately from association. That is a core change and an ADR-level
   decision.

**Who decides:** the operator. Steps 1 and 2 uninstall or edit installed applications on the
operator's own box; step 3 touches the ADR-149 authorization core, which is load-bearing. The
done-when criteria are in [BACKLOG.md](../BACKLOG.md).
