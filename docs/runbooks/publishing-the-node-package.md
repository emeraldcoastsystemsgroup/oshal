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
| `files` | `dist/**`, `src/renderer/**`, `bin/**`, `scripts/**` — 48 files, 88 kB packed |
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

Then the terminal:

```bash
# 4. Authenticate this machine. npm 11 opens a browser.
npm login
npm whoami          # confirms which identity is about to own the package

# 5. Look at what you are about to make permanent.
cd packages/oshal-chat
npm pack --dry-run

# 6. Publish. --access public is REQUIRED for a scoped package; without it npm
#    refuses (scoped packages default to restricted, which needs a paid plan).
npm publish --access public
```

An org is not strictly required — a *username* of `oshal` yields the same `@oshal/*` scope. The
org is still the better choice: it survives a change of account owner and can hold several
maintainers, neither of which a personal scope can do.

Then confirm the thing that actually matters — that a stranger's machine can get it:

```bash
npm view @oshal/chat version
```

## Before you type step 4

**Publishing is effectively permanent.** `npm unpublish` is refused after 72 hours, and
refused earlier than that once anything depends on it. Treat the tarball as public forever.

**The version is a one-way door too.** `0.2.0` can never be republished with different
contents. If the first publish is wrong, the fix is `0.2.1`, not a replacement.

**Check the secret scan is still true.** It was clean when this was written, against the file
list `npm pack --dry-run` produced. Re-run it if the package has changed since:

```bash
npm pack --dry-run --ignore-scripts   # then scan the listed files
```

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
