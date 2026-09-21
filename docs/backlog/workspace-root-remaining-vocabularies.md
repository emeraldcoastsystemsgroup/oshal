# The workspace root outside `src/`: the `any-bot` vocabulary and two compose files

**Status:** open. Filed 2026-09-20 by CKR-17 step 2, which converged every `src/` site and named these
two as out of scope for that change rather than leaving them unrecorded.

Read [clean-kernel-repair.md](./clean-kernel-repair.md) CKR-17 first. This entry is only the part that
change deliberately did not touch.

## What is done, so the remainder is legible

Every workspace-root chain in `src/` resolves through `resolveSharedWorkspaceRoot()`. The resolver reads
all six variables, an eslint rule errors on any new `process.env.<one of the six>` outside it, and
`tests/unit/workspace-root-resolution.spec.ts` carries a case per collapsed chain. So inside `src/`
the class is closed and cannot regrow.

## What remains

### 1. The `any-bot/` vocabulary — 14 files, its own precedence order

`any-bot/` is the legacy JavaScript layer and is explicitly out of the eslint config's scope
(`ignores: ['any-bot/**']`), so the rule that holds `src/` cannot see it. Measured on 2026-09-20:

| chain | files |
|---|---|
| `WORKSPACE_DIR \|\| SHARED_WORKSPACE_ROOT \|\| CLINE_SHARED_WORKSPACE_ROOT \|\| WORKSPACE_ROOT` | `ToolRegistry.js`, `brokered-cli-runner.js`, `routes-workspace-static.js` |
| `WORKSPACE_DIR` alone | `config.js`, `TaskController.js`, `ClineProvider.js` (×2), `QueueManagerService.js` (×2), `RoutingDecisionLog.js` |
| `WORKSPACE_ROOT` alone | `ProvisioningManager.js` |
| `CODEX_WORKSPACE` — a **seventh** name, read nowhere else | `CodexProvider.js` |

Note the ordering: this side puts `WORKSPACE_DIR` **first**, where the canonical resolver puts it
**last**. On a box that sets every variable to the same value — which the local compose file does — that
is invisible. On one that sets two to different values, the two halves of the platform write to
different directories.

`PLANE_WORKSPACE_SLUG`, `AGENT_WORKSPACES`, `WORKSPACE_BASE_URL` and `QUEUE_MANAGER_MULTI_WORKSPACE` are
**not** part of this: they name a Plane workspace, an agent list and a URL, not a filesystem root. Do not
sweep them in on a name match.

**Done when.** Either `any-bot/` resolves the root through one shared JavaScript helper whose precedence
order matches `src/shared/workspace-root.ts` exactly — with a case proving the two agree for each of the
six variables set alone — or a decision is recorded that the two halves keep separate orders, with the
reason. `CODEX_WORKSPACE` either joins the union in both halves or is deleted. A guard has to cover
`any-bot/`, which means either widening the eslint scope or a source scan, because the existing rule
structurally cannot.

### 2. `docker-compose.core.yml` and `docker-compose.yml` set two of the six

Both set `SHARED_WORKSPACE_ROOT` and `CLINE_SHARED_WORKSPACE_ROOT` and nothing else, while
`docker-compose.oshal-local.yml` pins all six (`:116`, `:132-135`, `:141`).

**This is no longer a live symptom for `src/`** — the convergence is why. Every `src/` site now reads the
resolver, the resolver reads `SHARED_WORKSPACE_ROOT` at priority 2, and both files set it. Before the
sweep, a site reading only `CLINE_WORKSPACE_ROOT` got the container default under those files while its
neighbour got the configured root.

It **is** still live for `any-bot/`, whose first-priority variable is `WORKSPACE_DIR`, which neither file
sets. That is the same defect, one layer down, and it is why item 1 is the real work here.

**Done when.** Either the two compose files set the same six the local file does, or a spec asserts that
every compose file in the repository sets at least one variable that BOTH resolvers read — the second is
the better shape, because it states the invariant rather than a list.

## Why this was not folded into CKR-17

The operator's answer to CKR-17 step 2 was "converge all thirty-six sites now", and that entry names
these two as separate work in its own closing paragraph. Widening a decided scope mid-change is how a
sweep becomes unreviewable. The measurement above is recorded here so the next reader starts from
counted files rather than from a fresh grep.
