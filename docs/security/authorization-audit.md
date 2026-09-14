# Applied authorization change history

Access Administration now shows persisted changes separately from current assignments. The history lists successful grant, revoke, deny, clear-deny and directory mapping operations committed by the shared authorization service. Previewing a change or receiving a denied execution decision does not create an applied-change entry. This is not a complete security event log.

The same read operation is available through `GET /api/authorization/audit` and the code-owned `swarm_authorization_read` tool with `{ "operation": "audit_history", "query": { "app": "app-name", "limit": 25 } }`. It is read-only. Existing interactive preview/apply restrictions remain unchanged.

Every page refreshes the caller's verified identity and rechecks current authority. Application history requires the existing application `read` management scope; a tenant-scoped manager must supply that exact tenant. An omitted application requests all-application history and requires a current swarm administrator. Delegated callers also need `platform:authorization.read` in their attenuation ceiling. A cursor cannot supply identity or authority. Removed applications retain their history, accessible only under current matching scope or swarm administration.

Responses explicitly project audit ID, committed policy revision, timestamp, exact actor issuer/subject, application, tenant, action and affected principal/group/role/permission references. Freeform reasons, approval references, preview payloads, resource values and credentials are omitted. History does not expose application records or execute a business-data adapter. Browser output escapes all identities as text; losing scope clears the visible history.

Pages contain 25 entries by default and permit 1–100. Filtering happens in PostgreSQL before the page limit. A cursor binds the exact caller and filter selection to a revision snapshot and descending revision/ID continuation, so changes arriving later do not shift older pages. Refreshing starts a new snapshot. Cursors are pagination data rather than signed capabilities: all authority and filtering are independently reapplied on every request. Unknown fields and malformed cursors fail closed.

Migration `131-authorization-audit-indexes.sql` adds indexes for global, application and tenant pagination without granting new database privileges. The existing audit ledger remains under forced control-plane row security. Runtime initialization installs the same indexes through the established schema bootstrap policy.

Validation uses `tests/unit/authorization-audit.spec.ts` (real PostgreSQL, HTTP and fixed read tool) and `tests/unit/authorization-audit-browser.spec.ts` (the actual Access page in Chromium). It covers concurrent new entries between pages, durable restart reads, redaction, database row security, application/tenant isolation, malformed cursors, privilege revocation and browser rendering.

Explicit external business-tenant membership changes share this revision and audit ledger under the
reserved `platform-tenant-membership` label. Packages cannot register that name. Reading those entries
requires current swarm administration even when an application manager supplies the reserved label
directly; no delegated application scope exposes platform membership changes. Roster metadata imports
have a separate metadata revision and audit table because they grant no application or tenant authority.
