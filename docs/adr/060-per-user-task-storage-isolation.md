# ADR-060: Per-User Task Storage Isolation

- **Status:** **Reverted in implementation** (accepted 2026-06-20; the per-user path layout was
  reverted, the isolation goal is met elsewhere — see
  [Reverted: where the isolation actually lives](#reverted-where-the-isolation-actually-lives) at the
  end of this ADR, which supersedes the Decision and Implementation sections below).
- **Supersedes / relates to:** ADR-056 (ticketed data-access broker), ADR-057 (personal-data schema). This ADR extends per-user isolation from data records to the **filesystem** where bots do task work.

## Context

The swarm is multi-user. Each task is executed by a bot that reads and writes files in a
"workspace" directory on the shared volume (`workspace-shared`, browsable via code-server).

Until now, that directory was keyed **only by task id**, flat under a single root:

```
<workspaceRoot>/<taskId>/...           # ToolExecutorService.ensureWorkspacePath fallback
<workspaceRoot>/<taskId>/...           # WorkspaceBootstrapService
```

Two problems follow from a flat, task-keyed layout:

1. **No user attribution.** The filesystem has no notion of which user a task (and its output)
   belongs to. The system literally "does not know which task belongs to which user." Per-user
   isolation existed only at the API/DB layer (ADR's owner_sub columns), not on disk.
2. **Shared blast radius.** A task's deliverables — and the brokered per-user credential files
   dropped into the bot's cwd (`.oshal-cred-<provider>`, `.oshal-user-sub`,
   `tool-executor-service.ts:234-236`) — sat in a common namespace. Anything able to read the
   shared root (a mis-scoped bot, code-server, a backup) saw every user's working files together.

The execution path has a single chokepoint, `ToolExecutorService.ensureWorkspacePath(taskId)`,
which resolves the working directory as: ticket-linked named workspace first, else the flat
fallback. `ToolExecutorService` already holds `workspaceService` (and through it `ticketStore`),
so a task's owner is derivable (`task → ticket link → ticket.owner_sub`) without threading
`userSub` through every tool handler.

## Decision

**Each user gets an allocated storage namespace under the shared root, and a task's files are
written into its owner's namespace.**

### Layout

```
<workspaceRoot>/users/<ownerDir>/<taskId>/...   # owned tasks
<workspaceRoot>/_shared/<taskId>/...            # tasks with no resolvable owner (system/swarm)
<workspaceRoot>/<taskId>/...                     # LEGACY flat dirs (pre-existing) — preserved
```

`ownerDir` is the owner's OIDC `sub` passed through the existing `normalizeWorkspaceId`
sanitizer (`[^a-zA-Z0-9-_] → _`), so it is always a safe single path segment.

### Owner resolution

`ensureWorkspacePath` resolves the owner via `WorkspaceService.resolveTaskOwner(taskId)`:
1. If `taskId` is itself a ticket id → that ticket's `owner_sub`.
2. Else follow `getTicketLinksForTask(taskId)` → the linked ticket's `owner_sub`.
3. No owner found → `_shared` (system/swarm tasks that run with no user session).

This makes the **ticket's owner the source of truth** for a task's storage, consistent with the
ADR-era owner_sub columns. No `userSub` threading through tool handlers is required.

### Backward compatibility (non-negotiable)

Changing where the live swarm writes files must not orphan existing work:
- If the **legacy flat path** `<workspaceRoot>/<taskId>` already exists on disk, keep using it.
  Only **new** tasks (no existing dir) are placed under the per-user namespace.
- The path-escape guard (`resolvedPath.startsWith(workspacePath + sep)`) is unchanged and still
  enforced relative to whichever workspace path is selected.
- Existing named workspaces (DB `workspaces.path`) are untouched; their owner was backfilled
  separately (the 200 historical workspaces were assigned to the primary user).

### Security rationale

- A bot working task T can only land files under `users/<owner-of-T>/`. A prompt-injected or
  buggy bot cannot write another user's namespace by construction of the cwd.
- Brokered credential drops (`.oshal-cred-*`) now live under the owning user's directory, not a
  shared one — closing the cross-user credential-exposure path noted in the bot-isolation review.
- Combined with the API-layer ownership checks (ticket/workspace routes) and the data broker
  (ADR-056), isolation now holds at all three layers: API, database, and filesystem.

## Consequences

- **Positive:** real on-disk per-user isolation; credentials scoped to their owner; code-server /
  backups no longer expose a single flat pile; the layout is self-documenting (`users/<sub>/`).
- **Cost:** one extra DB lookup per new-task workspace creation (owner resolution) — negligible
  and consistent with the existing `resolveTaskWorkspace` lookup.
- **Migration:** none forced. Legacy flat dirs keep working; the namespace fills in as new tasks
  run. A future optional job could relocate legacy dirs into `users/<owner>/` and then the
  legacy branch can be retired.
- **Multi-root caveat:** `ToolExecutorService` resolves its root from
  `CLINE_WORKSPACE_ROOT`/`WORKSPACE_ROOT`; `WorkspaceService`'s delete guard uses
  `SHARED_WORKSPACE_ROOT`/`/app/workspace-shared`. The per-user layout applies under the
  tool-executor root; aligning the two roots is tracked separately and does not block this ADR.

## Implementation

Two execution paths write task files, and both are covered:

**API-orchestrated path (TypeScript tool-executor):**
- `WorkspaceService.resolveTaskOwner(taskId)` — owner via ticket id / task→ticket link.
- `userScopedWorkspacePath(root, ownerSub, taskId)` — pure, unit-testable path builder.
- `ToolExecutorService.ensureWorkspacePath` — legacy-exists check → owner resolution →
  per-user (or `_shared`) path.

**Swarm/bot path (the main path — `bot-node` runtime):** A dispatched task flows
api → `BotNodeClient` (sends `userSub`) → `bot-node-server` → mesh → `bot-node-execution-handler`
(`payload.userSub`) → `anyBotTaskController.createTask({ forceTaskId, userSub })` → the any-bot
`TaskController`. The owner is **threaded** here (not DB-resolved) because it is already on the
envelope:
- `any-bot/server/utils/user-workspace-path.js` — `resolveUserTaskDir(base, userSub, taskId)`,
  the JS mirror of the TS helper (legacy-exists → `users/<sub>` → `_shared`).
- `TaskController.createTask` honors `options.userSub` in its `forceTaskId`, `ticketId`, and
  UUID branches; the resulting `workspace_dir` is stored on the task and is the cwd the CLI runs
  in, so `applyUserScoping` drops `.oshal-user-sub`/`.oshal-cred-*` into the owner's dir too.
- `bot-node-execution-handler.ts` passes `userSub` into both `createTask` calls.

Note: the `WORKSPACE_DIR` for both the API and the bots is `/app/workspace-shared` (the mounted
volume code-server serves), so the `users/<sub>/<taskId>` layout is consistent and visible across
API, bot, and the workspace browser.

## Reverted: where the isolation actually lives

**The per-user path layout above was reverted and is NOT what the system does.** Everything from
"Decision" through "Implementation" describes a layout that no code produces. This section is the
as-built truth; read it instead.

### What the code does today

Both write paths use the **flat** `<root>/<taskId>` layout:

- `ToolExecutorService.ensureWorkspacePath` — `tool-executor-service.ts` (the flat join, with the
  revert rationale in a comment at the same site).
- any-bot `TaskController.createTask` — flat in all three branches (`forceTaskId`, `ticketId`,
  UUID), `any-bot/server/controllers/TaskController.js`.

**Why it was reverted:** the flat layout is assumed by roughly a dozen READER modules —
`task-folder-service.ts` (7 sites), `task-explorer-workspace-service.ts`,
`workspace-bootstrap-service.ts`, `runtime-trace-analyzer-service.ts`,
`token-chase-read-service.ts`, `claude-code-provider.ts`, `tool-runtime-context.ts`,
`jarvis-visuals.ts`, plus the any-bot deliverable/handover readers. Moving only the two WRITERS
(which is all the two helpers below could do) makes bots write to `users/<sub>/<id>` while the
verifier, task explorer, Token Chase capture reader, and handover readers still look in
`<root>/<id>` — deliverables silently vanish. That is a functional regression wearing a security
fix's clothes.

**The two helpers this ADR specified are deleted** (`user-scoped-workspace-path.ts`,
`any-bot/server/utils/user-workspace-path.js`). They had no importer after the revert, and a
security-shaped module that nothing calls is worse than no module: it reads as a control that
exists.

### Why the layout was not the boundary anyway

Every bot container mounts the **same** workspace volume read-write —
`oshal_workspace:/app/workspace-shared:rw` in `docker-compose.oshal-local.yml`, ~40 services. A bot
holding a shell in `users/<subB>/<task>` reaches `users/<subA>` with `../..`. A directory layout on a
shared read-write mount is **attribution, not enforcement**. This ADR's claim that a bot "cannot
write another user's namespace by construction of the cwd" was true only for the TS file tools,
which are separately guarded by the path-escape check in `resolveWorkspacePath` — never for the
shell tool or a spawned CLI harness.

### The controls that actually hold the line

1. **Cross-owner directory reuse is rejected.** The workspace directory is keyed by the workspace
   folder id — the ROOT TICKET UUID on the swarm path (`queue-manager-service.ts` sets
   `workspaceTaskId`), falling back to a ticket `externalId` that carries a UNIQUE index
   (`idx_tickets_external_unique` in `ticket-schema.ts`). Two users therefore cannot *organically*
   land in one directory. Where an id could be reused across owners, the owner binding rejects it:
   `assertExistingTaskOwner` in `bot-node-execution-handler.ts` (before any `createTask` or
   execution) and `assertTaskOwnerBinding` in `TaskController.js` (ticket-workspace reuse). Both
   throw `TASK_OWNER_MISMATCH` and fail closed across the owned / ownerless / anonymous boundaries.
2. **Brokered credentials do not linger in a shared workspace.** `BaseCliHarnessAdapter`'s
   `acquireUserScopingLease` / `applyUserScoping` / `wipeOwnedUserScoping` write
   `.oshal-cred-<provider>` and `.oshal-user-sub` at mode `0600`, serialize requests that share a
   cwd behind a per-workspace lease, and unlink exactly the files this invocation created
   (dev/ino/mtime/size verified) in a `finally` — "issue → use → wipe" (ADR-040). This closes the
   cross-user credential-exposure path that was this ADR's strongest motivation, and unlike a path
   layout it does so independently of where the directory sits.
3. **API / DB layers.** Owner-or-operator checks on ticket, workspace, and task-message routes
   (404 on mismatch), `owner_sub` columns, and RLS (ADR-076).

### Guards

- `tests/unit/bot-node-workspace-owner-binding.spec.ts` — the swarm-path binding: cross-owner
  rejection, no task creation or execution on mismatch, owner stamping on creation, folder-id
  derivation precedence, and TS/JS owner-normalization parity. This one is load-bearing: the
  handler's `createTask({ forceTaskId })` branch has no owner assert of its own.
- `tests/unit/any-bot-task-owner-scope.spec.ts` — `assertTaskOwnerBinding` and its durable
  persistence.
- `tests/cred-wipe.spec.ts`, `tests/harness-adapter-behavior.spec.ts` — the lease / wipe cycle.
- `tests/unit/ticket-isolation-routes.spec.ts`, `tests/unit/task-message-isolation-routes.spec.ts` —
  the route layer.

### If per-user file partitioning is revisited

Done-when, all of it or none:

1. One resolver every workspace path flows through — **readers included** — not a helper the two
   writers call.
2. Each of the ~12 reader modules listed above migrated to it, with a compatibility branch for
   pre-existing flat directories.
3. A real boundary underneath it, because a layout on a shared read-write mount is not one:
   per-owner subpath mounts, per-owner volumes, or a filesystem jail per bot container.
4. A guard proving a bot cannot traverse out of its own namespace — the property this ADR asserted
   but never demonstrated.

Without item 3 the work buys attribution and tidier browsing, not isolation. Track it as backlog,
not as a security gap.
