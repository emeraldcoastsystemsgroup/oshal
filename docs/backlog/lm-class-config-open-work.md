# Little Monsters — class configuration (OPEN WORK / handover)

**Status:** shipped & verified on the local stack (real Google OIDC via the Cloudflare tunnel) · session 2026-06-13.
**Owner intent:** a single-school ("demo tenant") model where students sign in with their own SSO identity, join teacher-published classes from a **Class Bank** or create their own **private** class, and attach documents (incl. phone photos, OCR'd) that stay **private to them** by default. Sharing with a class is a teacher action and is deferred.

This file is the resume point for the class-management/Class-Bank/materials work. The forward-looking feature wishlist lives in [lm-feature-backlog.md](lm-feature-backlog.md); operator/infra deferrals live in the root [BACKLOG.md](../BACKLOG.md).

## What this configuration is
- **Identity is server-side.** `resolveAuthedStudent` maps the OIDC session (Google `sub` + email) to an `lm_students` row (provisioned on first sign-in); a path param can never select another student. Role comes from `LM_TEACHER_EMAILS`.
- **Class Bank.** Teacher-published classes (`lm_classes.published = true`) are browsable + self-enrollable school-wide. Student-created classes are **private** (`published = false`).
- **Materials are private per student.** Any enrolled member can upload any file (or snap a photo on mobile); only the uploader can list/open it, and its text grounds only the uploader's tutor (per-student RAG collection).
- **Ribbon is enrollment-scoped.** Class icons on the cockpit ribbon show only the signed-in student's enrolled classes.

## Verified working (2026-06-13)
| Capability | Evidence |
|---|---|
| SSO login + per-student data | live Google login as `operator@example.com`; `tests/education-access-control.spec.ts` proves path-param can't leak others |
| Class lifecycle (edit/archive/delete/share-by-email) | owner-gated Manage tab; commit `c730bc2` |
| Styling (modal theme vars, slim scrollbars) | commits `2185931`, `c730bc2`; served `education.css` has 5 scrollbar rules |
| Ribbon scoped to enrollment | commit `2ccafcc`; `RibbonNav._enrolledClassToolKeys` in served JS |
| Class Bank (catalog + self-enroll/leave + publish toggle) | commit `2258201`; 5 demo classes published; `/catalog` route compiled |
| **Upload document (any type) + mobile camera** | commit `eb8f54c`; Materials tab served with `uploadDoc` + `capture=`; `lm_materials` table live |
| Materials private per student | commit `6948774`; list/file scoped to `uploaded_by`; per-student storage folder |
| **OCR for photos** | commit `6948774`; `tesseract 5.5.1` in image; live test OCR'd a rendered image to "HELLO OCR 12345" |
| Private grounding | tutor queries `privateMaterialsCollection(class, student)` alongside class-shared |

**Migrations:** 026 (identity: `external_id`, `role`, `teacher_student_id`), 027 (`lm_classes.published`), 028 (`lm_materials`). All also bootstrap idempotently in `ensureEducationSchema`.

**Deploy note:** compose runs image `oshal-bot:latest`; education HTML/CSS + cockpit JS are **baked into the image** (not hot-swapped) — UI changes need a rebuild + `up -d --force-recreate --no-deps oshal-api`. See memory `oshal-deploy-gotchas`.

## Status update — 2026-06-13 (backlog burn-down)

All nine items below were worked this session, plus the operator-reported bugs.

**Shipped + verified:**
- **#1 + #6 share/approval + toggle** — DONE. Materials private by default; upload "share with class" toggle; teacher shares directly, student requests → teacher approve/deny; shared materials open for enrolled members + ground the class via `sharedMaterialsCollection`. (migration 029)
- **#2 /api/tools/dynamic scoping** — DONE. `lm-class-*` entries scoped to the caller's enrolled classes (fails closed); class-name leak closed.
- **#3 teacher allowlist** — DONE. `operator@example.com` added to `LM_TEACHER_EMAILS`.
- **#4 ribbon live-refresh** — DONE. Dashboard posts `lm-classes-changed`; `RibbonNav` re-resolves class icons without reload.
- **#5 materials polish** — DONE. `DELETE /materials/:id`; scanned/photo PDFs OCR via poppler `pdftoppm` → tesseract (10-page bound).
- **#8 e2e coverage** — specs written in `tests/education-class-bank-materials.spec.ts` (catalog/enroll/leave/private-materials/share). **Run pending** a MOCK_OIDC instance (prod is real-OIDC).
- **#9 cleanup** — orphaned `uploadMaterial()` removed. (seed-class ownership still open, below.)
- **Operator bugs** — neural TTS (gemini-tts via lm-voice.js, replacing robotic browser voice), chat Send-below-input + read-aloud, settable Voice Settings, internal presentation creator + picker (never was presentron).

**Partial / foundation only:**
- **#7 multi-tenant** — FOUNDATION shipped (migration 030): `lm_tenants` table + `tenant_id` on students/classes (default "Default School"), domain→tenant resolution on provision, class bank scoped per tenant. Additive — the single-tenant demo is unchanged. **Remaining for full multi-tenant:** scope every remaining query (materials, roster, teacher views) by tenant; a tenant sign-up/onboarding flow; admin tenant management UI; per-tenant cost/usage rollups.

## Remaining open work (done-when criteria)

> **Re-baseline 2026-07-19: this list is a STALE DUPLICATE of the burn-down above — do not work it
> as written.** It predates the "Status update — 2026-06-13 (backlog burn-down)" section: items
> #1–#6 and the bulk of #8/#9 shipped there (see the evidence lines above). The genuinely open
> work is **#7 full multi-tenant** (foundation-only — migration 030 shipped the schema; the
> per-tenant query scoping, sign-up/onboarding, admin UI, and cost rollups remain), plus two
> residuals: #8's spec *run* (specs are written; pending a MOCK_OIDC instance) and #9's
> seed-class ownership. The per-item text is kept below for its done-when criteria only.

### 1. Teacher share + student-share-with-approval (the deferred core)
- **What:** a teacher can share a private material with the whole class; a student can *request* a share that a teacher approves. On approval the material's text is (re)ingested into the **shared** class collection (`lm-class-{classId}-textbook`/`-shared`) and becomes listable/openable by the enrolled roster.
- **Why deferred:** product decision — kids set up classes solo first; isolation ships first.
- **Done when:** `lm_materials` has `shared boolean` + `share_status` (`none|requested|approved|denied`); `POST /materials/:id/share-request` (student) and `POST /materials/:id/approve|deny` (teacher-gated); approved materials appear in a `GET /classes/:id/shared-materials` enrolled-gated list and ground every enrolled student's tutor; a non-approved material remains 403 to non-uploaders. Module header in `education-materials-routes.ts` already flags this.

### 2. `/api/tools/dynamic` per-session scoping (privacy leak)
- **What:** the ribbon no longer shows non-enrolled classes (client filter), but `GET /api/tools/dynamic` still returns every `lm-class-*` entry — class **names** leak to a direct API caller.
- **Why deferred:** ribbon fix solved the visible bug; backend scoping is a separate change to a generic endpoint.
- **Done when:** `/api/tools/dynamic` (or a LM-specific variant) filters `lm-class-*` tools to the caller's enrolled classes server-side; a direct unauthenticated/other-student call returns none of a class it isn't enrolled in.

### 3. Teacher allowlist for the demo operator
- **What:** `operator@example.com` is a student (not in `LM_TEACHER_EMAILS`), so can't publish or see the teacher dashboard.
- **Why deferred:** operator config decision.
- **Done when:** the gmail is added to `LM_TEACHER_EMAILS` in `.env` and api recreated; the user can publish a class + reach `/teacher/classes`. **Owner:** operator.

### 4. Ribbon live-refresh after join/leave
- **What:** joining/leaving a class updates *My Classes* immediately but the left ribbon only reflects it on the next cockpit load (the dashboard runs in an iframe; the parent ribbon isn't re-fetched).
- **Done when:** join/leave posts a message to the parent cockpit that re-runs `RibbonNav._loadToolViews()` (or equivalent) without a full reload.

### 5. OCR + materials polish
- **What:** (a) OCR quality — no image preprocessing (deskew/threshold) before tesseract, so low-contrast phone photos may read poorly; (b) no **delete material** endpoint/button; (c) no personal **kind** filter/sort in the Materials list; (d) PDFs that are scanned images aren't OCR'd (only `pdf-parse` text path runs).
- **Done when:** images are preprocessed before OCR (or a vision fallback is offered via a bot-node, not the controller); `DELETE /materials/:id` (owner-only) + a trash control exist; scanned-PDF pages fall through to OCR.

### 6. Personal vs. shared materials toggle (UX)
- **What:** materials are private by default; once #1 lands, the upload UI should let the uploader choose private vs. (request) shared at upload time.
- **Done when:** the Materials upload has a private/shared choice wired to #1's share flow.

### 7. Real multi-tenant (beyond the single demo school)
- **What:** today "school" == the whole instance (no `tenant_id`). The Class Bank is instance-wide.
- **Why deferred:** the demo is one school; multi-tenant is a larger schema + isolation change (see root BACKLOG / costing notes).
- **Done when:** `tenant_id` on students/classes/materials; catalog + roster + bank scoped per tenant; a sign-up flow assigns a tenant.

### 8. e2e coverage for the new surfaces
- **What:** the new endpoints lack dedicated specs (the live stack is real-OIDC, so MOCK-mode specs need a demo instance — see #3/operator).
- **Done when:** specs cover: catalog lists only published; self-enroll into private = 403; owner-can't-leave; a second student can't list/open another's material (private); publish is teacher-gated; OCR'd image produces a private collection hit. Run via a MOCK_OIDC demo instance.

### 9. Cleanup / tech-debt
- **What:** orphaned `uploadMaterial()` JS remains in `class-view.html` after the Manage upload button was removed (harmless, unused); the seed demo classes were bulk-published via one-off SQL (no real teacher owner).
- **Done when:** dead JS removed; seed classes either given a real `teacher_student_id` or purged for a clean deployment.
