# Kernel skills — the framework's package-facing API

**Status:** built 2026-07-13 (ADR-085 Tier-0b, ADR-090 D8). Enforced by CI.

A **skill** is a shared capability the kernel always provides: a provider abstraction with no
domain of its own, existing so a vendor stays swappable. An **app** is a domain plus a surface.

> If ≥2 apps would need it, or it wraps swappable vendors → **kernel skill**. Apps declare `uses:`
> and *call* it. They never bundle it, and they can never uninstall it out from under each other.

The twelve skills below are the **stable API an installed app may import** — treat removing one
like removing a public method. The first ten were signed off by the operator on 2026-07-13
(migration plan §2); `payments` and `spatial-mapping` were pinned later at the finance and spaces
carves respectively — engines that stay kernel per ADR-093 while only their *surface* carves, so
the carve doesn't prune them out of `dist/` (the google-calendar/notifications bug class).

## The skills

| Skill id | Import from a package | Why it's kernel |
|---|---|---|
| `voice` | `@/features/voice-providers`, `@/features/voice` | Pluggable-vendor TTS/STT registry — CLAUDE.md forbids hardcoding a vendor. |
| `notifications` | `@/features/notifications` | `notifyOperator` / `notifyAll` fan-out across email/Telegram/WhatsApp/Discord. |
| `rag` | `@/features/rag` | ChromaDB abstraction with a BM25 fallback. |
| `storage` | `@/app/routes/storage-target` | Dropbox / GitHub / local storage targets (ADR-041). |
| `deck-generation` | `@/features/presentation-generation` | The deck engine behind the presentations app. |
| `graph` | `@/features/graph`, `@/features/personal-graph` | Engine-agnostic graph connector (ADR-045). |
| `scheduling` | `@/features/scheduling` | Manifest `schedules:` register and tear down through it. |
| `memory` | `@/features/memory`, `@/features/user-model`, `@/features/personal-data` | Cross-app user state. |
| `tool-registry` | `@/features/tool-registry`, `@/features/llm-provider` | Tool + model access — the aggregation thesis (ADR-049). |
| `media-generation` | `@/features/video-generation`, `@/features/visual-response` | Vendor-abstracted image/video generation. |
| `payments` | `@/features/payments` | Provider-agnostic money rails: the Stripe `PaymentAdapter` half (finance package) + the Square/PayPal merchant half (payments package). Pinned at the finance carve (ADR-085 Wave 1 #5) — until then it survived in dist only through finance-routes' import. |

Source of truth: [`src/shared/kernel-skills/registry.ts`](../../src/shared/kernel-skills/registry.ts).

## Declaring a skill in your app

```yaml
# oshal-app.yaml — declare what your code actually imports.
uses:
  - deck-generation
  - rag
dependencies:
  apps: []        # a SKILL never goes here — it isn't an installable app
```

Validation is **fail-closed**: an unknown skill id fails at manifest load, not at mount.

**A skill is not an app dependency.** `dependencies.apps` is for real apps — it drives install
resolution and the reverse-dependency guard. A skill is always present, so it needs neither.
Little Monsters used to declare `dependencies.apps: [presentations]`; what it actually needed was
the always-present `deck-generation` engine. When the presentations app carves to the store, only
its **surface** carves — the engine stays kernel ("skills with a surface", migration plan §2).

## Why this contract has to exist — the silent-prune bug

`tsconfig.server.json` compiles `src/app/**`, `src/shared/**`, `src/entities/**` and **excludes
`src/features/**`**. So a feature reaches `dist/` **only when something in an include-root imports
it.** TypeScript's `exclude` filters `include` but never overrides the import graph — meaning an
explicit tsconfig `include` of a feature is *silently a no-op* while that broad exclude stands.
**An import is the only reliable pin.**

The failure mode this produces is nasty, because the cause and the symptom are far apart:

1. Core stops importing a feature (often as a side effect of carving an app out).
2. The feature silently vanishes from the built image.
3. An **installed package** that imports it — packages resolve `@/…` against the *running
   framework's* dist at mount time — dies at **mount**, in production, in someone else's app.

This has already happened twice: `google-calendar` was pruned when little-monsters was carved out,
and `notifications` was pruned outright. Nothing failed at compile time either time.

**The fix, in two halves:**

- [`src/app/composition/kernel-skills.ts`](../../src/app/composition/kernel-skills.ts) — the build
  anchor. It lives in an include root and re-exports every declared skill module, which is what
  physically carries them into `dist/`. **Deleting a line there is a breaking API change.**
- [`scripts/check-kernel-skills.ts`](../../scripts/check-kernel-skills.ts) — the guard. It asserts
  every declared skill is (a) anchored in source and (b) actually present **inside the built
  image**. A prune now fails CI instead of a customer's app.

## Running the guard

```bash
# source half — is every declared skill anchored? (no build needed)
npx ts-node -r tsconfig-paths/register --transpile-only scripts/check-kernel-skills.ts

# artifact half — is every declared skill really in the build / the image?
… scripts/check-kernel-skills.ts --dist .
… scripts/check-kernel-skills.ts --image oshal-ci:latest
```

Both run in `scripts/ci-local.sh` (gates `kernel-skills` and `kernel-skills-image`); the source
half also runs in the GitHub Actions TypeCheck job.

## Adding a skill

1. Append the declaration to `src/shared/kernel-skills/registry.ts` (id, why, modules).
2. Add the matching `export * as … from '…'` to `src/app/composition/kernel-skills.ts`.
3. Add a row to the table above.

The guard fails until steps 1 and 2 agree, so a skill cannot be declared without being pinned —
which is precisely the bug it exists to prevent.
