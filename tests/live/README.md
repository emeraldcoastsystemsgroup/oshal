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
| `OSHAL_E2E_BASE_URL` | `https://oshal.agenticfederal.us` for general suites; required for UAM acceptance | Target app. UAM acceptance requires an explicit HTTP loopback or HTTPS installation origin. |
| `OSHAL_E2E_CDP_URL` | `http://localhost:9222` | Where your debuggable Chrome is listening. |
| `OSHAL_E2E_ALLOW_WRITES` | unset (off) | Allow reversible writes (save-to-Drive, drafts). Off = read-only. |
| `OSHAL_E2E_EXPECTED_COMMIT` | required for UAM acceptance | Exact full 40-character lowercase `GIT_SHA` of the image being verified. |

## Safety

- **Read-only by default.** Specs navigate and observe. Anything that writes is
  gated behind `OSHAL_E2E_ALLOW_WRITES`; nothing sends mail, charges, or books.
- Runs against **your live session** — it acts as you. The suite never closes
  your Chrome.
- Flagship-flow selectors are a first cut for the headed shakeout; soft
  assertions report which leg of a flow is/ isn't wired instead of dying on the
  first mismatch.

## Installed Users and Access acceptance

After the real deployment is ready, explicitly select either its HTTP loopback
origin (for example `http://localhost:35457`) or its configured HTTPS origin that
routes to the same installation through the hosted tunnel. Confirm that routing
separately, and obtain the expected full commit from the image you deployed. A
matching commit verifies the build; it does not identify a deployment's database.
There is no default origin or automatic switch between hosted and localhost.

Use the existing operator session signed in on that exact origin in the debuggable
browser. A hosted-domain login does not authenticate localhost. OIDC uses an
origin from `APP_URL` or `OIDC_BASE_URLS`, with its callback registered at the login
provider; an unlisted localhost request falls back to the `APP_URL` configuration.
If this installation only supports hosted login, select its existing HTTPS origin.
This focused spec uses `_attach-noprune.ts`; it opens its own tab and leaves existing
tabs alone. It never enables mock authentication or starts a login flow.

```powershell
$env:OSHAL_E2E_BASE_URL='http://localhost:35457'
# Or explicitly set the configured HTTPS origin that routes to this installation:
# $env:OSHAL_E2E_BASE_URL='https://your-configured-installation.example'
$env:OSHAL_E2E_CDP_URL='http://localhost:9222'
$env:OSHAL_E2E_EXPECTED_COMMIT='<full 40-character lowercase deployed commit>'
npx playwright test --config playwright.live.config.ts tests/live/authorization-management.live.spec.ts
```

Configuration is validated before browser attachment, including for `--list`.
Only a canonical HTTPS origin or HTTP `localhost`, `127.0.0.1` or `[::1]` origin is
accepted, with an optional port and trailing slash. Credentials, paths, queries,
fragments, missing values and abbreviated commits are rejected. A different build
fails before the account and authorization checks.

The spec checks the exact published build, current operator/root state, loaded Users and
Access pages, application source revisions, current effective rights, bounded audit
reads and the Lab's catalog probe. Missing authentication or unavailable modules
fail; an empty application catalog is reported without claiming an app read.
Account/grant writes and other origins are blocked. Screenshots, traces and video
are disabled; the attached report contains booleans, counts and build/app metadata.

The Lab retains the registration ID `authorization-localhost-live` for this file;
the report records the origin actually tested. Its Lab
button reports pending because HTTP cannot run the authenticated browser. The
`authorization-management` button runs only its read-only catalog probe; the fixed
`npm run test:authorization` command remains the isolated regression suite list.
Discovery and static checks do not count as signed-in acceptance; that remains
pending until this focused spec runs successfully through the authenticated CDP browser.

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
