# ADR-015: OSHAL Swarm Phase Inheritance Pack

## Status
Accepted

## Context

The current OSHAL workspace has reached a point where most Layer 0 / Layer 1 restoration work is already in place. The remaining runtime work is primarily:

- live Presentron validation
- live Google Search MCP validation
- final workspace/bootstrap validation in the preferred operator flow
- UX and documentation consistency

At the same time, the next major workstream is swarm implementation. The repository now contains a large amount of historical context across ADRs, handover files, implementation plans, and RALF session briefs. Re-loading that full history into every new session creates avoidable context pressure and increases the risk of re-opening already-closed runtime decisions.

We need a way to close the current runtime-heavy phase and let the next swarm-focused phase inherit the system state without requiring the full historical replay.

## Decision

We will treat the current runtime baseline as **inherited project state** and start swarm work from a **canonical low-context inheritance pack**.

### 1. Split the work into two tracks

- **Runtime close track**
  - limited to validation, bug fixes, operator guidance, and documentation consistency
- **Swarm build track**
  - owns new swarm architecture and implementation work

Swarm work must not routinely reopen runtime closeout items unless a verified blocker is found.

### 2. Use a canonical inheritance pack for new swarm sessions

New swarm sessions should begin from:

1. `docs/swarm-phase-inheritance-pack.md`
2. `docs/HANDOVER.md`
3. `docs/technical-debt.md`
4. `docs/swarm-agent-architecture-spec.md`

Additional history is pull-on-demand only.

### 3. Treat historical project material as reference, not default preload

The broader `ralf/` history, deeper research docs, and closeout notes remain valuable, but they are no longer required default context for every new task. They become escalation context that is loaded only when the inheritance pack and Tier 1 references are insufficient.

### 4. Keep new work on OSHAL terminology

New swarm documentation, task briefs, and implementation work must use OSHAL naming even when historical artifacts still contain legacy migration wording.

## Consequences

### Positive

- Smaller default context windows for new swarm sessions
- Clear separation between runtime closeout and swarm implementation
- Lower risk of re-litigating already-closed runtime decisions
- Faster onboarding for both human and AI contributors
- A single maintained entrypoint for starting new swarm work

### Negative

- The inheritance pack must be actively maintained as system truth changes
- Some historical nuance is hidden until explicitly requested
- Contributors need discipline to avoid bypassing the pack and overloading sessions with archive material

### Operational Rule

If the runtime baseline materially changes, update the inheritance pack and the active handover docs rather than requiring future sessions to rediscover the change from scattered historical notes.