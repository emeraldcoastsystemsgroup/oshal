# ADR-001: Migration of the legacy codebase onto OSHAL with Feature-Sliced Design

---

## Naming and Migration Policy

- All new code, objects, endpoints, and documentation must use the `OSHAL` namespace and naming.
- No legacy (pre-OSHAL) naming, objects, or conventions are allowed.
- See `.clinerules/naming.md` for the full rule and enforcement policy.

---
## Status
Accepted

## Context
OSHAL was conceived as a **framework**: a secure environment in which a first-time builder can
design and deploy their own multi-agent application while focusing entirely on design and
function, never on the technical nuts and bolts of an orchestrated swarm. The platform's job is
to carry the orchestration, isolation, and security so the builder doesn't have to.

The code lineage is older than that decision: the earliest ancestor was a single bot built on
AWS Bedrock roughly a year before this ADR, which evolved into a multi-agent swarm with
orchestration capabilities. That inherited codebase had grown to approximately 100K lines
without consistent architectural structure.

Recent feature additions — including multi-provider support, agent orchestration, and dynamic configuration — have exceeded the capacity of the original backbone architecture. Key problems include:

- **Monolithic structure**: No clear separation between layers, features, or domains
- **Tight coupling**: Components directly depend on each other without abstraction boundaries
- **No governance**: No enforced file size limits, logging standards, or documentation requirements
- **Difficult onboarding**: New developers (human or AI) struggle to understand the codebase without extensive context

## Decision
Create **OSHAL** as a clean foundation workspace and migrate the legacy codebase onto it. The migration follows a phased approach:

1. **Phase 1 (current)**: Build POCs, establish governance rules (`.clinerules/`), validate patterns
2. **Phase 2**: Scaffold the FSD directory structure, set up logging infrastructure, define CI/CD
3. **Phase 3**: Execute the full migration — bring the legacy code over, restructure into FSD layers
4. **Phase 4**: Stabilization, testing, documentation

The target architecture uses **Feature-Sliced Design (FSD)**:
```
app/        → Application entry, providers, global config
pages/      → Route-level compositions
features/   → User-facing functionality (self-contained slices)
entities/   → Business domain objects
shared/     → Reusable utilities, UI primitives, constants
```

Governance standards are enforced via `.clinerules/`:
- 1000-line file cap, 800-line refactoring trigger
- Structured JSON logging (Flight Recorder)
- Change Log headers, JSDoc, ADRs
- HANDOVER.md per feature, living READMEs

## Consequences

### Positive
- Clean, maintainable architecture from day one
- Governance rules prevent the same sprawl that plagued the legacy codebase
- FSD provides clear boundaries for the swarm's features (agents, orchestration, providers)
- Structured logging makes debugging multi-agent interactions tractable
- RALF + HANDOVER documentation ensures continuity across sessions

### Negative
- Migration effort is significant (~100K lines to restructure)
- Two codebases temporarily maintained in parallel during transition
- FSD has a learning curve for contributors unfamiliar with the pattern
- Strict governance adds overhead to every change (Change Logs, JSDoc, logging)

### Risks
- Some legacy features may not map cleanly to FSD layers — will require judgment calls
- The swarm's real-time orchestration may need performance-sensitive exceptions to logging rules
- POC patterns established in Phase 1 may need revision when real complexity is introduced