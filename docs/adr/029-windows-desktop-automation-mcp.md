# ADR-029: Windows Desktop Automation MCP Server Adoption

**Status:** Accepted  
**Date:** 2026-03-31  
**Author:** maintainer@emeraldcoastsystemsgroup.com  
**Supersedes:** Extends ADR-012 (OS MCP Adoption Strategy)

---

## Context

ADR-012 established the strategy for OS-level desktop control via MCP servers, recommending:
- macOS: `mediar-ai/mcp-server-macos-use`
- Windows: `AB498/computer-control-mcp` (Python/PyAutoGUI)
- Linux: `kurojs/wayland-mcp`

During implementation on a Windows 11 development workstation (2026-03-31), the recommended Windows candidates were evaluated and found to have blocking dependencies:

| Candidate | Blocker |
|-----------|---------|
| `@darbotlabs/darbot-windows-mcp` v1.2.0 | Requires Python 3.12+ (system has 3.11.9) |
| `mcp-control` (MCPControl) | Requires Visual Studio C++ Build Tools for `keysender` native module (node-gyp) |
| `AB498/computer-control-mcp` | Requires Python + PyAutoGUI, not npm-installable |

## Decision

Adopt **`@mseep/mcp-windows-desktop-automation`** v0.1.0 as the Windows desktop control MCP server for local bot deployment.

### Why this package

1. **No native compilation** — Uses `node-autoit-koffi` which is a pure JavaScript FFI wrapper via the `koffi` library. No node-gyp, no Visual Studio Build Tools, no Python required.
2. **Clean npm install** — `npm install -g @mseep/mcp-windows-desktop-automation` completes in ~5 seconds, 97 packages, zero build errors.
3. **AutoIt foundation** — Wraps the battle-tested AutoIt3 Windows automation library via FFI, providing reliable window/mouse/keyboard control.
4. **MCP SDK compliant** — Built on `@modelcontextprotocol/sdk` ^1.7.0, stdio transport.
5. **MIT license** — No licensing concerns for commercial use.

### Verified capabilities

Tested on Windows 11 (build 26200), Node.js v24.11.0:

| Tool | Verified | Description |
|------|----------|-------------|
| `mouseGetPos` | Yes | Returns current mouse coordinates |
| `mouseClick` | Yes | Click at coordinates |
| `mouseMove` | Yes | Move mouse to position |
| `send` | Yes | Send keystrokes |
| `winActivate` | Yes | Bring window to foreground |
| `winGetPos` | Yes | Get window position/size |
| `winGetText` | Yes | Extract window text content |
| `winExists` | Yes | Check if window exists |
| `controlClick` | Yes | Click a specific UI control |
| `controlSetText` | Yes | Set text in a control |
| `run` | Yes | Launch a program |
| `processExists` | Yes | Check if process is running |
| `clipGet` / `clipPut` | Yes | Clipboard read/write |

### Configuration

**Cline MCP settings** (`cline_mcp_settings.json`):
```json
{
  "github.com/mseep/mcp-windows-desktop-automation": {
    "autoApprove": [],
    "disabled": false,
    "timeout": 60,
    "type": "stdio",
    "command": "node",
    "args": [
      "C:\\Users\\the operator\\AppData\\Roaming\\npm\\node_modules\\@mseep\\mcp-windows-desktop-automation\\dist\\index.js"
    ]
  }
}
```

**Security:** `autoApprove` is intentionally empty — all desktop control actions require explicit human approval. This aligns with the ADR-012 principle of "explicit opt-in, no auto-approve" for OS control.

## Deployment Scope

This MCP server is **local-only** — it should only be assigned to bots running on the operator's local machine or edge agents with physical access to a Windows desktop. Container-deployed swarm bots must NOT have this tool.

The tool registry baseline entry uses `deploymentScope: 'local-only'` to enforce this.

## Consequences

### Positive
- Local bots can now control the Windows desktop (mouse, keyboard, windows, clipboard, processes)
- Zero additional system dependencies beyond Node.js
- Consistent with the MCP architecture already used for Playwright, ChromaDB, and other tools
- All actions gated behind human approval

### Negative
- AutoIt-based automation is coordinate-driven rather than accessibility-tree-aware (less semantic than macOS accessibility APIs)
- The `node-autoit-koffi` wrapper is a relatively small project — if it stops being maintained, we may need to switch to a different approach
- FFI through koffi adds a small performance overhead vs native bindings

### Risks
- **R1:** AutoIt may trigger antivirus false positives on some systems (mitigated: well-known automation tool)
- **R2:** `koffi` FFI library updates could break compatibility (mitigated: pin version)
- **R3:** Limited to Windows — cross-platform story still requires per-OS MCP servers per ADR-012

## Future Work

1. Register as a baseline tool in `src/features/tool-registry/services/baseline-tools.ts` with `deploymentScope: 'local-only'`
2. Add OS detection in agent factory to auto-assign the correct OS MCP (macOS vs Windows)
3. Evaluate upgrading to `@darbotlabs/darbot-windows-mcp` once Python 3.12+ is available on the development machine
4. Evaluate `mcp-control` (MCPControl) if Visual Studio Build Tools are installed in the future
5. Build structured audit logging for all desktop control actions
6. Add emergency stop / kill switch capability per ADR-012 security requirements