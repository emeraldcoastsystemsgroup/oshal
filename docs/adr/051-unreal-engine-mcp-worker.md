# ADR-051 — Unreal Engine MCP worker (swarm-driven editor control on a GPU endpoint)

- **Status:** Accepted (referenced upstream — no longer vendored; first worker bring-up pending)
- **Date:** 2026-06-18
- **Author:** maintainer@emeraldcoastsystemsgroup.com
- **Related:** [ADR-012 (OS MCP adoption strategy)](012-os-mcp-adoption-strategy.md),
  [ADR-029 (Windows desktop automation MCP)](029-windows-desktop-automation-mcp.md);
  the remote-client surface ([docs/architecture/remote-client-architecture.md](../architecture/remote-client-architecture.md),
  [src/features/remote-client/](../../src/features/remote-client/));
  the worker-node desktop app ([packages/oshal-chat](../../packages/oshal-chat)).

> **Update 2026-07-23 — de-vendored; reference upstream instead.** The original decision vendored the
> tree into `unreal-mcp/`. That was reversed. Stripping the upstream `.git` at vendoring time also
> stripped its **MIT LICENSE and copyright notice**, so redistributing the copy breached MIT's
> notice-retention clause; and 7 files under `MCPGameProject/` carry **Epic Games** copyright, making
> them **UE-EULA** code that is not redistributable under this repo's **AGPL-3.0**. Nothing in the
> control plane imported the tree — the MCP runs on the GPU endpoint — so the vendored copy bought no
> runtime benefit and only carried third-party redistribution risk. The tree was removed
> (`git rm -r unreal-mcp/`) and `unreal-mcp/` is now gitignored. The worker **clones it from upstream
> at bring-up** into `./unreal-mcp/`, so the launch preset below is unchanged. The MCP itself was never
> proven end-to-end, so nothing working was lost.

## Context

We want the swarm to drive **Unreal Engine** — spawn actors, edit Blueprints, build UMG widgets —
through natural-language tasks. Unreal cannot run in the cloud control plane: it needs a GPU
workstation with the editor open. This is the same shape ADR-029 already solved for Windows desktop
automation: the control plane stays remote, the MCP executes locally on the endpoint, and the
remote-client daemon bridges the two over stdio JSON-RPC.

The candidate landscape (June 2026) includes chongdashu/unreal-mcp, GenOrca/unreal-mcp,
remiphilippe/mcp-unreal, ChiR24/Unreal_mcp, and mirno-ehf/ue5-mcp. They share a two-part design: a
local MCP server process plus a C++ editor plugin the server talks to over a private socket.

## Decision

Adopt **chongdashu/unreal-mcp** as the Unreal Engine MCP server, **referenced from upstream** — the
GPU worker clones `https://github.com/chongdashu/unreal-mcp` into `./unreal-mcp/` at bring-up. It is
**not** vendored into this repo (see the 2026-07-23 update above for why: MIT-notice + UE-EULA
redistribution constraints incompatible with AGPL-3.0).

### Why this one

- Most popular and best-documented of the candidates; broad enough coverage (actors, Blueprints, UMG).
- Standard stdio MCP transport, so it drops straight onto the existing
  [`mcp-stdio-client.ts`](../../src/features/remote-client/services/mcp-stdio-client.ts) bridge with
  no new transport code.
- `uv`-launched, so the endpoint does not need a system Python 3.12 — `uv` fetches the right runtime.

### Architecture

- **MCP server** (`unreal-mcp/Python/unreal_mcp_server.py`, in the worker's upstream clone) —
  speaks MCP over **stdio** to the remote-client daemon; internally bridges to the editor over TCP **55557**.
- **Editor plugin** (`unreal-mcp/MCPGameProject/Plugins/UnrealMCP/`, UE 5.5+, C++) — copied into the
  worker's UE project, enabled in Editor > Plugins, and built (Development Editor).
- **Dispatch** — the swarm reaches the endpoint through the existing remote-client control plane; no
  registry code changes were needed. The registry is server-agnostic — a worker simply declares this
  MCP via its launch config.

### Registration

Recorded canonically in [`config-seed/claude-code-mcp.json`](../../config-seed/claude-code-mcp.json)
as `unrealMCP` (`uv --directory ./unreal-mcp/Python run unreal_mcp_server.py`). An Unreal worker is
provisioned by the env preset in the remote-client architecture doc
(`REMOTE_CLIENT_MCP_COMMAND=uv`, `REMOTE_CLIENT_MCP_ARGS=[...]`, `REMOTE_CLIENT_PLATFORM=windows`).

## Consequences

- The editor must be open with the plugin enabled before tasks dispatch; tool calls fail closed if
  the editor is down (the 55557 bridge has nothing to connect to). This is an operational
  precondition, not a code path — surface it in worker bring-up.
- Building the C++ plugin requires Visual Studio C++ build tools on the worker (same class of
  dependency ADR-029 flagged for native MCP modules).
- Referencing upstream means the worker tracks the plugin's `main` at clone time; pin to a specific
  commit in the bring-up steps if a fast-moving upstream change breaks a worker. This avoids carrying
  a third-party (MIT + Epic-copyright) tree in an AGPL repo — see the 2026-07-23 update.
- Security model is inherited from the remote-client guardrails (private overlay reachability,
  shared-secret gating, MCP execution stays on the endpoint). The planned per-command allowlist from
  ADR-029 should include `unrealMCP` when implemented.

## Status of work

- Referenced (not vendored) and registered. Worker bring-up (clone upstream, install UE + plugin,
  build, run daemon) is pending the first GPU endpoint. Live checklist:
  [unreal-mcp-worker-next-steps.md](../apps/unreal-mcp-worker-next-steps.md).
