#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Pin deployment source independently of Docker; retain main release checks and require a freshly fetched, exactly published feature branch for explicit previews.
# -----------------------------------------------------------------------------

# Record a safe source refusal for the caller's existing preflight logger.
oshal_deploy_source_error() {
  DEPLOY_SOURCE_ERROR="$*"
  return 2
}

# Preview is explicit and cannot borrow the emergency release override.
oshal_deploy_preview_source() {
  local branch="$1" allow_unpushed="$2" remote upstream current
  [ "$allow_unpushed" -eq 0 ] || { oshal_deploy_source_error "--preview cannot be combined with --allow-unpushed"; return 2; }
  [ "$branch" != main ] || { oshal_deploy_source_error "--preview requires a feature branch; main uses the default release mode"; return 2; }
  remote=$(git config --get "branch.$branch.remote")
  upstream=$(git config --get "branch.$branch.merge")
  if [ "$remote" != origin ] || [ "$upstream" != "refs/heads/$branch" ]; then
    oshal_deploy_source_error "preview branch must track the same published branch on origin"; return 2
  fi
  if ! git fetch --quiet --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; then
    oshal_deploy_source_error "preview fetch failed; a fresh origin branch tip is required"; return 2
  fi
  current=$(git rev-parse --verify "refs/remotes/origin/$branch^{commit}" 2>/dev/null) || {
    oshal_deploy_source_error "preview branch has no published origin tip"; return 2
  }
  if [ "$current" != "$HEAD_SHA" ]; then
    oshal_deploy_source_error "preview HEAD differs from the fresh origin branch tip; synchronize and push first"; return 2
  fi
  if [ "$(git symbolic-ref --quiet --short HEAD)" != "$branch" ] || [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]; then
    oshal_deploy_source_error "preview source changed during preflight; retry from the intended branch"; return 2
  fi
}

# Sets HEAD_SHA once; mutable working-tree files never become build input.
oshal_deploy_source_preflight() {
  local preview="$1" allow_unpushed="$2" branch
  DEPLOY_SOURCE_ERROR=''
  git rev-parse --git-dir >/dev/null 2>&1 || { oshal_deploy_source_error "not a git repo"; return 2; }
  branch=$(git symbolic-ref --quiet --short HEAD) || { oshal_deploy_source_error "detached HEAD is not a deployment branch"; return 2; }
  HEAD_SHA=$(git rev-parse --verify 'HEAD^{commit}') || { oshal_deploy_source_error "HEAD is not a commit"; return 2; }
  if [ "$preview" -eq 1 ]; then
    oshal_deploy_preview_source "$branch" "$allow_unpushed"; return $?
  fi
  [ "$branch" = main ] || { oshal_deploy_source_error "not on main (Rule 0); an authorized feature preview requires --preview"; return 2; }
  git fetch --quiet origin main 2>/dev/null || printf '%s\n' 'warn: fetch failed - comparing against last-known origin/main' >&2
  if [ "$HEAD_SHA" != "$(git rev-parse origin/main)" ] && [ "$allow_unpushed" -ne 1 ]; then
    oshal_deploy_source_error "HEAD != origin/main - push first (or --allow-unpushed for an emergency)"; return 2
  fi
}

# Export canonical committed bytes even if HEAD moves after source admission.
oshal_deploy_archive() {
  git -c core.autocrlf=false archive "$HEAD_SHA"
}

# Preview always verifies source parity, including an existing image/dry run.
oshal_deploy_image_label_matches() {
  local preview="$1" skip_build="$2" label="$3"
  if [ "$preview" -eq 0 ] && [ "$skip_build" -eq 1 ]; then return 0; fi
  [ "$label" = "$HEAD_SHA" ]
}
