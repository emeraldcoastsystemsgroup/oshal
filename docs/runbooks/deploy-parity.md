# Deploy parity — keep the api and bot containers on the same image build

**Script:** [`scripts/deploy-parity-check.sh`](../../scripts/deploy-parity-check.sh)

## Why this exists

The api and every bot-node run the **same** image (`oshal-bot:latest`); which process starts is decided
at container boot by `BOT_RUNTIME` ([CLAUDE.md](../../CLAUDE.md) "Two runtimes, one image"). When
concurrent sessions retag `:latest` at different times and recreate **only some** containers, the api
and bots drift onto **different builds**. A two-half feature — the writer half in a bot, the reader
half in the api (or vice versa) — then ships **split**: tickets complete, nothing the other half
expects is persisted, and every delayed job silently shows fallback output. This bit the stack on
2026-07-10 (weather "produced no readable output"). The parity check makes that drift loud instead of
silent.

## Run it after any recreate

```bash
bash scripts/deploy-parity-check.sh
```

- Prints the api's reference build, how many bot-nodes are in parity vs drifted, the distinct builds in
  play, and — on drift — every straggler by name with its build time and the exact recreate command.
- **Exit codes:** `0` = all in parity · `1` = drift detected · `2` = environment error (docker down,
  no api container running).
- `--quiet` prints nothing unless there is drift (used by `oshal-up.sh`).

`scripts/oshal-up.sh` runs it automatically (advisory) at the end of an ordered bring-up, so a fresh
`oshal-up` surfaces drift immediately.

## Fixing drift

For an operator-authorized local preview of a feature awaiting PR review, use the
same verified deployment command with `--preview`:

```bash
bash scripts/oshal-deploy.sh --preview
```

Commit and push first. The branch must track its same-named branch on `origin` and
match a fresh fetch exactly. Detached, unpublished, remote-diverged and fetch-failed
previews are refused. `--allow-unpushed` cannot be combined with preview mode.
The build archives the captured commit even if the shared checkout advances, and
the image label must match it even with `--skip-build` or `--dry-run`. API-first
recreation, worker batching, kernel-skill verification, the Cline fallback entrypoint
probe (`scripts/check-cline-entrypoint.mjs --image`, see
[cline-fallback-entrypoint.md](cline-fallback-entrypoint.md)), rollback and parity gates
remain in force. Default releases use `main`; previews confer no merge approval.

The source-admission regressions use temporary local Git repositories and invoke
no Docker commands. Readiness regressions drain synthetic startup logs and retain
failure on missing startup markers or failed log reads. These and the rollback outcome checks are registered in the
Installed application test registration card and `npm run test:platform-readiness`.

Recreate the stale containers from the **same** build the api runs:

```bash
docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps <stale names>
```

or bring the whole stack up in order (infra → api → bots), which rebuilds parity:

```bash
bash scripts/oshal-up.sh
```

Root cause is usually a `:latest` retag between recreates — see the deploy notes in
[CLAUDE.md](../../CLAUDE.md) ("api+bots share dist — recreate BOTH from the SAME build").

## Post-deploy live verification — a deploy is not finished until Jarvis answers and a ticket moves

**Library:** [`scripts/lib/deploy-verify.sh`](../../scripts/lib/deploy-verify.sh) ·
**loopback probe:** [`scripts/operations/deploy-live-verification.js`](../../scripts/operations/deploy-live-verification.js) ·
**guards:** `tests/unit/deploy-live-verification.spec.ts` (the three checks) and
`tests/unit/deploy-verify-exit-contract.spec.ts` (what a deploy does with their verdicts)

Every other gate in `scripts/oshal-deploy.sh` measures the **stack**: containers healthy, image
parity clean, `/health` 200, zero unhealthy. On 2026-09-15 all of them were green, the run printed
`DEPLOYED`, and the **product** was down in two places at once — Jarvis answered nothing, and a
ticket the operator raised at 00:51Z escalated with `manifest_worker_dispatch_failed` /
`authorization_recorded_delegation_required` in its status-history metadata instead of being
worked. These three checks run last, after the health/parity/census gates, and their verdict
decides whether `DEPLOYED` is printed at all.

| Check | What it asserts | Why |
|---|---|---|
| `bot-role-grant` | `has_function_privilege('oshal_bot','public.oshal_application_execution_claims(text,text,boolean)','EXECUTE')` is true | The ADR-149 posture guard every bot node runs asks one question — which application claims this bot, and is it protected — and fails closed on any error, so **every** Jarvis ask answers `503 authorization_bot_posture_unavailable` when it cannot ask it. `scripts/governance/provision-app-role.mjs` re-converges `oshal_bot` onto an exact allowlist on every api boot; that allowlist carries the migration-142 helper and deliberately **not** the tables behind it (which is why the direct table grants of the removed migration 140 were stripped at every boot). A missing `EXECUTE` here therefore means the provisioner did not run or did not reach its final phase — not that something stripped it. |
| `jarvis-ask` | Jarvis answers one fixed question **as the operator**, on a fresh thread | The reasoning rail is the product. A time-boxed PAT is minted inside the api container with the service secret already in its environment, used on loopback, and revoked by id; the thread is closed afterwards. The token and the operator subject are never printed. |
| `ticket-dispatch` | one synthetic `task` ticket, **pinned to the workflow's declared owner**, leaves `approved` without landing in `escalated`/`dead_letter`/`failed` | `task` is a built-in `manifest-worker` workflow, so it exercises the exact dispatch path that failed, on every box, with no manifest-registration race. The pin (`metadata.targetAgentId`, resolved by name through `GET /api/agents`) is what makes the target a **dedicated bot node**: unpinned, a `task` ticket routes by the ADR-083 call-out and lands on whichever knowledge owner wins the bid, which on 2026-09-15/16 was an INLINE bot — and signed delegation refuses every inline target outright (`Signed HTTP delegation requires a dedicated bot-node endpoint`). The ticket is cancelled and deleted whatever the verdict. |

Each check prints one `VERIFY PASS` / `VERIFY FAIL` / `VERIFY UNVERIFIED` line; anything that is not
a pass prints the remedy underneath it, including the exact re-apply command for the missing grant
(`scripts/migrations/158-narrow-application-execution-claims-helper.sql`, then the role provisioner).

### `VERIFY UNVERIFIED` — the third state, and why it is not a pass

There is exactly one thing this gate structurally cannot do for itself, and pretending otherwise
made it permanently red on 2026-09-15 and 2026-09-16.

The probe asks as a PAT it mints inside the api container from `SWARM_SERVICE_SECRET`. That mint
records **no principal issuer**, on purpose: every bot container carries the fleet-wide service
secret, so treating it as proof of an identity-provider namespace would let one injected bot assert
any user's identity namespace (`src/app/routes/cli-token-routes.ts` — "a service-secret assertion is
not proof of an IdP namespace"). With `OSHAL_DELEGATION_SIGNING_KID` +
`OSHAL_DELEGATION_SIGNING_PRIVATE_KEY` configured on the controller, `resolveDelegatedPrincipal`
(`src/features/agent-management/services/bot-node-client.ts`) therefore refuses a user-bound
delegation raised under that PAT with `User-bound delegation requires a verified principal issuer` —
for the Jarvis ask **and** for the queued dispatch. That refusal is the authorization rule working.

So that refusal — and *only* that refusal, and only when signing is configured, and only on the PAT
the check minted for itself — prints `VERIFY UNVERIFIED`, counts in its own bucket, and does **not**
fail the deploy *immediately*. It is not a pass either: the run log says
`N check(s) NOT VERIFIABLE from automation - this deploy is UNPROVEN as a product`. **Any** other
refusal is still `VERIFY FAIL` and still exit 4 — including this same refusal when an operator token
*was* supplied, because then the supplied token is the thing at fault.

#### With `OSHAL_VERIFY_OPERATOR_PAT` set, there is no third state

**A check that has a token either passes or fails.** With `OSHAL_VERIFY_OPERATOR_PAT` non-empty in the
shell that runs the gate, `VERIFY UNVERIFIED` is unreachable for `jarvis-ask` and `ticket-dispatch` —
the gate refuses it and prints `VERIFY FAIL` instead. That rule is enforced twice on purpose, because
the two sides can disagree:

- the **probe**, inside the container, refuses to classify its way to "not verifiable" when it
  *received* a token (`classifyVerdict`); and
- the **gate**, in the deploy's own shell, refuses a "not verifiable" answer when it *sent* one.

Those are different facts, and the gap between them is reachable. `${!OSHAL_VERIFY_@}` enumerates
non-exported shell variables too, so `OSHAL_VERIFY_OPERATOR_PAT=abc` **without `export`** is forwarded
as a bare `-e OSHAL_VERIFY_OPERATOR_PAT`, docker resolves that name against *its own* environment,
finds nothing, and the probe mints a service-secret PAT and refuses exactly as if no token had been
supplied. Only the shell can see that, so only the shell can refuse it. When it does, the remedy names
both causes and puts the free one first:

```bash
export OSHAL_VERIFY_OPERATOR_PAT          # (b) it never reached the container - check this first
```

If that is already done, the cause is (a): the token carries no verified principal issuer, i.e. it was
not minted from a signed-in session. Mint a new one the way the next section shows.

**To verify it for real**, hand the gate an identity that carries a verified issuer. Only a mint made
from a signed-in session records one, so from a browser already logged into the cockpit:

```js
// browser console on the cockpit origin, signed in
await (await fetch('/api/cli-tokens', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'deploy-verify' }) })).json()
```

```bash
export OSHAL_VERIFY_OPERATOR_PAT='<the token from that response>'
bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'
```

That token is used as-is and **never revoked** by the gate (it is the operator's own credential), and
it is forwarded into the container by `docker exec -e NAME` with no `=value`, so it never appears in
a command line, in `ps`, or in the run log. Every `OSHAL_VERIFY_*` variable exported by the caller is
forwarded the same way — the probe reads its knobs from the environment of the process it runs in,
which is the api container, not the shell that started the deploy.

### When nothing proves the product: the unproven streak, and `exit 5`

`VERIFY UNVERIFIED` used to return 0 forever. Between 2026-09-15 and 2026-09-16 it printed on **every**
deploy, in the same words each time, while Jarvis answered `503` to every ask and a real `task` ticket
landed in `escalated` — and each of those runs still ended `DEPLOYED … parity clean, 0 unhealthy`. A
verdict with no consequence is not a gate, and a sentence that never changes its wording is wallpaper.

So an unproven run now escalates. The gate appends **one line per completed run** to a ledger and counts
consecutive unproven runs back from it — the same shape `scripts/ci/ci-gate-streak.mjs` uses for the
nightly gate, where the history is a *parse* of the log the tool already writes rather than new state:

```
~/.oshal-deploy/live-verify.log      # or $OSHAL_DEPLOY_STATE, or $OSHAL_VERIFY_LEDGER

2026-09-16T18:22:41Z UNPROVEN unverified=2
2026-09-16T18:40:03Z PROVEN
2026-09-16T18:55:12Z FAILED failed=1
```

| consecutive unproven runs | what the gate does |
|---|---|
| 1 | prints `UNPROVEN on 1 consecutive run(s) … 2 more before this FAILS the deploy`; returns 0 |
| 2 | same line, `1 more`; returns 0 |
| **3** | prints `the grace for that is SPENT - FAILING this deploy`; returns 3 → the deploy **exits 5** |

Three consecutive runs is the whole grace. One unproven run is a notice; by the third it is a standing
condition, and on this box's deploy cadence three lands inside a day. A `PROVEN` run resets the streak,
and so does a `FAILED` one — a failed run already exits non-zero, so it needs no escalation. A run
skipped with `OSHAL_DEPLOY_SKIP_LIVE_VERIFY` records **nothing**: it measured nothing, so it neither
grows nor resets the streak.

**The grace is a constant in `scripts/lib/deploy-verify.sh`, not an environment variable.** There is
deliberately no knob that widens it, because a knob that defuses a gate is the knob that gets used to
defuse the gate. The one switch there is only tightens it:

```bash
OSHAL_VERIFY_REQUIRE_PROOF=1 bash scripts/oshal-deploy.sh   # exits 5 on the FIRST unproven run
```

That is the **intended steady state** once an operator PAT exists on the box. Until then the grace is
what keeps the gate from being permanently red for something no process on the box can fix.

If the ledger cannot be written (a read-only `$HOME`, say) the run says so —
`the unproven streak cannot escalate` — and still returns 0. A gate that goes red because a log file is
unwritable is a gate nobody can act on; but without the ledger the escalation is frozen at its first
rung, so it must never be silent about it.

### `exit 4` and `exit 5`: proved broken vs never proved

Both mean the same thing about the stack: **the new image is live, serving, and deliberately not rolled
back.** They mean opposite things about the product, and they demand different actions.

| exit | meaning | what to go do |
|---|---|---|
| `4` | the product is **proved broken** — a check FAILED | fix the named check; re-verify without redeploying |
| `5` | the product was **never proved** — unproven past the grace | give the gate an identity it can prove the product with |

`exit 5` is not a softer `exit 4`. Nothing on the box is known to be broken *and nothing is known to
work*; what is missing is proof, and only a signed-in operator session can mint the identity that
supplies it. `src/features/dev-console/services/deploy-promoter.ts` decodes both as
`stackServing: true, needsHands: false` — an operator sent to `oshal-up.sh` for a stack that is already
up would be the exact inversion its exit-code contract exists to prevent.

### `exit 6`: deployed and serving, but the api did not live through the bot recreate

On 2026-09-05 the api process exited inside the bot recreate: the storm starved its event loop, a
transaction idled past Postgres's `idle_in_transaction_session_timeout`, the termination reached a
checked-out pg client that nothing owned, and the crash guards exited the process. Docker restarted
it, it was healthy 40 s later, and the run printed DEPLOYED over about a minute of downtime that only
the container's RestartCount recorded.

`scripts/api-storm-probe.sh` now makes that a named outcome. `begin` snapshots the api container's
RestartCount and the clock just before the recreate; after the census gate, `verify` reads the
RestartCount again and counts `idle-in-transaction` lines in the api log inside that window. Either
being non-zero is **exit 6**: the new image is live and serving, nothing is rolled back (the downtime
already happened, and a rollback would only run the storm again), and the run does not say DEPLOYED.
The promoter decodes it as `deployed-api-restarted` — `stackServing: true, needsHands: false`.

What to go do: read the restart. The `since` value is on the deploy's `api-storm-probe` line:

```bash
docker logs --since <since> oshal-local-api 2>&1 | grep -i -E 'UNCAUGHT|idle-in-transaction'
```

A terminated checked-out connection is logged by `src/shared/services/database/pool-connection-errors.ts`
with the backend pid, and the call site's own catch logs the statement that then rejected — together
they name the transaction. The recreate pacing (`OSHAL_UP_BATCH_SIZE` / `OSHAL_UP_BATCH_SETTLE`) is
printed on the "recreating N bots" line, so the log states what the run relied on. The probe runs
standalone over any window: `bash scripts/api-storm-probe.sh begin`, then
`bash scripts/api-storm-probe.sh verify <restarts> <since>`.

### Exit 4: deployed and serving, but the product is down

A verification failure is **exit 4** and is deliberately **not** rolled back. The new image is
already live and serving; returning to the previous one would add a version surprise to a product
outage, and the previous image is not the cause of a stripped grant or an undispatched ticket. Fix
the named check, then re-verify without redeploying:

```bash
bash -c 'source scripts/lib/deploy-verify.sh && oshal_deploy_post_verify'
```

#### The gap: exit 4 leaves a bad image running, including when the image is the cause

Be clear about what this policy does and does not cover. The no-rollback rule is right for the
failure it was built for — a stripped `oshal_bot` grant is the boot-time provisioner's doing and has
nothing to do with which image is running, so rolling back would cure nothing. But the policy is
**blanket**, and the other case is real: if the image you just deployed is *itself* what broke Jarvis
or ticket dispatch — a genuine regression, which is precisely what this gate exists to catch — the
run reports exit 4 and **leaves that broken image live and serving**, even though a rollback would
have cured it.

It is blanket on purpose. The gate observes that the product is down; it cannot attribute *why*, and
an automatic revert of the operator's running box on an unattributed product failure is a worse
default than a loud refusal — it would fire on every stripped-grant boot, which is the common case.

So **recovering from an image-caused break is a manual rollback, and nothing does it for you.** The
pre-deploy image is still tagged from that run:

```bash
docker tag oshal-bot:deploy-rollback oshal-bot:latest   # the image the deploy anchored at preflight
bash scripts/oshal-up.sh                                # ordered bring-up onto it (api, then bots)
bash scripts/deploy-parity-check.sh                     # proves api + bots actually landed on it
```

Then re-run the verification above against the restored image. If it passes, the image you deployed
was the cause and the change needs fixing before it ships again; if it still fails, the cause is on
the box, not in the image, and `exit 4` was already telling you where to look.

### The one skip switch

```bash
OSHAL_DEPLOY_SKIP_LIVE_VERIFY=1 bash scripts/oshal-deploy.sh
```

`OSHAL_DEPLOY_SKIP_LIVE_VERIFY=1` is the **only** switch that skips these checks, and it exists for
one case: a deployment that carries no operator identity to ask Jarvis a question as (empty
`OSHAL_OPERATOR_SUBS`). There is deliberately no per-check switch — three separate skips is how a
gate rots. A skipped run says so out loud and calls itself `UNVERIFIED as a product`.

If the api container is missing the helper, the deploy **refuses at preflight** (exit 2) rather than
quietly skipping.

### Tuning knobs (defaults are what a deploy uses)

`OSHAL_VERIFY_DB_CONTAINER` / `OSHAL_VERIFY_API_CONTAINER` / `OSHAL_VERIFY_DB_USER` /
`OSHAL_VERIFY_DB_NAME` name the containers and role; `OSHAL_VERIFY_TICKET_TYPE` picks the synthetic
ticket's workflow (`task`); `OSHAL_VERIFY_TICKET_WORKER` names the bot that ticket is pinned to
(`general-bot` — it must be one the registry marks `requiresOwnNode`, or signed delegation refuses it
as inline); `OSHAL_VERIFY_BUDGET_MS` (default 300000) bounds both polls; `OSHAL_VERIFY_QUESTION` sets
the Jarvis question; `OSHAL_VERIFY_OPERATOR_PAT` supplies a session-minted token so both product
checks are answerable under delegation signing (see `VERIFY UNVERIFIED` above) — **`export` it**, it is
forwarded into the container by name; `OSHAL_VERIFY_REQUIRE_PROOF=1` removes the unproven grace
entirely; `OSHAL_VERIFY_LEDGER` moves the run ledger off
`${OSHAL_DEPLOY_STATE:-~/.oshal-deploy}/live-verify.log` (the guard uses it to give each case an
isolated streak). There is no variable that *widens* the grace — see above for why.

### What a deploy leaves behind

Nothing on the board, and nothing in `chat_tasks`. Both checks remove what they wrote:

| Check | Writes | Removed by |
|---|---|---|
| `jarvis-ask` | a `deploy-verify-*` thread — a `chat_tasks` row, its `chat_messages`, and the chat-ticket the ask opens | `POST /api/jarvis/thread/close`, then `DELETE /api/tickets/<chatTicketId>` (the id comes back on the ask itself), then `DELETE /api/tasks/<sessionId>`, which takes the row and its messages |
| `ticket-dispatch` | one synthetic `task` ticket | `PUT /api/tickets/<id>/cancel`, then `DELETE /api/tickets/<id>` |

The thread id is **fresh every run and never reused**, so none of this meets the bookmarked-thread
refusal in [jarvis-couldnt-do-that-just-now.md](./jarvis-couldnt-do-that-just-now.md) — that refusal
is about *appending to* a thread from a different issuer, and nothing here appends to an old one. A
refused ask is cleaned up too: `ensureSessionTask` writes the thread's row *before* the ownership
gate, so a failed check would otherwise leak a row on exactly the deploys this gate is built to fail.

A cleanup step that does not return 2xx prints `CLEANUP FAILED: <request> -> <outcome>; <what was
left behind>` into the run log. It cannot change the check's verdict — cleanup runs after the verdict
is decided — so `grep 'CLEANUP FAILED' "$RUN_LOG"` is the only way a leak becomes visible. Act on it:
each line names the row or card still on the box.

**The one thing deliberately kept** is the cost ledger. The `oshal_cost_events` row for the Jarvis
call has no foreign key to `chat_tasks` and is not deleted — it is the record of real spend, and
deleting it would understate what the box costs.

### What a deploy spends

These checks are not free, and that is inherent to proving the product works rather than the stack:

- **one real Jarvis turn** against the live brain — a real LLM call on the operator's account, billed
  and recorded in the `oshal_cost_events` ledger like any other ask (the thread's `chat_tasks` rollup
  row goes with the thread when it is cleaned up; the per-event ledger row is what survives); and
- **one real ticket dispatch** — a synthetic `task` ticket genuinely picked up by the queue manager
  and handed to `manifest-worker`, which may itself spend before the ticket is cancelled and deleted.

**Worst case a deploy gets ~10 minutes slower before failing.** The two checks run sequentially and
each polls to `OSHAL_VERIFY_BUDGET_MS` (default 300000 ms), so a Jarvis that never answers followed by
a ticket that never moves is 5 + 5 minutes before the run fails closed with exit 4. Lower
`OSHAL_VERIFY_BUDGET_MS` on a box where that matters more than the diagnosis.
