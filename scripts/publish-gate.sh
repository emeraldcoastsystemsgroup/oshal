#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                     | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Fail-closed publish gate for developing directly on the public repo: scans tracked files for internal-only paths, vendor-prefixed credentials, and personal/employer identifiers. Attribution (author name + business email) and verified false positives (real place names, TTS voice ids) are deliberately excluded. Bare `git grep` (NOT `-- $(git ls-files)`, which argv-overflows and fails OPEN).
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Moved the personal/employer identifier list OUT of this tracked file into gitignored scripts/publish-gate.local.patterns: a public denylist republishes the very identifiers it protects (leak by enumeration — an employer name and family-name rules were publicly readable in this file's own regex). The gate loads the local file when present (fail-closed on this box), refuses if the patterns file is ever tracked, and states plainly when running with generic rules only.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Closed the binary blind spot. Every check here used `git grep -I`, which skips binary files, so the gate was text-only and a screenshot of a filled-in job application (home address, phone, EEO disclosures) passed clean — nothing in a PNG for a regex to match. Found live: artifacts/remote-control/ held 105 such captures, unignored, because the ignore rules covered only loose files at the top of artifacts/. New check 4 inverts the question for binaries — media is allowed ONLY in declared curated directories, everything else refused, so an automation pipeline dropping captures into a fresh dir fails closed without anyone having predicted the dir's name. Guarded by tests/unit/publish-gate.spec.ts.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Check 5 now refuses MODEL ATTRIBUTION in the commit messages a push publishes: a '-by:' trailer naming Claude or Anthropic, the vendor no-reply address, or the 'generated with' tool footer, matched case-insensitively on the identifier. The 2026-09-12 history scrub left no attributed commit reachable from origin; by 2026-09-14, 45 were reachable from main again (the scrub runbook's step-6 query at d679b696). The tree guard reads files, and no check read commit messages for this. Also fixes the scope: as the pre-push hook (--pre-push) the gate reads git's ref-update lines from stdin and judges the commits actually being pushed - a push BY SHA, the shared checkout's private-index recipe, publishes commits HEAD never reaches. History the remote already holds stays out of scope. The credential scan keeps HEAD and adds the pushed commits, so it only widens.
# =============================================================================
# publish-gate.sh — the safety net for developing directly on the PUBLIC repo.
#
# This repository IS public. There is no scrubber between a commit here and the
# whole world, so this gate is what the scrubber used to be: a fail-closed scan
# that refuses to let personal, employer, or credential-shaped content ship.
#
# It runs as the pre-push hook (.githooks/pre-push) and can be run by hand:
#     bash scripts/publish-gate.sh
# The hook passes --pre-push and git's ref-update lines on stdin, so check 5 judges the
# commits actually being pushed; by hand, the push is assumed to be HEAD.
#
# It scans TRACKED files only (git ls-files) — what a push would actually send.
#
# ATTRIBUTION IS NOT A LEAK. The maintainer alias (oshal maintainers) and its
# business email (maintainer@emeraldcoastsystemsgroup.com) are deliberately absent
# from every pattern below. The gate blocks only what is not the project's to
# publish, or what breaks other people's installs.
#
# RULE learned the hard way (five separate leak rounds): gate on the IDENTIFIER,
# never on an enumeration of the places it has appeared so far.
# =============================================================================
set -uo pipefail

# --pre-push: called as the pre-push hook. git writes one "<local ref> <local sha> <remote ref>
# <remote sha>" line per pushed ref to the hook's stdin. Read them FIRST, before any later command
# could consume stdin. Refuse to wait on a terminal: a hand run takes no argument.
PRE_PUSH=0
PUSH_LINES=""
case "${1:-}" in
  "") ;;
  --pre-push)
    PRE_PUSH=1
    if [ -t 0 ]; then
      printf 'publish-gate: --pre-push reads the ref lines git gives a pre-push hook on stdin; by hand, run it with no argument\n' >&2
      exit 2
    fi
    PUSH_LINES="$(cat)"
    ;;
  *) printf 'usage: %s [--pre-push]\n' "$0" >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
fail=0

say()  { printf '%s\n' "$*"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$*" >&2; fail=1; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }

# ── 1. Internal-only paths must never reappear in the public tree ─────────────
# These were dropped from the public snapshot on purpose: internal coordination,
# session briefs, the nightly QA corpus, personal career runbooks, the private
# release tooling, and the three commercial packages that live in oshal-app-private.
INTERNAL_PATHS='^(COLLABORATE\.md|ralf/|docs/evidence/|docs/intelligent-career-automation/|docs/archive/|scripts/release/|scripts/benchmark-results/|gov-contracting/|federal-capture/|capture-crm/|apps/)'
if git ls-files | grep -qE "$INTERNAL_PATHS"; then
  bad "internal-only paths are tracked (must not be in the public repo):"
  git ls-files | grep -E "$INTERNAL_PATHS" | sed 's/^/       /' | head -20 >&2
else
  ok "no internal-only paths tracked"
fi

# ── 2. Vendor-prefixed credentials, in every tracked text file ────────────────
CRED_RE='AKIA[0-9A-Z]{16}|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|hskey-auth-[A-Za-z0-9_-]{10,}|tskey-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{15,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|xox[bpsa]-[A-Za-z0-9-]{10,}|GOCSPX-[A-Za-z0-9_-]{10,}|dop_v1_[a-f0-9]{40,}|shpat_[a-f0-9]{32}'
# NOTE: bare `git grep` searches ALL tracked files (index + working tree). Do NOT pass
# `-- $(git ls-files)`: on a 4000-file tree that argv overflows and git grep exits 126,
# which `|| true` would swallow into a FALSE "clean" — a gate that fails open is worse
# than no gate. (Caught in testing: an injected leak sailed through exactly this way.)
# Exclusions mirror core's tier-A gate: `MIIBOgIBAAJBAK` is the truncated FAKE key body used
# in fixtures, and a QUOTED `'-----BEGIN ... PRIVATE KEY` is a string-literal assertion (the DLP
# redactor + kalshi-auth specs test PEM handling with no real material). A genuine key ships as
# a multi-line .pem/.key file (gitignored), never a single quoted assertion line.
# SELF is this gate + the hook. They necessarily CONTAIN every pattern they scan for (the regex
# source below), so they must be excluded — otherwise the gate flags itself, the same
# "publishing the sanitizer defeats the sanitizer" problem core solved by dropping its scrubber
# from the public cut. This gate ships (it's the ongoing safety net), so it self-excludes instead.
SELF=(":(exclude)scripts/publish-gate.sh" ":(exclude).githooks/pre-push")
CRED_HITS="$(git grep -nIE "$CRED_RE" -- . "${SELF[@]}" 2>/dev/null | grep -viE "REPLACE_ME|CHANGE_ME|example|placeholder|<[^>]+>|MIIBOgIBAAJBAK|['\"]-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY" || true)"
if [ -n "$CRED_HITS" ]; then
  bad "vendor-prefixed credential(s):"
  printf '%s\n' "$CRED_HITS" | sed 's/^/       /' | head -10 >&2
else
  ok "no vendor-prefixed credentials"
fi

# ── 3. Personal / employer identifiers ────────────────────────────────────────
# The sensitive pattern list is deliberately NOT tracked: a public denylist would
# republish the very identifiers it protects — leak by enumeration; this file's own
# regex is exactly how an employer name and family names reached the public tree.
# Operator boxes carry scripts/publish-gate.local.patterns (gitignored; one ERE per
# line, # comments allowed). Without it the gate still enforces every generic rule
# above and says so. NOTE the standing omissions: the maintainer's NAME and BUSINESS
# EMAIL are intentionally never gated (attribution), and bare given names are never
# gated ("Michelle" is an Azure TTS voice id; "elizabeth" is a town in us_cities.tsv).
LOCAL_PATTERNS="$(cd "$(dirname "$0")" && pwd)/publish-gate.local.patterns"
ID_RE=""
if git ls-files --error-unmatch "scripts/publish-gate.local.patterns" >/dev/null 2>&1; then
  bad "scripts/publish-gate.local.patterns is TRACKED — the identifier list must never be committed"
fi
if [ -f "$LOCAL_PATTERNS" ]; then
  ID_RE="$(grep -vE '^[[:space:]]*(#|$)' "$LOCAL_PATTERNS" | paste -sd'|' -)"
  if [ -n "$ID_RE" ]; then
    ID_HITS="$(git grep -nIE "$ID_RE" -- . "${SELF[@]}" 2>/dev/null | grep -viE 'example-user-sub|REDACTED|internal\.example\.com' || true)"
    if [ -n "$ID_HITS" ]; then
      bad "personal / employer identifier(s):"
      printf '%s\n' "$ID_HITS" | sed 's/^/       /' | head -15 >&2
    else
      ok "no personal / employer identifiers"
    fi
  fi
else
  say "  (i) operator identifier patterns absent (scripts/publish-gate.local.patterns) — generic checks only"
fi

# ── 4. Tracked binary media must live in a declared, curated directory ────────
# Checks 2 and 3 use `git grep -I`, which SKIPS binary files by definition. Every rule above is
# therefore text-only, and a screenshot is not text: a PNG of a filled-in job application — home
# address, phone, EEO disclosures — passes this gate clean, because there is nothing in it for a
# regex to match. That is not a pattern that needs widening; it is a whole class of content the
# wall never looked at.
#
# So invert the question for binaries. Text is reviewable by regex; an image is only reviewable by
# a human opening it. Media is allowed ONLY where curated media is declared to live, and anywhere
# else is refused — a new binary in an undeclared location is unreviewed-by-construction. This
# fails closed on the thing that actually happens (an automation pipeline dropping captures into a
# fresh directory) without depending on anyone having predicted that directory's name.
#
# Adding genuinely curated media is deliberate: put it in an allowed directory, or add the
# directory here in the same commit that adds the file — having looked at it.
MEDIA_RE='\.(png|jpe?g|gif|webp|bmp|tiff?|heic|pdf|zip|docx|xlsx|pptx|mp4|mov|avi|mkv|mp3|wav|sqlite|db)$'
                                                                                 # ↓ audited 2026-08-02: raw bytes AND all decompressed
                                                                                 #   streams scanned — zero hits for user paths, AppData,
                                                                                 #   scratchpad or file: URIs; metadata is Chromium/Skia only.
                                                                                 #   Listed as an EXACT FILE, like the whitepaper, so other
                                                                                 #   binaries landing in docs/research/ still trip the gate.
MEDIA_ALLOW='^(artifacts/jarvis-rich-ux-mockups/|docs/OSHAL-WHITEPAPER\.pdf$|docs/research/ambient-energy-vessel-report\.pdf$|docs/assets/|packages/[^/]+/images/|packages/[^/]+/icon\.png$|site/[^/]+/assets/|src/pages/cockpit/icons/)'
STRAY_MEDIA="$(git ls-files | grep -iE "$MEDIA_RE" | grep -vE "$MEDIA_ALLOW" || true)"
if [ -n "$STRAY_MEDIA" ]; then
  bad "binary media tracked outside a curated directory (checks above are text-only and CANNOT read these):"
  printf '%s\n' "$STRAY_MEDIA" | sed 's/^/       /' | head -15 >&2
  say "      → Open each one. If it is curated content, add its directory to MEDIA_ALLOW in this"
  say "        file. If it is pipeline debris (screenshots, exports), it belongs in .gitignore."
else
  ok "no binary media outside curated directories"
fi

# ── 5. Commit MESSAGES, which every rule above is blind to ────────────────────
# Checks 1-4 scan the TREE: `git ls-files` and `git grep` read file contents. A commit
# message is not a file. It is pushed, it is rendered on the public repo page, it is
# permanent — and until now it was the one part of a push this gate never looked at. A
# client name, a home address, or a token pasted into `git commit -m` shipped through a
# wall that printed "clean".
#
# It is also the expensive kind of leak to undo: fixing a published message means
# rewriting history, and the branch ruleset now refuses force-pushes on main with no
# bypass for anyone. Refusing the push is far cheaper than needing the rewrite.
#
# Scope is `HEAD --not --remotes` — exactly the commits THIS push would publish.
# Deliberately NOT `--all`: this box carries archive/pre-scrub-main and old worktree lanes
# that will never be pushed, and scanning them would fail the gate on every push forever.
# A gate that cries wolf on unpushable history is a gate people start bypassing.
#
# As the pre-push hook (--pre-push) the push itself is known: each ref-update line names the
# commit being pushed, and `<sha> --not --remotes` (less the remote's current tip of that ref,
# when this clone holds it) is what that ref publishes. HEAD is NOT the push when a commit goes
# out BY SHA (`git push origin <sha>:refs/heads/x`) - the private-index recipe every agent in the
# shared checkout uses while HEAD sits on another lane's branch.
MSG_SCAN_RE="$CRED_RE"
[ -n "$ID_RE" ] && MSG_SCAN_RE="$CRED_RE|$ID_RE"
HEAD_PENDING="$(git rev-list HEAD --not --remotes 2>/dev/null || true)"
PUSHED="$HEAD_PENDING"
if [ "$PRE_PUSH" -eq 1 ]; then
  PUSHED=""
  while read -r lref lsha _rref rsha; do
    [ -n "$lsha" ] && [ -n "${lsha//0/}" ] || continue    # blank, or all zeros: a DELETION publishes nothing
    ALREADY=""
    if [ -n "${rsha//0/}" ] && git cat-file -e "${rsha}^{commit}" 2>/dev/null; then ALREADY="$rsha"; fi
    if ! PART="$(git rev-list "$lsha" --not --remotes $ALREADY 2>/dev/null)"; then
      bad "cannot list the commits this push publishes for ${lref} (${lsha}) - refusing rather than scanning nothing"
      continue
    fi
    [ -n "$PART" ] && PUSHED="${PUSHED}${PART}"$'\n'
  done <<< "$PUSH_LINES"
fi
# The credential / identifier scan keeps HEAD's unpublished commits and adds the pushed ones, so it
# only ever widens. The attribution scan (5b) judges exactly what this push publishes.
PENDING="$(printf '%s\n%s\n' "$HEAD_PENDING" "$PUSHED" | awk 'NF && !seen[$0]++')"
if [ -z "$PENDING" ]; then
  ok "no unpublished commit messages to scan"
else
  MSG_HITS=""
  for sha in $PENDING; do
    HIT="$(git show -s --format='%B' "$sha" 2>/dev/null \
      | grep -IE "$MSG_SCAN_RE" \
      | grep -viE "REPLACE_ME|CHANGE_ME|example|placeholder|<[^>]+>|MIIBOgIBAAJBAK" \
      | head -2 || true)"
    if [ -n "$HIT" ]; then
      MSG_HITS="${MSG_HITS}$(git rev-parse --short "$sha"): $(printf '%s' "$HIT" | tr '\n' ' ')
"
    fi
  done
  if [ -n "$MSG_HITS" ]; then
    bad "personal / credential content in unpublished COMMIT MESSAGE(s):"
    printf '%s' "$MSG_HITS" | sed 's/^/       /' | head -10 >&2
    say "      → Reword before pushing: git commit --amend  (or git rebase -i for older ones)."
    say "        Once pushed this is permanent — main refuses force-pushes for everyone."
  else
    ok "no personal / credential content in unpublished commit messages"
  fi
fi

# ── 5b. Model attribution in the commit messages this push publishes ─────────
# Operator directive: no model attribution anywhere in this repository - not in files, commit
# messages or PR descriptions. The tree guard (tests/unit/no-model-attribution.spec.ts) reads
# FILES; a harness session's default puts a co-author trailer and a tool footer in the commit
# MESSAGE, which only this check sees. The 2026-09-12 history scrub
# (docs/runbooks/model-attribution-scrub.md) left no attributed commit reachable from origin; by
# 2026-09-14, 45 were reachable from main again (that runbook's step-6 query at d679b696).
#
# Matched on the IDENTIFIER, case-insensitively, in any spelling a session produces:
#   - a '-by:' trailer (Co-Authored-By, Co-authored-by, Assisted-by, Signed-off-by, ...) whose
#     value names Claude or Anthropic, at any address. The name is the identifier, so a trailer
#     naming a person called Claude is refused too - credit them in the body instead;
#   - the vendor's no-reply address anywhere in the message;
#   - 'generated with / by / using / via' followed by Claude: the tool footer, link or no link.
# Deliberately NOT through the credential scan's exclusion filter above: that filter drops every
# line holding '<...>', and every trailer carries its address in angle brackets. `grep -a` so a
# message is always read as text; LC_ALL=C so case folding and classes behave the same everywhere.
#
# Scope is PUSHED: exactly the commits this push publishes. History the remote already holds is
# out of scope by construction - main still carries those 45 commits, removing them is an
# operator-run history rewrite, and a gate that refused every push until then would halt all work.
ATTRIB_RE='^[[:space:]]*[a-z]+([-_ ][a-z]+)*[-_ ]by[[:space:]]*:.*(claude|anthropic)|no-?reply@([a-z0-9-]+\.)*anthropic\.com|generated[[:space:]]+(with|by|using|via)[^[:alnum:]]*claude'
ATTRIB_HITS=""
ATTRIB_FIXES=""
for sha in $PUSHED; do
  if ! MSG="$(git show -s --format='%B' "$sha" 2>/dev/null)"; then
    bad "cannot read the message of pushed commit $sha - refusing rather than passing it unread"
    continue
  fi
  HIT="$(printf '%s\n' "$MSG" | LC_ALL=C grep -aiE "$ATTRIB_RE" | head -3 || true)"
  [ -n "$HIT" ] || continue
  SHORT="$(git rev-parse --short "$sha")"
  ATTRIB_HITS="${ATTRIB_HITS}${SHORT} $(git log -1 --format='%s' "$sha")"$'\n'"$(printf '%s\n' "$HIT" | sed 's/^/    /')"$'\n'
  ATTRIB_FIXES="${ATTRIB_FIXES}          ${SHORT}:  git rebase -i ${SHORT}~1   (mark it 'reword'), or git commit --amend if it is your branch tip"$'\n'
done
if [ -n "$ATTRIB_HITS" ]; then
  bad "model attribution in unpublished COMMIT MESSAGE(s) - none is allowed in this repository:"
  printf '%s' "$ATTRIB_HITS" | sed 's/^/       /' >&2
  say "      -> Delete those lines from each message, then push again:"
  printf '%s' "$ATTRIB_FIXES"
  say "        Built with git commit-tree (private index)? Rebuild it with a clean -F message instead."
  say "        Never push with --no-verify: this gate is the only wall between this repo and the world."
else
  ok "no model attribution in unpublished commit messages"
fi

echo ""
if [ "$fail" -ne 0 ]; then
  say "PUBLISH GATE FAILED — this content is PUBLIC. Remove the flagged items before pushing."
  say "If a hit is a genuine false positive (a real place name, a documented example),"
  say "narrow the pattern in scripts/publish-gate.sh rather than weakening the gate."
  exit 1
fi
say "Publish gate clean."
exit 0
