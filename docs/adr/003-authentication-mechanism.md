# ADR 003: Authentication Mechanism — API Key (Bearer Token)

## Status
Accepted

## Date
2026-03-07

## Context
The API configuration server (`src/api/server.js`) exposes REST endpoints for reading, writing, and deleting configuration data including API keys and secrets. Prior to this decision, anyone with network access to port 3456 could access all endpoints without authentication.

For a production swarm system, authentication is needed to:
- Prevent unauthorized access to stored secrets
- Enable audit trails for configuration changes
- Support future multi-user/multi-agent credential stores
- Protect admin operations (delete, migrate)

### Options Evaluated

| Approach | Complexity | Dependencies | Statefulness | POC Fit |
|----------|-----------|-------------|-------------|---------|
| **API Key (Bearer)** | Low | None | Stateless | Yes Best |
| JWT Tokens | Medium | jsonwebtoken | Stateless | ⚠️ Over-engineered |
| Session-based | Medium | express-session | Stateful | No Wrong pattern |
| OAuth2 | High | Multiple | Stateful | No Over-engineered |

## Decision
Use **API Key authentication via Bearer token** in the `Authorization` header.

### Implementation Details
- API key configured via `AUTH_API_KEY` environment variable
- When `AUTH_API_KEY` is not set, authentication is **disabled** (backward compatible)
- Clients send `Authorization: Bearer <api-key>` header with API requests
- Authentication applies only to `/api/*` routes; static files remain open
- `OPTIONS` requests bypass auth (CORS preflight)
- Timing-safe comparison (`crypto.timingSafeEqual`) prevents side-channel attacks
- 401 responses include `WWW-Authenticate: Bearer realm="api"` header per RFC 6750

### Architecture
- `src/api/auth-middleware.js` — Self-contained auth module with `createAuthGuard()` factory
- Guard integrated into `server.js` request router before API route dispatch
- UI (`ui.html` + `ui-logic.js`) provides API key input stored in `localStorage`

## Consequences

### Positive
- Zero external dependencies (uses Node.js `crypto` built-in)
- Backward compatible — existing deployments without `AUTH_API_KEY` are unaffected
- All existing tests continue to pass without modification
- Simple mental model consistent with how LLM API keys work
- Timing-safe comparison provides security against timing attacks

### Negative
- Single shared key (no per-user keys or roles)
- No automatic key rotation mechanism
- API key transmitted in plaintext over HTTP (production should use HTTPS)
- No rate limiting or brute-force protection

### Future Migration Path
- Upgrade to JWT when multi-user/role support is needed
- Add rate limiting middleware when exposed to untrusted networks
- Add key rotation endpoint in a future session
- HTTPS enforcement should be added at the reverse proxy layer