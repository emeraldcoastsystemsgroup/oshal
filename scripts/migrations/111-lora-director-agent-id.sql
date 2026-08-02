/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Identity canon for a0…049 (BACKLOG "Swarm-wiring agentId collision: a0000000-...-049 claimed by two apps"). validate-swarm-wiring logged a SWARM WIRING COLLISION on every api boot: `intelligent-trades:trading-research-analyst` and `lora:lora-director` both declared a0…049. The kernel owns 049 — swarm-bot-registry-local.ts has registered trading-research-analyst on it since ADR-054, and swarm-bot-registry.ts removed lora-director BY NAME during the ADR-085 carve precisely because 049 is trading's. So the STORE package moves: lora-director → a0…065 (oshal-applications lora/oshal-app.yaml + lora/personas/lora-director.yaml, same change window). This migration is the DB half, mirroring 100-agent-identity-canon.sql: restore any row the collision era left mis-named, and record what the historic rows mean.
 */

-- =============================================================================
-- Migration 111: agent identity canon — a0…049 belongs to trading-research-analyst
--
-- MIGRATION NOTE FOR EXISTING ROWS: rows referencing
-- a0000000-0000-0000-0000-000000000049 from BEFORE this migration are AMBIGUOUS
-- between trading-research-analyst (Intelligent Trades) and lora-director (LoRA
-- Studio) — the two identities shared the id, which is exactly why a UUID cannot
-- be safely re-pointed and the split id is the fix. Those historic rows are left
-- untouched: they are a truthful record of the collision era. From this migration
-- on, a0…049 attribution means trading-research-analyst and a0…065 means
-- lora-director, unambiguously.
--
-- Redis heartbeats need no migration: oshal:runtime-agent:{agentId} keys carry a
-- 90s TTL, so the old key expires on its own. Neither bot is a compose service
-- (both run inline on the api), so there is no AGENT_ID to reconcile — the
-- authorities are the two registries and the two app manifests.
--
-- No row is INSERTED for a0…065 here. lora is a STORE package (ADR-085) and its
-- bot row is seeded by the app loader on activation; a kernel migration that
-- inserts an application's agent would put app data back into the kernel, which
-- is the boundary ADR-085 spent 21 carves establishing.
-- =============================================================================

-- ── Restore 049 to its canonical owner ──────────────────────────────────────
-- Idempotent: no-ops when the row is absent or already canonical. It is NOT a
-- no-op everywhere — whichever app seeded last won the name, so a box where the
-- lora manifest loaded after intelligent-trades carries 'lora-director' here and
-- every per-agent lookup by name resolves to the wrong bot.
UPDATE agents
SET name = 'trading-research-analyst', updated_at = NOW()
WHERE agent_id = 'a0000000-0000-0000-0000-000000000049'
  AND name = 'lora-director';

-- ── Nothing else is re-pointed, and that is a checked claim, not an assumption ─
-- Every other table keyed on agent_id was counted on the reference box before this
-- migration was written: agent_config, agent_memories, agent_tools and chat_tasks
-- all hold ZERO rows for a0…049, and both manifests seeded 0 persona
-- authorizations (the boot log says so on each load). So the `agents` row above is
-- the entire footprint of the collision here.
--
-- On a box that DID accrue rows, they stay put on purpose: a cost row, a memory or
-- a tool grant written during the collision era cannot be attributed to one of the
-- two bots after the fact, and silently moving it to a0…065 would manufacture a
-- provenance the data does not have. Migration 100 made the same call for a0…030.
-- Re-seeding fixes the forward-looking state: the lora manifest's next activation
-- creates the a0…065 row with its own persona, tools and authorizations, and the
-- intelligent-trades manifest re-seeds 049 with trading's.
