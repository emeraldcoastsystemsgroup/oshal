# os-mcp

This directory is the planning workspace for an OSHAL OS-control MCP initiative: a Model Context Protocol server that can control the host operating system with explicit user consent by moving the mouse, clicking, typing, pressing keys, and capturing screen context.

## Current recommendation

After researching currently available MCP projects, the best near-term path is a **two-track strategy**:

1. **Prototype quickly with an existing macOS-native MCP**
   - Best immediate candidate: `mediar-ai/mcp-server-macos-use`
   - Why: active project, macOS accessibility-first approach, strong computer-control feature set

2. **Own the production integration under `os-mcp/`**
   - Preferred long-term shape: a hardened, macOS-first MCP server we can audit, log, and constrain for OSHAL
   - Why: explicit consent requirements, approval policy, logging, and licensing clarity matter for OS-control tooling

## Cross-platform answer

Yes — there are viable options beyond macOS:

- **Windows:** `AB498/computer-control-mcp`
  - best current general-purpose Windows-friendly recommendation
  - Python / PyAutoGUI based
  - MIT licensed

- **Linux GUI (especially Wayland):** `kurojs/wayland-mcp`
  - purpose-built for Linux GUI automation on Wayland
  - strongest Linux-GUI-specific fit found so far

- **Cross-platform fallback:** `AB498/computer-control-mcp`
  - best single-MCP answer if you want one baseline across Windows + macOS + some Linux setups

- **Remote end-user control across machines:** `barry-ran/QuickDesk`
  - better if the goal is controlling a different machine over a remote desktop-style architecture

## What is in this folder?

- `RESEARCH.md` — candidate MCP survey and recommendation matrix
- `IMPLEMENTATION-PLAN.md` — phased plan for adoption/build-out
- `HANDOVER.md` — current status, debt, and next steps

## Current local install status

- Selected MCP: `mediar-ai/mcp-server-macos-use`
- Local clone path: `/Users/SAPUSER/Documents/Cline/MCP/mcp-server-macos-use`
- Local binary path: `/Users/SAPUSER/Documents/Cline/MCP/mcp-server-macos-use/.build/release/mcp-server-macos-use`
- VS Code / Cline MCP settings path:
  - `/Users/SAPUSER/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Safety defaults applied:
  - `disabled: false`
  - `autoApprove: []`

## Scope

This folder contains the research/plan for the broader `os-mcp` initiative plus the current local prototype selection/install status.

## Manual follow-up still required

macOS may still require you to grant permissions before the MCP can actually control applications reliably:

- Accessibility
- Screen Recording (if screenshots/traversal depend on it)
- Input Monitoring (if prompted by macOS)

## Important constraint

For true **remote end-user computer control**, the MCP server or desktop agent must run on the end user's machine (or inside an authenticated remote desktop/session). Local stdio MCP servers only control the host machine where they are launched.

OSHAL now has a remote-client scaffold that matches that model:

- control-plane registry + task routes under `src/app/routes/remote-client-routes.ts`
- local endpoint daemon under `scripts/remote-client.ts`
- shared A2A / remote-client contracts under `src/shared/types/a2a.ts`
- launch it with `npm run remote-client:start`
