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
