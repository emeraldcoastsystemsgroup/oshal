# @oshal/swarm-cli

**Talk to Jarvis — the whole OSHAL swarm — from your terminal.** The chat window, headless.

The same endpoints the browser cockpit uses, so behavior is identical: one persistent thread
(shared with the browser), real delegation to the swarm's bots, and big asks handed off as tickets
you can collect later. Zero npm dependencies — just Node 18+.

```bash
swarm-cli login                              # sign in (mints a personal access token)
swarm-cli ask "what's on my calendar today?" # one-shot; answer on stdout
swarm-cli chat                               # interactive REPL — TAB completes, /help inside
swarm-cli tasks                              # durable handed-off work + results
```

## Install

From a checkout of the OSHAL repo:

```bash
npm install -g ./packages/swarm-cli     # puts `swarm-cli` on your PATH
swarm-cli --version
```

For development, `npm link` from this directory gives you a live-editable global binary.

Uninstall with `npm uninstall -g @oshal/swarm-cli`. Your credentials live in `~/.oshal` and are
left alone — delete that directory to remove them too.

> This package is `private: true` so it cannot be published to npm by accident. Publishing is an
> operator decision: flip `private` to `false`, then `npm publish --access public`.

## Auth

```bash
swarm-cli login
```

You'll be prompted for the controller URL and a credential. Two ways in:

| You have | What happens |
|---|---|
| A **personal access token** (`oshal_pat_…`) | stored in your context and used as `Authorization: Bearer` |
| The deployment's **service secret** + an **operator** user sub | it **bootstrap-mints a time-boxed PAT** (default 30-day TTL) and stores *that* — the machine-wide secret is never written to disk. Non-operator subs get `403 operator_required` |
| A dev server with `MOCK_OIDC=true` | nothing needed |

Credentials are kept in kubeconfig-style **contexts** at `~/.oshal/config.json` (mode 0600).
`--context <name>` targets another; `swarm-cli logout` forgets one. Precedence is
**flags > env (`OSHAL_CLI_TOKEN`, `OSHAL_API_URL`, …) > saved context**.

Tokens are revocable and audited:

```bash
swarm-cli tokens                # list, with last-used
swarm-cli tokens revoke <id>    # dead immediately — the server rejects it
```

## Commands

| Command | Does |
|---|---|
| `login` / `logout` / `whoami` | sign in, sign out, show who the server thinks you are |
| `ask <message…>` | one-shot question; the answer goes to **stdout** (pipe-safe) |
| `chat` | interactive REPL on a persistent thread |
| `history` | replay the current thread |
| `catalog` | the apps & agents Jarvis can reach |
| `tasks` | durable handed-off work items and their results |
| `tokens [revoke <id>]` | manage personal access tokens |
| `completion <bash\|zsh\|powershell>` | print a shell tab-completion script |
| `version`, `help` | — |

Flags: `--url --token --secret --sub --context --label --session --new --json --timeout --poll
--quiet --no-banner`.

## Tab completion

```bash
# bash
eval "$(swarm-cli completion bash)"                                   # this shell
swarm-cli completion bash | sudo tee /etc/bash_completion.d/swarm-cli # persist

# zsh
swarm-cli completion zsh > "${fpath[1]}/_swarm-cli"                   # then restart zsh

# PowerShell
swarm-cli completion powershell | Out-String | Invoke-Expression      # add to $PROFILE to persist
```

Completes subcommands, flags, `completion <shell>`, `tokens revoke`, and even your saved context
names for `--context`. Inside `chat`, **TAB** completes slash-commands (`/help /catalog /tasks
/whoami /history /session /new /clear /exit`).

> zsh completion is emitted and syntax-checked but has **not** been executed on a real zsh —
> see the backlog. bash and PowerShell are verified through their own completion engines.

## Scripting

`stdout` carries only the answer (or `--json`), so it pipes cleanly. Status notes and the banner go
to stderr / interactive terminals only, and color auto-disables when piped or when `NO_COLOR` is set.

```bash
swarm-cli ask "summarize today's inbox" | mail -s digest you@example.com
swarm-cli ask "any tickets stuck?" --json | jq -r .answer
```

Exit codes: `0` ok · `1` request/server error · `2` auth/config error · `3` timed out waiting.

## Environment

| Var | Meaning |
|---|---|
| `OSHAL_API_URL` | controller base URL (default `http://localhost:35457`) |
| `OSHAL_CLI_TOKEN` | personal access token |
| `SWARM_SERVICE_SECRET` + `OSHAL_USER_SUB` | trusted-service auth (bots; bootstrap only for humans) |
| `OSHAL_CLI_STATE_DIR` | where contexts + thread state live (default `~/.oshal`) |
| `NO_COLOR`, `FORCE_COLOR` | disable / force color |

Runbook: [`docs/runbooks/headless-swarm-cli.md`](../../docs/runbooks/headless-swarm-cli.md).
Live proof: `docs/evidence/swarm-cli-live-2026-07-12.md`.
