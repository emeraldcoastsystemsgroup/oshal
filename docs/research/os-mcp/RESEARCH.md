# OS-Control MCP Research

## Objective

Find an MCP server that can control the operating system at the mouse/keyboard level, or determine the best foundation for building one under `os-mcp/`.

## Candidate summary

| Candidate | Platform fit | Strengths | Risks / gaps | Recommended use |
|---|---|---|---|---|
| `mediar-ai/mcp-server-macos-use` | macOS | Active, Swift-based, accessibility-tree traversal after actions, strong “computer use” focus | GitHub metadata reported `NOASSERTION` license, so adoption needs license review before vendoring | **Best immediate prototype target for local macOS** |
| `aerocristobal/MCP-MacOSControl` | macOS | MIT license, Swift native, broad tool surface (mouse, keyboard, OCR, windowing, capture) | Lower adoption signal and less obvious ecosystem momentum | **Best reference for an in-house macOS build** |
| `AB498/computer-control-mcp` | Cross-platform/Python | MIT license, good activity, includes OCR/screenshot support, simple install via `uvx` | PyAutoGUI is more coordinate-driven and less semantically aware than macOS accessibility APIs | **Best cross-platform fallback** |
| `tanob/mcp-desktop-automation` | Node/desktop | MIT, npm-friendly, RobotJS-based, simple for JavaScript environments | Native addon friction and README notes screenshot payload size limitations | Good lightweight spike if Node-only is required |
| `hathibelagal-dev/mcp-pyautogui` | Cross-platform/Python | Straightforward PyAutoGUI wrapper, packaged on PyPI | GPL-3.0 may be a licensing concern for direct incorporation | Research reference only unless GPL is acceptable |
| `barry-ran/QuickDesk` | Remote desktop | Remote-computer control story, built-in MCP server, good if the target machine is remote | Larger product surface than we need; not a small local MCP | Best option if remote control becomes the real requirement |
| `jagjerez-org/desktop-mcp-server` | Remote/WebRTC | Explicit remote desktop architecture with screen/input/audio | Immature signal and unclear licensing position in repo metadata | Interesting remote-control architecture reference |

## Cross-platform guidance

### Windows

Best current recommendation:

- `AB498/computer-control-mcp`

Why:

- strongest overall activity/adoption signal among non-macOS-specific options
- MIT license
- explicit support for mouse, keyboard, screenshots, OCR, and window activation
- easier recommendation than native Node desktop automation stacks if you want a broad OS story

Secondary option:

- `tanob/mcp-desktop-automation`

Why:

- also viable for Windows-style desktop automation
- simpler Node/npm setup story

Trade-off:

- RobotJS/native module friction can be more annoying than Python-based packaging

### Linux GUI

Best current recommendation for modern Linux desktops:

- `kurojs/wayland-mcp`

Why:

- specifically built for **Wayland** GUI automation
- includes screenshot + mouse + keyboard workflow thinking
- better answer than generic desktop automation tools when the target machine is a modern Wayland desktop

Important caveat:

- this is a **Wayland-specific** answer, not a universal Linux GUI answer for every distro/session type
- repo metadata surfaced weak public adoption signal and GitHub metadata returned `NOASSERTION` even though the README shows GPL-style licensing badges, so license validation is still required

### Cross-platform single-answer option

If you want one MCP to try first across Windows/macOS/Linux rather than a separate MCP per OS:

- `AB498/computer-control-mcp`

This is the best current “one baseline across multiple desktop OSes” candidate from the research.

### Remote GUI / another user’s computer

If the real goal is **controlling a different machine over the network**, the better fit is:

- `barry-ran/QuickDesk`

This is not just local desktop automation — it is a remote desktop product with MCP built in.

## Key research finding

There are **two different problem classes** hidden inside the original request:

1. **Local host control**
   - The MCP server runs on the same machine it controls.
   - Best candidates: `mcp-server-macos-use`, `MCP-MacOSControl`, `computer-control-mcp`.

2. **Remote end-user computer control**
   - The MCP server or desktop agent runs on the remote machine and exposes a secure control plane.
   - Best candidates: `QuickDesk`, `desktop-mcp-server`.

If the goal is to control **this macOS workstation**, a local stdio MCP is enough.
If the goal is to control **someone else’s computer**, that machine must run a trusted agent or remote desktop component with explicit user permission.

## Recommended direction

### Recommendation A — fastest path

Use `mediar-ai/mcp-server-macos-use` as the first proof-of-concept target because it appears to be the strongest macOS-native option for real desktop control.

### Recommendation A2 — best Windows path

Use `AB498/computer-control-mcp` first for Windows.

### Recommendation A3 — best Linux GUI path

Use `kurojs/wayland-mcp` first for Linux GUI environments that run Wayland.

### Recommendation B — safest long-term path for OSHAL

Use `aerocristobal/MCP-MacOSControl` and `mediar-ai/mcp-server-macos-use` as architectural references, but build or own an `os-mcp` server that adds OSHAL governance requirements:

- explicit human approval for high-risk actions
- structured audit logging
- default `autoApprove: []`
- app allowlist / denylist support
- emergency stop / kill switch
- typed-text redaction for secrets
- coordinate and bounds validation

## Why macOS-native matters here

Because the current development environment is macOS, native Accessibility APIs are a better foundation than a pure coordinate-only abstraction:

- better app targeting
- better traversal of UI structure
- better integration with window and element context
- fewer brittle “blind click” sequences

## Research notes used for this recommendation

- GitHub repository metadata and README reviews were collected for candidate MCP projects.
- The most promising local-macOS candidate surfaced as `mediar-ai/mcp-server-macos-use`.
- The most promising MIT-licensed macOS reference surfaced as `aerocristobal/MCP-MacOSControl`.
- The most promising general cross-platform fallback surfaced as `AB498/computer-control-mcp`.
- The most promising Linux-GUI-specific candidate surfaced as `kurojs/wayland-mcp`.
- The most promising remote-computer-control candidate surfaced as `barry-ran/QuickDesk`.