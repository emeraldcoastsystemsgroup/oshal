# ADR-075 — Little Monsters: app-scoped onboarding + student-experience enhancements

- **Status:** **Implemented + deployed** — 2026-06-27. All sections (A/B onboarding override,
  C My Day master calendar, D interaction fixes, E anti-cheating guardrails, F toolkit, G arena +
  rewards/collection/avatar) are built and live on `oshal.agenticfederal.us` (student view at
  `/cockpit/?app=little-monsters&student=1`). Beyond the original spec: the six mini-games were
  rewritten, flashcards were consolidated into a create/edit/study hub, the rewards loop gained an
  in-app animation hook, and a security/best-practices review was run (see below). Remaining is
  product polish only — two-way Dropbox/GitHub file sync and the full Vids "render a video" handoff.
  Scope is the Little Monsters surface at `/cockpit/?app=little-monsters&student=1`.

## Security & best-practices review (2026-06-27)

A two-part read-only review (backend routes + front-end surfaces) was run over the LM code.
**Fixed in this pass:**
- **IDOR on flashcard cards/sets** — `PATCH`/`DELETE /flashcards/cards/:id`, `POST`/`DELETE
  /flashcards/sets/:id`, and the previously-unauthenticated `GET /flashcards/sets/:id/cards` now
  resolve the owning class and run `assertClassAccess` (null `class_id` = a student's private
  self-study set, allowed). Card `front`/`back` are coerced + length-capped.
- **Rewards box-open race** — the box spend is now a single atomic `UPDATE ... WHERE boxes > 0
  RETURNING`, so concurrent opens can't double-spend.
- **Tutor crash on image-only messages** — `message.length` logging guarded (`(message||'').length`);
  the CLI path uses `promptText`. Tutor-question XP now resolves the asker (was a silent no-op).
- **Front-end XSS / trust** — flashcard-hub set titles moved from inline `onclick` strings to
  `data-*` + listeners with attribute-safe escaping; the tutor read-aloud button binds via a JS
  closure instead of inlining the reply; the arcade XP listener verifies `e.source` is the game
  iframe; monster hue/sat are numeric-coerced before going into a `style`; failed flashcard
  saves/deletes now check `r.ok` instead of falsely reporting success.
- Internal `err.message` is no longer returned to students on the touched endpoints (generic
  message + server-side log).

**Known follow-ups (pre-existing, out of this pass's scope):**
- `GET /student/:studentId/dashboard` lets a teacher read any student (no "teaches a shared
  class" check); `POST /enroll` and `POST /students` are unauthenticated and trust a client
  `studentId`. These predate this work and need a broader authz pass.
- A per-set `owner_sub` column would let private (class_id-null) sets be ownership-checked rather
  than left ungated.
- Accessibility: the canvas games need `aria-label` + an `aria-live` score region; several
  clickable `span`/`div` controls should be `<button>`s. The duplicated `esc()`/confetti helpers
  across surfaces should be factored into one shared script.

## Implementation status

| § | Item | State | Deploy |
|---|---|---|---|
| D | Recorder Back/Minimize exit (`lecture-recorder.html`) | **Done** | hot (refresh) |
| D | Tutor typing-indicator render fix (`tutor-chat.html`) | **Done** | hot |
| D | Tutor photo / file / camera upload UI (`tutor-chat.html`) | **Done** | hot |
| D | Tutor backend vision (image→SDK blocks, `education-routes.ts`) | **Done, typecheck-clean** | needs api rebuild |
| D | Read-aloud: neural voice + emoji/icon strip + leak fix (`lm-voice.js`, tutor) | **Done** | hot |
| E | Anti-cheating guardrails (inline tutor prompt + `class-tutor.yaml`) | **Done** | inline prompt needs rebuild; persona on next bot reload |
| — | **Floating LM concierge** — right-rail chat replaced by a single hovering "Little Monster Expert" bubble, no bot dropdown, persists screen-to-screen (`lm-concierge.js`) | **Done** | hot (refresh) |
| — | **Theme re-skin to the real pink monster** (magenta body + blue horns + purple world); pink character used for concierge/header/mascot (was wrongly the teal app-logo) | **Done** | hot |
| C | My Day master calendar + bold class tiles | Pending | — |
| F | **Materials→Tools** tab rename (`class-view.html`) | **Done** | hot |
| F | **Formula Lab**, **STEM Helpers** (calc + periodic table + PhET), **Citations** (MLA/APA + Citation Machine) surfaces + manifest ribbon entries | **Done** | needs api rebuild |
| F | Flashcard Builder, Lecture Timelines | Pending | — |
| G | **Games arcade** — 6 bundled mini-games (`/api/education/games`) + study warm-up gate + manifest entry | **Done (basic)** | needs api rebuild |
| G | Curriculum-linked gating (warm-up pulls real class flashcards) + evolving monster avatar | Pending | — |
| A/B | App-scoped onboarding override (manifest + welcome.js + redirect) | Pending | — |
- **Date:** 2026-06-27
- **Guiding constraint:** **Negligible change to the core platform.** Enhance Little Monsters by
  leaning on framework extension points (swarm-app manifest, app-owned surfaces, personas, theme CSS)
  and adding exactly **one** small, generic, additive platform hook — an *app-scoped onboarding
  override*. Every non-LM entry path stays byte-for-byte unchanged. Where the spec implies a platform
  change, this ADR re-routes it to an app-local mechanism instead.
- **Related:**
  [ADR (swarm application manifests)](033b-swarm-application-manifests.md) — the manifest is
  the single source of truth this ADR extends.
  [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md) /
  [ADR-057 (personal data schema)](057-personal-data-schema.md) — the per-user/tenant isolation LM
  relies on; **not modified here**.
  [ADR-064 (free-tier LLM access)](064-free-tier-llm-access.md) — the mandatory-model gate the
  onboarding wizard enforces; preserved.

---

## Context

Little Monsters is a loaded swarm application (`swarm-apps/little-monsters.yaml`) with six education
bots, its own routes (`/api/education/*`), static UI surfaces, a theme, and a workflow pipeline. The
student entry point is `/cockpit/?app=little-monsters&student=1`; the `student=1` ribbon mode (see
`RibbonNav.js`) already strips operator chrome down to the LM screens.

What is **not** yet app-aware is the **first-run onboarding wizard** (`src/pages/welcome/welcome.js`).
A first-time user — even one who arrived specifically for Little Monsters — gets the generic 7-step
OSHAL flow:

```
0 welcome    "Welcome to OSHAL"            (OSHAL-branded)
1 features   "Platform Features"           (47 bots / tickets / swarm …)
2 config     "Configuration Status"
3 setup      "Connect an AI model"         (mandatory model gate — ADR-064)
4 capabilities "Choose what it does"       ← to be DELETED for app-scoped entry
5 connect    "Connect your accounts"       ← to be REDUCED for LM
6 done       "You're All Set!"             ← to be REBRANDED for LM
```

The login/onboarding is OSHAL-branded, offers the full connector catalog, and asks the user to "choose
what it does" — which is redundant and a bottleneck when the URL already declared the app. The product
direction for LM is a native "Little Monster" experience end-to-end, with a tightened connector set and
a rebranded finish, then a student-agenda dashboard, several interaction fixes, anti-cheating tutor
guardrails, new per-class toolkit modules, and a study-gated game arena with an evolving monster avatar.

The hard requirement from the product owner: do this **without** forking core platform behavior — keep
the platform changes negligible and additive, and put the LM-specific weight in the LM app.

---

## Decision

### A. The one platform primitive: an **app-scoped onboarding override** (generic, additive)

Add an optional `onboarding` block to the swarm-app manifest schema (`SwarmAppManifest` in
`src/features/swarm-apps/types.ts`). When — and only when — the wizard is entered with `?app=<name>`
**and** that app's manifest declares an `onboarding` block, the wizard adapts. With no `?app=` param,
or an app that declares no `onboarding` block, the wizard renders **exactly as it does today**. This is
the guard that keeps the change "negligible": default behavior is unchanged by construction.

Proposed manifest shape (LM values shown):

```yaml
# swarm-apps/little-monsters.yaml  (additive block — no existing field changes)
onboarding:
  # 1. Branding — replaces the hardcoded "Welcome to OSHAL" strings + theme when this app
  #    is the onboarding context. Falls back to OSHAL defaults when absent.
  brand:
    title: "Welcome to Little Monsters"
    subtitle: "Your voice-first study buddy"
    logo: /api/education/assets/lm-logo.svg
    theme: little-monsters          # an existing COCKPIT_THEMES id (manifest already has `theme:`)
  # 2. Skip the redundant "Choose what it does" step — the app is already chosen.
  skipSteps: [capabilities, features]
  # 3. Reduce the connector catalog to an allow-list (by connector id / category).
  connectors:
    allow: [google, dropbox, whatsapp, social]   # Email(Gmail), Dropbox, WhatsApp/Socials only
    intro: "Connect just what helps you study. You can skip any of these."
  # 4. Rebrand the finish screen + where Finish lands.
  done:
    title: "You're all set!"
    blurb: "Here's your Little Monster system — let's get to your dashboard."
    surface: /api/education/onboarding-done    # optional app-owned partial; else branded default
  landing: "/cockpit/?app=little-monsters&student=1"
```

**`welcome.js` changes (small, all guarded by "did the app declare onboarding?"):**

1. On load, read `?app=` and fetch the already-existing `/api/ui/profile?name=<app>` (RibbonNav already
   does this) plus the new `onboarding` block (exposed via the same synthesised profile). Cache it.
2. **Branding:** when `onboarding.brand` exists, render its title/subtitle/logo and apply
   `onboarding.brand.theme` to the wizard root. This is the same transient-theme pattern
   `RibbonNav._applyAppBranding()` already uses for the cockpit shell. The OSHAL default strings stay
   as the fallback literal.
3. **Skip steps:** filter `STEPS` by `onboarding.skipSteps`. The `setup` (model) and `done` steps can
   never be skipped (the ADR-064 model gate is preserved). Deleting `capabilities` here is exactly what
   the spec asks — the app is the capability, so the app is hot-loaded directly (see A.4).
4. **Connectors:** in `renderConnectAccounts`, when `onboarding.connectors.allow` exists, filter the
   provider list to the allow-list before grouping. The full "Open the full Connectors hub" link stays
   as an escape hatch.
5. **Done + landing:** render `onboarding.done` content (or embed `onboarding.done.surface`), and set
   `chosenLanding = onboarding.landing` so Finish drops the student on the student cockpit.
6. **Auto-install the app:** because we skip the capability picker, `installSelectedApps()` instead
   loads the entered app's manifest directly (it is already active in our deployment, so this is a
   no-op idempotent path via the existing `POST /api/swarm/apps/load`).

**Gate plumbing (one-line additive change):** the first-run gate in `src/app/server.ts` that redirects
`GET /` → `/welcome` must **preserve the query string** so `?app=little-monsters&student=1` survives to
the wizard. The LM first-run entry link is therefore `/welcome?app=little-monsters&student=1`. No
default behavior changes — a bare `GET /` still redirects to a bare `/welcome`.

> **Multi-tenant note (no change):** the school-by-school tenant isolation the spec "confirms" is the
> existing personal-data schema + RLS (ADR-056/057 and the governance/RLS work). Public-sandbox shared
> classes (e.g. "Biology 2") vs. private grades/notes is already the public-vs-person/tenant scope
> model. This ADR **relies on** it and changes nothing there. It is listed as a platform **invariant**
> below, not a work item.

That is the entire platform-facing surface of this ADR: a new optional manifest block, ~40 lines of
guarded logic in one front-end file, and a query-string-preserving redirect. Everything that follows is
**app-local** — LM surfaces, personas, theme, manifest entries, and game assets.

---

### B. Onboarding flow — concrete per-screen outcome (LM context only)

| Screen | Today | LM student onboarding | Where it lives |
|---|---|---|---|
| Welcome | "Welcome to OSHAL" | "Welcome to Little Monsters" + LM logo/theme | `onboarding.brand` (manifest) |
| Features | platform tour | **skipped** | `onboarding.skipSteps` |
| Config | health check | kept (or skipped; optional) | `onboarding.skipSteps` |
| Connect a model | mandatory | **kept, unchanged** (ADR-064 gate preserved) | platform (no change) |
| **Choose what it does** | capability multi-select | **DELETED** | `onboarding.skipSteps: [capabilities]` |
| **Connect your accounts** | full catalog | **REDUCED** to Gmail, Dropbox, WhatsApp/Socials | `onboarding.connectors.allow` |
| **You're All Set** | OSHAL tips | **REBRANDED** LM system overview → student dashboard | `onboarding.done` + `landing` |

The "Choose what it does" slot is freed for the future **"How do you learn best?"** learning-style
metric / class-selection page — implemented later as an *app-owned* step surface (an LM HTML partial the
wizard embeds), not as new platform UI.

---

### C. Master dashboard — "My Day" (app surface only; zero platform change)

All in LM-owned surfaces (`any-bot/server/services/tools/education/my-day.html`,
`student-dashboard.html`) served by the existing `/api/education/*` routes; calendar data from the
existing `education-calendar-routes.ts`.

- **Unified master calendar grid** aggregated on "My Day" under the welcome banner — one visual grid
  showing school times, classes, and assignment deadlines (no longer per-class/hidden).
- **Class modules as primary tiles** — Biology, English Comp, etc., rendered big and bold as the main
  navigation on the dashboard.

---

### D. Critical interaction & chatbot fixes (app surfaces / wiring; zero platform change)

| Fix | Cause | Where |
|---|---|---|
| **Recorder trap** — no exit from Record Lecture | missing nav affordance | add Back/Minimize in `lecture-recorder.html` |
| **Tutor renders `span.dots.thinking` as text** | markup emitted as text, not DOM; slow-bot path | `tutor-chat.html` — fix the typing indicator; point the tutor at the existing **fast/synchronous chat endpoint** instead of the workflow ("slow bot") path. Uses an existing platform capability; no core change. |
| **File / image / camera uploads in tutor** | input lacks upload affordances | `tutor-chat.html` input + the existing `education-materials-routes.ts` (already accepts any filetype + mobile photo per migration 028) |
| **Read-aloud uses robotic Chrome voice** | client not calling the high-quality path | `lm-voice.js` — call `/api/voice/synthesize` (manifest already sets `tts: gemini-tts`), browser voice only as fallback |
| **Read-aloud memory leak** — reads previous chat windows + icon titles (e.g. "Waving hand") | stale text accumulation + reading `title`/`aria-label` of icons | `lm-voice.js` — scope read-aloud to the current message node; exclude decorative/icon nodes; clear buffer on window change |

> "Fast Bot" here means the LM tutor uses the existing low-latency chat route rather than the
> phased workflow dispatcher. This is an LM wiring choice, **not** a change to the chat architecture.

---

### E. Anti-cheating guardrails (persona/prompt only; zero platform change)

Hardcode the academic-integrity policy into the tutor **persona** (`ai-lab/bot-personas/class-tutor.yaml`
and the shared `education-foundation.yaml`). When a student uploads an assignment/worksheet, the tutor
**must not** give direct answers; it is constrained to:

1. **Lecture Recaps** — point back to the exact timestamp in the recorded lecture or the flashcard set
   covering the concept (grounded by the existing class RAG: `lm-class-<id>-lecture` collections).
2. **Parallel Problem Solving** — generate and solve a *similar* problem to map the method, never the
   student's actual problem.
3. **Socratic Debugging** — analyze a photo of the student's handwritten work, highlight the exact step
   where the logic failed, and prompt a retry.
4. **Custom Tutorials** — step-by-step masterclass on the underlying theory.

This is a prompt/policy change inside the app's own bots. No platform guardrail engine is added.

---

### F. New & updated toolkit modules (manifest `ui.static` + app surfaces; "use the framework tools")

Per-class tabs rename **"Materials" → "Tools"** (label change in `class-view.html`). New modules are
registered the framework way — as `ui.static` entries in the manifest pointing at new LM HTML surfaces
(and/or per-class "Tools" tabs), exactly the pattern the existing LM tools use:

| Module | Subject | Notes | Mechanism |
|---|---|---|---|
| **Custom Flashcard Builder** | all | manual term/definition entry, "build from text" prompt, image/doc upload, **class dropdown** to assign cards to a subject; replace ambiguous "Hard" with **Got It / Don't Got It** toggle | extend `flashcard-study.html` + existing flashcard endpoints |
| **Automated Lecture Timelines** | History/general | chart key events/deadlines along a linear progression bar from a recorded lecture | new LM surface + `lecture-scribe` capability |
| **Formula Lab** | Physics/Chemistry | digital cheat-sheet index of Physics 1 + Chemistry formulas | new static LM surface |
| **STEM Helpers** | STEM | scientific calculator, periodic table, PhET Simulations links/frames | new static LM surfaces / iframes |
| **My Citations** | English/Humanities | citation manager with Citation Machine link integration | new static LM surface |

Each is a manifest-declared tool + an app-owned HTML file. The platform tool registry already supports
this; nothing new is needed platform-side.

---

### G. Game arena & monster progression (app assets + education API; zero platform change)

- **Study-gated games** — the game backend is ready; accessing a game (e.g. Milkshake Maker) requires
  answering study questions mapped to the student's **current curriculum flashcards**. The games are LM
  assets (the `lm-2/games/*` set we surfaced); gating calls the existing education flashcard API.
- **Evolving monster avatar** — the LM character icon (rendered in the LM tutor/dashboard surfaces, and
  the `xp-system` app) **dynamically evolves** as the student wins arena points and completes goals.
  Rendered in the **LM surfaces**, not the cockpit chat-panel avatar — so no platform UI change. (If a
  future requirement wants the cockpit right-rail avatar itself to evolve, that would be a platform
  change and is explicitly deferred / out of scope here.)

---

## Change-impact analysis

### 1. Platform changes (must stay negligible) — the complete list

| # | Change | Files | Size | Default-path impact |
|---|---|---|---|---|
| P1 | Add optional `onboarding` block to manifest schema | `src/features/swarm-apps/types.ts` | additive interface fields | none (optional) |
| P2 | Expose `onboarding` on the synthesised profile | `swarm-app-service.ts` `synthesiseProfile` | ~5 lines | none (additive field) |
| P3 | Make the wizard app-aware (branding, skipSteps, connector allow-list, done, landing), guarded by "app declared onboarding?" | `src/pages/welcome/welcome.js` | ~40 lines, all behind a guard | **none** — no `?app=`/no block → identical flow |
| P4 | Preserve query string on the `GET /` → `/welcome` redirect | `src/app/server.ts` | 1 line | none (bare `/` still → bare `/welcome`) |

**That is the entire platform footprint: 4 additive, guarded edits across 4 files.** No new platform
routes, no new tables, no change to defaults, no change to any other app's onboarding, and the
mandatory model gate (ADR-064) is untouched. `welcome.js` and the cockpit JS are bind-mounted
(`./src/pages:/app/src/pages:ro`), so P3 is refresh-hot; P1/P2/P4 are TypeScript and need the standard
`oshal-api` rebuild.

### 2. App-local changes (the bulk of the work — no platform risk)

| Area | Artifacts | Type |
|---|---|---|
| Onboarding content/brand/connectors/done | `little-monsters.yaml` `onboarding` block, LM logo asset, optional `onboarding-done` partial | manifest + assets |
| My Day dashboard | `my-day.html`, `student-dashboard.html` | app surface |
| Interaction fixes | `lecture-recorder.html`, `tutor-chat.html`, `lm-voice.js` | app surface/wiring |
| Anti-cheating | `class-tutor.yaml`, `education-foundation.yaml` | persona/prompt |
| Toolkit modules | new LM HTML surfaces + `ui.static` manifest entries; `class-view.html` "Tools" relabel; `flashcard-study.html` | manifest + app surface |
| Game arena + avatar | `lm-2/games/*`, `xp-system`, LM avatar component, education flashcard API calls | app assets + existing API |

### 3. Platform invariants this ADR depends on (do **not** touch)

- The **mandatory-model gate** (ADR-064) — onboarding still cannot finish without a connected model.
- **Tenant/personal isolation** (ADR-056/057 + RLS) — school-by-school tenant separation, public
  sandbox classes vs. private grades/notes. Already satisfied; relied upon, not modified.
- The generic **welcome flow defaults** — unchanged for every non-LM (and every no-`?app=`) entry.
- The **chat architecture** — the tutor "Fast Bot" fix selects an existing endpoint; it does not alter
  dispatch.

### 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| The onboarding guard regresses the default flow | The guard is "app declared `onboarding`?" — add a test asserting a bare `/welcome` renders all 7 OSHAL steps unchanged. |
| `?app=` lost before the wizard | P4 preserves the query string; the LM entry link carries `?app=…&student=1` explicitly. |
| Connector allow-list hides a connector a school needs | The "Open the full Connectors hub" escape hatch stays; allow-list is presentation-only, not an authz change. |
| Skipping `capabilities` means the app isn't installed | On Finish, hot-load the entered app's manifest directly (idempotent; already active in our deployment). |
| Read-aloud still leaks across surfaces | Scope to the current message node and clear the buffer on view change; add a focused check in the LM live E2E harness. |

---

## Alternatives considered

1. **Fork a dedicated `/lm/welcome` flow.** Rejected — duplicates the wizard, drifts from the model
   gate, and is a larger platform footprint than one guarded manifest-driven branch.
2. **Hardcode LM branding/steps into `welcome.js`.** Rejected — bakes one app into a platform file and
   breaks the "negligible, generic" constraint; the manifest-driven block serves any future app
   (Career Hunter, etc.) for free.
3. **A separate onboarding microservice / new tables.** Rejected — the existing
   `user_preferences.onboarding_*` columns and `/api/user/onboarding` already persist progress; no new
   storage is warranted.

## Rollout

1. Land P1–P4 behind the guard; ship the regression test for the default flow first.
2. Add the `onboarding` block to `little-monsters.yaml` (manifest-only; refresh-hot for the front-end
   parts, rebuild for P1/P2/P4).
3. Sequence the app-local work by user-visible pain: D (interaction fixes) → C (My Day) → E
   (guardrails) → F (toolkit) → G (arena/avatar). Each is independently shippable and carries no
   platform risk.

## Consequences

- The platform gains a reusable, opt-in onboarding-personalization seam at a cost of ~four small edits;
  any future app can brand and trim its own first-run without further platform work.
- Little Monsters becomes a coherent, native student experience from login to dashboard while the core
  platform's default behavior is provably unchanged.
- The "Choose what it does" slot is retired for app-scoped entry and reserved for the future "How do you
  learn best?" / class-selection step, to be added as an app-owned surface.
