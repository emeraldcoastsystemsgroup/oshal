/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1: Swarm controller barrel — re-exports from existing feature locations
 */

/**
 * @description Swarm controller layer barrel.
 *
 * This module re-exports all swarm-controller-only features from their current
 * locations in src/features/. No files have been moved — this is a convention
 * layer that establishes the import boundary.
 *
 * Import rule: src/swarm/ CANNOT import from src/agent/
 *              src/swarm/ CAN import from src/shared/, src/entities/, src/features/
 *
 * Modules:
 *   - orchestration  → queue management, phase routing, ticket decomposition, consensus
 *   - scheduling     → agent scheduler, cron-style task scheduling
 *   - intake         → ticket intake pipeline, approval workflows
 *   - selector       → bot selection and routing logic
 *   - lifecycle      → bot lifecycle, container spawning, runtime registry
 *   - intelligence   → swarm metrics, runtime analysis
 */

// ── Swarm Orchestration ──────────────────────────────────────────────────────
export * from '@/features/swarm-orchestration/index.js';

// ── Agent Management (lifecycle, registry, spawning) ─────────────────────────
export * from '@/features/agent-management/index.js';

// ── Intake (ticket intake pipeline) ──────────────────────────────────────────
export * from '@/features/intake/index.js';

// ── Scheduling ───────────────────────────────────────────────────────────────
// Note: scheduling/ may not have a barrel export yet — re-export when available
// export * from '@/features/scheduling/index.js';

// ── Selector Composition (bot selection/routing) ─────────────────────────────
// Note: selector-composition/ may not have a barrel export yet
// export * from '@/features/selector-composition/index.js';

// ── Operational Intelligence (swarm metrics) ─────────────────────────────────
// Note: operational-intelligence/ may not have a barrel export yet
// export * from '@/features/operational-intelligence/index.js';