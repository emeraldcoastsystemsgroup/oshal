# Headless swarm CLI — talk to Jarvis from a terminal

**`@oshal/swarm-cli`** ([packages/swarm-cli](../../packages/swarm-cli)) is the chat window without
the browser: it drives the **same** endpoints the cockpit Jarvis surface uses
(`POST /api/jarvis/ask` → poll `GET /api/jarvis/ask/result`, plus `/history`, `/catalog`, `/tasks`),
so a terminal turn behaves identically — classify→delegate→synthesize (ADR-050), one persistent
thread per controller+user, handoffs filed as tickets, turns persisted for replay in the browser
surface. Built for headless deployments (servers, containers, CI) where no browser or OIDC session
exists.

A real npm package with **zero dependencies** (Node 18+): `npm install -g ./packages/swarm-cli` and
`swarm-cli` is on your PATH — no checkout required afterwards. It is already installed inside the
image, so `docker exec <container> swarm-cli ask "…"` works out of the box.

**Live proof:** docs/evidence/swarm-cli-live-2026-07-12.md
— 23/23 assertions against the running swarm (including PAT mint → revoke → 401, proving revocation
is enforced), banner/color on a real TTY, and TAB completion driven through bash, PowerShell, and
readline's own engines. Known gaps are in [BACKLOG](../BACKLOG.md) (zsh completion unexecuted).

## Auth — `swarm-cli login` and personal access tokens

The standard path is a real login (the `gh auth login` shape):

```bash
swarm-cli login          # prompts: controller URL, then token OR service secret + sub
```

- **Personal access tokens (PATs)** are the credential humans should hold: `oshal_pat_…`
  strings minted per user, sha256-hashed at rest in `oshal_cli_tokens`, revocable
  (`swarm-cli tokens`, `swarm-cli tokens revoke <id>`), auditable (`last_used_at`), and
  sent as `Authorization: Bearer …`. The server middleware resolves a PAT to its owner's
  identity, so **every** `requiresAuth` route accepts it — RLS, ownership, and operator
  checks all see the token's owner.
- **Bootstrap** (`swarm-cli login --secret`): an **operator** login with the service
  secret + sub **mints a PAT and stores that** — the machine-wide secret is never written
  to disk. As of PR #83 this session-less path is **operator-only** (the asserted sub must
  be on `OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`; a non-operator sub gets
  `403 operator_required`) and the minted token is **time-boxed** by
  `OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS` (default 30 days). The earlier "not an escalation —
  the secret already implies full impersonation" reasoning was retired: every bot container
  carries `SWARM_SERVICE_SECRET` and a bot is prompt-injectable, so an unbounded bootstrap
  mint was a permanent cross-user credential (see [SECURITY-HARDENING.md](../security/SECURITY-HARDENING.md)
  item 10). Guard: `tests/unit/cli-token-auth.spec.ts`.
- **Operator note — the 30-day re-login.** Because a bootstrap PAT now expires, a headless
  or CI node that logged in via `--secret` must re-run `swarm-cli login` roughly every 30
  days; a sudden 401 on a previously-working node is usually the bootstrap token expiring,
  not a server fault. Raise `OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS` to lengthen the window, or
  mint a token from a cockpit **session** (which stays non-expiring) and carry that instead.
- Credentials live in kubeconfig-style **contexts** (`<stateDir>/config.json`, 0600).
  `--context <name>` targets others; `swarm-cli logout` forgets one. Precedence:
  **flags > env (`OSHAL_CLI_TOKEN`, `SWARM_SERVICE_SECRET`+`OSHAL_USER_SUB`,
  `OSHAL_API_URL`) > current context**.
- `swarm-cli whoami` shows what the server resolves you to — the login verifies against
  the same endpoint (`GET /api/cli-tokens/whoami`).
- Local dev with `MOCK_OIDC=true` needs nothing — the server injects the mock user.

Raw trusted-service headers (`X-Service-Secret` + `x-oshal-user-sub`, the message-routes /
`/api/graph` pattern, honored by `/api/jarvis` as of 2026-07-11) remain for **internal
bots**; humans should hold a PAT, not the master secret.

## Install

It is a real, zero-dependency npm package — [`packages/swarm-cli`](../../packages/swarm-cli)
(`@oshal/swarm-cli`). Install it globally from a checkout:

```bash
npm install -g ./packages/swarm-cli     # puts `swarm-cli` on your PATH
swarm-cli version
```

That is the whole install: no dependency tree (a global install of the repo *root* would drag in
express/pg/etc — wrong for a client), and no checkout needed afterwards. `npm link` from the package
dir gives a live-editable binary for development. Remove with
`npm uninstall -g @oshal/swarm-cli` (credentials in `~/.oshal` survive; delete that dir to clear them).

**Inside containers it is already installed** — the image runs `npm install -g ./packages/swarm-cli`,
so `docker exec <container> swarm-cli ask "…"` works with no path juggling.

The package is `private: true`, so it cannot reach npm by accident. Publishing is an operator
decision: flip `private` to `false`, then `npm publish --access public`.

## Use

```bash
swarm-cli login                      # sign in once (mints a PAT; see Auth below)

swarm-cli ask "what's on my calendar today?"
swarm-cli chat        # interactive REPL: TAB completes, /help inside
swarm-cli history     # replay the current thread
swarm-cli catalog     # what Jarvis can reach
swarm-cli tasks       # durable handed-off work + results
```

Flags: `--url --token --secret --sub --context --session <id> --new --json --timeout <sec>
--poll <ms> --quiet --no-banner` (see `swarm-cli help`).

## Terminal polish

- **Banner + color.** `chat` and a successful `login` print an OSHAL banner (UTF-8 block
  art, pure-ASCII fallback on non-UTF-8 locales / legacy Windows console). Output is
  colored in a real terminal. Both auto-disable when stdout is **not** a TTY (piped,
  redirected, CI), and honor `NO_COLOR` and `TERM=dumb`; `--no-banner` suppresses the
  banner, `--quiet` suppresses it and the status notes. stdout stays answer/JSON-only, so
  `swarm-cli ask … | jq` is never polluted.
- **REPL slash-commands** (`chat`): `/help /catalog /tasks /whoami /history /session /new
  /clear /exit`. Press **TAB** to complete a slash-command.
- **Shell tab-completion** for `swarm-cli <TAB>` at your normal prompt — the standard
  `completion <shell>` pattern (like gh/kubectl):

  ```bash
  # bash
  eval "$(swarm-cli completion bash)"                          # this shell
  swarm-cli completion bash | sudo tee /etc/bash_completion.d/swarm-cli   # persist
  # zsh
  swarm-cli completion zsh > "${fpath[1]}/_swarm-cli"          # then restart zsh
  # PowerShell (Windows)
  swarm-cli completion powershell | Out-String | Invoke-Expression
  ```

  The scripts complete subcommands, global flags, `completion <shell>`, and `tokens
  revoke`; `--context` even completes your saved context names. They live in
  `packages/swarm-cli/completions/*.{bash,zsh,ps1}` and are printed verbatim by the CLI.

Behavior notes:

- **Threads persist.** Consecutive `ask` invocations continue one conversation (the
  thread id is stored per controller+user in `~/.oshal/swarm-cli-state.json`, like the
  browser's localStorage id). `--new` starts a fresh thread; `--session <id>` pins one
  explicitly. The same thread is visible in the browser Jarvis surface and vice versa.
- **stdout is the answer**, status notes go to stderr — safe to pipe. `--json` prints
  the full result object (answer, dispatched work, visual metadata) for scripting.
- **Big asks hand off.** When Jarvis decides a request is real work, the CLI prints the
  handoff note and the ticket rides the normal queue; check `swarm-cli tasks` later.
- Exit codes: `0` ok · `1` request/server error · `2` auth/config error · `3` timed out
  waiting (the job may still finish server-side — see `tasks`).

## WSL notes

Install it the normal way — `npm install -g ./packages/swarm-cli` from a checkout (Node ≥18;
`apt-get install nodejs` on Ubuntu 24.04). One WSL-specific gotcha remains:

- **`localhost` does not forward into a NAT-mode WSL distro.** The controller listens on the
  *Windows host*, reachable from the distro at its default-gateway IP — and that IP **changes across
  WSL restarts**, so don't hardcode it. Resolve it at run time and pass it (or set `OSHAL_API_URL`):

  ```bash
  export OSHAL_API_URL="http://$(ip route show default | awk '{print $3; exit}'):35457"
  swarm-cli login
  ```

  (An earlier build used a hand-rolled `~/.local/bin` wrapper that did this automatically; the npm
  package supersedes it — delete any old wrapper to avoid two `swarm-cli` binaries on PATH.)

If `wsl -d <distro>` fails with `Wsl/Service/CreateInstance/0x8007274c` (connection timeout) while
management commands still work: `tailscale down` is NOT enough (the tailscaled WFP filters persist),
and per-distro `wsl --terminate` doesn't help either — **`wsl --shutdown` is what clears it**. That
kills the docker-desktop VM too, i.e. the whole OSHAL stack: recover with
`bash scripts/oshal-up.sh`. The `\\wsl.localhost\...` file bridge keeps working throughout, so
file-only deployment is possible even while exec is wedged.

## Relation to the other "remote" pieces

- **`@oshal/chat` (packages/oshal-chat)** is the Electron edge node: swarm→node A2A
  worker + a windowed chat. The CLI is the opposite direction — terminal→Jarvis — with
  no install, no Electron, no registration loop.
- **`scripts/oshal-*.js`** are per-provider tool CLIs that bots shell out to; this file
  is deliberately named `swarm-cli.js` so Jarvis's tool-catalog scan (`oshal-*.js`)
  doesn't pick up the chat client as a callable tool.

## Tests

`tests/unit/swarm-cli.spec.ts` (vitest) proves the endpoint contract against a stub
controller: auth headers, ask→poll→answer, thread persistence/rotation, the
OIDC-redirect → exit-2 path, job errors, poll timeout.
