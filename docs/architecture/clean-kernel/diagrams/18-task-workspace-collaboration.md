# 18 — The task workspace: claims, commits and any-harness collaboration

The task is the common thread, the workspace is the shared ground, and no two writers ever share an
index. Spec: [08](../08-workspace-and-assistant.md).

## Claim, work, commit

```mermaid
sequenceDiagram
  autonumber
  participant K as kernel (workspace of record)
  participant NA as node A · Codex-kind harness
  participant NB as node B · Grok-kind harness
  participant H as human reviewer

  Note over K: Workspace v1 for ticket T
  K->>NA: Envelope phase 1 · claim scope src/**
  K->>NB: Envelope phase 2 · claim scope tests/**
  Note over NA,NB: disjoint claims → genuinely parallel
  K-->>NA: materialize(v1, src/**) + read-only context
  K-->>NB: materialize(v1, tests/**) + read-only context
  NA->>NA: harness does its own kind of work
  NB->>NB: harness does its own kind of work
  NA->>K: commit(base v1, scope src/**, change set)
  K->>K: verify scope · base · secrets · size
  K-->>NA: v2 (author bot A, harness codex, node A)
  NB->>K: commit(base v1, scope tests/**, change set)
  K->>K: base v1 is stale, but scope is disjoint from v2
  K-->>NB: v3 (author bot B, harness grok, node B)
  K->>H: freeze at v3 for review
  H-->>K: approve → phase 3
```

Disjoint scopes make a stale base harmless: the kernel is rebasing a scoped change set, not merging two
views of one tree. Overlapping scopes take the other path.

## What a commit must survive

```mermaid
flowchart TB
  CS["Change set from a harness<br/>(untrusted input)"] --> C1{"Active claim?"}
  C1 -- no --> R1["Refused: no claim"]
  C1 -- yes --> C2{"All paths inside the claim?"}
  C2 -- no --> R2["Refused: the offending paths are named<br/>(never trimmed, never partially applied)"]
  C2 -- yes --> C3{"Base current, or path has a declared merge policy?"}
  C3 -- no --> R3["Refused: stale base"]
  C3 -- yes --> C4{"Secret patterns?"}
  C4 -- yes --> R4["Refused: secret in workspace"]
  C4 -- no --> C5{"Within size and policy limits?"}
  C5 -- no --> R5["Refused: policy"]
  C5 -- yes --> V["New version<br/>base · bot · harness · node · envelope recorded"]
```

## Merge policy vocabulary, closed by design

| Policy | Behavior | Typical path |
|---|---|---|
| `exclusive` (default) | concurrent writers serialize; stale base refused | source files |
| `append-only` | appends merge, rewrites refused | logs, journals, ledgers |
| `last-writer-wins` | newest commit wins, older recorded | generated outputs |
| `three-way` | textual merge, conflict markers refused | text a team genuinely co-edits |

An automatic merge nobody declared is how a change disappears, so there is no fifth option and no
default that merges silently.

## The rule underneath

Each harness gets its own materialization. There is no shared working directory and no shared index.
That is the direct negation of the failure shape this project already paid for: a rejected commit
retried against an index another session had cleared, shipping one file of a set.
