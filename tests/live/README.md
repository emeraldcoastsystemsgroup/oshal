# Live headed E2E — your own browser, your session, real data

Foreground Playwright that **attaches to your own Chrome** (where you're already
signed in) and exercises features on **real data** in the hosted app. This is
separate from the default suite (`playwright.config.ts`), which boots a throwaway
server with `MOCK_OIDC` and runs headless.

## Why it attaches instead of logging in

The hosted app is gated by Google sign-in, and Google **blocks logins from
Playwright-launched browsers**. So instead of logging in, the suite connects over
CDP to a Chrome **you** launched and signed into — no login step, no block.

## Run

```powershell
# 1. Launch a debuggable Chrome and sign in ONCE (real Chrome, so Google allows it).
#    Leave this window open. The dedicated profile remembers the login next time.
powershell -ExecutionPolicy Bypass -File scripts/launch-e2e-chrome.ps1

# 2. With that window open + signed in, run the suite (attaches over CDP):
npx playwright test --config playwright.live.config.ts

# Just the flagship Walmart -> Drive -> validate flow:
npx playwright test --config playwright.live.config.ts walmart-drive-flow

# Allow the reversible write step (save the list to your Drive):
$env:OSHAL_E2E_ALLOW_WRITES=1; npx playwright test --config playwright.live.config.ts walmart-drive-flow

# Create one real build ticket and require complete/escalated-with-metadata:
$env:OSHAL_E2E_ALLOW_WRITES=1; npx playwright test --config playwright.live.config.ts build-ticket-terminal-state

# Report (screenshots per feature):
npx playwright show-report playwright-report-live
```

If you already keep a normal Chrome open with the app, you can instead start *that*
Chrome with `--remote-debugging-port=9222` (and a non-default `--user-data-dir`)
and the suite will reuse its session — the launcher just automates that.

## Knobs

| Env | Default | Effect |
|---|---|---|
| `OSHAL_E2E_BASE_URL` | `https://oshal.agenticfederal.us` | Target app (set to a local docker URL to test that instead). |
| `OSHAL_E2E_CDP_URL` | `http://localhost:9222` | Where your debuggable Chrome is listening. |
| `OSHAL_E2E_ALLOW_WRITES` | unset (off) | Allow reversible writes (save-to-Drive, drafts). Off = read-only. |

## Safety

- **Read-only by default.** Specs navigate and observe. Anything that writes is
  gated behind `OSHAL_E2E_ALLOW_WRITES`; nothing sends mail, charges, or books.
- Runs against **your live session** — it acts as you. The suite never closes
  your Chrome.
- Flagship-flow selectors are a first cut for the headed shakeout; soft
  assertions report which leg of a flow is/ isn't wired instead of dying on the
  first mismatch.

## Localhost Users and Access acceptance

After the real deployment is ready, use the existing operator session signed in on
`http://localhost:35457` in the debuggable browser. A hosted-domain login does not
authenticate this origin. This focused spec uses `_attach-noprune.ts`; it opens its
own tab and leaves existing tabs alone. It never enables mock authentication.

```powershell
$env:OSHAL_E2E_BASE_URL='http://localhost:35457'
$env:OSHAL_E2E_CDP_URL='http://localhost:9222'
# Optional: require the exact GIT_SHA reported by the newly deployed image.
# $env:OSHAL_E2E_EXPECTED_COMMIT='<full deployed commit>'
npx playwright test --config playwright.live.config.ts tests/live/authorization-management.live.spec.ts
```

The spec checks the published build, current operator/root state, loaded Users and
Access pages, application source revisions, current effective rights, bounded audit
reads and the Lab's catalog probe. Missing authentication or unavailable modules
fail; an empty application catalog is reported without claiming an app read.
Account/grant writes and other origins are blocked. Screenshots, traces and video
are disabled; the attached report contains booleans, counts and build/app metadata.

The Lab registers this file separately as `authorization-localhost-live`. Its Lab
button reports pending because HTTP cannot run the authenticated browser. The
`authorization-management` button runs only its read-only catalog probe; the fixed
`npm run test:authorization` command remains the isolated regression suite list.

## Assisted provider onboarding

For partner app registration, use the same debuggable Chrome profile but keep
human-only steps human:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/launch-e2e-chrome.ps1
npm run connectors:assisted-onboarding -- --providers spotify,github,dropbox --mode guided
```

The helper opens provider registration or OSHAL connect pages and writes a report.
It does **not** type passwords, accept Google password prompts, bypass MFA, submit
sign-up forms, accept legal terms, create paid resources, or copy secrets.
