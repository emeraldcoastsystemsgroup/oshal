# Google Bot Runtime Setup

This is the local operator guide for `google-bot`.

The runtime path is:

- bot persona: `ai-lab/bot-personas/google-bot.yaml`
- runtime tool alias: `gogcli`
- executable: `node scripts/google-workspace-cli.js`
- bot-scoped runtime home: `output/bot-runtime/<agent-id>/google-workspace`

## Purpose

`google-bot` is the swarm agent that consumes the repo-native Google Workspace CLI.
It should use the CLI for Gmail, Drive, Docs, Sheets, Slides, Calendar, and generic authenticated Google API requests.

This setup guide lives in the local repo docs on purpose. Do not rely on a Google Doc for the bot's own configuration story.

## Required Config

Enter these on the bot config screen or through `/api/swarm/agents/google-bot/config`:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_ACCOUNT_EMAIL`

Optional:

- `GOG_ACCOUNT`
- `GOOGLE_REDIRECT_PORT`
- `GOOGLE_SCOPES`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SERVICE_ACCOUNT_SUBJECT`

## OAuth Flow

For personal-account testing, use installed-app OAuth:

1. Create a Google OAuth desktop client in Google Cloud.
2. Add the operator Google account as a test user if the app is in Testing mode.
3. Save `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Run auth status first.
5. Run auth login and complete browser consent.

## Required Google Cloud APIs

Enable only the APIs the bot actually needs:

- Gmail API
- Drive API
- Docs API
- Sheets API
- Slides API
- Calendar API

If a command returns `SERVICE_DISABLED`, enable that API in Google Cloud for the same project as the OAuth client.

## Smoke Tests

Run these through the CLI or through `google-bot` using the `gogcli` tool alias:

```powershell
node scripts/google-workspace-cli.js auth status --json --profile personal
node scripts/google-workspace-cli.js gmail list --query "in:inbox" --max-results 3 --json --profile personal
node scripts/google-workspace-cli.js drive list --max-results 3 --json --profile personal
node scripts/google-workspace-cli.js sheets create --title "oshal smoke sheet" --json --profile personal
node scripts/google-workspace-cli.js slides create --title "oshal smoke slides" --json --profile personal
```

Docs and Calendar require both:

- the API enabled in Google Cloud
- the consented scope present in the saved token

## Runtime Storage

User-shell auth may land under:

- `C:\Users\you\.oshal-google-workspace`

The actual bot runtime should keep its own profile under:

- `output/bot-runtime/<agent-id>/google-workspace/profiles`

That keeps the bot runtime story explicit and reproducible.

## Factory Lesson

Any future tool-backed agent should ship with:

- a declared runtime executable or tool path
- config schema
- safe defaults
- a local docs guide like this one
- smoke-test commands

If one of those is missing, the agent is created but not truly deployable.
