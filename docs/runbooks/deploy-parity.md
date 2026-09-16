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
recreation, worker batching, kernel-skill verification, rollback and parity gates
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
**guard:** `tests/unit/deploy-live-verification.spec.ts`

Every other gate in `scripts/oshal-deploy.sh` measures the **stack**: containers healthy, image
parity clean, `/health` 200, zero unhealthy. On 2026-09-15 all of them were green, the run printed
`DEPLOYED`, and the **product** was down in two places at once — Jarvis answered nothing, and a
ticket the operator raised at 00:51Z escalated with `manifest_worker_dispatch_failed` /
`authorization_recorded_delegation_required` in its status-history metadata instead of being
worked. These three checks run last, after the health/parity/census gates, and their verdict
decides whether `DEPLOYED` is printed at all.

| Check | What it asserts | Why |
|---|---|---|
| `bot-role-grant` | `has_function_privilege('oshal_bot','public.oshal_application_execution_claims(text,text,text,boolean)','EXECUTE')` is true | The ADR-149 posture guard every bot node runs asks one question — which application claims this bot, and is it protected — and fails closed on any error, so **every** Jarvis ask answers `503 authorization_bot_posture_unavailable` when it cannot ask it. `scripts/governance/provision-app-role.mjs` re-converges `oshal_bot` onto an exact allowlist on every api boot; that allowlist carries the migration-142 helper and deliberately **not** the tables behind it (which is why the direct table grants of the removed migration 140 were stripped at every boot). A missing `EXECUTE` here therefore means the provisioner did not run or did not reach its final phase — not that something stripped it. |
| `jarvis-ask` | Jarvis answers one fixed question **as the operator**, on a fresh thread | The reasoning rail is the product. A time-boxed PAT is minted inside the api container with the service secret already in its environment, used on loopback, and revoked by id; the thread is closed afterwards. The token and the operator subject are never printed. |
| `ticket-dispatch` | one synthetic `task` ticket, **pinned to the workflow's declared owner**, leaves `approved` without landing in `escalated`/`dead_letter`/`failed` | `task` is a built-in `manifest-worker` workflow, so it exercises the exact dispatch path that failed, on every box, with no manifest-registration race. The pin (`metadata.targetAgentId`, resolved by name through `GET /api/agents`) is what makes the target a **dedicated bot node**: unpinned, a `task` ticket routes by the ADR-083 call-out and lands on whichever knowledge owner wins the bid, which on 2026-09-15/16 was an INLINE bot — and signed delegation refuses every inline target outright (`Signed HTTP delegation requires a dedicated bot-node endpoint`). The ticket is cancelled and deleted whatever the verdict. |

Each check prints one `VERIFY PASS` / `VERIFY FAIL` / `VERIFY UNVERIFIED` line; anything that is not
a pass prints the remedy underneath it, including the exact re-apply command for the missing grant
(`scripts/migrations/142-application-execution-claims-helper.sql`, then the role provisioner).

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
fail the deploy. It is not a pass either: the run log says
`N check(s) NOT VERIFIABLE from automation - this deploy is UNPROVEN as a product`. **Any** other
refusal is still `VERIFY FAIL` and still exit 4 — including this same refusal when an operator token
*was* supplied, because then the supplied token is the thing at fault.

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
checks are answerable under delegation signing (see `VERIFY UNVERIFIED` above).

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
