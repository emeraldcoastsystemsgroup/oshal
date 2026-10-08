# Native runtime logging

Open `/cockpit/?app=logs` on a native kernel deployment. Log reads and logging settings require the current kernel administrator role or the configured root identity. A normal user sees an access refusal; the screen does not turn a refused request into empty history.

The screen filters by severity, module, trace ID, ticket ID, text and time. Expand a row to inspect its safe correlation fields. Selecting a trace or ticket in a row applies that filter. "All retained" means the records currently in the bounded recent buffer, not a complete permanent history. The status shows evictions and oversized records omitted; the buffer resets when the daemon restarts. The durable cost ledger remains separate and authoritative.

Expand **Logging settings** to choose `error`, `warn`, `info`, `debug` or `trace`. The default is `info`. Module overrides use one `module=level` per line; choose a module listed by the module filter. For example:

```text
oshald.inference=debug
oshald.rag=trace
```

**Apply levels** sends the last acknowledged configuration as a precondition. A stale screen receives HTTP409 and must reload before applying. The effective settings display changes only after a valid server acknowledgement. Diagnostic changes take effect on subsequent events without restart and are persisted before being applied. Audit, admission, refusal and cost records stay enabled at every verbosity setting.

Trace breadcrumbs cover current bot/provider selection, recall, inference attempts, tool execution and turn completion. They carry identifiers, counts, outcomes and durations. They exclude raw prompts, responses, tool arguments, headers and credential values, including at trace level. The sealed observer boundary and the closed diagnostic schema are complementary controls; neither is a promise that arbitrary free text can be made safe automatically.

API contracts:

- `GET /api/v1/logs/query`: bounded records and actual retention metadata.
- `GET /api/v1/logs/modules`: supported module names.
- `GET /api/admin/logging`: effective configuration and mandatory-audit status.
- `PUT /api/admin/logging`: validated `level`, `module_levels`, and optional `expected_config` conditional update.

The existing AI Test Lab has an explicit **Native traces and administrator log levels** card. Its two steps only read using the initiating session; they do not change log levels. Browser fixtures test the shipped screen with an isolated HTTP double and do not establish native authentication or durable persistence. Native backend tests and the source-pinned private development acceptance provide those separate checks.

Source verification: `tests/unit/logging-native-screen.spec.ts`, `tests/unit/test-lab-native-logging.spec.ts`, and `tests/unit/logging-native-browser.spec.ts`. Deployment status must be taken from the exact running `/version` and the matching acceptance receipt, not this guide.
