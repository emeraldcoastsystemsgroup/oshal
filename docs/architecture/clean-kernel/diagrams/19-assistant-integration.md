# 19 — The assistant as the human's integration with the swarm

The assistant is a package. The three rails under it are kernel. Spec:
[08 §6](../08-workspace-and-assistant.md#6-the-assistant-the-humans-integration-with-the-swarm).

```mermaid
flowchart TB
  P["Person"] --> AS["Assistant package<br/>conversation · intent · hand-off"]
  P -. "always available directly" .-> SURF["Any surface or API<br/>(the assistant is never required)"]

  AS --> D["control::admit — as the person, with their grants"]

  subgraph rails["Kernel rails the assistant depends on"]
    CAT["1 · Capability catalog<br/>bots · tools · workflows · apps · surfaces · connectors<br/>grant-filtered per principal"]
    RT["2 · Data-driven routing<br/>declarations: ownership · skills · routing rules"]
    SC["3 · Session continuity + receipts<br/>thread · history · what was recalled · what was done"]
  end

  D --> CAT
  D --> RT
  D --> SC
  RT --> PICK{"What handles this?"}
  PICK -- "a surface can do it better" --> HAND["Hand off to the surface<br/>(affordances are declared)"]
  PICK -- "a bot" --> BOT["Bot invocation (one chokepoint)"]
  PICK -- "a process" --> TIX["Create a ticket → workspace → workflow"]
  PICK -- "a consequential write" --> CONF["Ask for explicit confirmation → Ctx&lt;Confirmed&gt;"]
  BOT --> OUT["Result + receipt"]
  TIX --> OUT
  HAND --> OUT
  CONF --> OUT
  OUT --> P

  ERR["Any failure"] --> TRUTH["Surface the REAL cause to the person and the audit"]
  TRUTH -.-> P
  ERR -. forbidden .-> MASK["Generic apology that hides the cause"]
```

## The rails, and why each is kernel rather than package

| Rail | Why it cannot live in the assistant |
|---|---|
| Capability catalog | it must be grant-filtered by the same authority as the door, or it becomes a discovery leak |
| Routing declarations | routing by pattern matching in the assistant is the drift this platform already removed once |
| Session continuity and receipts | receipts are a person-model obligation, not a convenience of one surface |

## Four rules with scars behind them

| Rule | Origin |
|---|---|
| Never a required chokepoint (A5) | the assistant was down for three days; everything else had to keep working |
| Surface the real error, never a generic apology (A7) | a catch-all hid an ownership bug with nothing logged |
| A refusal must not strand a half-created task (A7) | refused threads left records stuck in a created state |
| Acts as the person, never with more authority (A6) | it is the most prompt-exposed component in the platform |
