# Developing OSHAL

This is the canonical repository. Development happens **here**, in feature branches that
merge to `main` — not on `main` directly.

## First-time setup (once per clone)

```bash
git clone https://github.com/emeraldcoastsystemsgroup/oshal.git
cd oshal
git config core.hooksPath .githooks   # enable the pre-commit / pre-push gates
npm install
```

`git config core.hooksPath .githooks` is required — it wires the hooks that keep the
repository clean and compiling.

## The workflow

```bash
git switch -c feat/short-description        # branch off main
# ... make changes, commit small and often ...
git push -u origin feat/short-description    # the pre-push gate runs here
```

Open a pull request into `main`. `main` is protected: it only advances through merged
PRs, never a direct push.

## What the gates enforce

Two things run before anything reaches the remote:

1. **The publish gate** (`scripts/publish-gate.sh`, via the pre-push hook). **This repo is
   public.** There is no scrubber between your commit and the world, so the gate refuses to
   push:
   - internal-only paths (nightly QA evidence, session coordination, release tooling, the
     commercial capture packages);
   - vendor-prefixed credentials (`AKIA…`, `ghp_…`, private keys, …);
   - personal or employer identifiers (a maintainer's personal accounts, home network,
     absolute user paths, an employer's internal infrastructure, third parties' details).

   It deliberately does **not** flag the author's own name or business email — that is
   attribution, and it stays. If the gate trips on a genuine false positive (a real place
   name, a documented example), **narrow the pattern in `scripts/publish-gate.sh`** rather
   than weakening the gate. Run it any time with `bash scripts/publish-gate.sh`.

2. **The HEAD typecheck** (pre-push). Exports the committed HEAD to a scratch tree and
   typechecks *that*, catching the case where your working tree is green but what you
   actually committed is not.

## If the publish gate blocks you

It prints exactly what it found and where. Remove the flagged content — do not force it
through. The one thing you may skip is the slower typecheck
(`OSHAL_SKIP_PREPUSH_VERIFY=1 git push`); the leak gate is never skippable.

## Notes

- Local dev with no keys and a mock login: `bash scripts/install.sh` (or the Windows
  installer), then `MOCK_OIDC=true` — see [INSTALL.md](INSTALL.md).
- Application packages install from the store — see the app authoring docs under `docs/`.
