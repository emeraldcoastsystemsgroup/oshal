<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Operator runbook: workspace-root fix go-live (push + redeploy) and the auto-committer hazard on main. No credentials — safe to track/check out anywhere (operator-local credential notes stay in HUMANTODO.md).
-->

# Runbook — Workspace-root fix go-live & the auto-committer

Two operator actions, both safe to track (no secrets here — credential-bearing
notes stay in the gitignored `HUMANTODO.md`).

---

## 1. Workspace-root fix — push + redeploy so code-server shows artifacts

### What was wrong

Bots write deliverables to `/app/workspace-shared` (the `oshal_workspace` volume
code-server browses), but `RALFHandoverManager`, `WorkspaceArtifactEnforcer`, and
`FailureGovernanceService` defaulted to `OSHAL_WORKSPACE_ROOT || '/tmp/oshal-workspace'`
— and that env var was never set. So handovers, continuation briefs, and artifact
validation went to an unmounted `/tmp` dir: invisible in code-server, wiped on
restart, and the enforcer reported "no artifacts" even when deliverables existed.
code-server's mount was also read-only, so edits couldn't save.

### What's fixed (already verified)

- New canonical `resolveSharedWorkspaceRoot()` in `src/shared/workspace-root.ts`
  (precedence: `OSHAL_WORKSPACE_ROOT` > `SHARED_WORKSPACE_ROOT` >
  `CLINE_WORKSPACE_ROOT` > `WORKSPACE_ROOT`, first non-blank wins, then
  container/local-dev fallbacks). All three services route through it.
- `docker-compose.oshal-local.yml` pins `OSHAL_WORKSPACE_ROOT=/app/workspace-shared`
  and flips the code-server mount `:ro` → `:rw`.
- Machine-verified: typecheck 0 errors; full unit suite 350/350 (incl. 11 new in
  `tests/unit/workspace-root-resolution.spec.ts`).
- Architecture write-up: see `docs/architecture/swarm-container-topology.md`
  ("Workspace Artifacts & code-server").

### What's left for the operator

1. **Push the fix.** Commit `a16a440` (resolver + 3 services + tests + topology doc)
   is committed but not pushed. The compose change is already on `origin/main`.
   ```bash
   cd C:/Projects/open-shal-swarm-harness-agent-llm
   git push
   ```
2. **Recreate the containers** so the env + new image take effect (a plain restart
   will not re-read compose env):
   ```bash
   docker compose -f docker-compose.oshal-local.yml up -d --build oshal-api code-server
   ```
3. **Verify.** Open cockpit `/code` (or `http://localhost:8444`), confirm a recent
   task's `developer-handovers/` and `deliverables/` are visible, and that edits save.

**Risk if skipped:** the running stack keeps splitting artifacts to `/tmp`, so the
workspace browser stays empty/stale and the enforcer keeps flagging real work as
missing.

---

## 2. Auto-committer on `main` — fragmenting work under your name

A background process commits specific paths to `main` on a timer and pushes
immediately. During the workspace-root edit it swept the `docker-compose.oshal-local.yml`
change into an **unrelated** deploy-fix commit (`09cd21b`, "fix(deploy): exec the
final process…") and pushed it to `origin/main`.

Concrete hazard it demonstrated: it can grab a half-edited file mid-session. Here it
took the compose edit while the new `src/shared/workspace-root.ts` module and the
service files importing it were still untracked — had it grabbed the importing `.ts`
files without the module, `origin/main` would not compile. That was avoided by
committing all six files atomically (`a16a440`), but the process is still running.

**Operator decision:**
- Pause/stop it while actively editing, OR scope it so it never auto-commits source
  (`src/**`, `tests/**`) — only the artifacts/docs it is meant to manage.
- Give it its own author identity so its commits don't read as hand-authored, and a
  message convention so unrelated changes aren't bundled.

**Risk if skipped:** it keeps folding stray working-tree edits into mislabeled commits
on the trunk under your name, and can push a non-compiling half-state during any
future editing session.
