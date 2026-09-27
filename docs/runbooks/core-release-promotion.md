# Core release promotion — cut once, promote the same image, roll back in one command

**Decision:** [ADR-167](../adr/167-core-release-identity-and-promotion.md).
**Commands:** [`cut-release.sh`](../../scripts/core-promote/cut-release.sh),
[`promote.sh`](../../scripts/core-promote/promote.sh),
[`core-drift-check.sh`](../../scripts/core-promote/core-drift-check.sh), and the on-box
[`managed-core-release.sh`](../../scripts/managed-core-release.sh), which `promote.sh` drives over SSH.

This runbook is for a **managed box**: a box that runs `scripts/managed-postgres-compose.sh <env> up`
from a root-owned release directory, with a root-owned `0600` env file. It covers core only.

| You are updating | Use |
|---|---|
| the dev box | `bash scripts/oshal-deploy.sh` ([deploy-parity.md](deploy-parity.md)). Never on a customer box: it would start the whole bot fleet. |
| a store package | the package's own `deploy.js` |
| core on a managed box | this runbook |

A box is **at** a release when `GET /api/version` reports it:

```json
{"name":"oshal","version":"2.1.0-beta.1","commit":"<40-hex>","release":"core-2026.09.28"}
```

`release` is `null` for any image that was not cut as a release.

## One-time setup

**On the operator's machine**, write one target file per box:
`~/.oshal-core-release/targets/<name>.conf`. `promote.sh` reads it line by line and never
sources it. Every value is checked against a strict pattern, because it reaches a remote shell.

```ini
SSH_DEST=root@192.168.50.20
RELEASE_ROOT=/opt/customer/oshal
ENV_FILE=/opt/customer/crm-production.env
CHANNEL=production
# optional
SSH_KEY=/home/user/.ssh/customer_ed25519
SSH_PORT=22
```

SSH is key-based and runs as root. A passphrase-protected key needs `ssh-agent` or `SSH_ASKPASS`
in the shell that runs `promote.sh`, because the script does not prompt.

**On each box**, declare the box's channel once in its env file:

```bash
echo 'OSHAL_RELEASE_CHANNEL=production' >> /opt/customer/crm-production.env   # staging on the staging box
```

The on-box helper refuses a box that declares no channel. It also refuses a promote whose target
names a different channel, which is the guard against sending a release to the wrong droplet.
The staging target must itself be a managed box, because the helper runs only there.

## 1. Cut the release (operator machine)

Cut from a clean checkout. The probes run from that checkout's own scripts.

```bash
bash scripts/core-promote/cut-release.sh --dry-run          # the plan; builds nothing
bash scripts/core-promote/cut-release.sh --push-tag         # the published origin/main tip
bash scripts/core-promote/cut-release.sh --sha <commit> --push-tag
```

The script works through these steps:

1. It builds `oshal-bot:sha-<commit>` and `oshal-bot:<release>` once, from `git archive <commit>`,
   stamped with `GIT_SHA`, `OSHAL_RELEASE` and the commit label. `oshal-bot:latest` is not touched.
2. It verifies the image with the commit and release labels and the kernel-skills and
   cline-entrypoint probes. These are the same probe scripts `oshal-deploy.sh` runs. A missing
   probe refuses rather than skips.
3. It writes the record `~/.oshal-core-release/records/<release>.json`, which holds the commit and
   the image ID.
4. It creates the annotated tag `core-YYYY.MM.DD`. A later cut the same day gets `.2`, `.3` and so
   on. `--push-tag` publishes the tag. A box's promote requires the published tag.

The script refuses, and builds nothing, in these cases:

- modified tracked files;
- a commit that is not on `origin/main`;
- a commit that already has a release;
- a malformed or already-taken name.

A red probe or a failed build leaves no record and no tag.

| Exit | Meaning |
|---|---|
| 0 | Cut: built, verified, recorded and tagged. |
| 1 | The build or image verification failed. There is no record and no tag. |
| 2 | Preflight refusal. Nothing was built. |
| 4 | Cut and recorded, but the tag push failed. The command to push it is printed. |

Keep the cut image on this engine until production has it. A pruned artifact refuses to promote.

## 2. Promote to staging

```bash
bash scripts/core-promote/promote.sh --target staging --release core-2026.09.28
# first promote on a box whose release dir predates the helper:
bash scripts/core-promote/promote.sh --target staging --release core-2026.09.28 --bootstrap
```

`promote.sh` never builds on the box. It checks that this machine still holds the cut image ID. It
then streams `docker save | gzip | ssh … docker load`, and checks that the box now holds exactly
that image ID. If the box already holds it, nothing is streamed. If the box holds a *different*
image under the same tag, the promote is refused.

It then runs the box transaction, `managed-core-release.sh <env> promote …`, as root on the box.
The box transaction first refuses unless all of these hold:

- the loaded image's ID and labels are the release;
- the channel matches;
- the release dir is clean and agrees with the pinned image;
- the commit is on `origin/main`;
- the release tag is published on that commit.

If none of those refuse, it runs these steps in order:

1. **`pg_dump --format=custom`** to `/var/lib/oshal/core-release/<deployment-id>/dumps/pre-<txn>.dump`.
   The dump runs in the PostgreSQL image the managed override already pins. It connects with
   `BOOTSTRAP_DATABASE_URL`, which is staged in a root-only file and removed straight afterwards.
   A failed dump refuses the promote, and nothing is changed.
2. Appends a `begin` line to `history.tsv`, **before** any change.
3. `git checkout --detach <commit>` in the release dir.
4. Repoints `OSHAL_BOT_IMAGE=oshal-bot:sha-<commit>` atomically, as a rewrite beside the file and
   a rename over it.
5. `managed-postgres-compose.sh <env> up`: the launcher's own migration/RLS gate and topology
   checks.
6. Verifies that the running api is on that image ID, and that `/api/version` reports that commit
   and release.

A failure after the dump restores the previous checkout and pin, runs `up` again and verifies the
previous state. Only a verified exit 0 writes the staging receipt
`~/.oshal-core-release/records/<release>.staging.json`.

`--bootstrap` copies the helper and its library from the release commit's own git objects into
`<release dir>/.release-bootstrap`. It runs the transaction from there and deletes the directory
afterwards. After that first promote the release dir holds the helper under `scripts/`.

## 3. Promote to production

```bash
bash scripts/core-promote/promote.sh --target production --release core-2026.09.28
```

This works like staging, with one extra refusal. Production refuses a release whose staging receipt
is missing, or whose receipt names a different image ID. That ensures production only receives
bytes that staging ran.

`--registry ghcr.io/emeraldcoastsystemsgroup/oshal-bot` makes the box pull
`<repo>@sha256:<digest>` instead of streaming the image. It works only when this machine's copy
of that exact image carries that repository digest. That is the case after the image was pushed
from here, for example by `scripts/ci/publish-image.sh` on an all-green nightly run.

| Exit (promote) | Meaning |
|---|---|
| 0 | Promoted and verified on the box. |
| 1 | The box's promote failed. The box restored and verified its prior release, so it is serving. |
| 2 | Refused before the box's running state changed. |
| 3 | The box did not verify after a failure, or the connection dropped mid-transaction. The box needs hands: run `--status`. |
| 4 | Transport failure (SSH or the image transfer). The box's running state is unchanged. |

## 4. Check drift

```bash
bash scripts/core-promote/promote.sh --target production --status     # a managed box
bash scripts/core-promote/core-drift-check.sh                          # the dev box's own stack
```

The drift check reports these legs:

- the release-dir HEAD;
- the env file's pin (image ID, commit and release labels);
- the running api (image ID, `GIT_SHA`, `OSHAL_RELEASE`);
- on a box, the image `history.tsv` records as live;
- `origin/main`, with how many commits the running commit is behind.

Being behind main is reported, not treated as drift. An unfinished transaction in the history turns
an otherwise clean status into exit 1.

| Exit | Meaning |
|---|---|
| 0 | In sync. |
| 1 | Drift. Each leg that disagrees is named. |
| 2 | Unverifiable: a leg could not be read and no drift was proven. |
| 4 | (`promote.sh --status` only) The box could not be reached. |

## 5. Roll back

```bash
bash scripts/core-promote/promote.sh --target production --rollback
```

Rollback returns the box to its state before the most recent promote still in effect: the previous
checkout, pin and image, verified the same way. The history works as a stack, so a second rollback
goes one promote further back. If a transaction never finished (exit 3), the next promote is
refused until `rollback` finishes it. Rollback undoes a dangling promote, or retries a dangling
rollback. A rollback refuses when its image has been pruned from the box.

**The database is not rolled back.** An image rollback is enough when the release added no
migration. When a migration has to be undone, the restore is the promote's pre-deploy dump. This is
a deliberate operator step on the box, it replaces data, and it has not been drilled on a managed
box. The dump path is in the promote's output and in `history.tsv`:

```bash
pg_restore --clean --if-exists --no-owner --dbname="<bootstrap DSN>" /var/lib/oshal/core-release/<deployment-id>/dumps/pre-<txn>.dump
```

| Exit (rollback) | Meaning |
|---|---|
| 0 | Rolled back and verified. |
| 2 | Refused before any change. |
| 3 | Did not verify. The box needs hands. |

## Where the state lives

| Where | What |
|---|---|
| operator machine `~/.oshal-core-release/` | `records/<release>.json`, the staging and production receipts, `targets/<name>.conf`, cut logs |
| box `/var/lib/oshal/core-release/<deployment-id>/` | `history.tsv`, which is append-only, and `dumps/`. Both are root-only. |

The repository holds none of this: box addresses must not be public, and the publish gate refuses
`scripts/release/`. Each `history.tsv` line has these tab-separated fields, with `-` marking an
empty field:

```text
ts  txn  event(promote|rollback)  outcome(begin|ok|restored|degraded)  to_release  to_sha  to_ref  to_id
from_release  from_sha  from_ref  from_id  dump  reverts
```

## Coverage

These specs cover the pipeline. Each runs the shipped script in Git Bash against real git
repositories, with docker, ssh and curl replaced by recording stand-ins:

- `tests/unit/core-cut-release.spec.ts`
- `tests/unit/core-promote.spec.ts`
- `tests/unit/managed-core-release.spec.ts`
- `tests/unit/core-drift-check.spec.ts`
- `tests/unit/update-check.spec.ts`: the `/api/version` route over HTTP
- `tests/unit/dockerfile-release-identity.spec.ts`

They are registered with the deploy-contract regressions in the AI Test Lab (`installed-app-tests`)
and run by `npm run test:platform-readiness`.

**Not yet proven live:** a staging → production promotion and a rollback drill on the managed
boxes. The first run is `promote.sh --bootstrap` to the staging target, then production, then
`--status` and `--rollback`.
