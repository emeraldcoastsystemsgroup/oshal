# Claude auth across the swarm + the token keepalive

How Claude Code authentication actually works between the host and the ~40 bot containers, the
two failure classes it produced on 2026-07-09, and the standing fixes. Companion facts for the
`oshal-dev` git-auth model live here too — same investigation, same day.

## The auth model (as-built)

- **The host owns the credential.** `~/.claude/.credentials.json` (Windows:
  `%USERPROFILE%\.claude\.credentials.json`) holds the Claude Code OAuth session
  (`claudeAiOauth`: accessToken / refreshToken / expiresAt).
- **Every container is a read-only consumer.** Compose bind-mounts `~/.claude` into the api and
  all bot nodes with `:ro` (`x-claude-auth-volume` in
  [docker-compose.oshal-local.yml](../../docker-compose.oshal-local.yml)). Containers can never
  write a refreshed token back — by design (one writer, no concurrent-rotation races, and bots
  never hold long-lived secrets of their own).
- A host-side write propagates into every container **instantly** (it is the same file).

## Finding 1 — the ~8h token only refreshed by accident

The access token lives ~8 hours. Two non-obvious facts, both proven live on 2026-07-09:

1. **The CLI refreshes only a token it finds EXPIRED.** A minimal `claude -p ok` against a
   still-valid token completes without touching `expiresAt` — so "run a cheap turn on a schedule"
   is NOT a keepalive. Do not revert the keepalive to that approach.
2. **The token was being kept alive only by interactive host sessions.** While an operator Claude
   Code session is active, the CLI rotates the token as needed. Idle/overnight gaps → token
   expires → **every claude-code dispatch in every container 401s** and the ticket escalates.

**Failure signature** (this is what it looks like in the DB):

```
tickets.status = 'escalated'
metadata.lastStatusTransition.reason  = 'manifest_worker_dispatch_failed'
metadata.lastStatusTransition.message = 'ClaudeCodeCliHarnessAdapter: claude exited with code 1.
  … Failed to authenticate. API Error: 401 Invalid authentication credentials.'
```

Observed blast radius before the fix: 17 `task` + 43 `build` tickets escalated.

## The fix — "OSHAL Claude token keepalive" (host scheduled task)

A Windows scheduled task runs every 2 hours:

- [scripts/claude-token-keepalive.ps1](../../scripts/claude-token-keepalive.ps1) reads
  `expiresAt`; with **more than 5h** left it exits (logs `OK`). Under 5h it runs
- [scripts/claude-token-refresh.js](../../scripts/claude-token-refresh.js): a direct
  `grant_type=refresh_token` POST using the Claude Code CLI's own client id (the same id
  [claude-code-auth-service.ts](../../src/features/claude-code-auth/services/claude-code-auth-service.ts)
  uses), then an **atomic** rewrite of the credentials file (tmp + rename — active sessions and
  ro-mounted containers never see a torn file; all non-token fields preserved).

Endpoint finding: the refresh grant is accepted by **`https://console.anthropic.com/v1/oauth/token`
(JSON body)**; `https://claude.ai/oauth/token` (the code-exchange endpoint the in-repo auth service
uses, form-encoded) **403s refresh grants**. The script tries console first, claude.ai as fallback.

Live verification (2026-07-09): token at 3.5h → refreshed to 8.0h; `docker exec oshal-local-api`
saw the new `expiresAt` immediately.

### Operate it

| Action | Command |
|---|---|
| Check it ran | `Get-Content $env:USERPROFILE\.claude\keepalive.log -Tail 10` |
| Check the token | `node -e "const c=require(process.env.USERPROFILE+'/.claude/.credentials.json');console.log(new Date(c.claudeAiOauth.expiresAt))"` |
| Force a run now | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claude-token-keepalive.ps1` |
| Re-register the task | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-claude-token-keepalive.ps1` |
| Remove the task | `Unregister-ScheduledTask -TaskName 'OSHAL Claude token keepalive' -Confirm:$false` |

Worst case with the task running: the token can never drop below ~3h, so containers always read a
valid token. If the machine was off long enough for the **refresh token** itself to die, the
keepalive logs `FAIL` — that needs one interactive `claude` login on the host (see
`Connect-AI.bat` / the AI-provider login flow); nothing container-side ever needs touching.

## Finding 2 — dev-repo git auth died at ticket time (HOME mismatch)

`oshal-developer`'s clone (`/app/dev-repo`) authenticates to GitHub via a credential helper that
reads `OSHAL_DEV_REPO_TOKEN` at use time (the secret is never persisted — ADR-081). It worked in
`docker exec` but failed inside tickets with
`fatal: could not read Username for 'https://github.com'`. Root cause: the helper lived **only in
`/root/.gitconfig`**, and the codex harness runs ticket work with
**`HOME=<workspace>/.codex-home`** — ticket-time git never loads the global gitconfig.

Fix (in [scripts/bot-entrypoint.sh](../../scripts/bot-entrypoint.sh) `dev_repo_setup`), three layers:

1. **Repo-local helper** in `/app/dev-repo/.git/config` — HOME-independent; this is what
   ticket-time git actually loads.
2. Helper falls back to **`/run/oshal-dev-token`** (mode 600, container-local, on no volume —
   dies with the container) in case the spawn env is scrubbed. The secret still never persists.
3. The global helper remains for operator `docker exec` convenience.

**Caveat:** `oshal-developer` deliberately has **no `./scripts` bind-mount** (it must never see
the live tree), so entrypoint changes for it require an **image rebuild** + container recreate —
a restart alone runs the old baked entrypoint.

Verification (the ticket-condition test — run it after any change here):

```bash
docker exec -e OSHAL_DEV_REPO_TOKEN= oshal-local-oshal-developer sh -c \
  'export HOME=/tmp/fake && mkdir -p $HOME && cd /app/dev-repo && git pull --rebase origin main'
# expected: a clean pull ("Already up to date." / fast-forward) — NOT "could not read Username"
```

## Troubleshooting quick table

| Symptom | Check | Fix |
|---|---|---|
| task/build tickets escalate with 401 auth message | `keepalive.log`; token `expiresAt` | force a keepalive run; if `FAIL`, interactive `claude` login on host |
| keepalive logs `WARN: expiresAt did not advance` | endpoint/pipeline change | run `node scripts/claude-token-refresh.js` by hand, read its stderr |
| dev bot: `could not read Username` in a ticket | `git config --local --get credential.helper` inside `/app/dev-repo`; `test -f /run/oshal-dev-token` | rebuild image + recreate `oshal-developer` (entrypoint is baked) |
| containers see a stale token but host is fresh | mount path (`CLAUDE_CONFIG_HOST_PATH`) | it's the same file — if they diverge, the container is mounting a different host dir |
