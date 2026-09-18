# 06 — Bring your own harness: a harness is a node

Enrollment, envelope claim, and connector access for a user-owned harness. The kernel never spawns the
harness and never holds its credential. Spec: [01 §4.6](../01-high-level-spec.md#46-bot-model-any-bot),
requirements B-05, B-09 to B-12.

```mermaid
sequenceDiagram
  autonumber
  participant P as Person
  participant N as oshal-node<br/>(harness adapter on the person's machine)
  participant K as oshald<br/>(control · orchestration · intents)
  participant H as Harness process<br/>(Claude Code · Codex CLI · Gemini CLI · Cline · custom)

  P->>K: enroll node (ownership proof, ADR-114)
  K-->>N: device-bound token · node record (owner, harness kind as data)
  P->>K: bind bot identities to this node
  loop heartbeat
    N->>K: heartbeat (configuration generation hash)
  end
  K->>K: envelope for a bot whose posture is remote
  N->>K: claim (token, bot, generation)
  K-->>N: Envelope (scopes for this phase · no secret)
  N->>H: run with the pinned generation and the person's own credentials
  H->>N: needs connector data
  N->>K: intent request as the bot principal
  K->>K: admit · resolve SecretRef inside intents only
  K-->>N: normalized intent result
  H-->>N: artifacts · token report
  N->>K: complete (artifacts, reported cost, generation)
  K->>K: admit result as bot principal · CostEvent(kind = Reported)
  K-->>P: status · trace
```

## The three bring-your-own shapes

```mermaid
flowchart LR
  subgraph byo["What a person brings"]
    A["API key / OAuth to a model endpoint"]
    B["An agent runtime on a machine they own"]
    C["An agent that is not oshal-aware"]
  end
  A --> PA["inference::Provider<br/>ephemeral byo connection (ADR-162)<br/>cost Metered"]
  B --> PB["Node with harness kind<br/>enrolled · bound · claims envelopes<br/>cost Reported"]
  C --> PC["A2A gateway<br/>default-off · per-agent scoped credential (ADR-109)"]
  PA --> D["control::admit"]
  PB --> D
  PC --> D
```

## Requirements this diagram satisfies

| ID | Where in the sequence |
|---|---|
| B-05 no kernel spawn | there is no arrow from K to H |
| B-09 enrolled node only, local included | steps 1 to 3; a local harness enrolls the same way |
| B-10 immutable generation | steps 4, 6, 8, 14; mismatch fails the run |
| B-11 intents only, no secret in an envelope | steps 7, 10 to 12 |
| B-12 reported cost labelled | step 15 |
