# Package specialist context

Packages can register a deterministic, caller-scoped facts reader for a dedicated specialist bot.
`BotNodeClient` appends its result before constructing the delegated request signature. The
existing execution, accounting and remote transport boundaries remain in force.

Declare `uses: [application-authorization, specialist-context]` in `oshal-app.yaml`. Cores without
this capability reject the package instead of silently ignoring the context requirement. Register
the reader synchronously from an existing package route factory:

```js
exports.createRoutes = function createRoutes(ctx) {
  ctx.specialistContext.register({
    agentId: 'the-agent-id-declared-by-this-package',
    toolName: 'read-board-counts',
    facts: ['documents.out', 'records.total'],
    read: async function readBoardCounts({ sub, issuer, signal }) {
      return readExistingCallerScopedBoardCounts(ctx.pool, { sub, issuer, signal });
    },
  });
  return existingRoutes(ctx);
};
```

Both executable names must belong to the registering package according to the authorization
runtime. The read must use the package's existing record/capability policy and deterministic
queries. Its input contains only the authenticated subject, verified issuer and cancellation
signal. The model cannot supply a query, URL, connection, credential, substitute actor or reader
name. The package's normal authorization catalog binds the named tool to its read permission;
an app without a catalog retains the explicit app-admin fallback requirement.

The result must have exactly the declared keys, with finite numbers, booleans or null values.
Strings, nested records, getters, undeclared keys and non-finite numbers are refused. There may
be at most 64 keys of at most 64 characters each; numbers have absolute magnitude at most
10^15 and serialized facts have an 8 KiB ceiling. Use descriptive keys and distinguish complete
counts from bounded samples. Names, notes, document text, URLs and credentials do not belong
in this contract.

The controller checks the named read permission before and after the read, under the real caller
with `isOperator: false`. Initial/final read-policy checks and the reader share a two-second
deadline. Composition can set 20–10,000 milliseconds for isolated tests or a reviewed adapter.
The AbortSignal requests cooperative cancellation; a package should also bound its database
queries. A timeout stops delivery but cannot forcibly terminate JavaScript or database work that
ignores cancellation. Late policy completion cannot start the canceled reader.

Bot permission is checked again after facts are prepared. A captured registration is then checked
synchronously before signing/sending, so unmount or replacement during that final policy check
cannot send stale facts. Missing identity, missing/revoked permission, reader failure, malformed
output, reload or timeout prevents dispatch. Package exception details are not returned as facts.

Registrations publish only when their route factories succeed. Failed factories roll back their
contributions; an accepted requirement remains remembered even if its first factory fails. Reload
replaces active readers, and empty routes, disable and uninstall retire them. Superseded activation
stages cannot replace a newer reader. A retired specialist never silently dispatches a bare prompt.

The supported path is the existing dedicated `BotNodeClient`. Registered specialists fail closed
on the inline branch, which has no equivalent context transport. Protected remote application bots
still return `authorization_bot_transport_unavailable` until live signed user-rights revalidation
exists on the node. This change does not authorize a production Sales task or an unattended CLI.

The AI Test Lab references two suites: `tests/unit/specialist-context.spec.ts` (unit) and
`tests/unit/specialist-context-dispatch.spec.ts` (integration). They use temporary installed packages,
the real mounter and policy service with in-memory persistence, and an Ed25519-signed loopback
HTTP receiver. Known-answer fixtures distinguish two owners, independent bot/read grants,
revocation during reads, lifecycle changes, timeout and unsupported inline transport. No customer
database, provider or live model is contacted.
