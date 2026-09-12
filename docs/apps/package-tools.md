# Application tools under current user permissions

An installed application can register fixed in-process handlers through `ctx.tools` during
its route factory activation. The manifest must declare `uses: [application-authorization,
package-tools]`, an authorization v1 catalog, and each tool's executor:

```yaml
tools:
  - name: example_records_read
    displayName: Read records
    description: Read records visible to the current user.
    defaultAuthMode: auto
    executor: { executorType: builtin, builtinKey: package }
```

Bind the exact tool name to permissions in the application's authorization catalog. Inside
the factory, register its handler once:

```typescript
ctx.tools.register('example_records_read', async input => {
  // Validate a closed domain input, then use the same authorized service as HTTP.
  return records.read(input);
});
```

The platform requires every declared handler before publishing the activation. Failed
factories roll back their registrations. Deactivation removes handlers and retains a
refusal for their names, so calls cannot fall back to a generic transport. Core names
and the `swarm_` namespace are reserved.

Execution retains the trusted exact issuer and subject, checks the current application
permission and tool approval mode, and enters the non-operator database context. A top-level
`tenantId`, when supplied, selects a business workspace; current verified membership and
the matching permission are still required. The domain service must enforce record and
field permissions and its own closed input schema, just as it does for HTTP.

The registry rechecks permissions and the active registration before returning bounded
JSON. This prevents releasing a result after revocation or unload; it does not roll back a
side effect that already committed. Mutations must use domain transactions and fresh checks
at their write boundary. Use `defaultAuthMode: ask` for changes that require approval.

Run `npm run test:package-tools` for the isolated activation, HTTP/tool parity, tenant,
revocation and approval cases. AI Test Lab registers these under **Authorized application
tools**; registration does not claim that a local runner has executed.

## Jarvis proposals

Jarvis receives only currently authorized tool names, descriptions, bounded deduplicated keywords
from the manifest routing tags and tags, input schemas and workspace
selectors. It may emit one closed `oshal:package-tool` proposal containing `toolName` and `input`.
The controller binds an opaque proposal to the exact user, canonical owned conversation, input
and active package generation for two minutes. Mixed control directives and model-supplied
confirmation are refused. Polling rechecks access before exposing a pending proposal.

The signed-in page executes through the same server tool executor. AUTO is available only when
every permission in the tool's named binding has a read effect and both installed and current
tool metadata permit it. Other operations require review of the exact input and an Approve click.
Execution consumes the proposal once; concurrent or repeated calls cannot repeat the action.

Private output is delivered once into a temporary panel. It is never cached server-side, appended
to chat history, sent back into the model, or broadcast through the conversation stream. The panel
clears on blur or expiry; refreshing requires a new request. `/result` returns no completed bytes,
because record/team/field ownership can change independently of the named tool grant. The package
must still perform fresh domain checks before its own reads, commits and result release.

This controller interaction does not widen the legacy remote/CLI MCP bridge. A fleet secret and
subject cannot invoke a protected tool; that transport still lacks a verified issuer-bearing
user context. No completed result or proposal survives a controller restart.
