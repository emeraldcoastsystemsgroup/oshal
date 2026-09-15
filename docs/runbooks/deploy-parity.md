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
| `bot-role-grant` | `has_table_privilege('oshal_bot','public.oshal_authorization_applications','SELECT')` is true | `scripts/governance/provision-app-role.mjs` re-converges `oshal_bot` to an exact allowlist on every api boot, and that allowlist does not contain this table — so migration 140's grants are stripped at boot and **every** Jarvis ask answers `503 authorization_bot_posture_unavailable` until someone re-applies them by hand. |
| `jarvis-ask` | Jarvis answers one fixed question **as the operator**, on a fresh thread | The reasoning rail is the product. A time-boxed PAT is minted inside the api container with the service secret already in its environment, used on loopback, and revoked by id; the thread is closed afterwards. The token and the operator subject are never printed. |
| `ticket-dispatch` | one synthetic `task` ticket leaves `approved` without landing in `escalated`/`dead_letter`/`failed` | `task` is a built-in `manifest-worker` workflow, so it exercises the exact dispatch path that failed, on every box, with no manifest-registration race. The ticket is cancelled and deleted whatever the verdict. |

Each check prints one `VERIFY PASS` / `VERIFY FAIL` line; a failure prints the remedy underneath it,
including the exact re-apply command for the missing grant.

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
ticket's workflow (`task`); `OSHAL_VERIFY_BUDGET_MS` (default 300000) bounds both polls;
`OSHAL_VERIFY_QUESTION` sets the Jarvis question.

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
