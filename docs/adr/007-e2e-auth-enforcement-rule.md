# ADR 007: E2E Authentication Enforcement Rule

## Context

During E2E development, Playwright tests reported "passing" even when the server was not enforcing authentication and the UI was accessible to unauthenticated users. This occurred because the tests did not explicitly assert authentication/redirect behavior, and the server's OIDC logic was not triggered due to misconfiguration or route order. As a result, both automated tests and manual browser checks failed to catch the lack of real authentication enforcement.

## Decision

**New Rule:**  
No authentication or security-sensitive feature is considered complete until both:
1. Automated E2E tests explicitly assert authentication/redirect behavior and fail if enforcement is missing.
2. A manual browser check is performed and a screenshot or log artifact is attached to prove real-world enforcement.

All E2E test PRs must include:
- Assertions for redirect/auth enforcement (e.g., expect 302/redirect, not just page load).
- A screenshot or log from a manual browser session showing the redirect or access denial for unauthenticated users.

## Consequences

- Prevents false positives in test reporting for authentication and security flows.
- Ensures that both automated and manual validation are required for completion.
- Reduces risk of shipping features that appear secure in tests but are not enforced in production.

## Status

Accepted and required for all future authentication/security-sensitive E2E work.