# Runbook — turning on the Email Summarizer bot

## Current state (verified 2026-06-13)
- **App:** `email-summarizer` is **loaded + active** (auto-loads from `swarm-apps/email-summarizer.yaml`).
- **Bot:** registered inline in the local registry (`swarm-bot-registry-local.ts`) — runs in the `oshal-api` container, no separate container needed.
- **Workflow:** ticketType `email-summarizer` → pipeline registered.
- **Blocker:** **no Gmail OAuth.** `~/.oshal-google-workspace/profiles/` is empty, so the bot has never been authorized to read mail. Everything below is the one-time authorization.

The bot targets the **`owner@example.com`** account via the Google Workspace OAuth profile **`workspace-profile`**, scopes **`gmail.modify`** (includes read; enables mark-as-read) **+ `calendar`**. It does a daily end-of-day digest (Mode A = full digest when authorized; Mode B = degraded "authorize me" note when not).

## What does NOT change
Your **sign-in** (OIDC, `openid profile email`) stays identity-only. Do **not** add Gmail scopes to the login — the bot uses a *separate* Google OAuth (the Workspace CLI), so reading mail never touches the user login flow.

## One-time setup (your Google account — interactive)

### 1. Google Cloud project
- Enable **Gmail API** and **Google Calendar API**.
- OAuth consent screen → add scopes: `.../auth/gmail.modify`, `.../auth/calendar`.
- If the app is in **Testing**, add `owner@example.com` as a test user.
- Create an **OAuth client** (Desktop app is simplest for the installed-app CLI flow) → note its **Client ID + Secret**. (This is a *different* client from the login's `OIDC_CLIENT_ID`.)

### 2. Authorize the bot's profile (on the host — opens a browser)
The CLI is `scripts/google-workspace-cli.js` and runs **on the host** (the container only reads the resulting token via the mounted `~/.oshal-google-workspace` volume).

```bash
# from C:\Projects\open-shal-swarm-harness-agent-llm
GOOGLE_CLIENT_ID=<client-id> GOOGLE_CLIENT_SECRET=<client-secret> \
  node scripts/google-workspace-cli.js auth login --profile workspace-profile
# sign in as owner@example.com, grant Gmail + Calendar
# verify:
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  node scripts/google-workspace-cli.js auth status --profile workspace-profile
```

Success writes a refresh token to `~/.oshal-google-workspace/profiles/workspace-profile.json`, which is bind-mounted into `oshal-api` — so the bot can immediately use it (no rebuild).

## Run a digest
Once authorized, trigger the pipeline by creating an `email-summarizer` ticket (cockpit → new ticket with that type, or `POST /api/tickets {"ticketType":"email-summarizer", ...}`). The bot reads today's Gmail + Calendar and produces the digest; it can mark triaged-junk with an `OSHAL/triaged-junk` Gmail label (never deletes).

## Make it daily (optional)
After a successful manual run, schedule it via the agent scheduler (`ENABLE_AGENT_SCHEDULER=true`, Redis-backed) so an `email-summarizer` ticket is created each evening. Wire the schedule once OAuth is confirmed working so it doesn't fire daily into an unauthorized bot.

## Troubleshooting
- "OAuth client credentials are not configured" → `GOOGLE_CLIENT_ID/SECRET` not set for the CLI call.
- Bot returns a Mode-B "authorize me" digest → the `workspace-profile` profile isn't authorized (re-run `auth login`).
- Gmail 429/5xx → transient; the bot degrades to Mode B for that run.
- **A Jarvis "summarize my emails" ticket sits in the WORK QUEUE forever (never picked up)** → this
  was a real dispatch gap, fixed 2026-06-22 (see below). If it recurs after a code change, check
  `oshal-api` logs for `Workflow not yet registered for app-contributed ticketType — deferring`.

## Why a filed Jarvis task could sit unprocessed (fixed 2026-06-22)

**Symptom.** Voice/Jarvis requests that get *filed as work* (e.g. "Summarize today's emails",
"Prioritize today's email summary") sat in the cockpit WORK QUEUE indefinitely, while deep-link
app hand-offs (Uber/Spotify) showed "done". Bot-work never ran.

**Root cause.** Jarvis files these as `ticketType: 'task'` (status `approved`) — both on a hand-off
directive and on the `DECISION_TIMEOUT` auto-file in `jarvis-routes.ts`. The queue-manager *did*
claim them (it polls `status:'approved'`), but the dispatcher routes purely from the workflow
registry, and **no workflow was registered for `'task'`**. So `chooseDispatchPath()` returned
`'defer'` and the queue-manager skipped the ticket on every poll cycle — forever. (The deep-link
apps looked "done" only because Jarvis had already returned their link inline in chat; their filed
tickets were *also* silently deferring.)

**Fix (3 files).**
1. `dispatch-routing.ts` — registered a built-in `task` workflow → `pipeline: 'manifest-worker'`
   (the lightweight single-bot path, **not** the 7-phase build `swarm`), default
   `workerBot: 'project-manager'` (catch-all).
2. `dispatch-manifest-worker.ts` — the dispatcher now honors a per-ticket `metadata.targetAgentId`
   override, so one `task` workflow fans out to the right specialist instead of always PM.
3. `jarvis-routes.ts` — `resolveTaskBotAgentId()` (deterministic keyword match, no LLM) stamps
   `metadata.targetAgentId` at both file sites: email/calendar → communications-bot, home →
   home-bot, cloud → cloud-ops-bot, jobs → career-advisor, else PM.

**Net:** "Summarize today's emails" → filed `task` with `targetAgentId = communications-bot` →
claimed → dispatched straight to communications-bot. Requires an `oshal-api` rebuild to go live
(compiled TS, not the hot-swap-mounted dirs).

**Backlog / follow-up.** Deep-link concierge apps (Uber→`rides-concierge`, Eats→`eats-concierge`,
Spotify, Shopping) are filed as `task` too and currently fall back to PM rather than their concierge
bot. Extend `resolveTaskBotAgentId()` with those keyword→agent mappings if we want them owned by the
concierge bots instead of PM. (Not a regression — they previously deferred silently.)
