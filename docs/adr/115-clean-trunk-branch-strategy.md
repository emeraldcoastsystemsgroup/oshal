# ADR-115 — The clean repo is the trunk: branch strategy, and application code never mixes with swarm code

- Status: Accepted — CORE CUTOVER EXECUTED 2026-07-23/24: this repo (`emeraldcoastsystemsgroup/oshal`) is the development trunk and the private full-history repo is a reference archive (CLAUDE.md Rule 0b). The store cutover (`oshal-applications` → `oshal-apps`) is still pending a quiet swarm. (Reconciled 2026-07-31.)
- Date: 2026-07-23
- Related: [ADR-085](085-remote-app-packages-and-registries.md) (apps carve out of the kernel), [ADR-093](093-packaged-app-runtime-placement.md) (bot placement — the D1 interim this depends on), [ADR-090](090-skills-as-first-class-packages.md) (kernel skills = the package-facing API), [ADR-090-CI](090-github-actions-to-local-ci.md) (why CI is local), `docs/release/PUBLIC-RELEASE-SOP.md` (**not in this repo** — the go-public SOP is internal-only and lives in the private archive; `scripts/publish-gate.sh` refuses `scripts/release/` for the same reason)

## Context

Development happens in two private full-history repos — `open-shal` (the platform) and
`oshal-applications` (the app store) — under RULE 0: everyone on `main`, no branches, commit and
push constantly. The public repos (`oshal`, `oshal-apps`) are **derived artifacts**: a sanitizer
exports tracked HEAD, drops internal trees, scrubs identifiers, gates fail-closed across four secret
tiers plus gitleaks, and emits a **single root commit with no history**.

That model was chosen deliberately over the alternative. The original plan — rebase the private work
onto the public repo and share history, developing on branches in an extension repo — was rejected
as *one mis-push from a leak*, and the record supports it: squashing history did not remove a
Headscale key that was in the **tree**, and a force-push does not purge GitHub's object store (every
old commit stayed fetchable by SHA, and a closed PR page advertised them). The repo had to be
renamed and recreated. Five independent leak rounds since then found real material the gate had just
called clean, including a non-rotatable AWS GovCloud account id and customer-identifying cluster
names in a live bot prompt.

Two problems remain with the status quo.

**First, the derived public repo is permanently stale.** A snapshot is a photograph. As of this ADR
the public core trunk holds 4 commits, last updated 2026-07-22 22:07, while the private trunk has
taken 38 commits since. A trunk that is never the truth is not a trunk. A "Model A" cutover was
tooled up on 2026-07-22 — `publish-gate.sh` as a fail-closed pre-push hook, a PR workflow, hooks
that permit branches — and then nothing moved: every one of those 38 commits landed in the private
repo anyway. Tooling without a rule does not change behavior.

**Second, nothing enforces the app/platform split.** [ADR-085](085-remote-app-packages-and-registries.md) spent 21
carves moving every application surface out of the kernel; the public core snapshot is therefore
app-free *by construction*, not by filtering. But no check stops an application walking back in. The
failure mode is silent and late: a re-mixed app is discovered at publish time, in the artifact, when
the cost of unwinding it is highest.

## Decision

**1. The clean, no-history repo becomes the trunk, and work happens on branches.**

`emeraldcoastsystemsgroup/oshal` (core) and `emeraldcoastsystemsgroup/oshal-apps` (store) are the
development trunks. The model changes from *everyone-on-main* to **branch → PR → merge**. RULE 0's
trunk discipline (pull before you start, commit small, push immediately, never reset away from
another agent's work, claim files in COLLABORATE.md) survives intact — what changes is that `main`
is reached through a branch and a merge instead of directly.

The private repos keep their full history and are **not** force-pushed over. They become the
reference archive plus the home of what may never be public: `COLLABORATE.md`, `ralf/`,
`docs/evidence/`, `scripts/release/` (whose `secret-replacements.txt` holds real values), and the
personal/internal doc trees the sanitizer drops.

**There is no rebase of private history onto the clean repo.** "Rebase" here means *replay the
current state*, not the commits: the cutover cuts one final gated snapshot from private HEAD and
lands it as one commit on the clean trunk. Dirty history never travels — that property is the entire
reason the clean repo exists, and a rebase would destroy it.

**2. The publish gate replaces the scrubber, and it runs on every push.**

Developing directly in a public-track repo means there is no sanitizer standing between a commit and
the world. `scripts/publish-gate.sh` is that wall instead: a fail-closed pre-push hook (plus a
server-side PR check, which is the bypass-proof half) that refuses internal-only paths,
vendor-prefixed credentials, and personal/employer identifiers. It gates on the **identifier**,
never on an enumeration of where that identifier has appeared — the rule learned across five leak
rounds. Attribution is explicitly *not* a leak: the author's name and business email are preserved
by design.

**3. Application code never mixes with swarm code, and a guard enforces it.**

The swarm repo ships the **platform**; applications ship from the **store** repo. The sharpest
marker of the boundary is `oshal-app.yaml` — the store package manifest. Exactly one of those in the
kernel tree means an application has been re-mixed into the platform.

This is the *repo* boundary, and it is a different axis from the older
[swarm-agent-code-separation-plan](swarm-agent-code-separation-plan.md), which splits controller
code from worker code **inside** the kernel. Both can hold at once; do not conflate them.

`scripts/check-repo-separation.js` asserts, on committed HEAD:

- no tracked `oshal-app.yaml` anywhere in the kernel;
- `swarm-apps/*.yaml` is **exactly** the ten kernel-resident manifests (`jarvis`, `oshal-dev`,
  `oshal-engineering`, `security`, `workflow-studio`, `codex-packer`, `person-model`, `devops`,
  `intelligent-operations`, `intelligent-processing`) — an addition is a new application inside the
  platform repo, a removal is a core-platform app carved by mistake;
- the explicit-load variant dir (`swarm-apps-build/`) holds its fixed membership;
- no tracked `apps/` or `deployed-apps/` (installed-package staging lives in the workspace volume);
- and, when a store checkout is present, that the store holds no kernel-shaped paths.

It runs as a `ci-local.sh` gate (`repo-separation`), in the Actions TypeCheck job, and
`tests/unit/repo-separation.spec.ts` proves it goes **red** on each violation shape using fixture
checkouts — never this tree's shared index. Widening `KERNEL_MANIFESTS` is an architectural decision
that belongs in an ADR, not a convenience edit.

**4. The cutover is a gated, one-command operation that requires a quiet swarm.**

`scripts/release/cutover-to-clean-trunk.sh` refuses to run while the swarm is live — recent commits,
an unreleased COLLABORATE claim, or a dirty tree all abort it. This is not ceremony: a snapshot taken
mid-flight strands whatever another agent has not yet pushed, and *that agent's work is invisible in
the new trunk*. The script gates (typecheck + unit + separation), cuts the sanitized baseline, lands
one commit on the clean trunk, and verifies the result before anything is pushed.

## Consequences

- **Positive:** the public repo becomes the truth instead of a stale photograph; review re-enters the
  loop (branch → PR) without reintroducing the leak risk of shared history; the app/platform split
  is enforced by a red gate instead of discipline; the private history stays private, permanently.
- **Positive:** the separation guard closes a defect class that was previously only discoverable at
  publish time.
- **Negative:** branch → PR → merge is slower than everyone-on-main, and this is a multi-agent repo
  where the shared index is already a constraint. Branches reduce index contention but add merge
  work; claims in COLLABORATE.md matter *more*, not less.
- **Negative (resolved 2026-07-23, see Done-when 2):** internal coordination (COLLABORATE.md) cannot
  live in the public trunk, so the thread and the code would be in different repos after cutover.
  This was called out here as the weakest point of the design and needing a decision. The decision
  taken was neither of the two options sketched above: the thread does not travel through git at
  **all**. It is gitignored in the core trunk (`.gitignore`), refused by `scripts/publish-gate.sh`
  (`INTERNAL_PATHS`), and therefore local to each working directory — which is workable precisely
  because Rule 0a keeps the swarm to **one worktree**, so "local to the working directory" and
  "visible to every agent" are the same set. The cost of the choice is real and accepted: the thread
  does not survive a re-clone and a second checkout cannot see it, so anything that must outlive the
  working directory belongs in an ADR, a runbook, or the BACKLOG — not in COLLABORATE.md.
- **Negative:** the cutover has a real cost — every agent re-clones, and any work not pushed at
  freeze time is stranded. Hence the quiet-swarm precondition.

## Done-when — status verified 2026-08-02

Every remaining item is **store-side**. The core half of this ADR is closed.

1. ✅ **Core cutover executed (2026-07-23/24).** `emeraldcoastsystemsgroup/oshal` holds the gated
   snapshot of private HEAD, every agent works from it, and the private full-history repo is a
   reference archive — recorded as binding in CLAUDE.md Rule 0b. ⬜ **The store cutover
   (`oshal-applications` → `oshal-apps`) is still open** and still blocked on the same quiet-swarm
   bar §4 sets; `oshal-apps` exists on GitHub but has not received the snapshot.
2. ✅ **COLLABORATE.md home decided: it never enters git.** Gitignored in the core trunk and refused
   by `scripts/publish-gate.sh`, so the thread is local to the single shared working directory (Rule
   0a) rather than living in either repo. See the reconciled Consequences bullet above for the cost
   this accepts. This ADR no longer has an unanswered design question.
3. ⬜ **Store-side guard** — still open. `oshal-apps` gets its own pre-push separation check; today
   the reverse direction is only checked opportunistically, from the core repo, when the sibling
   checkout is on the box. Verified 2026-08-02: the store checkout has no `.githooks/` and no
   `core.hooksPath`, so nothing runs on a store push.
4. ⬜ **The store snapshot still ships `COLLABORATE.md`** — re-verified 2026-08-02, the file is
   still tracked in the store checkout. Core's gate drops it explicitly; the store emit script does
   not. Fix before `oshal-apps` takes the snapshot.
5. ✅ core / ⬜ store — **Branch protection.** Core `main` is protected by two **rulesets** (not
   classic branch protection, which is why a `branches/main/protection` probe 404s): *"main: no
   force-push, no delete"* (`deletion` + `non_fast_forward`) and *"main: pull request required"*
   (1 approving review, dismiss-stale-on-push, require-last-push-approval, thread resolution), both
   `enforcement: active` since 2026-07-29. `oshal-apps` has **no** rules on `main` yet.
