# ADR-028: Phase 8 Architecture Pre-Round — Complexity-Driven Trigger

## Status
Accepted

## Date
2026-03-30

## Context

The swarm pipeline has an optional Phase 8 (Architecture Pre-Round) that dispatches the system architect agent to write `TECHNICAL-SPECIFICATION.md` before PM planning begins. This was implemented in Session 99 but gated by a global environment variable `USE_ARCHITECTURE_PHASE=true`, which defaulted to disabled.

### Problem

Phase 8 never triggered in production because:
1. The env var was never set in any Docker container
2. The env var was a global on/off — no per-ticket intelligence
3. Phase awareness prompts didn't include Phase 8, so agents didn't know about it
4. The competency ranker had no Phase 8 roles for agent scoring

### Decision

Make Phase 8 **complexity-driven with env var override**:

```typescript
function isArchitecturePhaseEnabled(complexity?: string): boolean {
  if (process.env.USE_ARCHITECTURE_PHASE === 'true') return true;
  if (process.env.USE_ARCHITECTURE_PHASE === 'false') return false;
  return complexity === 'high';  // Auto-enable for high-complexity tickets
}
```

Behavior:
- **Unset / 'auto'**: Phase 8 fires for high-complexity tickets (score >= 7)
- **'true'**: Phase 8 fires for ALL tickets regardless of complexity
- **'false'**: Phase 8 never fires

Additionally:
- Add Phase 8 to `PHASE_DESCRIPTIONS` in swarm awareness prompt
- Add Phase 8 to `PHASE_NAMES` in handover manager
- Add `ARCHITECTURE_PRE_ROUND: 8` to `SWARM_PHASES` enum
- Add architecture roles to competency ranker

## Consequences

### Positive
- High-complexity tickets get architectural review before PM planning
- System architect agent participates meaningfully in the pipeline
- Agents are aware of Phase 8 in their context prompts
- Operators can force-enable/disable via env var for testing

### Negative
- Adds ~60s latency to high-complexity ticket processing (architecture round)
- Requires architect-bot container to be online

### Neutral
- Low/medium complexity tickets unaffected (Phase 8 skipped)
- Existing Phase 2-7 flow unchanged

## Related Documents
- `ralf/2026-03-30-session-18-swarm-completion.md` — Session 18 completion brief
- `src/features/swarm-orchestration/services/planning-round-orchestrator.ts` — Implementation
