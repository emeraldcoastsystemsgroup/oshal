# Security policy

## Supported versions

OSHAL is in active beta. Security fixes land on `main` and ship in the
next tagged release. Older tags don't get backports.

| Version           | Supported          |
|-------------------|--------------------|
| `2.0.0-beta.x`    | Yes                |
| `< 2.0.0`         | No                 |

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Email `maintainer@emeraldcoastsystemsgroup.com` with:

- A clear description of the issue (impact, attack scenario)
- Steps to reproduce or a proof-of-concept
- The OSHAL version / commit hash you tested against
- Your contact for follow-up

Acknowledgement target: 72 hours. Triage + initial mitigation plan: 7
days. Public disclosure timeline is coordinated with the reporter; we
default to a 90-day embargo unless the issue is being exploited in the
wild, in which case we ship a fix as fast as we can and disclose
immediately after.

## Scope

In scope:
- The control plane (`src/app/server.ts`, all `src/app/routes/*`)
- The bot-node runtime (`src/app/bot-node-server.ts`, `any-bot/server/*`)
- All harness adapters (codex-cli, claude-code, gemini-cli, cline, a2a)
- The cockpit UI (`src/pages/cockpit/*`)
- Dispatch/queue/orchestration (`src/features/swarm-orchestration/*`)
- Auth + middleware (`src/shared/middleware/oidc.ts`, `requiresAuth`)
- Persona files in `ai-lab/bot-personas/*` insofar as they describe
  bot capabilities (escalation surface)

Out of scope:
- Vulnerabilities in upstream dependencies that don't affect OSHAL
  (report those upstream — `@google/gemini-cli`, `cline`, etc.)
- Findings from automated scanners without a working PoC against an
  actually-deployed OSHAL instance
- Social-engineering / phishing scenarios that don't exploit OSHAL code
- Self-XSS in cockpit UI when the attacker already has the operator's
  authenticated session

## Hardening defaults

OSHAL's [src/shared/middleware/oidc.ts](src/shared/middleware/oidc.ts)
sets `authRequired: false` at the OIDC layer — every Express route
must opt in to `requiresAuth` middleware explicitly. The convention
is enforced by [tests/security-review-fixes.spec.ts](tests/security-review-fixes.spec.ts).
When adding routes that:

- Spawn subprocesses (codex / claude / gemini CLI)
- Read/write workspace files
- Create tickets or trigger orchestration
- Return persona / agent / runtime details

you MUST gate them with `requiresAuth`. Routes that miss this are
treated as P1 security findings — see the precedent in commit `9ff374e`.

The `fast-intake` route (which spawns codex from a user-supplied
prompt) uses `spawn(..., { shell: false })` deliberately; never flip
that to `shell: true` — the prompt is user input, and shell:true
turns metacharacters (`;`, `|`, `&`, `$()`, backticks) into command
execution on the host.

## Credential storage

OSHAL never embeds credentials in code or images. Auth artifacts come
from:

- `~/.codex/auth.json` (OpenAI Codex CLI OAuth) — bind-mounted read-only
- `~/.claude/.credentials.json` (Anthropic Claude Code OAuth) — bind-mounted read-only
- `~/.gemini/oauth_creds.json` (Google Gemini CLI OAuth) — bind-mounted read-only
- `config-seed/secrets.json` — operator-managed, gitignored
- `.env` — operator-managed, gitignored

The repo's [.env.example](.env.example) is the canonical reference;
any new env var that holds a secret must be added there as a commented
stub with a clear comment about what the value should be.

## Audit hygiene

Every catch block that could mask a security failure must log at ERROR
with the error and stack trace per the rule in
[CLAUDE.md](CLAUDE.md#logging-structured-json-no-silent-catches).
Silent error swallows are treated as security findings. Reviewer
guidance: search PRs for empty `catch {}` blocks and reject them.
