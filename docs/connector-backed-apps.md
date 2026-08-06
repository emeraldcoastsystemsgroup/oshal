# Connector-Backed Apps

**Status:** Current security recipe (2026-08-06)

**Author:** maintainer@emeraldcoastsystemsgroup.com

This guide explains how an oshal application may act on an authenticated user's external account.
It complements [partner-app-registration.md](partner-app-registration.md), which covers the human
partner-registration work, and [addon-developer-guide.md](addon-developer-guide.md), which covers
application composition.

## Non-negotiable boundary

A connector authenticates an exact user-owned account. It does not give a model, bot process, CLI,
workspace, or arbitrary tool general access to that credential.

Connector credentials:

- are encrypted at rest in `oshal_connections` and selected under the authenticated caller;
- are resolved only for an audited `trusted-provider-intent` or `fixed-server-operation`;
- exist only for the duration of that exact server-side operation;
- never enter a prompt, model/CLI environment, task workspace, generic bot request, log, or result;
- never fall back to bot-side database decryption or `SESSION_SECRET` access; and
- are not propagated through Redis, generic HTTP import/export, or runtime configuration payloads.

Unattended Cline, Claude Code, Codex, and Gemini CLI execution is operationally disabled until an
audited oshal-brokered sandbox enforces immutable request-start handler generations and exact
operation scopes while keeping authentication and connector credentials outside the model-visible
process and workspace. OAuth presence does not authorize autonomous execution.

For reasoning, use hosted/BYO inference. For external data or action, use a schema-bounded
deterministic server provider intent or another fixed server operation.

## Current flow

```text
authenticated surface
       |
       | typed request / approved action
       v
controller authorization + exact operation parser
       |
       | resolveServerOperationCreds(
       |   callerSub, exactProviders,
       |   'trusted-provider-intent' | 'fixed-server-operation', selectors)
       v
deterministic server handler ---- minimum credential ----> provider API
       |
       | normalized/redacted result only
       +-------------------------------> hosted/BYO inference or surface
```

The model may choose among capabilities that the server already authorized, but it cannot invent a
command, URL, credential consumer, provider, handler generation, or scope. The server parses the
complete intent and rejects unknown fields before resolving a credential.

## Supported operation shapes

### Trusted provider intent

Use a trusted provider intent when a request must cross the bot-node dispatch seam but does not need
model mediation to call the provider. `src/app/bot-node-provider-intent.ts` owns the current closed
union and exact parser. Each intent has:

- a schema version;
- a fixed `kind` and `operation`;
- exact allowed keys and bounded literal values;
- a dedicated least-privilege agent identity;
- a deterministic handler with no shell or model-authored arguments; and
- a normalized, redacted result record.

Adding a new connector does not automatically add a provider intent. Extend the closed union,
parser, dedicated identity mapping, executor, credential map, and adversarial regression tests as one
reviewable change.

### Fixed server operation

Use a fixed server operation when the authenticated route can call a deterministic adapter directly.
The route derives the caller identity from the authenticated request, validates a closed input
schema, resolves only the named connection, invokes one operation, and returns a redacted result.
The credential must not escape the handler closure or be attached to a later model request.

Mutating or billable operations also need the platform's action/approval gate. Connector ownership is
necessary but does not replace human approval.

## Connector authentication

A connector provider may use OAuth or token entry:

- **OAuth:** the server generates the partner authorization URL, validates single-use state on the
  callback, exchanges the code server-side, and persists access/refresh material under the caller.
- **Token entry:** an authenticated, authorized route validates and stores the token for the caller.
  Never use this shape for a deployment-wide App Secret that belongs in deployment configuration.

Partner App IDs and App Secrets are deployment-managed. Do not store them in browser
`localStorage`, return them from a status route, place them in a manifest, or accept them through an
unscoped bot settings endpoint.

Adding a connector creates a new partner relationship and credential. Record its ownership,
redirects, scopes, review/test-user requirements, and rotation procedure in
[partner-app-registration.md](partner-app-registration.md). A connector is not complete until its
credential drives a real, bounded operation.

## Multi-account selection

The connector store supports multiple connections per provider. `ConnectionSelector` may identify a
connection by label, account email, or connection ID. If no selector is supplied, resolution uses the
marked default deterministically and warns when several accounts exist.

The server—not a prompt—performs selection. A selector that matches nothing produces a visible
not-connected result; it must never silently fall back to a different account.

## Implementation recipe

1. **Register the partner application.** Use the business owner account and document redirects,
   scopes, review gates, test users, and rotation.
2. **Add the connector definition.** Implement OAuth or token persistence under the authenticated
   caller, including refresh and multi-account metadata.
3. **Define one operation.** Give it a versioned closed schema, exact key set, bounded literal values,
   and a named authorization/approval policy. Do not accept a command, arbitrary URL, free-form
   headers, environment map, or filesystem path.
4. **Implement a deterministic handler.** Call the provider client or a directly imported tested
   function. Do not spawn an autonomous CLI or let model output become shell arguments.
5. **Resolve the minimum credential at the last responsible moment.** Call
   `resolveServerOperationCreds` with the authenticated subject, exact provider list, audited purpose,
   and optional selector. Treat an omitted credential as not connected.
6. **Normalize the result.** Return only the fields the surface/model needs. Strip provider secrets,
   raw headers, internal paths, and unbounded error bodies.
7. **Keep inference separate.** If reasoning is needed, pass the normalized result to hosted/BYO
   inference after the provider operation has completed and the credential is out of scope.
8. **Add boundary tests.** Prove wrong-owner, missing-owner, disabled-connector, unknown-field,
   oversized-input, unapproved-write, and missing-credential cases fail before provider I/O. Add a
   source guard proving the credential is not written to a workspace or child environment.
9. **Wire the application package.** Add the persona, manifest, routes, and surface only after the
   operation boundary is working. A persona authorization names the capability; it does not weaken
   the server check.

## Retired pattern (historical; do not copy)

Before the 2026-08-06 containment change, this guide instructed routes to call `resolveBotCreds`,
send `creds`/`OSHAL_CRED_*` into a bot request, write `.oshal-cred-*` files into task workspaces, and
let toolkit wrappers shell `scripts/oshal-*.js`. Some historical ADRs and application revisions may
still describe that architecture.

That pattern is not current implementation guidance. Generic credential carriers are rejected,
workspace credential files are not allowed, direct generic connector CLI execution returns a stable
disabled result, and bot-side database decryption is not a fallback.

## New-connector checklist

- [ ] Partner ownership, callback URI, scopes, test/review gate, and rotation documented.
- [ ] Credential stored under the authenticated caller and encrypted at rest.
- [ ] Multi-account selector/default behavior deterministic and tested.
- [ ] Versioned closed operation schema rejects unknown keys and unbounded values.
- [ ] Exact authorization and any required human-action approval enforced server-side.
- [ ] `resolveServerOperationCreds` called only inside the deterministic handler with an audited purpose.
- [ ] No `creds`, `credentials`, `OSHAL_CRED_*`, or `.oshal-cred-*` model/workspace carrier.
- [ ] No bot-side `SESSION_SECRET`/database fallback and no autonomous connector CLI spawn.
- [ ] Provider response normalized and redacted before it reaches inference or the surface.
- [ ] Hosted/BYO inference used when reasoning is required; OAuth presence is not execution authority.
- [ ] Focused ownership, parser, denial, redaction, and no-side-effect tests pass.

## References

- [ADR-036](adr/036-bot-owned-application-architecture.md) — accountable bot/domain ownership.
- [ADR-042](adr/042-iot-connector-tenancy.md) — multi-account and personal/shared tenancy.
- [building-a-bot.md](building-a-bot.md) — current bot registration and execution limits.
- [SECURITY-HARDENING.md](security/SECURITY-HARDENING.md) — implemented containment controls.
