# A2A Sample Agent (foreign / non-OSHAL)

A **standalone** [A2A protocol](https://a2a-protocol.org) agent used as the independent
counterparty in the OSHAL A2A gateway end-to-end proof (BACKLOG "Plan F" done-when).

It is **deliberately not OSHAL code**: zero imports from this repository, zero npm
dependencies, only Node built-ins (`node:http`, `node:crypto`). That independence is the
point — it exercises OSHAL's inbound and outbound A2A surface exactly the way a real
third-party agent would, with no shared code smoothing over a protocol mismatch.

## What it does

- Serves its own **agent card** at `GET /.well-known/agent-card.json` (JSONRPC transport).
- Answers **JSON-RPC 2.0** at `POST /a2a` (or any POST):
  - `message/send` — does **real deterministic work** on the delegated task text
    (word/line/char counts, a `sha256` checksum, sorted unique tokens, and top-level JSON
    key sorting when the input carries a JSON block), caches the finished task, and returns
    a `working` task handle.
  - `tasks/get` — returns the completed task with the computed **artifact** and honest
    **usage** metadata (`inputTokens`, `outputTokens`, `totalCostUsd`).
  - `tasks/cancel` — marks a known task `canceled`.

The work is not an echo — every returned field is a computed measurement or transform, so a
caller can independently recompute and assert it.

## Run

```bash
node tools/a2a-sample-agent/server.js --port 41241
```

It binds `127.0.0.1` only. Verify:

```bash
curl -s http://127.0.0.1:41241/.well-known/agent-card.json
curl -s -X POST http://127.0.0.1:41241/a2a \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"parts":[{"kind":"text","text":"hello world hello"}]}}}'
```

## Used by

`tests/a2a-gateway-e2e.spec.ts` spawns this server as a child process (killed in
`afterAll`) and drives OSHAL's outbound `A2AHarnessAdapter` against it over a real
JSON-RPC round trip — proving the computed artifact returns and the cost/attribution path
is invoked with this agent's real usage numbers.
