# 17 — Ambient capture, the person model, and recall

The most consent-sensitive path in the platform, from a microphone to a prompt. Spec:
[07 §O, §P](../07-subsystem-specs-2.md#o-ambient-capture-listening-transcription-diarization).

```mermaid
flowchart TB
  MIC["Capture on a node<br/>audio · screen · video"] --> CON{"Consent record?<br/>device · surface · hours · retention"}
  CON -- "absent or revoked" --> STOP["No capture. Off by default (E-01)"]
  CON -- present --> IND["Visible active indicator + one-action stop (E-04)"]
  IND --> LOCAL["Local processing on the node (E-02)"]
  LOCAL --> TRX["Transcription (provider trait, local impl for demo)"]
  TRX --> DIA["Deterministic diarization<br/>unmatched speaker = unknown (E-03)"]
  DIA --> TXT["Transcript + attribution<br/>raw media stays on the node"]

  TXT --> GATE{"Person-model consent gate (O7, J-04)"}
  GATE -- no --> HIST["History only<br/>immutable · retention-bound"]
  GATE -- yes --> ENR["Enrichment (asynchronous)"]

  subgraph pm["Person model — three stores, never one blob"]
    HIST
    PROF["Profile<br/>durable, person-readable, correctable"]
    DER["Derivations<br/>each with source + confidence"]
  end
  ENR --> DER
  ENR --> PROF
  DER -. "projection ledger: delete a source, derivations go with it (J-01, J-02)" .-> HIST

  PROF --> RG
  DER --> RG
  HIST --> RG
  RG["Recall guard<br/>task-scoped + grant-filtered"] --> SLICE["Only the justified slice"]
  SLICE --> PA["Prompt assembly (fixed frame, B-13)"]
  RG --> RCP["Receipt: what was recalled, when, for which task (J-03)"]
  PA --> BOT["Bot invocation"]
  BOT --> LEARN["Learned signal"]
  LEARN --> SET["Settings + ranking ONLY"]
  LEARN -. never .-> GR["grants · policy · gates (J-05)"]
```

## The four rules this path exists to enforce

| Rule | Why |
|---|---|
| Capture off by default, consent scoped and revocable | a listening default-on is indefensible |
| Raw media stays on the node | the kernel receives transcripts, not streams |
| Recall is a guarded slice with a receipt | dumping a profile into every prompt is an exfiltration channel |
| Learning moves settings and ranking, never authority | a learned signal is as untrusted as the model (P4) |

## Proactivity

Unsolicited action is rate-limited, budgeted and switchable off (J-06). An assistant that can act on
its own without a bound is both a cost incident and a trust incident.
