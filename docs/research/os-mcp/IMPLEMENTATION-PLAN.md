# os-mcp Implementation Plan

## Executive summary

The `os-mcp` initiative should start as a **macOS-first, explicit-consent MCP server plan** for OSHAL that can perform mouse movement, click, type, keypress, drag, scroll, and screen-context operations on the host machine.

The plan intentionally separates:

- **short-term validation** with an existing MCP project
- **long-term hardened ownership** of an OSHAL-compatible OS-control MCP

---

## Desired outcome

Create an MCP capability that allows an agent to:

- inspect screen state
- move the cursor
- click or double-click
- type text
- press keys / shortcuts
- drag and scroll
- optionally inspect the active application/window/accessibility tree

while preserving:

- explicit user consent
- auditability
- no stealth or hidden auto-control
- bounded risk for destructive actions

---

## Non-goals for the first implementation

- fully unattended destructive system administration
- hidden background control of another person’s computer
- broad remote-desktop productization in phase 1
- automatic approval for all mouse/keyboard actions

---

## Recommended architecture

### Platform-specific adoption guidance

- **macOS:** `mediar-ai/mcp-server-macos-use` now validated locally on this machine
- **Windows:** prefer `AB498/computer-control-mcp` as the first candidate
- **Linux GUI / Wayland:** prefer `kurojs/wayland-mcp`
- **Remote end-user computer control:** prefer `barry-ran/QuickDesk` if the requirement is cross-machine remote control rather than local-host automation

### Phase 1: validate an existing macOS MCP

Primary spike target:

- `mediar-ai/mcp-server-macos-use`

Validation checklist:

1. Confirm its license posture is acceptable for evaluation and/or integration.
2. Run it locally in an isolated test profile.
3. Verify required macOS permissions:
   - Accessibility
   - Input Monitoring (if needed)
   - Screen Recording (if screenshots are used)
4. Validate minimum interaction set:
   - open application
   - click
   - type
   - press key
   - traverse app state
5. Measure practical reliability against one real flow, such as:
   - open TextEdit
   - click text area
   - type a sentence

**Exit criterion:** confirm whether an existing server is “good enough” for OSHAL local development workflows.

### Phase 2: design the hardened OSHAL `os-mcp`

If the prototype succeeds but licensing, observability, or policy controls are insufficient, build an owned server under `os-mcp/`.

Preferred implementation direction:

- **language:** Swift
- **transport:** stdio MCP server
- **OS integration:** macOS Accessibility APIs + screen capture support where needed

Why Swift:

- best native fit for macOS accessibility
- fewer cross-platform native addon problems than RobotJS/nut.js on macOS
- strongest foundation for semantic app/window interaction

### Phase 3: integrate with OSHAL policy and tool governance

When the server exists, integrate it into the OSHAL tool framework as an MCP capability with explicit governance.

Integration requirements:

- MCP server definition stored in OSHAL configuration
- auth/policy defaults set to the safest posture
- action logging tied to task/session identity
- no implicit blanket approvals
- visible runtime status in the agent/tool settings UI

### Phase 3b: cross-platform evaluation path

After macOS validation, evaluate whether OSHAL wants:

1. **best-per-OS strategy**
   - macOS → `mcp-server-macos-use`
   - Windows → `computer-control-mcp`
   - Linux Wayland → `wayland-mcp`

2. **single cross-platform baseline strategy**
   - first candidate → `computer-control-mcp`

3. **remote-control product strategy**
   - first candidate → `QuickDesk`

This decision should be made before committing to a single long-term owned implementation shape.

---

## Proposed tool surface

The first owned `os-mcp` should expose a minimal, controlled tool set:

1. `get_active_application`
2. `list_windows`
3. `capture_screen`
4. `move_mouse`
5. `click_mouse`
6. `double_click_mouse`
7. `drag_mouse`
8. `scroll_mouse`
9. `type_text`
10. `press_key`
11. `press_hotkey`
12. `open_application`
13. `inspect_accessibility_tree`
14. `emergency_stop`

### Deferred tools

- OCR-specific tools
- remote desktop tools
- multi-monitor targeting helpers
- semantic element caching
- text-field safety heuristics

---

## Security and safety requirements

Because OS control is a high-risk capability, `os-mcp` should be designed with strict guardrails.

### Required controls

1. **Explicit opt-in enablement**
   - controlled by environment/config flag such as `OS_MCP_ENABLED=true`

2. **No default auto-approval**
   - MCP client config should default to:
   - `disabled: false`
   - `autoApprove: []`

3. **Structured audit logging**
   - every tool call logs action, target app/window, timing, result, and correlation/task ID
   - sensitive typed text must be redacted when marked secret or when the target field is password-like

4. **Bounds validation**
   - reject impossible or off-screen coordinates

5. **Application allowlist / denylist**
   - allow safe-app pilot mode first (for example TextEdit, Notes, browser dev windows)

6. **Emergency stop**
   - kill switch or hotkey that halts automation immediately

7. **Foreground visibility**
   - no hidden background automation mode for production use

8. **Local-first deployment**
   - initial implementation controls only the local machine where the server runs

---

## Logging requirements

Per OSHAL governance, the server must use structured JSON logging and must never rely on silent catches.

At minimum, log:

- server start/stop
- permission checks
- inbound tool call
- outbound result
- active app/window context when available
- errors with stack traces
- execution duration

---

## Packaging plan for this folder

Current state:

```text
os-mcp/
├── README.md
├── RESEARCH.md
├── IMPLEMENTATION-PLAN.md
└── HANDOVER.md
```

Future implementation target:

```text
os-mcp/
├── README.md
├── RESEARCH.md
├── IMPLEMENTATION-PLAN.md
├── HANDOVER.md
├── package.json or Package.swift
├── src/
│   ├── server/
│   ├── tools/
│   ├── services/
│   └── logging/
└── tests/
```

---

## Delivery phases

### Phase 0 — complete research and planning

- shortlist existing MCP projects
- decide local vs remote scope
- write plan and ADR

**Status:** complete

### Phase 1 — proof of concept with existing project

- validate `mcp-server-macos-use`
- verify permissions and reliability
- confirm whether license posture is usable

**Deliverable:** go/no-go decision for reuse vs in-house build

### Phase 2 — scaffold owned `os-mcp`

- create native server skeleton
- implement minimal tools: screen, move, click, type, keypress
- add structured logs and safe defaults

**Deliverable:** local stdio MCP server controlling the current macOS host

### Phase 3 — OSHAL integration

- register MCP in OSHAL config/workflow
- wire policy visibility into tool/MCP settings
- attach session/task correlation IDs

**Deliverable:** governed MCP integration visible to OSHAL runtime

### Phase 4 — optional remote-control mode

- evaluate QuickDesk or WebRTC-based remote agent model
- require authenticated agent on target machine
- document security model separately

**Deliverable:** remote end-user control design, not enabled by default

---

## Acceptance criteria

The `os-mcp` plan is ready for implementation when:

- a preferred prototype candidate is selected
- license position is understood
- required macOS permissions are documented
- minimal safe tool surface is defined
- audit/safety controls are specified
- OSHAL integration boundaries are documented
- Windows/Linux/remote evaluation paths are documented for future expansion

---

## Immediate next three actions

1. Evaluate `mediar-ai/mcp-server-macos-use` in a local macOS test profile and verify license status.
2. Decide whether Windows should use `computer-control-mcp` and Linux GUI should use `wayland-mcp`, or whether OSHAL should force a single cross-platform baseline.
3. Define the OSHAL MCP registration contract and approval defaults before any additional OS-control server is added to live user settings.