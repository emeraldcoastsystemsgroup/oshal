#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Stray-worktree guard (backlog "Seven agent-worktree branches" done-when 3). Under the shared-worktree model an unpushed commit was still VISIBLE — it sat in the one index and the next agent tripped over it in minutes; that accident was load-bearing. Worktree isolation gives each agent a private tree AND a private branch, so an unpushed commit is invisible to everyone, forever — seven of them sat silent for two days in 2026-07 and two were regression guards, the category the hardening doctrine says must never be orphaned. This script makes that state LOUD: it fails when any linked worktree carries commits absent from origin, or uncommitted changes, or when a worktree has been deleted without `git worktree prune`. Run standalone or via the ci-local gate.
#
# Exit codes: 0 = clean; 1 = stray work found (details on stderr); 2 = not a git repo.
set -u

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 2; }
cd "$repo_root" || exit 2

fail=0
main_wt=$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')

# Parse `git worktree list --porcelain`: blocks separated by blank lines,
# each with `worktree <path>` and (usually) `branch refs/heads/<name>`.
current=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *) current="${line#worktree }" ;;
    branch\ refs/heads/*)
      branch="${line#branch refs/heads/}"
      # The primary checkout is the operators' shared tree — other rules govern it.
      [ "$current" = "$main_wt" ] && continue
      if [ ! -d "$current" ]; then
        echo "STRAY: worktree '$current' (branch $branch) no longer exists on disk — run 'git worktree prune'" >&2
        fail=1
        continue
      fi
      # Uncommitted work in a linked worktree is invisible to every other agent.
      dirty=$(git -C "$current" status --porcelain 2>/dev/null | wc -l)
      if [ "$dirty" -gt 0 ]; then
        echo "STRAY: worktree '$current' (branch $branch) has $dirty uncommitted change(s) — commit with explicit pathspecs and push" >&2
        fail=1
      fi
      # Commits that exist nowhere but this disk. If the branch has no upstream,
      # compare against origin/<branch>; absent entirely on origin = everything
      # on it past origin/main is unpushed.
      if git rev-parse --verify -q "origin/$branch" >/dev/null; then
        ahead=$(git rev-list --count "origin/$branch..$branch" 2>/dev/null || echo 0)
      else
        ahead=$(git rev-list --count "origin/main..$branch" 2>/dev/null || echo 0)
      fi
      if [ "${ahead:-0}" -gt 0 ]; then
        echo "STRAY: branch '$branch' (worktree $current) is $ahead commit(s) ahead of origin and UNPUSHED — push it now; Rule 0's 'push immediately' is the only thing between this commit and oblivion" >&2
        fail=1
      fi
      ;;
  esac
done <<EOF_WT
$(git worktree list --porcelain)
EOF_WT

if [ "$fail" -eq 0 ]; then
  echo "worktree-strays: clean ($(git worktree list | wc -l) worktree(s), nothing unpushed)"
fi
exit "$fail"
