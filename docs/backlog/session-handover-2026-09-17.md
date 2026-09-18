# Session handover — 2026-09-17, end of the overnight run

Written at a deliberate stopping point, with the operator out of tokens for five hours. Everything
below was measured at the time of writing, not remembered. The next session should start here.

## State of the tree — nothing is stranded

| | |
|---|---|
| core `C:\Projects\oshal` | on `main` at `18b1bea1`, identical to `origin/main`. Zero ahead, zero behind. |
| store `C:\Projects\oshal-applications` | on `feat/embodied-medium-record`, fast-forwarded to its remote. Zero ahead. |

Both working trees are clean. Two untracked files remain in core, deliberately:

- `RESTART-PLAN.md` — scratch from 2026-09-15 that says to delete itself once the session resumes.
  Its one durable fact is worth keeping: **the api boot strips the `oshal_bot` grants every time**,
  so migration 140 has to be re-applied after every api restart until draft PR #459 merges.
- `docs/apps/intelligent-career-end-to-end-reference.md` — 8,345 lines, a full product and
  reconstruction specification for Intelligent Career. It is left untracked on purpose. This repo is
  public-track with no sanitizer between a commit and the world, and an 8,000-line endpoint catalog
  and data dictionary is exactly the shape of document that deserves a human read before it is
  published, not a wind-down commit. **This is a decision for the operator, not a chore.**

## Work that was stopped mid-flight

Two workflows were running when the tokens ran out and were stopped cleanly. Workflow resume is
same-session only, so neither can be resumed — the next session restarts the work, and both are
worth restarting.

1. **`assign-package-to-person`** — the important one. It exists to answer the operator's objection
   directly: build a real role catalog for little-monsters so a child can be granted `student`
   instead of `@app-admin`, plus the single-action apply path. **Start here.**
2. **Wave 5** — 18 backlog items, build-and-review. Four of its PRs landed before it stopped
   (#620–#623, below); the rest were not reached.

## Open PRs

| PR | what it is |
|---|---|
| #605 | `authz-oidc-app-tier` — an explicit app tier belongs to a (subject, issuer) pair, not a subject. **Its adversarial review was killed by a session restart and never finished.** It must not merge on the strength of the build alone; re-run the review. |
| #620 | the SEC-05 memory ledger proof was written but never run |
| #621 | the remote-client flake was one import billed to the wrong stopwatch |
| #622 | the dev-console sandbox scratch is prepared for a container uid that owns nothing on the host |
| #623 | the incident-RCA cost figures now travel with their n |

## The open design question, in the operator's words

> "i dont understand why [the student] has to be an admin just to be a user of an aplication. thats some
> bullshit."

He is right, and it is a real defect, not a misunderstanding. What was verified:

- The grant **did land**. `oshal_authorization_assignments` carries `little-monsters` for Google subject at issuer `https://accounts.google.com`, role `@app-admin`, tier admin.
- `little-monsters` is `active` again (it and eight others were silently deactivated at 05:07 when
  `persistence-activation` timed out during the crash recovery).
- `swarm_roles` has one row — swarm root is claimed.
- the student's `lm_students` row is `role=student` with **`external_issuer` still NULL**. The package
  self-heals that on her first login (`education-access.ts:236`), so she needs to sign in once.

The cause is one branch in `src/features/application-authorization/service.ts:159-163`: an app with
no role catalog has no vocabulary for "ordinary user", so the only grantable role is `@app-admin` at
tier admin. Inside the package she is genuinely a student — every route in
`little-monsters/src-routes/education-access.ts` keys on `lm_students.role` and none reads the
platform tier. So the label is wrong rather than the access being wrong.

**What was NOT verified, and should be before anyone calls this harmless:** whether any platform
surface *outside* the package — uninstall, grant management for that app — accepts an `@app-admin`
and would therefore accept the student. That is the open question. The fix is a role catalog, which is what
the stopped workflow was building.

## Do not repeat these

- A curl-based grant is blocked by design. `authorizationSameOrigin` in
  `src/app/routes/authorization-routes.ts:30-34` is applied at line 75 to the whole router, `/tool`
  included, so there is no machine path. **Spoofing the browser headers past it was refused and
  should stay refused** — the grant went through an operator console paste instead.
- The running api is on `49686ac4`, **25 commits behind main** (measured). Anything that 404s on the
  box before a deploy is probably just this.

## A publish-gate miss, found by tripping over it

Pushing this handover was **blocked** by the publish gate for carrying the operator's Windows home
path. The gate was right both times it fired, and the path was removed rather than the pattern
narrowed. Checking where else that path appeared turned up the real finding.

The literal cannot be quoted here without becoming the leak it describes. It is the per-user profile
directory with the operator's account name in it, followed by the WSL config file, and
`git show origin/main:docs/OPERATOR-QUEUE.md | grep -n Users` prints it at line 56.

**That identifier is already on public `main`**, merged in #619, in both `docs/OPERATOR-QUEUE.md` and
`docs/backlog/operator-now.json`. This commit removes both occurrences, rewritten to `%USERPROFILE%`,
which is what the runbook should have said anyway.

What is proven, and what is not:

- The local identifier pattern puts a single-character wildcard between path segments. It therefore
  does **not** match the JSON-escaped form, where each separator is two characters. That cleanly
  explains how the `.json` file got through.
- It **does** match the plain single-separator form — proven just now, because that is exactly what
  blocked this push. So the `.md` file's escape in #619 is **not** explained by the pattern, and no
  claim is made here about why. Something about that push differed; what, has not been established.

Done-when: a fixture carrying a **placeholder** account name in all three shapes — forward-slash,
single-separator Windows, and JSON-escaped — is refused by `scripts/publish-gate.sh`, proven by a
test that goes red when the pattern is reverted; plus one check of whether the hook actually ran on
the #619 push. The real patterns stay in the untracked `scripts/publish-gate.local.patterns`; a
tracked fixture must use a placeholder, never the operator's name, or the guard becomes the leak.

Resumed work and current rollout steps: [September 17 authorization resume](session-resume-2026-09-17.md).
