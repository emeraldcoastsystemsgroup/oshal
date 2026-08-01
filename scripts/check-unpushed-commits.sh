#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Unpushed-commit guard: the third leg of the backlog "Seven agent-worktree branches" done-when, and the half check-worktree-strays.sh deliberately leaves open. That script skips the PRIMARY checkout ("other rules govern it") and only inspects worktrees with a branch checked out — so the shapes that actually strand work here go undetected: a commit on the primary checkout's branch that was never pushed, a local branch ref left ahead of origin, and a detached HEAD carrying a commit (the private-index/push-by-SHA recipe's failure mode, where a stale branch pointer pushes "successfully" while the real commit stays local). This script judges EVERY local ref against every origin remote-tracking ref and separates work that exists nowhere but this disk (fails) from refs whose content already landed as a squash merge and from dead pre-scrub history (both informational), so the red state stays actionable instead of 36 lines nobody reads.
#
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Third landed-proof (subject trace), found the same night by deleting the 59 landed remote branches: the two structural proofs are not DURABLE. A branch that merged origin/main into itself before being squash-merged has no patch-id match (the squash's diff is the whole branch, not any one commit) and stops producing a no-op merge the moment main edits a file it touched — so three long-merged branches (PRs #24/#26/#29) flipped to STRANDED as soon as their remote counterparts were pruned. Because GitHub's squash body lists each original commit subject, requiring EVERY non-merge subject to appear in origin/main's log is the proof that survives main moving. It is last in precedence and needs subjects of real length, so it can only clear a branch whose every commit is already named in the trunk's history.
#
# WHY A CONTENT CHECK AND NOT JUST `rev-list --count`: this repo squash-merges every PR, so a
# landed branch's original commit object is never an ancestor of origin/main. A naive
# ahead-of-origin count reports dozens of already-shipped branch refs as unpushed — a red gate
# nobody acts on, which the 2026-07-19 doctrine says trains everyone to ignore red. Two positive
# tests answer the real question "is this content in the trunk?": a no-op merge into origin/main
# (result tree byte-identical to origin/main's), or `git cherry` finding every commit's patch-id
# already upstream. Either is proof; neither can be satisfied by a genuinely new commit.
#
# THE THIRD PROOF, AND WHY IT IS NEEDED: both structural tests DECAY. A branch that merged
# origin/main into itself before landing has no per-commit patch-id match (the squash's diff is the
# whole branch), and its no-op merge stops holding the first time main edits a file it touched. So a
# branch merged weeks ago silently becomes "STRANDED" as the trunk advances. GitHub's squash body
# lists each original commit subject, so requiring EVERY non-merge commit's subject to appear
# somewhere in origin/main's log is the proof that does not decay. It is deliberately LAST: a subject
# is text, not content, so it can be fooled by a genuinely new commit that reuses an old subject
# verbatim. Short subjects are refused for that reason, and the two structural proofs get first say.
#
# WHY TWO NON-FAILING CLASSES EXIST, AND WHY THEY ARE NOT LOOPHOLES:
#   * `archive/*` — deliberate local-only history snapshots. `archive/pre-scrub-main` holds the
#     pre-scrub trunk, which has NO common ancestor with the clean repo and must never be pushed
#     (the clean repo's entire value is that no dirty commit has ever touched it). Pushing it
#     would be the incident, not the fix.
#   * NO COMMON ANCESTOR with origin/main — the trunk was deleted and recreated (ADR-115 / the
#     2026-07-29 delete-and-recreate), so every ref from before it is unrelated history — the
#     first commit on the current trunk is dated 2026-07-29. It cannot be pushed as
#     a PR at all: there is no merge base to diff against. Both classes are printed by name, never
#     hidden, so the pile stays visible and prunable.
#
# Usage:  bash scripts/check-unpushed-commits.sh [--fetch]
#   --fetch   refresh origin remote-tracking refs first (stale refs cause false STRANDED reports).
#             Also enabled by UNPUSHED_GUARD_FETCH=1. Network failure warns and continues.
#
# Exit codes: 0 = nothing stranded; 1 = stranded local commits found (details on stderr);
#             2 = not a git repo / nothing on origin to compare against.
set -u

WANT_FETCH="${UNPUSHED_GUARD_FETCH:-0}"
for arg in "$@"; do
  case "$arg" in
    --fetch) WANT_FETCH=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 2; }
cd "$repo_root" || exit 2

if [ "$WANT_FETCH" = "1" ]; then
  if ! timeout 120 git fetch --quiet origin 2>/dev/null; then
    echo "WARN: could not fetch origin — judging against possibly stale remote-tracking refs" >&2
  fi
fi

# Nothing can be proven pushed without remote-tracking refs. Fail loud rather than exit 0 on a
# repo where every local commit would trivially look "not in origin".
if [ "$(git for-each-ref --format='%(refname)' refs/remotes/origin | wc -l)" -eq 0 ]; then
  echo "STRANDED-CHECK UNAVAILABLE: no refs/remotes/origin/* refs — run 'git fetch origin' first" >&2
  exit 2
fi
if ! git rev-parse --verify -q origin/main >/dev/null; then
  echo "STRANDED-CHECK UNAVAILABLE: origin/main is missing — run 'git fetch origin' first" >&2
  exit 2
fi
main_tree=$(git rev-parse 'origin/main^{tree}')

fail=0
checked=0
stale_names=""
stale_n=0
orphan_names=""
orphan_n=0
exempt_names=""
exempt_n=0

# --- is this ref's content already in origin/main? -------------------------------------------
# Two independent positive proofs; either one is sufficient, neither is satisfiable by new work.
content_landed() {
  local rev="$1" merged_tree rc
  merged_tree=$(git merge-tree --write-tree --no-messages origin/main "$rev" 2>/dev/null)
  rc=$?
  [ "$rc" -eq 0 ] && [ "$merged_tree" = "$main_tree" ] && return 0
  # Squash merges break ancestry but keep patch-ids: `git cherry` marks an upstream-equivalent
  # commit with '-' and an unlanded one with '+'. Zero '+' lines means everything landed.
  [ "$(git cherry origin/main "$rev" 2>/dev/null | grep -c '^+')" -eq 0 ] && return 0
  subjects_landed "$rev" && return 0
  return 1
}

# --- last-resort proof: is every commit on this ref NAMED in the trunk's history? --------------
# The squash body lists the branch's original subjects, so this survives main advancing past the
# point where the structural proofs decay. Merge commits are skipped: a merge carries no original
# work and never gets a subject of its own in the squash body. A subject shorter than
# MIN_SUBJECT_CHARS is refused as evidence — "wip" matching something is not proof of anything.
MIN_SUBJECT_CHARS=16
main_log_cache=""
subjects_landed() {
  local rev="$1" mb subject found=0
  mb=$(git merge-base "$rev" origin/main 2>/dev/null) || return 1
  if [ -z "$main_log_cache" ]; then
    main_log_cache=$(mktemp) || return 1
    git log --format='%s%n%b' origin/main > "$main_log_cache" 2>/dev/null || return 1
  fi
  while IFS= read -r subject; do
    [ -z "$subject" ] && continue
    [ "${#subject}" -lt "$MIN_SUBJECT_CHARS" ] && return 1
    grep -qF -- "$subject" "$main_log_cache" || return 1
    found=$((found + 1))
  done <<EOF_SUBJ
$(git log --no-merges --format='%s' "$mb..$rev" 2>/dev/null)
EOF_SUBJ
  [ "$found" -gt 0 ]
}

# --- classify one ref -------------------------------------------------------------------------
# Sets `fail=1` only for content that exists nowhere but this disk.
classify() {
  local label="$1" rev="$2" ahead
  ahead=$(git rev-list --count "$rev" --not --remotes=origin 2>/dev/null || echo 0)
  [ "${ahead:-0}" -eq 0 ] && return 0
  checked=$((checked + 1))

  case "$label" in
    archive/*)
      exempt_names="$exempt_names $label"; exempt_n=$((exempt_n + 1)); return 0 ;;
  esac

  if ! git merge-base "$rev" origin/main >/dev/null 2>&1; then
    orphan_names="$orphan_names $label"; orphan_n=$((orphan_n + 1)); return 0
  fi

  if content_landed "$rev"; then
    stale_names="$stale_names $label"; stale_n=$((stale_n + 1)); return 0
  fi

  echo "STRANDED: $label has $ahead commit(s) that exist NOWHERE but this disk, and whose content" >&2
  echo "          is NOT in origin/main. Push it now — Rule 0's 'push immediately after committing'" >&2
  echo "          is the only thing between this commit and oblivion." >&2
  git log --oneline -5 "$rev" --not --remotes=origin 2>/dev/null | sed 's/^/            /' >&2
  fail=1
}

# --- every local branch ----------------------------------------------------------------------
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  classify "$ref" "refs/heads/$ref"
done <<EOF_HEADS
$(git for-each-ref --format='%(refname:short)' refs/heads)
EOF_HEADS

# --- a detached HEAD, in any worktree, carries commits no branch points at -------------------
# `git worktree list --porcelain` emits `detached` instead of `branch <ref>` for those, and the
# stray-worktree guard skips them entirely, so this is the only check that sees them.
wt_path=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *) wt_path="${line#worktree }" ;;
    detached)
      if [ -n "$wt_path" ] && [ -d "$wt_path" ]; then
        head_sha=$(git -C "$wt_path" rev-parse HEAD 2>/dev/null || echo "")
        [ -n "$head_sha" ] && classify "detached HEAD in $wt_path" "$head_sha"
      fi
      ;;
  esac
done <<EOF_WT
$(git worktree list --porcelain)
EOF_WT

# --- summary ---------------------------------------------------------------------------------
# The two non-failing classes are always named, so the pile is visible and can be pruned.
[ "$stale_n" -gt 0 ] && \
  echo "stale refs ($stale_n) — content already in origin/main, safe to 'git branch -D':$stale_names"
[ "$orphan_n" -gt 0 ] && \
  echo "pre-scrub orphans ($orphan_n) — no common ancestor with origin/main (the trunk history restarts 2026-07-29); unpushable by construction:$orphan_names"
[ "$exempt_n" -gt 0 ] && \
  echo "archive refs ($exempt_n) — deliberate local-only history, must NOT be pushed:$exempt_names"

[ -n "$main_log_cache" ] && rm -f "$main_log_cache"

if [ "$fail" -eq 0 ]; then
  echo "unpushed-commits: clean (nothing stranded; $checked ref(s) ahead of origin, all accounted for)"
else
  echo "unpushed-commits: FAILED — the stranded local commits above must be pushed" >&2
fi
exit "$fail"
