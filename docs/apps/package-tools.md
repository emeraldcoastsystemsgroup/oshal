# Application tools under current user permissions

An installed application can register fixed in-process handlers through `ctx.tools` during
its route factory activation. The manifest must declare `uses: [application-authorization,
package-tools]`, an authorization v1 catalog, and each tool's executor:

```yaml
tools:
  - name: example_records_read
    displayName: Read records
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
