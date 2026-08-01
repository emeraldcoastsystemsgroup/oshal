# ADR-012: OS Control MCP Adoption Strategy

**Status:** Parked (reconciled 2026-07-31) — the vendored third-party OS-MCP adoption proposed here was never executed in this repo; OS/desktop control shipped by other routes: ADR-029 (Windows Desktop Automation MCP) and the operator-desktop remote-client rail (`packages/apply-operator-mcp` `browser_control` + `codex.exec` on `@oshal/chat` nodes — see ADR-101's context)  
**Date:** 2026-03-10  
**Deciders:** OSHAL project team  
**Technical Story:** Phase 11 Session 19 — OS MCP Research and Planning

---

## Context

OSHAL needs a path for controlled OS-level automation so an agent can move the mouse, click, type, press keys, and inspect on-screen context when explicitly authorized by a human operator.

The request raised two adjacent but different requirements:

1. **Local host control** — the MCP server runs on the same machine it controls.
2. **Remote end-user control** — the target machine runs a remote agent/desktop component that the MCP client connects to.

Research identified several relevant existing MCP projects:

- `mediar-ai/mcp-server-macos-use`
- `aerocristobal/MCP-MacOSControl`
- `AB498/computer-control-mcp`
- `tanob/mcp-desktop-automation`
- `barry-ran/QuickDesk`
- `jagjerez-org/desktop-mcp-server`

Because OSHAL currently runs on macOS and already applies strict governance around logging, approval, and local testability, the chosen approach must preserve:

- explicit user consent
- structured audit logging
- approval-safe defaults
- maintainable platform fit
- a clear distinction between local and remote control models

---

## Decision

OSHAL will use a **two-track strategy** for OS-control MCP capability.

### Track 1: Prototype with an existing macOS-native MCP

The first proof-of-concept target will be:

- `mediar-ai/mcp-server-macos-use`

Rationale:

- strongest current signal for practical macOS computer-use workflows
- accessibility-oriented behavior is a better fit than blind coordinate-only automation
- faster validation path than building from zero before we know the exact gaps

### Track 2: Own the long-term `os-mcp` integration

OSHAL should not assume that an external MCP is sufficient for long-term use. If licensing, logging, policy, or approval controls are inadequate, OSHAL should build or own a hardened `os-mcp` server under the new `os-mcp/` module.

Reference architectures for that owned implementation include:

- `aerocristobal/MCP-MacOSControl` for native macOS breadth and MIT licensing
- `mediar-ai/mcp-server-macos-use` for macOS accessibility-driven interaction patterns

The owned `os-mcp` must default to:

- no blanket auto-approval
- explicit opt-in enablement
- structured JSON logging
- application allowlist/denylist support
- coordinate validation
- emergency-stop support

### Scope boundary

The initial `os-mcp` plan is **macOS-first and local-host-first**.

If true remote control of another user’s machine is needed, that will be treated as a separate architecture track using a remote agent or authenticated remote desktop model rather than a simple local stdio MCP.

---

## Consequences

### Positive

1. Fastest route to a usable proof of concept.
2. Preserves the option to own the final control plane under OSHAL governance.
3. Aligns implementation with macOS-native capabilities instead of fragile cross-platform abstractions.
4. Avoids conflating local automation with remote-control product architecture.
5. Creates a clear, reviewable plan before enabling a high-risk capability.

### Negative

1. Adds a validation step before implementation can begin.
2. May require building an owned server if license or operational controls are insufficient.
3. macOS-first scope delays broader cross-platform support.
4. Remote-control use cases remain deferred.

### Mitigations

- Use existing projects only for proof-of-concept validation first.
- Defer any production install until licensing and safety defaults are reviewed.
- Keep the initial tool surface intentionally small.
- Treat remote control as a separate ADR if it becomes a hard requirement.

---

## Alternatives Considered

### 1. Adopt `MCP-MacOSControl` immediately

**Not selected as primary prototype target** because it has better license clarity but weaker adoption signal than `mcp-server-macos-use`.

### 2. Adopt `computer-control-mcp` as the main solution

**Not selected as primary path** because it is a strong fallback but less macOS-native in behavior than Swift/accessibility-first approaches.

### 3. Use a JavaScript desktop automation server first

**Not selected** because RobotJS/nut.js style solutions can introduce native addon friction and are less semantically aligned with macOS accessibility.

### 4. Start with remote desktop tooling

**Not selected** because the current requirement can be decomposed into local-host control first, while remote control introduces a larger trust, deployment, and authentication model.

### 5. Build from scratch immediately

**Not selected as the first move** because a proof-of-concept against an existing server is faster and better informs the exact minimum tool set we need to own.

---

## References

- `docs/research/os-mcp/README.md`
- `docs/research/os-mcp/RESEARCH.md`
- `docs/research/os-mcp/IMPLEMENTATION-PLAN.md`
- `docs/research/os-mcp/HANDOVER.md`
- `ralf/phase-11-session-19-os-mcp-task-brief.md`
- `ralf/phase-11-session-19-os-mcp-completion.md`

---

## Related ADRs

- [ADR-010: Layer 1 Tools Framework - Database-Backed Switch System](./010-layer1-tools-framework.md)
- [ADR-011: Agent Framework Architecture with Cline CLI Integration Layer](./011-agent-framework-architecture.md)