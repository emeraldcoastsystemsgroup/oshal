# Haven deferred properties — what is closed, what is still open

Tracks the ADR-030 persona properties and the ADR-079 "Deferred" list. Read
[ADR-030](../adr/030-home-persona-layer.md) and
[ADR-079](../adr/079-haven-user-model-and-learning-loop.md) first — Haven is not a separate
surface: **Haven = Jarvis + the per-user model.**

## Closed (2026-08-02)

| Item | Where it lives | Guard |
|---|---|---|
| Push proactivity (ADR-030 property 3) | `src/features/user-model/services/haven-proactivity.ts` (gate + policy), `src/app/routes/haven-proactivity-cron.ts` (delivery), `GET/POST /api/user-model/proactivity` (the switch) | `tests/unit/haven-push-proactivity.spec.ts` |
| Connector-signal facts | `src/features/user-model/services/connector-signal-facts.ts`, refreshed in `UserModelService.sweep` | `tests/unit/haven-connector-signal-facts.spec.ts` |
| Cross-session model compaction | `src/features/user-model/services/model-compaction.ts`, applied in `UserModelService.sweep` | `tests/unit/haven-model-compaction.spec.ts` |

Two things about push worth carrying forward, because they generalize to every outward producer:

- **The push gate reads the `haven-proactive` preference row directly and has no fallback.**
  `NotificationRouter.resolveRouting` deliberately falls back to the `default` topic row and then to
  *email-if-Gmail-else-none*. That is right for a digest the user asked for and wrong for an
  assistant messaging you unprompted — routing through it would have switched push on for everyone
  with Gmail connected, and let the welcome wizard's one generic "text me" answer stand in for
  consent that was never given. No `haven-proactive` row means no push.
- **Two gates, not one.** `HAVEN_PUSH_CRON=1` enables the capability for a deployment; each user
  still switches themselves on. Flipping the env var messages nobody.

## Still open

### Conversational integration onboarding (ADR-030 property 4)
Every new connection should be a 3-turn conversation (discovery → connection → preference capture)
rather than a config screen. The rails now exist — the connector inventory is readable per user
(`readConnectorSignalRows`), the model can capture the preference turn (`POST /api/user-model/teach`),
and `connectorAttentionMessages` already produces the discovery prompt for a *broken* connection.
What is missing is the **forward** case: noticing that a capability the user keeps asking for maps to
a provider they have not connected, and running the three turns.

**Done when:** a signed-in user with no Slack connection who asks Jarvis something Slack-shaped is
offered the connection conversationally, completing it lands a `connector-slack` signal fact plus at
least one captured preference fact, and abandoning it mid-way leaves no partial state. Guard: a unit
spec over the turn state machine (no live OAuth) plus a `MOCK_OIDC=true` browser pass.

### Persona wrapping of specialist replies (ADR-030 property 5)
Jarvis synthesizes its *own* answers in one voice, and `summarizeComplexTask` re-narrates a completed
ticket. A specialist bot's reply that reaches the user through any other path is still unwrapped, so
the voice changes mid-conversation — the exact failure ADR-030 rejected multiple personas to avoid.

**Done when:** every user-visible bot reply on a Jarvis surface passes through one voice layer (or is
explicitly exempted with a reason), a spec enumerates the paths and fails when a new unwrapped one
appears, and wrapping costs at most one extra accountable call per delivery — not one per step.

### Haven as the default login surface (ADR-030)
Superseded in practice by the 2026-07-07 operator decision that login lands on `/cockpit/`, and
overridable per deployment with `LANDING_PATH`. Recorded here so the ADR's open list does not keep
re-raising it.

**Done when:** ADR-030's status line stops listing it as open (it now points at `LANDING_PATH`).

### Suggestion quality beyond v1
`computeSuggestions` still has only the two ADR-079 v1 signals (stale goal, teach nudge) plus the new
connector-attention rule. The pushable set is what a user gets interrupted for, so widening it is a
product decision, not a code one.

**Done when:** a new suggestion kind ships with (a) a reason it is worth interrupting someone for,
(b) an entry in `PUSHABLE_SUGGESTION_KINDS` or an explicit note that it stays pull-only, and (c) a
guard case in `haven-push-proactivity.spec.ts`.
