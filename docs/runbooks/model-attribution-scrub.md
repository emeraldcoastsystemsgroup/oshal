# Model-attribution scrub — history, PR descriptions, and the guards

**Rule (operator directive, 2026-07-24, reaffirmed 2026-07-31 and 2026-09-09):** no model
attribution anywhere in these repositories — not in commit messages, PR descriptions, issues,
file headers, or files. The harness default of appending a model `Co-Authored-By:` trailer and a
"Generated with" footer is overridden in every repo. The Change Log author is always
`maintainer@emeraldcoastsystemsgroup.com`.

This runbook records the scrub that ran on 2026-09-12, how it was verified, what it could not
remove, and the exact procedure to run it again. The tooling lives in
[`scripts/governance/attribution-scrub/`](../../scripts/governance/attribution-scrub/).

## What happened on 2026-09-12

Sessions following the harness default had re-introduced the trailer after the 2026-07-24 scrub.
Measured before the run (every branch reachable from `origin`, all three repos fetched fresh):

| Repo | Attributed commits | Commits rewritten | Branches force-pushed | PR descriptions edited |
|---|---|---|---|---|
| `oshal` | 139 | 286 | 47 (incl. `main`) | 148 |
| `oshal-applications` | 51 | 163 | 37 (incl. `main`) | 66 |
| `oshal-app-private` | 21 | 49 | 5 (incl. `main`) | 19 |

`agenticfederal`, `emeraldcoastsystemsgroup`, and `jmn-platform` were already clean. "Commits
rewritten" is larger than "attributed" because every descendant of an attributed commit must
change SHA too; nothing older than the first attributed commit (2026-09-02) moved, so the
GitHub-signed history before it kept its SHAs and its "Verified" badge. Rewritten commits that
GitHub had signed lost the badge — inherent to rewriting them.

Also landed: core PR #436 removed the one in-tree source (`scripts/test-lab-nightly.mjs`
hardcoded the trailer into every nightly auto-commit) and added the tree guard
`tests/unit/no-model-attribution.spec.ts`.

End state, verified from a fresh fetch: zero remote-reachable commits with the trailer and zero
tracked-file hits on `main` in all six repos. Local checkouts were re-pointed with pointer moves
only (no checkout, index, or file touched); every local branch showed zero divergence afterwards.

## What cannot be removed by us

- GitHub keeps hidden `refs/pull/N/head` refs for closed PRs. They still point at the old commits
  (verified on `oshal` PRs #426 and #430 after the push), and an old SHA stays viewable at
  `/commit/<sha>` until GitHub garbage-collects. Only GitHub Support can purge unreachable objects.
  None of it is on a branch; the contributors graph is computed from `main`. The decision whether
  to file that request is a BACKLOG item.

## Preconditions

- `git` and `git-filter-repo` (`pip install git-filter-repo`; `git filter-repo --version` must
  answer). Python 3.
- `gh auth status` logged in as the maintainer account (`emeraldcoastsystemsgroup`) with `repo`
  scope. Only that account can edit PR descriptions and toggle rulesets.
- A quiet swarm for the affected repos: post a CLAIM in `COLLABORATE.md` asking for pushes to be
  held, and expect them anyway — the per-ref lease in step 5 is what makes a concurrent push safe.

## Procedure

Work in a scratch directory outside every working clone. Never run `git filter-repo` inside a
working clone: it operates on the process cwd, and on 2026-09-12 it was one prompt away from
rewriting the shared checkout.

1. **Bare clone (not `--mirror`).** `--mirror` fetches GitHub's hidden `refs/pull/*`, and a
   mirror push is refused for them.
   ```bash
   git clone --bare https://github.com/emeraldcoastsystemsgroup/<repo>.git <repo>.git
   git -C <repo>.git for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags > <repo>.old-refs.txt
   ```
2. **Dry run.** Prints the attributed count, the rewrite set (attributed commits plus every
   descendant), the boundary parents that stay untouched, and which refs will move.
   ```bash
   python scripts/governance/attribution-scrub/scrub_history.py <repo>.git --dry-run
   ```
3. **Rewrite.** Message-only; trees are never modified. The script refuses to exit 0 unless
   every rewritten ref has an identical tree and zero attribution remains anywhere. It writes
   `<repo>.commit-map` (old SHA → new SHA) next to the bare clone.
   ```bash
   python scripts/governance/attribution-scrub/scrub_history.py <repo>.git
   ```
4. **Drift check.** If any branch on GitHub moved since step 1, delete the bare clone and repeat
   from step 1. Do not try to merge a moved branch into a rewritten clone.
   ```bash
   diff <(sort -k2 <repo>.old-refs.txt) <(git ls-remote --heads --tags https://github.com/emeraldcoastsystemsgroup/<repo>.git | grep -v '\^{}' | sort -k2)
   ```
5. **Push every moved ref with its own lease.** One `--force-with-lease=<ref>:<old-sha>` per ref;
   a branch someone pushed in the meantime is refused on its own and nothing else is affected.
   ```bash
   while read -r old ref; do
     new=$(git -C <repo>.git rev-parse "$ref"); [ "$new" = "$old" ] && continue
     args+=("--force-with-lease=$ref:$old" "$new:$ref")
   done < <repo>.old-refs.txt
   git -C <repo>.git push https://github.com/emeraldcoastsystemsgroup/<repo>.git "${args[@]}"
   ```
   **`oshal` only:** `main` is protected by ruleset `20009106` (`non_fast_forward` + `deletion`,
   bypass = nobody, including the owner). Disable it for the push and restore it immediately,
   then read it back and confirm the rules, bypass list, and target are unchanged:
   ```bash
   gh api -X PUT repos/emeraldcoastsystemsgroup/oshal/rulesets/20009106 -f enforcement=disabled
   # ... push ...
   gh api -X PUT repos/emeraldcoastsystemsgroup/oshal/rulesets/20009106 -f enforcement=active
   gh api repos/emeraldcoastsystemsgroup/oshal/rulesets/20009106 --jq '{enforcement, rules: [.rules[].type], bypass: .bypass_actors, target: .conditions.ref_name.include}'
   ```
   The private repos are on the free plan and have no rulesets (the API answers 403), so a plain
   push with leases is enough there.
6. **Verify the remote.** `git ls-remote --heads <url>` must equal the bare clone's heads, and a
   fresh `git fetch` in a working clone must show zero attributed commits reachable from remotes:
   ```bash
   git log --remotes -i -E --grep='co-authored-by:.*noreply@anthropic' --grep='generated with \[claude code\]' --format=%h | wc -l
   ```
7. **PR descriptions.** Lists every PR (any state) whose body carries the footer or a trailer,
   re-reads each body immediately before patching, and re-reads after to prove it is gone.
   ```bash
   python scripts/governance/attribution-scrub/strip_pr_footers.py emeraldcoastsystemsgroup/<repo> --dry-run
   python scripts/governance/attribution-scrub/strip_pr_footers.py emeraldcoastsystemsgroup/<repo>
   ```
8. **Re-point the working clones — pointer-only.** In each shared checkout, after `git fetch
   origin`, run the re-point with the commit-map and the old-refs file from step 1. A tip that is
   in the map moves with `update-ref`; a branch with unpushed commits gets those commits rebuilt on
   the mapped parents (same tree, author, committer, dates; cleaned message); a branch unrelated
   to the rewritten range is left alone and listed. Every move asserts old tree == new tree. No
   checkout, no index change, no file touched — this is the only shape allowed in the shared
   multi-agent checkouts (CLAUDE.md Rule 0).
   ```bash
   python scripts/governance/attribution-scrub/repoint_local.py <working-clone> <repo>.commit-map <repo>.old-refs.txt --dry-run
   python scripts/governance/attribution-scrub/repoint_local.py <working-clone> <repo>.commit-map <repo>.old-refs.txt
   ```
9. **Release the COLLABORATE claim** and state the new `main` SHA. Anyone whose push is refused
   afterwards needs `git fetch` then `git rebase origin/<branch>` — nothing more.

## Landmines met on 2026-09-12

- `git filter-repo` runs on the **process cwd**. `chdir` into the bare clone first (the script
  does); the working clone's leftover `.git/filter-repo/already_ran` marker is what stopped the
  first attempt.
- A branch moved on GitHub between the clone and the push (another agent's normal work). The
  lease refused exactly that ref; re-clone and re-run rather than patching the rewritten clone.
- Rewriting only descendants of attributed commits is what keeps churn small: 171 of the 200
  `main` commits before the range were GitHub-signed, and a whole-history pass through
  `fast-export` drops every signature and changes every SHA.
- On Windows: the Write tool produces CRLF (normalize to LF before hashing blobs), `tar -C` needs
  a POSIX path (`cygpath -u`), `cmd /c mklink` needs `MSYS_NO_PATHCONV=1`, and long heredocs
  mangle backslashes — put scripts in files.
- A loose grep for "Generated with" flags the runbook and the fix's own prose. The guards match
  the full shapes (the markdown link, or a `Co-Authored-By:` line carrying the vendor no-reply
  address in angle brackets), so mentions like this paragraph do not trip them.

## Guards in place

- `tests/unit/no-model-attribution.spec.ts` — every tracked text file (git when `.git` exists,
  a tree walk in the ci-local `--head` export shape otherwise); red-proven on fixtures.
- `tests/unit/attribution-scrub-tooling.spec.ts` — drives the real rewrite over a fixture repo
  (real git + git-filter-repo): trailer and footer gone, trees identical, clean root SHA kept.
- `scripts/test-lab-nightly.mjs` no longer writes the trailer (PR #436).

## How to continue (BACKLOG, "Promotion, deployment, and regression proof")

- *Publish gate: refuse model-attribution trailers at push time* — the pre-push wall for the
  public repo; commit messages are where the trailers came from and the tree guard cannot see them.
- *Store and private repos have no attribution guard* — `oshal-applications` and
  `oshal-app-private` were scrubbed but nothing stops a recurrence there.
- *GitHub-side residue of the 2026-09-12 attribution scrub* — decide whether to ask GitHub Support
  to purge the unreachable objects and closed-PR refs, and record the decision.
