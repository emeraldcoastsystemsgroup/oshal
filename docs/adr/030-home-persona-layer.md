# ADR-030: Home Persona Layer — Persistent Front-of-House Identity

**Status:** Superseded in part by ADR-050 (one voice / hidden routing — delivered as the Jarvis app) and ADR-079 (user model, learning loop, pull-based proactivity — as-built 2026-07-06). Haven is NOT a separate surface: Haven = Jarvis + the ADR-079 user model. Still open from this ADR: conversational onboarding (property 4), persona-wrapping of specialist replies (property 5 beyond Jarvis synthesis), push proactivity, and Haven-as-default-login-surface.
**Date:** 2026-04-01 (reconciled 2026-07-06)
**Deciders:** oshal maintainers

---

## Context

The oshal platform has solid execution infrastructure: a swarm orchestration engine, MCP tool integrations, smart home CLI wrappers (Google Home, Alexa, SmartThings), and an onboarding flow. What it lacks is the conversational layer that makes this infrastructure feel like a *relationship* rather than a toolbox.

Users who interact with ChatGPT report a qualitatively different experience — not because the underlying model is smarter for every task, but because the interaction has:
- One consistent voice that never breaks character
- Memory that builds within and across sessions
- Proactive suggestions rather than purely reactive responses
- Warmth that makes people feel helped, not served

The oshal home context is fundamentally different from a web chatbot: the assistant is embedded in the user's physical life. It knows their devices, accounts, household, and routines. This creates an opportunity for a level of contextual intimacy that no web-based chatbot can match — *if* the persona layer is designed to exploit it.

The smart home planning work (see `planning/smart-home-assistant-agent.md`, `planning/smart-home-unified-agent-ticket.md`) already identifies the CLI/tool execution layer. This ADR addresses the missing layer above it: the conversational identity that users actually interact with.

---

## Decision

Introduce a **Home Persona Layer** — a named, persistent conversational character that serves as the single front-of-house interface for all oshal home capabilities.

**Key properties of this layer:**

1. **One voice.** All user interactions go through one persona. The persona wraps swarm agents, CLI tools, and integrations. Users never see agent routing, phase dispatch, or tool names.

2. **Persistent home context model.** A structured DB model (devices, integrations, household, preferences, unfinished threads) that the persona reads before every exchange and writes back to after. This is the memory that makes it feel like *your* assistant.

3. **Proactive initiation.** The persona can start conversations — new device detected, integration expiring, anomaly noticed. It does not wait to be addressed.

4. **Conversational integration onboarding.** Every new connection (device, account, service) follows a 3-turn conversational pattern instead of a config screen: discovery → connection → preference capture.

5. **Persona consistency enforced at the system prompt level.** The persona system prompt wraps every LLM call. No swarm bot response reaches the user unfiltered — it always passes through the persona voice layer.

The persona is named **Haven**.

---

## Rationale

### Why a named persona?

A name does two architecturally significant things:
1. It creates user expectation of consistency — a named entity is expected to remember things and maintain a voice.
2. It provides a clear seam for the persona system prompt boundary.

Unnamed assistants ("the assistant," "your AI") are perceived as tools. Named ones are perceived as relationships. The home context demands the latter.

### Why wrap the swarm rather than replace it?

The swarm orchestration is good at parallel task execution with QA cycles. The persona layer is not a replacement — it's a routing and voice layer above the swarm. User message → persona layer (reads home context, crafts intent) → swarm agent (executes) → persona layer (translates result back into Haven's voice) → user.

### Why proactive initiation?

ChatGPT's primary limitation is reactive-only design. The home context creates natural signals (new devices on the network, recurring patterns, approaching expiry dates) that a home assistant should notice and surface. This is the feature that creates the feeling of "living with" the assistant rather than "using" it.

### Why conversational onboarding over config screens?

Config screens externalize the cognitive burden to the user. Conversational onboarding keeps the user in a natural interaction mode and captures preference data as a side effect of normal conversation. The result is a richer home context model with less friction.

---

## Alternatives Considered

### Alt 1: Extend the existing personal-assistant.yaml persona
Rejected. The existing personal-assistant.yaml is a generic worker agent. It has no home context, no persistent memory binding, and no proactive capability. Building on it would create a confusing hybrid.

### Alt 2: Multiple specialized personas (smart-home-persona, finance-persona, etc.)
Rejected. Multiple personas break the conversational contract — users notice when the "voice" changes. The swarm handles specialization behind the scenes. The user needs exactly one voice.

### Alt 3: Keep the cockpit UI as the primary interface
Rejected for the home use case. The cockpit is a power-user tool. The home use case demands zero-config, natural language interaction. The cockpit remains available for technical inspection; Haven becomes the primary surface.

---

## Consequences

**Positive:**
- Users experience one consistent, warm, contextually-aware voice across all home capabilities
- The home context model becomes a shared resource — every new integration enriches it
- Proactive triggers create ongoing engagement without requiring users to remember to ask
- Conversational onboarding captures preference data naturally

**Negative:**
- Every LLM call now has additional system prompt overhead (persona + home context snapshot)
- The persona system prompt must be maintained as capabilities grow — drift risk
- Haven's voice must be carefully defined; an inconsistent persona is worse than no persona

**Neutral:**
- Existing swarm infrastructure unchanged; persona layer is additive
- Existing cockpit/admin surfaces unchanged; Haven is a new entry point, not a replacement

---

## Implementation Artifacts

See `planning/home-persona-layer-build-plan.md` for:
- Haven persona definition (name, tone, 12 example exchanges)
- Home context model DB schema
- Build sequence and acceptance criteria
- Proactive trigger design

See `ai-lab/bot-personas/haven-home-assistant.yaml` for the persona YAML.