# Unreal Engine MCP worker — next steps / where we left off

**Last updated:** 2026-07-23
**Owner:** the operator
**Status:** Referenced upstream (de-vendored 2026-07-23) + wired by inspection. No live run yet (this machine has no UE/GPU). First worker bring-up is the next action.

Related: [ADR-051](../adr/051-unreal-engine-mcp-worker.md) · [remote-client architecture](../architecture/remote-client-architecture.md) · memory `unreal-mcp-integration`.

---

## TL;DR

The swarm will drive Unreal Engine on a remote GPU worker PC. We chose **chongdashu/unreal-mcp** and wired the remote-client preset so a worker becomes an "Unreal worker" with env vars only — no registry code change. The MCP is **referenced from upstream, not vendored** — the worker clones it at bring-up (de-vendored 2026-07-23 for licensing reasons; see [ADR-051](../adr/051-unreal-engine-mcp-worker.md)). Nothing has been run against a real editor yet.

---

## Done (verified by inspection)

- **Chose** chongdashu/unreal-mcp (referenced from upstream — the worker clones `https://github.com/chongdashu/unreal-mcp` into `./unreal-mcp/` at bring-up; NOT vendored into this repo).
- **Registered** as `unrealMCP` in [`config-seed/claude-code-mcp.json`](../../config-seed/claude-code-mcp.json) — `uv --directory ./unreal-mcp/Python run unreal_mcp_server.py`.
- **Wired the worker preset** + operational note in [remote-client architecture](../architecture/remote-client-architecture.md). Registry needed no change (it's MCP-agnostic; a worker declares its server via env).
- **ADR-051** written.
- **Memory** updated (`unreal-mcp-integration`).

## Not done

- No commit yet (changes are in the working tree on `main`).
- No live run — UE + plugin never built/launched; the 55557 bridge and tool list are unverified end-to-end.
- No GPU worker endpoint provisioned.
- Per-command MCP allowlist (ADR-029 planned hardening) does not yet include `unrealMCP`.

---

## Next action: first worker bring-up

On the GPU PC that will host Unreal (NOT this machine):

1. **Prereqs:** Unreal Engine 5.5+, Visual Studio with C++ build tools, `uv` (fetches Python 3.12 itself), this repo checked out.
2. **Clone the MCP from upstream** (it is not in this repo): from the repo root, `git clone https://github.com/chongdashu/unreal-mcp` so the tree lands at `./unreal-mcp/` (the path the launch preset expects). Pin to a known-good commit if desired.
3. **Plugin:** copy `unreal-mcp/MCPGameProject/Plugins/UnrealMCP` into the target UE project's `Plugins/` folder.
4. **Build:** right-click the `.uproject` → Generate Visual Studio project files → open `.sln` → build **Development Editor**.
5. **Enable:** open the project, Editor > Plugins > enable **UnrealMCP** (Editor category), restart editor.
6. **Daemon env** (Unreal-worker preset):
   ```bash
   export REMOTE_CLIENT_CONTROL_PLANE_URL="http://<control-plane>:3456"
   export REMOTE_CLIENT_SHARED_SECRET="<secret>"
   export REMOTE_CLIENT_PLATFORM="windows"
   export REMOTE_CLIENT_NAME="unreal-worker"
   export REMOTE_CLIENT_MCP_COMMAND="uv"
   export REMOTE_CLIENT_MCP_ARGS='["--directory","./unreal-mcp/Python","run","unreal_mcp_server.py"]'
   ```
7. **Run** the remote-client daemon ([`scripts/remote-client.ts`](../../scripts/remote-client.ts)) from the repo root with the editor open.

## Verification (how we know it works)

- Daemon logs "Starting local MCP process" then registers with the control plane; `mcpToolCount` > 0 on the client record.
- The UnrealMCP server connects to the editor on TCP **55557** (fails closed if the editor is shut).
- Dispatch a smoke task (e.g. spawn a cube actor) via the swarm and confirm it appears in the editor viewport.

---

## Gotchas / risks

- **Editor must be open** with the plugin enabled before tasks dispatch — tool calls fail closed otherwise (nothing on 55557).
- **The MCP is not in this repo** — `unreal-mcp/` is gitignored and cloned from upstream at bring-up (step 2). To update, re-clone or `git pull` inside the worker's `unreal-mcp/`. Never commit it back into the core tree (it carries MIT + Epic-copyright code incompatible with this repo's AGPL — see ADR-051).
- **Native build dependency** — the C++ plugin needs VS build tools (same class of blocker ADR-029 hit).
- **Path assumption** — the preset uses `./unreal-mcp/Python` relative to the daemon's cwd (repo root). Set `REMOTE_CLIENT_MCP_CWD` if the daemon runs elsewhere.

## Open questions for the operator

- Which GPU PC is the first Unreal worker, and is it already on the Headscale/private overlay?
- Commit these changes now (branch off `main`) or wait until after a live smoke test?
- Should `unrealMCP` go on the ADR-029 MCP-command allowlist before first run, or after we trust it?
