# How to Configure and Operate Antigravity & Multi-Agent Swarms

This document outlines the complete operational, configuration, and multi-agent orchestration architecture for **Google Antigravity (AGY)** and its integration across the OSHAL ecosystem, local workstations, and remote development infrastructure.

---

## 1. System Architecture & Component Layout

Antigravity operates across three primary modalities on developer workstations:
1. **Antigravity IDE**: Standalone AI-first editor environment (built on VS Code core) supporting collaborative sidebar chat, inline commands, and automated code lenses.
2. **Antigravity CLI (`agy.exe`)**: High-performance native binary (`%LOCALAPPDATA%\agy\bin\agy.exe`) capable of autonomous non-interactive task execution (`-p / --print`).
3. **Multi-Agent Worker Pool**: Coordinated headless subagent fleet executing parallel tasks concurrently under an orchestrator.

### File Locations & Configuration Roots
| Component | Local Windows Filesystem Path | Purpose |
|---|---|---|
| **Global Customization Root** | `%USERPROFILE%\.gemini\config\` | Shared rules, plugins, and custom skills active across all workspaces. |
| **Global Custom Skills** | `%USERPROFILE%\.gemini\config\skills\` | On-demand procedural workflows (e.g., `subagents`, `vsdx-architect`). |
| **Installed Plugins** | `%USERPROFILE%\.gemini\config\plugins\` | Bundled plugins (`gemini-api`, `chrome-devtools-plugin`, etc.). |
| **CLI Runtime Settings** | `%USERPROFILE%\.gemini\antigravity-cli\settings.json` | CLI default model, effort, timeout, and execution flags. |
| **Subagent Execution Logs** | `%USERPROFILE%\.gemini\subagent-logs\` | Standard output and error streams for each spawned subagent. |
| **Cross-Thread Collaboration**| `%USERPROFILE%\.gemini\subagent-workspace\` | Shared file exchange, state checkpointing, and thread receipts. |
| **Workspace Customizations** | `.agents/` (inside repo root) | Project-scoped rules (`GEMINI.md`, `AGENTS.md`) and local skills. |

---

## 2. Model Selection & Credential Synchronization

Antigravity natively routes tasks across Google Gemini, Anthropic Claude, and OpenAI models.

### Available Models
- `gemini-3.8-flash-high` / `gemini-3.8-flash-medium` / `gemini-3.8-flash-low`
- `claude-sonnet-4-6` / `claude-opus-4-6-thinking`
- `gpt-oss-120b-medium`

### Credential Porting to Dev Containers & Droplets
When running bot containers or remote development nodes, credentials must be kept in sync:
```powershell
# Sync Claude Code OAuth tokens to remote development host
scp -i ~/.ssh/id_rsa ~/.claude/.credentials.json user@dev-host:~/.claude/.credentials.json
scp -i ~/.ssh/id_rsa ~/.claude.json user@dev-host:~/.claude.json
scp -i ~/.ssh/id_rsa ~/.claude/settings.json user@dev-host:~/.claude/settings.json
```
Containers mounted with read-only volumes (`~/.claude:ro`) immediately inherit fresh authorization tokens without container restarts.

---

## 3. Multi-Agent Subagent Orchestration (Running 10 Concurrent Workers)

To achieve maximum throughput without idle CPU/RAM headroom, Antigravity orchestrates up to 10 autonomous worker processes in parallel.

### The Dispatcher Engine
The subagents skill provides a high-throughput dispatcher script:
`%USERPROFILE%\.gemini\config\skills\subagents\scripts\dispatch.js`

```javascript
// Example programmatic invocation
const { dispatchAll } = require(path.join(process.env.USERPROFILE, '.gemini', 'config', 'skills', 'subagents', 'scripts', 'dispatch.js'));

const tasks = [
  { id: 1, prompt: "Run npm run typecheck in oshal", cwd: "c:\\Projects\\oshal" },
  { id: 2, prompt: "Run unit tests for connectors", cwd: "c:\\Projects\\oshal" },
  // ... up to 10 parallel tasks
];

dispatchAll(tasks, 10);
```

### CLI Direct Invocation
Individual subagents can also be spawned directly via PowerShell or background tasks:
```powershell
agy -p "Verify TypeScript compilation and report errors" --dangerously-skip-permissions
```

---

## 4. Parallel Workstream Strategy (Preventing Overlaps & Data Loss)

When 10 agents operate concurrently on an active codebase, strict conflict-prevention and durability safeguards are mandatory.

### Rule 1: Strict Domain & Path Partitioning
Each subagent is assigned a non-overlapping subsystem boundary:
- **Thread 1 (Core Kernel & Routes):** `src/app/`, `src/api/`
- **Thread 2 (Operational Intelligence & Tokens):** `src/features/operational-intelligence/`
- **Thread 3 (Connectors & Marketplace):** `src/app/connectors/`, `swarm-apps/`
- **Thread 4 (Jarvis & Provider Caching):** `any-bot/server/`, `src/features/jarvis/`
- **Thread 5 (Experience Shells & Views):** `src/experience/`, `src/pages/`
- **Thread 6 (Store Applications):** `c:\Projects\oshal-applications/`
- **Thread 7 (CRM & Contracting):** `c:\Projects\oshal-app-private\intelligent-sales/`
- **Thread 8-10 (Continuous Regressions & Deployment):** Test runners, compiler verifications, and droplet health probes.

### Rule 2: Inter-Thread Collaboration via Shared Folders
Subagents coordinate using a durable filesystem mailbox:
`%USERPROFILE%\.gemini\subagent-workspace\mailbox\`
- **Receipts (`/receipts/`)**: Stamped JSON files recording exact commit SHAs, test durations, and pass/fail counts.
- **Locks (`/locks/`)**: Ephemeral lockfiles identifying files or database tables currently being verified.
- **Handover Notes (`/handover/`)**: Structured markdown summaries left by completed tasks so the next worker in the queue inherits full context immediately.

### Rule 3: Dynamic Pipeline Queue (As One Shuts Down, The Next Starts)
The dispatcher maintains an active worker pool:
- Concurrency ceiling: 10 processes.
- As soon as Subagent $N$ exits (code 0 or 1), its results are flushed to its log, its slot is freed, and the next queued task from the backlog is immediately dequeued and launched.

### Rule 4: Headroom & Resource Preservation
- Workstations with 16 GB RAM allocate ~2.0 GB across 10 `agy` subagents (~200 MB per worker).
- At least 4 GB of RAM and 2 CPU threads are permanently reserved for compiler builds (`tsc`, `vite build`, `webpack`) and database engines (`pgvector`, `timescaledb`).

### Rule 5: Crash-Proof Durability ("No Lost Work")
To ensure no progress is lost during crashes or interruptions:
1. **Atomic Commits**: Each completed work item is committed to git with its ADR / backlog reference before the next item begins.
2. **Durable Logs**: Every subagent logs to disk (`%USERPROFILE%\.gemini\subagent-logs\agent-<id>.log`).
3. **Pre-Deploy Dumps**: Automated database backups (`pg_dump | gzip`) precede every deploy script on the droplet.

---

## 5. Quick Reference & Operational Commands

```powershell
# 1. View all active Antigravity subagent processes
Get-Process agy | Select-Object Id, ProcessName, CPU, @{Name="RAM_MB";Expression={[math]::Round($_.WorkingSet64/1MB)}}

# 2. Tail a subagent log in real time
Get-Content "$env:USERPROFILE\.gemini\subagent-logs\agent-1.log" -Wait -Tail 20

# 3. Dispatch 10 backlog tasks
node "$env:USERPROFILE\.gemini\config\skills\subagents\scripts\dispatch.js" "$env:USERPROFILE\.gemini\config\skills\subagents\scripts\sample-tasks.json"

# 4. Check droplet deploy status
ssh -n -i ~/.ssh/id_rsa user@dev-host "docker ps"
```
