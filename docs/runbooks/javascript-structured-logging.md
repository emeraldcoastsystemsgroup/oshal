# JavaScript structured logging (ADR-171 D1)

## Contract and compatibility

TypeScript imports `src/shared/logger/pino-config.json`; the real CommonJS adapter at
`any-bot/server/utils/logger.js` requires that same file by a module-relative path.
There is one redaction list, not a copied list. Missing or malformed configuration prevents loading;
there is no search-path/default-config fallback. Both adapters select the same environment level,
service identity, ISO time and Pino `err` serializer. Stdout is JSON even in development.
The TypeScript file transport stays in place; JavaScript no longer writes the old Winston files.

JavaScript callers can retain `log.info(message, metadata)`, `log.error(message, error)`,
native object/Error-first calls, `log.log(level, message, metadata)`, `child(bindings)`,
`level`, and Morgan's `stream.write`. Bind `module` on a child; the root has `module: any-bot`.
Queue-manager `LoggingStandard` keeps its helper signatures and traced return/rethrow behavior.
Known `ticketId`, `agentId`, `runId` and `phase` belong in metadata, never parsed back out of text.
An Error goes in `err` to retain its type, message and stack. Secret-bearing structured keys are
redacted; arbitrary message/stack text and paths deeper than the configured list are not sanitized.
Do not pass credentials in message strings.

Only existing console diagnostics were changed in configuration, Plane initialization,
AgentMetricsService, the CLI boundary and CodexCLIWrapper. Their decisions and side effects are
unchanged. This is not authorization to run any of them or to enable a CLI provider.

## Bounded source checks

With the installed locked development dependencies, Node 24+, one Node process and no provider, database or Docker:

```sh
node --max-old-space-size=384 scripts/check-javascript-logging.cjs
node --max-old-space-size=384 --test --experimental-test-isolation=none --test-concurrency=1 tests/logging/*.test.cjs
```

The normal `scripts/ci-local.sh` now invokes both as the blocking `javascript-logging` gate
against its selected `GATE_SRC` (including the committed export in HEAD mode). There is no allowlist
for console/Winston. The syntax scan refuses console aliases/references, bracket access and logger
imports, and missing or unparseable input fails closed. Fixtures plant actual console and Winston
violations in an owned temporary server tree, require the exact gate to return 1, then restore green.

The integration suite loads the actual JS adapter and LoggingStandard with real Pino and captures
stdout. It checks every configured redact path, child context, legacy calls, levels and errors.
A temporary relocated filesystem with actual installed dependencies proves real Node resolution of
the module-relative shared JSON and failure when that JSON is missing/malformed. Dockerfile source
guards pin the existing full `src/shared` and `any-bot/server` COPY instructions. Both TS builds have
`resolveJsonModule`; the compiler must emit the imported JSON beside the TS logger.
These are source/Node-filesystem proofs, not an image build or container result.

The existing `tests/unit/logger-redaction.spec.ts` remains the TS redaction guard. The Test Lab
`javascript-structured-logging` card links both new suites and that existing suite. Its explicit-only
browser checklist returns a gap until separate container evidence is collected; it cannot read
Docker stdout and does not claim a pass from a catalog entry.

## Exact-image acceptance — not yet run

Run only after a resource slot and the exact committed image build are approved. Do not start the
swarm, overlay or a provider. Use a disposable network-disabled container, no mounts or credentials,
the built immutable image ID, and an overridden Node entrypoint. The literal IDs/secret below are
synthetic fixtures:

```sh
docker run --rm --network none --memory 128m --memory-swap 128m --cpus 1 --no-healthcheck --entrypoint node IMAGE_ID -e 'const log=require("/app/any-bot/server/utils/logger").child({module:"logging-acceptance"});log.info("synthetic proof",{ticketId:"fixture-ticket",agentId:"fixture-agent",token:"fixture-redaction-sentinel"});log.error("synthetic error",new Error("fixture error"));'
```

Capture stdout and parse each complete line as JSON. Require numeric levels, ISO `time`, `msg`,
the named `module`, exact fixture ticket/agent IDs on the info line, `token: "[REDACTED]"`,
absence of the sentinel, and `err.type/message/stack` on the error line. Record exact image ID,
source commit, exit code and cleanup. Also verify compiled `dist/shared/logger/pino-config.json`
exists and matches the source contract in that image. No pretty/plain-text or old Winston fallback
is acceptable. This narrow test does not prove overlay ingestion, retention, search or memory budgets.

## Evidence status

The bounded source/real-module suites passed 13/13 with no skips on 2026-09-29, including both
planted violations turning the exact guard red and restored input green. The migrated metrics
failure test uses a named synthetic Redis failure, not a live Redis connection. Real-module
stdout, error serialization, shared redaction and relocated-package resolution are proven locally.
Full TypeScript builds, committed-HEAD hooks and exact-image/container acceptance remain pending
their coordinated slots. No deployed/backlog closure is claimed.
