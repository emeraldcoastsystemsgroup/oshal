# ADR-167: Core release identity and promotion of one built artifact

## Status

Proposed — built 2026-09-27: the release identity in the image and on `/api/version`, the cut,
promote, on-box transaction and drift-check commands, and their specs. The first staging →
production promotion and rollback drill on a managed box is the open live proof (see
[the runbook](../runbooks/core-release-promotion.md)).

## Context

Store packages have a release rail: a manifest `version:` and `deploy.js` parity. Core has none.

- **No release identity.** `package.json` `version` has been `2.1.0-beta.1` for every commit since
  the trunk snapshot, and the only tag is `v2.1.0-beta.1`. `GET /api/version`
  ([update-check-cron.ts](../../src/app/routes/update-check-cron.ts)) returns that version and the
  image's `GIT_SHA`. A box can say which commit it runs, but no box is *at* a named release.
- **Every box builds its own bytes.** The customer-box core update was a manual list: back up by
  hand, `docker tag … :rollback`, `git reset --hard origin/main`, `docker build` on the box, repoint
  the image, run the launcher. Two builds of one commit are not the same bytes:
  `Dockerfile.oshal` runs `apk upgrade` and installs vendor CLIs at build time, so a later build
  pulls later packages. Staging validating a commit therefore says nothing about the bytes
  production then builds.
- **No capture, no history, manual rollback.** The production launcher
  [`managed-postgres-compose.sh`](../../scripts/managed-postgres-compose.sh) is fail-closed
  (root-owned 0600 env, immutable image references, the migration/RLS bootstrap gate) but has only
  `up|validate|ps|logs|down`. The pre-deploy dump and the rollback tag were typed by hand.
  [`oshal-deploy.sh`](../../scripts/oshal-deploy.sh) has an automatic rollback but is the dev-box
  command and must not run on a customer box (it would start the whole bot fleet).
- **No drift report.** The update-check daemon compares the running commit with main. Nothing read
  the release directory or the env file's pin, so "main is ahead of production" and "the release
  dir moved without a deploy" were invisible.

## Decision

**D1 — Release name.** A core release is `core-YYYY.MM.DD` (UTC date of the cut), with `.2`, `.3` …
for a later cut the same day. It is an annotated git tag on a commit reachable from `origin/main`.
One commit gets at most one release name and a name is never reused. `package.json` `version` is
unchanged; it is not the release identity.

**D2 — The artifact is the image ID.** [`cut-release.sh`](../../scripts/core-promote/cut-release.sh)
builds once from `git archive <commit>` with `GIT_SHA`, `OSHAL_RELEASE` and the
`oshal.git.commit` label, tagged `oshal-bot:sha-<commit>` and `oshal-bot:<release>`. It verifies
the image with the probes the dev-box deploy runs (commit label, kernel-skills, cline
entrypoint) plus the release label, through
[`core-image-verify.sh`](../../scripts/lib/core-image-verify.sh). A missing probe script refuses. The
release record (`<release>.json`: commit, image ID, tags, probes, time) is written only after every
probe passes, and the tag only after the record. `oshal-bot:latest` is never touched.

**D3 — Identity in the image.** `ARG`/`ENV OSHAL_RELEASE` (default `unreleased`) and the label
`oshal.release` sit at the tail of `Dockerfile.oshal`, after the last `RUN`, beside `GIT_SHA`, so a
cut reuses every heavy layer. `IMAGE_VERSION` is not reused: it is declared above the heavy layers.
`/api/version` returns `{name, version, commit, release}`. `release` is null unless the value
matches the D1 scheme, so the public endpoint never echoes an arbitrary build argument.

**D4 — Channel.** Each managed box declares `OSHAL_RELEASE_CHANNEL=staging|production` once in its
root-owned env file. The on-box helper refuses a promote whose expected channel differs. This
guards against deploying to the wrong droplet.

**D5 — Promotion moves bytes.** [`promote.sh`](../../scripts/core-promote/promote.sh) streams
`docker save | gzip | ssh … docker load`. With `--registry <repo>` it instead pulls
`<repo>@sha256:<digest>`, and only when this machine's copy of that exact image carries that repo
digest. Either way, the box's image ID must equal the record before anything runs. A box that holds
a different image under the same tag is refused, not overwritten. Production refuses an image ID
without a staging receipt (`<release>.staging.json`). Only a staging promote that exits 0 after
verification writes that receipt, and only for the image ID it promoted.

**D6 — The on-box transaction.** [`managed-core-release.sh`](../../scripts/managed-core-release.sh)
is the root-side sibling of the launcher and uses the same path-trust rule. `promote` refuses
unless all of these hold:

- the loaded image's ID and labels are the release;
- the channel matches;
- the release dir is clean and agrees with the pinned image;
- the commit is on `origin/main` and the release tag is published on it.

Then it runs, in order:

1. Takes a `pg_dump --format=custom` with the pinned PostgreSQL image. Only `BOOTSTRAP_DATABASE_URL`
   is staged, in a root-only file that is removed straight afterwards.
2. Appends the history line.
3. Checks out the release commit.
4. Repoints `OSHAL_BOT_IMAGE` atomically.
5. Runs `managed-postgres-compose.sh up`.
6. Verifies that the running api image ID and `/api/version` commit and release match.

A failure after the capture restores the prior checkout and pin and verifies them (exit 1). A
failed restore is exit 3. Refusals are exit 2.

**D7 — Rollback is image and release dir only.** `rollback` returns to the state before the most
recent promote still in effect; the history is read as a stack. An unfinished or degraded
transaction blocks the next promote until `rollback` finishes it. The database is not rolled back.
When a migration has to be undone, the restore is that promote's pre-deploy dump (`pg_restore`),
done deliberately by the operator.

**D8 — Drift.** [`core-drift-check.sh`](../../scripts/core-promote/core-drift-check.sh) reports:

- the release-dir HEAD;
- the env pin (image ID, commit and release labels);
- the running api (image ID, `GIT_SHA`, `OSHAL_RELEASE`);
- on a managed box, the image the history records as live;
- `origin/main`, with how many commits the running commit is behind.

Exit codes are 0 in sync, 1 drift and 2 unverifiable. Proven drift outranks an unreadable leg.
Being behind main is reported, not drift.

**D9 — Scope and where state lives.** The dev box keeps `oshal-deploy.sh`. Store packages keep
their own rail. The GHCR publish step (`scripts/ci/publish-image.sh`) is unchanged. Release
records, receipts and target files live under `~/.oshal-core-release` on the operator's machine.
Box history and dumps live under `/var/lib/oshal/core-release/<deployment-id>` on the box. Neither
is ever in git: the publish gate refuses `scripts/release/`, and box addresses must not be public.

## Consequences

- Production receives the exact bytes staging ran, recorded by image ID. A wrong-box promote is
  refused by the channel. A capture and a history line precede every change, and a rollback is one
  command.
- `/api/version` names the release a box is at. The drift check turns "merged but never deployed"
  and a hand retag into a named report.
- A box whose release dir predates the helper cannot run it from there. Its first promote uses
  `promote.sh --bootstrap`, which stages the helper from the release commit's own git objects in
  the release dir for that one run and removes it afterwards.
- The default transfer streams the whole image over SSH on each promote. The `--registry` path
  avoids that once the image is published.
- The machine that cut a release must keep that image until production has it; a pruned artifact
  refuses.
- Rollback does not undo migrations. The dump is the documented restore.
- Not built: a cockpit footer (the endpoint carries the identity), automatic pruning of dumps, and
  a registry push inside `cut-release.sh`.

## Alternatives rejected

- **A semver bump in `package.json` per release.** It is the npm-facing field, and a value there
  does not reach the image without a build argument anyway.
- **Rebuilding on each box from the same commit.** A rebuild produces different bytes (see
  Context).
- **Registry-only promotion.** The existing publish rail (`scripts/ci/publish-image.sh`) pushes only
  after an all-green nightly run, so every release would wait on one. The stream transfer needs
  nothing on the box but `docker load`, and `--registry` remains available for an image that was
  published.
