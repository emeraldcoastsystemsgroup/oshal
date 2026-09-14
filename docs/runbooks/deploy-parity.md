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
