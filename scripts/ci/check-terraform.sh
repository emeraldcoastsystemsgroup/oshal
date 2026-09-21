#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Cluster-free gate for the deploy/terraform tenant module: `terraform fmt -check -recursive` and `terraform validate`. The module had no validator of any kind, and fmt -check already flagged two of its files when this gate was written - drift nobody saw because nothing looked. validate runs after `init -backend=false -lockfile=readonly`, so providers are installed only at the versions and hashes the committed .terraform.lock.hcl names, and nothing - no .terraform directory, no lock rewrite - is written into the tree being judged. Neither step configures a provider, so no cluster is contacted. Fail-closed: a missing terraform binary or an empty module never reports PASS.
# =============================================================================
#
# Usage:  bash scripts/ci/check-terraform.sh [root]
#   root  tree to judge (default: the repo this script lives in; ci-local.sh passes GATE_SRC)
#
# Both steps always run, so one red run names every problem. `init` downloads the pinned providers
# from the Terraform registry the first time (verified by terraform against the lock file's
# hashes) and then reuses OSHAL_TF_PLUGIN_CACHE; no network and an empty cache fails validate.
#
# Environment (all optional):
#   OSHAL_TERRAFORM         terraform binary (default: `terraform` on PATH)
#   OSHAL_TF_PLUGIN_CACHE   provider cache directory (default: $TMPDIR/oshal-terraform-plugin-cache)
#
# Exit: 0 = formatted and valid; 1 = fmt or validate failed; 2 = UNCHECKED (terraform is not
#       installed, or there is no module to judge).
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" 2>/dev/null || { echo "terraform: UNCHECKED - cannot enter '$ROOT'"; exit 2; }
MODULE=deploy/terraform
TERRAFORM="${OSHAL_TERRAFORM:-terraform}"

if ! command -v "$TERRAFORM" >/dev/null 2>&1; then
  echo "terraform: UNCHECKED - terraform not found ('$TERRAFORM')."
  echo "terraform: install it from https://releases.hashicorp.com/terraform/ (verify the zip against"
  echo "terraform: that release's SHA256SUMS file) and put it on PATH, or set OSHAL_TERRAFORM to the"
  echo "terraform: binary. This gate does not skip without it."
  exit 2
fi

shopt -s nullglob
TF_FILES=("$MODULE"/*.tf)
shopt -u nullglob
if [ "${#TF_FILES[@]}" -eq 0 ]; then
  echo "terraform: UNCHECKED - no $MODULE/*.tf under $ROOT; nothing was judged."
  exit 2
fi

# A native binary on Windows: hand it mixed-form paths, not MSYS ones.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

echo "terraform: $("$TERRAFORM" version 2>/dev/null | head -1), module $MODULE (${#TF_FILES[@]} .tf files)"
rc=0

echo "terraform: fmt -check -recursive"
if "$TERRAFORM" -chdir="$MODULE" fmt -check -recursive -diff -no-color; then
  echo "terraform: fmt PASS"
else
  echo "terraform: fmt FAIL - the files listed above are not in canonical format (terraform fmt -recursive $MODULE)"
  rc=1
fi

# init writes providers under TF_DATA_DIR, not into the module; -lockfile=readonly refuses to touch
# the committed lock. The data dir is this run's own and is removed with it.
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oshal-tf-data.XXXXXX")" || { echo "terraform: UNCHECKED - no temp dir"; exit 2; }
trap 'rm -rf "$DATA_DIR"' EXIT
PLUGIN_CACHE="${OSHAL_TF_PLUGIN_CACHE:-${TMPDIR:-/tmp}/oshal-terraform-plugin-cache}"
mkdir -p "$PLUGIN_CACHE" || { echo "terraform: UNCHECKED - cannot create plugin cache $PLUGIN_CACHE"; exit 2; }

echo "terraform: init -backend=false -lockfile=readonly, then validate"
if TF_DATA_DIR="$(winpath "$DATA_DIR")" TF_PLUGIN_CACHE_DIR="$(winpath "$PLUGIN_CACHE")" \
   TF_IN_AUTOMATION=1 CHECKPOINT_DISABLE=1 \
   "$TERRAFORM" -chdir="$MODULE" init -backend=false -input=false -lockfile=readonly -no-color >"$DATA_DIR/init.log" 2>&1; then
  if TF_DATA_DIR="$(winpath "$DATA_DIR")" TF_IN_AUTOMATION=1 CHECKPOINT_DISABLE=1 \
     "$TERRAFORM" -chdir="$MODULE" validate -no-color; then
    echo "terraform: validate PASS"
  else
    echo "terraform: validate FAIL"
    rc=1
  fi
else
  cat "$DATA_DIR/init.log"
  echo "terraform: validate FAIL - init did not complete, so the module could not be validated"
  rc=1
fi

[ "$rc" -eq 0 ] && echo "terraform: PASS - $MODULE is formatted and valid." || echo "terraform: FAIL"
exit "$rc"
