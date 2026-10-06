# Unreal Engine MCP worker — next steps / where we left off

**Last updated:** 2026-10-05
**Owner:** the operator
**Status:** Decision amended ([ADR-051](../adr/051-unreal-engine-mcp-worker.md) Amendment 1): ChiR24/Unreal_mcp on a
Windows satellite PC. No worker PC yet, so nothing has run against a real editor. On the DGX Spark itself, the 3-D
option is the store package `scene-studio` (Godot + Blender), which is live.

Related: [ADR-051](../adr/051-unreal-engine-mcp-worker.md) · [remote-client architecture](../architecture/remote-client-architecture.md)

---

## TL;DR

Unreal cannot run on the Spark (no Unreal Editor for Linux ARM64), so it runs on a separate Windows PC, the
"satellite", driven by the remote-client daemon. The MCP is **ChiR24/Unreal_mcp** (MIT, UE 5.0–5.8, actively
maintained), pinned to its stable npm release `unreal-engine-mcp-server@0.5.30` and the matching
*McpAutomationBridge* plugin release. Epic's experimental UE 5.8 Unreal MCP plugin is the fallback.
`chongdashu/unreal-mcp` is dropped (no commit since April 2025).

---

## Done

- Decision amended (ADR-051 Amendment 1, 2026-10-05), with the satellite-PC spec.
- The dead `unrealMCP` entry (chongdashu, `uv`) removed from `config-seed/claude-code-mcp.json`: it could not
  start in the control-plane containers, and the Unreal MCP runs only on the worker.
- The remote-client preset updated for ChiR24 (see the [remote-client architecture](../architecture/remote-client-architecture.md)).
- The Spark-side counterpart shipped: `scene-studio` (oshal-applications #422, #423).

## Not done

- No satellite PC yet; Unreal, the plugin and the bridge have never run against an editor here.
- **No concierge can call a worker's MCP tools yet** (verified 2026-10-05). The queue carries `mcp.call-tool` to a
  worker, but no bot-facing tool picks a worker tool, and the server-side executor refuses `executorType: mcp`.
  The first bring-up needs a caller: route-backed package tools that enqueue on the worker (the `scene-studio`
  pattern), or a generic remote-MCP tool in core.
- The planned per-command MCP allowlist (ADR-029) has no entry for the Unreal server.

---

## The satellite PC

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 11 (Windows 10 22H2 works) | Windows 11 |
| CPU | quad-core x64 | 8–16 cores (Ryzen 9 9900X class) |
| Memory | 32 GB | 64 GB |
| GPU | 8 GB VRAM, RTX 20-series or newer | RTX 5070 Ti 16 GB or RTX 5080 |
| Disk | SSD | 2 TB NVMe |
| Build tools | Visual Studio with the C++ game-development workload | same |

## Next action: first worker bring-up (on the satellite PC)

1. **Install** Unreal Engine 5.x (5.5–5.8) from the Epic Games Launcher, Visual Studio with the C++
   game-development workload, Node.js 20.19+, and a checkout of this repo (for the daemon).
2. **Plugin:** download the `McpAutomationBridge` plugin from the
   [ChiR24/Unreal_mcp releases](https://github.com/ChiR24/Unreal_mcp/releases) **for the same version as the npm
   server (0.5.30)**, and copy the `McpAutomationBridge` folder into the project's `Plugins/`. A Blueprint-only project
   needs C++ added once (or a prebuilt plugin for the exact engine version).
3. **Build and enable:** open the project and let Unreal build the plugin (or build *Development Editor* in Visual
   Studio). The status bar shows the plugin's state.
4. **Enrol the PC as a device:** in the cockpit (signed in as the owner), enrol a node with `POST /api/join/enroll`. Keep
   the returned token (`enrollment.token`) and client id (`enrollment.nodeClientId`) on the PC only.
5. **Daemon environment:**
   ```powershell
   $env:REMOTE_CLIENT_CONTROL_PLANE_URL = "https://<control-plane>"
   $env:REMOTE_CLIENT_CONTROL_PLANE_TOKEN = "<enrollment.token>"
   $env:REMOTE_CLIENT_ID = "<enrollment.nodeClientId>"
   $env:REMOTE_CLIENT_PLATFORM = "windows"
   $env:REMOTE_CLIENT_NAME = "unreal-worker"
   $env:REMOTE_CLIENT_MCP_COMMAND = "npx"
   $env:REMOTE_CLIENT_MCP_ARGS = '["-y","unreal-engine-mcp-server@0.5.30"]'
   $env:UE_PROJECT_PATH = "C:/Path/To/YourProject"
   ```
6. **Run** the remote-client daemon ([`scripts/remote-client.ts`](../../scripts/remote-client.ts)) with the editor open.

## Verification (how we know it works)

- The daemon logs "Starting local MCP process", registers, and the client record shows `mcpToolCount` > 0.
- The server finds the plugin on `127.0.0.1:8090` with the project's capability token; with the editor closed, tool
  calls fail closed.
- A smoke `mcp.call-tool` (spawn a light above the origin) appears in the editor viewport, then — once a caller exists
  (see *Not done*) — the same from a concierge.

---

## Gotchas / risks

- **Editor must be open** with the plugin enabled; the server has nothing to connect to otherwise.
- **Match the versions.** A 0.5 server does not match a 0.6 plugin; move both together.
- **Loopback only.** The plugin listens on `127.0.0.1` with a per-project capability token; keep it that way (the
  daemon runs on the same PC, and the control plane is reached outbound).
- **The 0.6 line** (one `unreal` tool, about 400 capabilities) is a beta; revisit the pin when it is released stable.
