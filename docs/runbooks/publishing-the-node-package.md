# Publishing `@oshal/chat` to npm

The cockpit's one-click node installer (`GET /api/join/node-installer`) installs the worker
node with `npm install -g @oshal/chat`. Until that package exists on the public registry, the
download reaches a machine and cannot finish.

Everything except the publish itself is already done in-tree. This is the remaining part, and
it needs a human because npm login is interactive.

## What is already true

| | |
|---|---|
| `packages/oshal-chat/package.json` | `private` removed; `license: AGPL-3.0-or-later`, matching the root `LICENSE` |
| `postinstall` | opt-in — a plain `npm install` no longer installs anyone else's CLIs |
| `files` | `dist/**`, `src/renderer/**`, `bin/**`, `scripts/**` — run `bash scripts/npm-publish.sh` for the current file count; do not hand-type it here |
| `prepack` | runs `npm run build`, so the tarball ships compiled |
| `bin` | `oshal-chat` → `bin/oshal-chat.js`, which spawns Electron against the package root |
| secret scan | clean: no credential-shaped strings, no internal hostnames |

## The steps

The first three are in a browser and cannot be scripted. **There is no `npm org create`** — the
CLI only manages members of an org that already exists (`npm org set|rm|ls`).

1. **Account** — <https://www.npmjs.com/signup>, under the business email
   (`maintainer@emeraldcoastsystemsgroup.com`), same rule as every other partner registration:
   that account owns the package name permanently and receives the security alerts. Verify the
   address; npm refuses to publish until you do.
2. **2FA** — Settings → Two-Factor Authentication → Authenticator app. Required for publishing.
   **Save the recovery codes somewhere durable**: losing both the authenticator and the codes
   means losing the scope, and npm will not re-assign a name.
3. **The org** — <https://www.npmjs.com/org/create>, name `oshal`, and pick the **Free** plan
   (unlimited *public* packages, $0 — the paid tier only buys private ones). Skip the invite
   step; members are addable later with `npm org set oshal <user> developer`.

Then the terminal. **Use the scripts** — they refuse the two things that have actually gone
wrong here (publishing over an existing version, and shipping a file the publish gate never saw):

```bash
# 4. Authenticate this machine. npm 11 opens a browser.
npm login
npm whoami          # confirms which identity is about to own the package

# 5. Is the registry even behind the repo, and by what?
bash scripts/npm-parity-check.sh

# 6. Dry run: what would ship, and is anything about to ship unaudited?
bash scripts/npm-publish.sh

# 7. Publish for real. Irreversible.
bash scripts/npm-publish.sh --publish
```

`npm-publish.sh` is **dry-run by default**; only `--publish` ships. It adds `--access public`
itself (required for a scoped package), refuses a version already on the registry with the bump
command instead of letting npm answer E403, and refuses to run unauthenticated rather than
half-completing.

An org is not strictly required — a *username* of `oshal` yields the same `@oshal/*` scope. The
org is still the better choice: it survives a change of account owner and can hold several
maintainers, neither of which a personal scope can do.

Then confirm the thing that actually matters — that a stranger's machine can get it:

```bash
npm view @oshal/chat version
```

## Why there are scripts at all

The package sat at `0.2.0` on npm from 2026-08-15 while two features landed in it (#300 the
in-node print service, #302 satellite login push). **`package.json` also said `0.2.0`**, so the
version numbers matched while the code differed and nothing could notice. A valid token would not
have helped either — publishing over `0.2.0` fails E403 regardless.

So comparing versions is not a check. `npm-parity-check.sh` compares the published version **and
asks git what landed after the publish timestamp**, and it fails *closed*: an unreachable registry
reports UNKNOWN and exit 2, never a false pass. `oshal-deploy.sh` reports it in preflight (it never
gates on it — blocking a container deploy over a stale client package is the wrong coupling).

One trap worth keeping: `npm view <pkg> time.<version>` does **not** work. npm parses the dots in a
semver as a field path (`time` → `0` → `2` → `0`) and silently returns nothing, which reads as
"in sync". Fetch the whole `time` map and index it by the exact version key.

## Before you type step 4

**Publishing is effectively permanent.** `npm unpublish` is refused after 72 hours, and
refused earlier than that once anything depends on it. Treat the tarball as public forever.

**The version is a one-way door too.** `0.2.0` can never be republished with different
contents. If the first publish is wrong, the fix is `0.2.1`, not a replacement.

**The publish gate does not cover the tarball.** `scripts/publish-gate.sh` scans *tracked* files —
"what a push would actually send" — but an npm tarball ships the `files` allowlist **including built
`dist/**`**. Measured on this package: most of what npm ships is untracked build output, so the
majority of the tarball has never been through the gate.

`npm-publish.sh` closes that: it lists every packed file, flags the ones git does not track, and
**refuses** any untracked path that is credential-shaped (`.env`, `credential`, `secret`, `token`,
`.pem`, `.key`, `id_rsa`). Build output is expected and passes; a stray credential file does not.

## After it exists

The installer needs no code change — `OSHAL_NODE_PACKAGE` defaults to `@oshal/chat`. Set that
env var on the control plane to point at a fork, a private registry, or a pinned version
(`@oshal/chat@0.2.0`) without touching the installer.

The one thing worth doing once, on a machine that has never seen this repo: download the
installer from the cockpit and run it. That is the only test that proves the path, and it is
the test that found three defects the unit suite could not — see
the ADR index and `tests/unit/node-installer.spec.ts`.

## What stays behind

`installer/lib/install-node.ps1` is unchanged and still the right path for a machine that
already has a checkout, or an offline install. It builds the app from `packages/oshal-chat`
rather than fetching it, and it accepts the same `-EnrollmentToken` / `-ClientId` pair.
