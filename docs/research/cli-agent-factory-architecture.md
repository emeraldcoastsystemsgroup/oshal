# CLI Agent Factory — Architecture Research

## Date: 2026-03-30

## What is "CLI Anything"?

The idea: **every CLI tool on the system becomes an agent**. Each agent is a specialist that deeply understands one CLI tool (git, docker, kubectl, npm, curl, ffmpeg, imagemagick, etc.) and exposes that expertise to other bots in the swarm.

This is an **Agent Factory** pattern — a runtime that can mint a new specialist agent for any CLI binary it discovers.

---

## How It Fits in oshal

### Current Architecture (summary)

| Layer | What exists |
|-------|------------|
| **Swarm** | Control-plane orchestrator routes tasks to bot containers |
| **Agent runtime** | `src/agent/index.ts` — agent config, tool binding, LLM dispatch |
| **Tool registry** | Catalog of tools (RAG, calendar, tickets, etc.) with JSON-schema descriptors |
| **Bot personas** | YAML/JSON persona files in `ai-lab/bot-personas/` defining role, tools, system prompt |
| **MCP** | `os-mcp/` research on Model Context Protocol for tool bridging |

### Where CLI agents slot in

```
┌─────────────────────────────────────────────────┐
│                  Swarm Control Plane             │
│  (routes tasks, manages queues, tracks status)   │
└──────────┬──────────────────────────┬───────────┘
           │                          │
   ┌───────▼────────┐       ┌────────▼────────┐
   │  Regular Bots   │       │  CLI Agent Pool  │
   │  (chat, RAG,    │       │  (factory-minted │
   │   tickets…)     │       │   specialists)   │
   └───────┬────────┘       └────────┬────────┘
           │                          │
           │    ◄── tool-call ──►     │
           │                          │
   ┌───────▼──────────────────────────▼───────────┐
   │           Shared Message Bus / Queue          │
   └──────────────────────────────────────────────┘
```

A regular bot (e.g., DevOps-bot) doesn't need to know `kubectl` internals — it asks the **kubectl-agent** via a tool-call. The kubectl-agent translates intent into safe commands, executes, parses output, returns structured results.

---

## Agent Factory Design

### 1. Discovery — What CLI tools exist?

```typescript
interface CLIToolManifest {
  name: string;           // "git", "docker", "kubectl"
  binary: string;         // full path to executable
  version: string;        // output of --version
  helpText: string;       // output of --help (truncated)
  manPage?: string;       // parsed man/help docs
  subcommands?: string[]; // top-level subcommands
  dangerZones: string[];  // commands that mutate/delete
}
```

**Bootstrap**: scan PATH, run `<tool> --help`, parse output, build manifest. This can be a one-time seed or a scheduled scan.

### 2. Agent Minting — One agent per tool

For each discovered CLI tool, the factory creates:

| Component | What |
|-----------|------|
| **System prompt** | "You are a specialist in `{tool.name}`. You translate natural-language requests into safe `{tool.name}` commands. You always explain what a command does before running it. You refuse destructive operations without explicit confirmation." |
| **Tool schema** | A single `execute_cli` tool with parameters: `command`, `args[]`, `working_dir`, `requires_approval` |
| **Safety rules** | Allowlist/denylist per tool (e.g., `git push --force` requires approval, `rm -rf /` is blocked) |
| **Knowledge base** | The tool's `--help` output, man pages, and optionally curated docs (pulled via RAG) |
| **Persona file** | Standard bot-persona YAML that the existing agent runtime already consumes |

```yaml
# ai-lab/bot-personas/cli-agents/git-agent.yaml
id: cli-git
name: Git Agent
role: specialist
description: Expert in git version control operations
system_prompt: |
  You are a git specialist agent. You help other bots and users
  perform git operations safely and correctly. You always:
  - Explain what a command will do before executing
  - Refuse force-pushes without explicit approval
  - Return structured results (changed files, commit hashes, etc.)
tools:
  - execute_cli
safety:
  require_approval:
    - "push --force"
    - "reset --hard"
    - "clean -fd"
  blocked:
    - "push --mirror"
knowledge_sources:
  - type: help
    content: "{{ git_help_output }}"
```

### 3. Communication Protocol — How bots call CLI agents

Using the existing tool-call pattern in the swarm:

```typescript
// A regular bot wants to check git status
const result = await swarm.delegateTo('cli-git', {
  intent: 'Show me uncommitted changes in the project',
  context: { workingDir: '/app/project' }
});

// cli-git agent internally:
// 1. Interprets intent → "git status --porcelain"
// 2. Executes command
// 3. Parses output into structured data
// 4. Returns: { modifiedFiles: [...], untrackedFiles: [...], branch: "main" }
```

### 4. The Delegation Flow

```
User → DevOps Bot: "Deploy the latest to staging"
                        │
                        ▼
            DevOps Bot decomposes task:
            1. Check current branch (→ delegate to git-agent)
            2. Build image (→ delegate to docker-agent)  
            3. Push image (→ delegate to docker-agent)
            4. Apply manifests (→ delegate to kubectl-agent)
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
    git-agent      docker-agent   kubectl-agent
    "git branch"   "docker build"  "kubectl apply"
    "git log -1"   "docker push"   "kubectl rollout status"
         │              │              │
         └──────────────┼──────────────┘
                        ▼
            DevOps Bot aggregates results
            → Reports back to user
```

### 5. Safety Layer

Every CLI agent wraps execution with:

```typescript
interface CLIExecution {
  // Pre-execution
  validateCommand(cmd: string): ValidationResult;  // check against safety rules
  explainCommand(cmd: string): string;              // human-readable explanation
  requireApproval(cmd: string): boolean;            // does this need a human OK?
  
  // Execution
  execute(cmd: string, opts: ExecOpts): ExecResult;
  
  // Post-execution  
  parseOutput(raw: string): StructuredResult;       // tool-specific parsing
  detectErrors(raw: string): Error[];               // catch failures
  auditLog(entry: AuditEntry): void;                // log everything
}
```

### 6. Registry Integration

CLI agents register themselves in the existing tool registry:

```typescript
// Extends the existing ToolRegistryEntry
interface CLIAgentRegistryEntry {
  agentId: string;        // "cli-git"
  toolName: string;       // "git"
  capabilities: string[]; // ["version-control", "branching", "merging"]
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  safetyLevel: 'read-only' | 'mutating' | 'destructive';
}
```

The **agent selector** (already spec'd in `technical-spec-tool-registry-and-agent-selector.md`) can then route tool-calls to the right CLI agent based on capability matching.

### 7. Deployable CLI Agent Contract

Minting a CLI agent is not complete when the persona exists.

Every CLI-backed agent must also define:

- the real executable or wrapper command
- how auth is bootstrapped
- how operators configure secrets
- a structured output mode such as `--json`
- approval and safety rules for mutating commands
- at least one smoke test command
- the provisioning path that binds the tool to a real bot

Example using the Google Workspace work:

- CLI wrapper: `oshal-google-workspace`
- runtime tool alias: `gogcli`
- imported-bot provisioning: `scripts/provision-imported-bot-runtime.ts`
- operator config path: `GET/PUT /api/swarm/agents/google-bot/config`
- smoke path: `version`, `auth status`, then Gmail/Docs/Sheets/Slides/Drive/Calendar checks

Without those pieces, the platform has a persona, not a deployable CLI specialist.

---

## What This Enables

| Capability | Description |
|-----------|-------------|
| **Composable automation** | High-level bots orchestrate complex workflows by chaining CLI specialists |
| **Safety isolation** | Each CLI agent enforces its own safety rules; the orchestrator doesn't need to know tool internals |
| **Knowledge depth** | Each agent can be loaded with tool-specific docs, examples, common pitfalls |
| **Auto-scaling** | Factory can mint agents on demand; unused agents can be parked |
| **MCP bridge** | CLI agents could expose themselves as MCP tool servers, making them usable outside the swarm too |
| **Audit trail** | Every CLI execution is logged with intent, command, output, and who requested it |

---

## Implementation Phases

### Phase 1: Foundation
- [ ] CLI discovery scanner (scan PATH, extract help text)
- [ ] Agent persona template (parameterized YAML)
- [ ] Factory function: `mintCLIAgent(manifest) → AgentConfig`
- [ ] Basic `execute_cli` tool with safety wrapper

### Phase 2: Integration  
- [ ] Register CLI agents in existing tool registry
- [ ] Wire delegation protocol into swarm message bus
- [ ] Add structured output parsers for top-5 tools (git, docker, kubectl, npm, curl)
- [ ] Safety rule engine (allowlist/denylist per tool)

### Phase 3: Intelligence
- [ ] RAG-load tool documentation for each agent
- [ ] Intent-to-command translation (agent interprets NL → CLI)
- [ ] Output-to-structured parsing (agent converts stdout → JSON)
- [ ] Error recovery suggestions

### Phase 4: MCP Bridge
- [ ] Expose CLI agents as MCP tool servers
- [ ] External consumers (Cline, other IDEs) can call CLI agents
- [ ] Bidirectional: CLI agents can also consume MCP resources

---

## Concrete Example: What a "git-agent" Session Looks Like

```
[incoming request from devops-bot]
Intent: "What changed in the last 3 commits?"
Context: { workingDir: "/app/project", branch: "main" }

[git-agent internal reasoning]
1. Parse intent → need git log with diff stats
2. Construct: git log -3 --stat --oneline
3. Safety check: read-only ✓, no approval needed
4. Execute command

[raw output]
abc1234 fix: resolve auth timeout
 src/auth.ts | 12 +++++---
 2 files changed, 8 insertions(+), 4 deletions(-)
def5678 feat: add retry logic  
 src/http.ts | 45 +++++++++++++++++++++
 1 file changed, 45 insertions(+)
ghi9012 chore: update deps
 package.json | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)

[structured response back to devops-bot]
{
  "commits": [
    { "hash": "abc1234", "message": "fix: resolve auth timeout", "filesChanged": 2, "insertions": 8, "deletions": 4 },
    { "hash": "def5678", "message": "feat: add retry logic", "filesChanged": 1, "insertions": 45, "deletions": 0 },
    { "hash": "ghi9012", "message": "chore: update deps", "filesChanged": 1, "insertions": 2, "deletions": 1 }
  ],
  "summary": "3 commits: 1 fix, 1 feature, 1 chore. 4 files touched, net +50 lines."
}
```

---

## Key Design Decisions

1. **One agent = one tool**: keeps context windows small, system prompts focused, safety rules scoped
2. **Structured I/O**: CLI agents always return JSON, not raw stdout — other bots can consume programmatically
3. **Approval escalation**: destructive commands bubble up to human approval via the existing ticket/queue system
4. **Factory, not manual**: adding a new CLI tool should be `factory.mint('ffmpeg')`, not writing a new bot from scratch
5. **Composable**: a "DevOps orchestrator" bot doesn't execute anything itself — it delegates to CLI specialists
6. **Deployable beats theoretical**: each minted CLI agent must carry its runtime, config, auth, and smoke-test story with it
