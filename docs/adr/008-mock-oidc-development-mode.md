# ADR 008: Mock OIDC Development Mode

## Status
Accepted

## Date
2026-03-08

## Context

The OSHAL project uses Keycloak as its OIDC identity provider for authentication. Running Keycloak requires Docker Compose with the `keycloak` service, realm configuration, and network setup. This creates a significant barrier for local development and testing:

- Developers must run `docker-compose up keycloak` before starting the app
- Keycloak takes 30-60 seconds to boot and initialize the realm
- Docker split-horizon DNS issues require HTTP request patching workarounds
- CI/CD pipelines need Keycloak containers for any test that touches authenticated routes
- The `.clinerules/human-testability.md` rule mandates that the system must be locally testable at every handover point

## Decision

Implement a `MOCK_OIDC` environment variable that, when set to a truthy value (`true`, `1`, `yes`), bypasses the real OIDC middleware and injects a fake authenticated user session into every request.

### Implementation Details

- The mock middleware lives in `src/shared/middleware/oidc.ts` alongside the real implementation
- `createOidcMiddleware()` checks `MOCK_OIDC` at initialization time and returns either mock or real middleware
- The mock injects a `req.oidc` object with `isAuthenticated()` returning `true` and a static mock user
- A warning is logged at startup when mock mode is active
- The `/api/user` endpoint works in both modes, returning the current user

### Mock User Profile
```json
{
  "sub": "mock-user-001",
  "name": "Dev User",
  "email": "dev@localhost",
  "preferred_username": "devuser"
}
```

## Consequences

### Positive
- Developers can run the full app with `MOCK_OIDC=true npm run dev` — no Keycloak needed
- Playwright tests can run without Docker Compose infrastructure
- Faster development cycle (no 30-60s Keycloak boot wait)
- Compliant with `.clinerules/human-testability.md` requirements

### Negative
- Risk of accidentally deploying with `MOCK_OIDC=true` in production (mitigated by prominent warning log)
- Mock user doesn't exercise real token refresh, session expiry, or OIDC flows
- Tests running in mock mode don't validate real authentication behavior

### Mitigations
- Console warning at startup: `🔓 MOCK OIDC MODE ENABLED — authentication is bypassed`
- Future: Add production environment guard to prevent mock mode in `NODE_ENV=production`
- Maintain separate E2E test suite that tests with real Keycloak (Docker Compose)