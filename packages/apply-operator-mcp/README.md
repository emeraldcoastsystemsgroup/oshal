# apply-operator-mcp — browser-control tool for the apply-operator worker bot

The deterministic OS-input hands for the `apply-operator` bot. A stdio FastMCP server that runs on
the **screen-control worker desktop** (the `oshal-chat` node, e.g. `home_01`) and drives the
operator's real, logged-in foreground Chrome with mouse / keyboard / clipboard / native file picker
+ screenshots. **No JavaScript injection, no debug port, no CDP** — those are fingerprinted and put
The operator's account at risk.

This follows the exact same remote-bot pattern as `unreal-mcp/` (a domain MCP tool server loaded on
a worker PC, reached through the OSHAL remote-client). The bot supplies judgement; this tool supplies
the hands. Spec: `docs/intelligent-career-automation/swarm-apply-agent-spec.md`.

## Tools (spec §4)
`shot(label)` · `click(x,y,double)` · `type_text(text)` · `paste(text)` · `key(name)` · `nav(url)` ·
`upload(abs_path)` · `pick_place(query)` · `preflight()`. Coordinates are **monitor-1-relative**
(reason in the screenshot's pixel space); phones / long text go in via `paste`, never `type`.

## Run it on the worker (Windows desktop with Chrome signed in)
This is **not** loaded into the swarm containers (it needs Windows + pywinauto). The remote-client
daemon on the worker launches it, the same way the Unreal worker launches its MCP — set the worker's
MCP-command env so the daemon discovers + exposes these tools:

```powershell
$env:REMOTE_CLIENT_MCP_COMMAND = "uv"
$env:REMOTE_CLIENT_MCP_ARGS     = "--directory ./packages/apply-operator-mcp run browser_control_server.py"
$env:REMOTE_CLIENT_MCP_CWD      = "C:\Projects\open-shal-swarm-harness-agent-llm"
# Multi-monitor: clicks are (APPLY_MON1_X + x, APPLY_MON1_Y + y)
$env:APPLY_MON1_X = "0"; $env:APPLY_MON1_Y = "0"
# then start the remote-client daemon (or the oshal-chat desktop app), which registers this node
# as a swarm worker with `browser_control` in its capabilities.
```

`uv` resolves `pyproject.toml` (mcp + fastmcp + pywinauto) on first run. Standalone smoke test:
`uv --directory ./packages/apply-operator-mcp run browser_control_server.py` then call `preflight`.

## How the swarm reaches it
1. The worker registers as a remote-client; its `browser_control` tool is advertised in its
   capabilities (see `src/features/remote-client/` + `src/app/routes/remote-client-routes.ts`).
2. The career-application queue dispatches an approved, packet-ready submission as a task to the
   worker's `agentId`; the `apply-operator` persona reasons over the screenshots `shot` returns and
   calls the primitives to fill + submit, then records the outcome and appends an `apply_trace` line.
3. Nothing automates submission inside the swarm — only this worker, on the operator's own machine.

## Still needed before a live run (the operator's calls)
- The screen-control worker box up with the `oshal-chat`/remote-client node running + Chrome signed in.
- The three policy decisions from the spec §12: `assist` (human clicks Submit) vs `auto` per-ATS;
  the comp threshold + per-company cooldown numbers; and the auto-create-employer-account policy.
- The companion tools the persona also calls — `career_profile` (canonical values), `apply_queue`
  (claim/record), `email_code` (Gmail code), `apply_trace` — wired per the spec's build order.
