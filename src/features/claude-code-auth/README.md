# Claude Code Auth Feature

This feature provides backend and UI wiring for Claude Code provider authentication flows in the OSHAL settings page.

## Public API

- `ClaudeCodeAuthService`
  - `getStatus()` - reads `claude auth status --json`
  - `startLogin(email?)` - starts `claude auth login` and returns discovered browser URL when available
  - `signOut()` - executes `claude auth logout`

## Routes

Mounted at:

- `GET /api/claude-code/auth/status`
- `GET /api/claude-code/auth/start`
- `POST /api/claude-code/auth/signout`

## UI Integration

The provider configuration UI (`/ui`) is patched by `src/api/ui-claude-code-auth.mjs`, which injects sign-in/sign-out controls when the `claude-code` provider is selected.
