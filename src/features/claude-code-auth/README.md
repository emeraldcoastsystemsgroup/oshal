# Claude Code Auth Feature

This feature provides backend and UI wiring for Claude Code authentication diagnostics and
operator-led login/logout flows in the oshal settings page. Authentication presence is not
authorization for unattended model execution.

## Public API

- `ClaudeCodeAuthService`
  - `getStatus()` - reads `claude auth status --json`
  - `startLogin(email?)` - starts `claude auth login` and returns discovered browser URL when available
  - `signOut()` - executes `claude auth logout`

## Routes

Mounted at:

- `GET /api/claude-code/auth/status`
- `GET /api/claude-code/auth/start`
- `POST /api/claude-code/auth/submit-code`
- `POST /api/claude-code/auth/signout`
- `GET /api/claude-code/auth/credentials`
- `POST /api/claude-code/auth/import`
- `GET /api/claude-code/auth/callback` (public, OAuth-state-bound callback)

## Authorization boundary

Claude Code credentials are shared platform/node credentials, not tenant credentials. Browser
status, start, code submission, sign-out, and credential diagnostics require an exact operator.
The diagnostics response reports presence/auth-method metadata and never returns access or refresh
tokens. Controller routes never accept the fleet secret; this prevents a compromised bot from
promoting credentials back into the control plane.

Raw credential distribution is disabled on every transport:

- Controller `POST /api/claude-code/auth/import` returns HTTP 409 with `imported: false` — the one
  exception is the demo portal fallback below, which is the operator adopting their own login on
  their own deployment, not a distribution rail.
- The bot-node import target requires the exact configured `X-Service-Secret` but is read-only and
  returns `imported: false`; it never copies a credential or reveals a filesystem path.
- Controller fleet propagation returns HTTP 409 when machine authentication is configured and
  refuses earlier when it is not safely configured.
- Redis credential broadcast is disabled. Pub/sub has neither durable ordering nor a monotonic
  revocation tombstone, so a delayed event could otherwise restore a key after sign-out.

Credentials can exist only in the node's local authentication persistence or a deployment-mounted
read-only credential file. There is no HTTP or Redis raw import/export path. Re-enabling
distribution requires a versioned, ordered rail with monotonic revocation tombstones.

### Demo portal fallback (ADR-137 amendment A)

A `DEMO_MODE` deployment is one person's own machine(s), and that person's vendor logins are the
deployment's brain (ADR-127). When the browser lives on a satellite rather than the swarm host,
`claude auth login` runs there — the vendor CLI listens on its own localhost redirect, exactly as
the VS Code extension does — and the `@oshal/chat` node pushes the file it wrote to
`POST /api/claude-code/auth/import` under the operator's verified OIDC session. The controller
adopts it into its mounted login path only when BOTH ADR-127 gates hold: `DEMO_MODE` truthy and
the exact `OSHAL_OPERATOR_SUBS` subject. It validates the `claudeAiOauth` shape, writes atomically
at 0600, and answers 409 `claude_credentials_path_read_only` when the mount is read-only
(`CLAUDE_AUTH_MOUNT_MODE=rw` opts the deployment in). Off demo, or for anyone else, the 409 above
stands. Codex has the same shape through `POST /api/openai-codex/oauth/import`, whose operator
platform promotion already writes the live `~/.codex/auth.json`.

The presence of a mounted OAuth file or a successful status response does not authorize autonomous
Cline, Claude Code, Codex, or Gemini CLI work. Unattended CLI execution is operationally disabled
until an audited oshal-brokered sandbox enforces immutable request-start handlers and exact operation
scopes while keeping credentials outside the model process and workspace. Use hosted/BYO inference
or a schema-bounded deterministic server provider intent instead.

## UI Integration

The provider configuration UI (`/ui`) is patched by `src/api/ui-claude-code-auth.mjs`, which injects sign-in/sign-out controls when the `claude-code` provider is selected.
