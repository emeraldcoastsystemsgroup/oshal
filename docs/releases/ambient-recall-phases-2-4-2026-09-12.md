# Ambient Recall (ADR-100) Phases 2-4 — as built, proven, and how to continue

**Date:** 2026-09-12 (thread closed 2026-09-13)
**Commits:** `018607e6` (Phases 2-4), `8a88d33e` (consent-trigger convergence) on `feat/store-compatibility-gate` — [PR #431](https://github.com/emeraldcoastsystemsgroup/oshal/pull/431), **not merged to `main`** when this record was written.
**Deployed:** preview deploys of both commits with `scripts/oshal-deploy.sh --preview` on the dev box (api + all bot nodes, parity clean, zero unhealthy). A release from `main` still has to happen after the PR merges.
**Status update (2026-09-14):** PR #431 merged to `main` as `b8de2099` — both commits above are its ancestors — and `scripts/oshal-deploy.sh` released that commit from `main` the same day (image `1fe73566ae87`, api + 34 bots, parity clean). Step 1 of *How to continue* is done.
**Design record:** [ADR-100](../adr/100-ambient-person-model.md) carries the as-built update and every deviation from the plan, with the file that proves each one.

## What the app does now

Open `/cockpit/?app=person-model` (ribbon item "Ambient Recall") or the surface directly at `/api/jarvis/ambient/person/`.

| Tab | What it shows | Source of truth |
|---|---|---|
| Recall | "How many times has Ella mentioned volleyball today?" — exact count, verbatim quotes, play-back; plus **Possibly related (not counted)** paraphrase hits | SQL count over the generated tsvector; pgvector chunks for the related list |
| Asks | Open asks and commitments per person, each beside the verbatim line, with Mark done / Dismiss | `ambient_person_asks` (analyst inferences, flagged as OSHAL's read) |
| People | Every heard voice → profile with Topics, Asks, Presence (lines per day, 30 days), Consent (allow / decline and purge) | rollups + segments + consent ledger |
| Trends | Topics by week per person; topics two people both raise | `ambient_person_topic_daily`, `ambient_person_relations` |

Jarvis chat answers the same shapes without a model turn: recall (unchanged), "what has Ella asked me", "what did Sam promise", "what has Ella been talking about lately / this week / this month", "what do Ella and Sam talk about". Ordinary chat falls through to the model.

## Where the code lives

- `src/features/person-model/services/person-model-intent.ts` — the front door (`detectPersonModelIntent`, `answerPersonModelIntent`). `jarvis-routes.ts` calls it in place of the old recall-only hook; that file is over the 800-code-line threshold, so add shapes here, never there.
- `trends-query.ts` — weekly trends, connections, heard-people list, profile summary (pure SQL).
- `semantic-projection.ts` + `projection-ledger.ts` — the pgvector leg: chunks `pm:<segment_id>` in the kernel-reserved `ambient-recall` collection, owner stamped in metadata so the engine lifts it into the RLS column and the data-lifecycle discovered deleter removes it by column; `relatedRecall` returns paraphrase hits that are never folded into the count; `person_model_projections` is the drift ledger.
- `scripts/migrations/138-person-model-parity.sql` — deletion and re-projection parity **in the database**: segment delete → chunk purge; speaker re-point (merge, or the FK SET NULL on forget) → asks and chunk tag follow, rollups rebuild in the same transaction; profile delete → asks, enrichment and chunks derived from that voice are purged. `pm_rebuild_rollups(owner)` is the shared pure-SQL re-projection.
- `person-model-schema.ts` — lazy DDL; now **converges** the consent-ledger trigger instead of creating it once (see the live finding below).
- `src/app/ambient-enrichment-runtime.ts` — the sweep also projects chunks (local MiniLM, no LLM); the nightly pass adds the orphan-chunk anti-join backstop.
- `src/app/routes/person-model-routes.ts` — `/recall` (now with `related[]`), `/asks`, `/people`, `/profile/:profileId`, `/projection`, `/trends`, `/connections`, `/consents`, all behind the fail-closed wrapper.
- `src/api/person-model.html` — the surface; loads `/shared/ui/js/surface-theme.js` so it follows the cockpit theme (it used to hardcode midnight).
- `scripts/person-model-rebuild.ts` — full re-projection for one owner or all, pure SQL/IO.
- `swarm-apps/person-model.yaml` — manifest `1.1.0`.

## Guards and how they were proven

| Guard | What it proves | How it ran |
|---|---|---|
| `tests/unit/person-model-intent.spec.ts` | every intent shape, ordinary chat falls through, phrasing from literal rows | vitest, pure |
| `tests/unit/person-model-surface.spec.ts` | theme script placement, the four views, routes behind `personRoute`, the Jarvis front door, migration 138 content, reserved collection, ADR status, manifest version | vitest, source pins |
| `tests/unit/person-model-parity-postgres.spec.ts` | on a scratch database created for the run: the full migration chain, lazy DDL twice with an identical object inventory, legacy consent-trigger convergence, consent UPDATE refused / DELETE clean, rollup rebuild idempotent, segment delete purges its chunk, merge re-points asks + chunk tag + rebuilds rollups, forget leaves zero derived rows, discovered lifecycle delete leaves zero rows for the sub while the other owner survives | needs a reachable Postgres (fails loudly otherwise) |
| ~~`scripts/person-model-gate-in-container.js`~~ | claimed the same assertions as the spec, as plain Node | **Retired 2026-09-21.** It never held the same assertions - the by-name-guard case had no twin in it - and the spec now starts its own PostgreSQL, so the host runs it directly |
| `scripts/person-model-live-proof.js` | on the live stack under an isolated synthetic owner: real embeddings, exact count kept literal, related hits returned separately, the front door and asks phrasing, triggers present, a trigger purging a chunk, migration 138 recorded, then the owner removed to zero rows | run inside `oshal-local-api` after a deploy |
| Test Lab scenario `ambient-recall` | as the signed-in user: themed surface, one labelled line through the real ingest route, exact recall of it, the four reads, Jarvis answering the asks shape deterministically | `src/app/routes/test-lab-ambient-scenarios.ts`; registered but not yet run from the Lab UI |

The dev box's Docker port publishing was wedged during this work (a free port reported "already allocated", and the database container's own published port was configured but not live), so the real-database spec could not run from the host. The in-container gate exists for exactly that situation and passed on both deploys.

**Followed up 2026-09-21.** The spec no longer depends on the stack's published port at all: it starts `pgvector/pgvector:pg16` on a kernel-assigned loopback port, runs the migration chain against it and force-removes the container afterwards. `npx vitest run tests/unit/person-model-parity-postgres.spec.ts` was measured green from the host in 13.45 s (9 passed), so the hand-kept in-container twin was retired rather than kept in step by hand; a new copy of it is now red in `tests/unit/lazy-ddl-guard-convergence.spec.ts`. `scripts/person-model-live-proof.js` is a different thing and stays - it proves the DEPLOYED stack, which no disposable container can.

## The live finding

On the dev box the consent-ledger trigger was still the shape the July lazy DDL had created — `BEFORE DELETE OR UPDATE … ambient_speaker_consents_append_only()` (read back with `pg_get_triggerdef`) — because the by-name `IF NOT EXISTS` guard never replaced it. Forgetting a consented voice, and the discovered `/api/me` delete of such an owner, failed with "ambient_speaker_consents is append-only". Commit `8a88d33e` makes the lazy DDL drop a DELETE-blocking variant before (re)creating the UPDATE-only trigger; the gate recreates the legacy shape and asserts convergence; the live database reads correctly after the second deploy.

Lesson worth keeping: a by-name `IF NOT EXISTS` guard around a trigger freezes the first definition forever. Converge on a property (here the tgtype DELETE bit), not on the name.

## Why the box has no transcripts

Transcript retention is 30 days (`ambient_user_settings.transcript_retention_days`, default 30, settable up to 365 in the Jarvis ambient panel). Chat history shows real recall answers on 2026-07-19; listening was switched off by 2026-08-11; the background purge removed everything older than 30 days. The database itself is continuous since April. No voice profiles remain and there is no age rule for them, so they were removed by a forget or delete-data action before the last Postgres restart, which is as far back as the counters reach.

## How to continue

1. ~~**Land it.**~~ **Done 2026-09-14:** PR #431 merged as `b8de2099` and was released from `main` with `bash scripts/oshal-deploy.sh`. Migration 138 is idempotent and the lazy DDL converges, so a redeploy is safe.
2. **Get real data.** In the Jarvis panel, turn ambient listening on with speaker recognition, speak for a few minutes, and name a voice under Manage Voices. `POST /api/jarvis/ambient/segments` cannot set a speaker, so attributed data only comes from the audio path.
3. **Prove it in the Lab.** Run the `ambient-recall` scenario from the AI Test Lab; all five steps should pass. Then open the People tab, allow modeling for the named voice, and wait one sweep (default five minutes) for the analyst to produce asks and topics.
4. **If a projection ever drifts:** `npx ts-node -r tsconfig-paths/register scripts/person-model-rebuild.ts --owner <sub>` (or `--all`). Pure SQL/IO; safe to repeat.
5. **To re-run the parity gate:** `npx vitest run tests/unit/person-model-parity-postgres.spec.ts` from the host. It owns its database - nothing is pointed at it and nothing published has to work. To prove the DEPLOYED stack instead (real embedder, real corpus, synthetic owner):

```bash
MSYS_NO_PATHCONV=1 docker cp scripts/person-model-live-proof.js oshal-local-api:/tmp/pm-live.js
docker exec oshal-local-api node /tmp/pm-live.js               # synthetic owner, removed afterwards
```

6. **To add a question shape:** add a detector and a phrasing function in `person-model-intent.ts`, extend `detectPersonModelIntent`, add cases to `tests/unit/person-model-intent.spec.ts` (including a falls-through case). Nothing in `jarvis-routes.ts` changes.
7. **To add a profile tab:** add the SQL read in `trends-query.ts`, expose it through `personProfileSummary`, render it in `person-model.html` next to `renderTopics` / `renderPresence` / `renderConsent`, and pin the new renderer in the surface spec.

Open work and its done-when criteria are in [BACKLOG.md](../BACKLOG.md) under "Ambient Recall (ADR-100)".
