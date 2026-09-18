# 20 — One way to do things: submission, and provenance by type

Rewritten 2026-09-18 after reading the code. The earlier version of this page claimed prompt assembly
was accretive concatenation and that an authority rebind existed to patch it. Both were wrong; the
corrected reading is in [10 §0](../10-what-we-are-improving.md#0-corrections-of-record) and [10
§4](../10-what-we-are-improving.md#4-persona-layers-and-tools).

## Starting work: one record, latency as a parameter

Today the interactive and queued modes already share one invocation function and one cost ledger. What
they do not share is a **record**, and that is the whole gap.

```mermaid
flowchart TB
  subgraph today["Today"]
    A["interactive call"] --> F["one invocation function<br/>resolves transport (HTTP vs in-process)"]
    B["ticket → queue manager → declared pipeline"] --> F
    F --> C["cost ledger (shared)"]
    A --> NR["no ticket · no status history · no phase trace<br/>workspace keyed by route+user, not by task<br/>a long request can only succeed or time out"]
    B --> R["ticket · history · workspace that follows the root ticket"]
  end
```

```mermaid
flowchart TB
  subgraph target["Target"]
    S["submit(ctx, work, latency)"] --> T["Task record at admission — always"]
    T --> M{"latency"}
    M -- "Interactive{deadline}" --> I["run in the caller's context, streamed"]
    M -- "Deferred" --> Q["dispatch to a worker"]
    I --> O{"past the deadline?"}
    O -- yes --> CV["CONVERT to deferred, return a handle"]
    O -- no --> RS["result"]
    CV --> Q
    Q --> RS
    RS --> ONE["one record · one workspace · one trace · one ledger"]
  end
```

The conversion arrow is the payoff. It is unreachable while only one of the two modes has a record.

## Prompt assembly: the frame is already right

The kernel-owned frame exists today and is good. Trust class is derived by the server and defaults to
untrusted; role layers are always untrusted because user-reachable surfaces persist them; untrusted
content is escaped and capped; and tool availability is not prompt text at all but an immutable binding
resolved from durable authorization modes.

The defect is narrower: **provenance is stamped by hand.**

```mermaid
flowchart TB
  subgraph now["Today — one flag decides the section, and it is set manually"]
    L1["file persona layer<br/>metadata: serverAuthored ✅"] --> CL{"classifyLayer<br/>(default: untrusted)"}
    L2["phase override, same priority slot<br/>NO metadata ❌"] --> CL
    L3["seeded platform / host / tenant rows<br/>NO server stamp ❌"] --> CL
    CL -- stamped --> POL["## TRUSTED POLICY"]
    CL -- unstamped --> UNT["## UNTRUSTED CONTENT — escaped, beside the ticket body"]
    L2 -. "review-mode identity silently demoted" .-> UNT
    L3 -. "swarm-wide policy inert as policy" .-> UNT
  end
```

```mermaid
flowchart TB
  subgraph target2["Target — the constructor carries the class, so it cannot be forgotten"]
    P["PolicyLayer::new(...)<br/>constructible only inside the kernel"] --> FR["frame: contract → policy → configuration → untrusted → rebind"]
    C2["ContentLayer::new(...)<br/>what a package or a store can build"] --> FR
    FR --> OUT["assembled prompt"]
    X["an unstamped policy layer"] -.-> NOPE["does not compile"]
  end
```

The fail-closed default is already correct, which is why the two mis-stamped layers are silently
demoted rather than dangerous. Making the class a type removes the silence.

## The counts that are real

Only the rows the audit confirmed.

| Count | Today | Target |
|---|---|---|
| Declarations nothing reads | 3 (phases, stages, extends) | 0, refused at load |
| Workflow shapes bridged by hand | 2 | 1 |
| Prompt assembly implementations | 3 | 1 |
| Provenance stamped by hand | 3 sites, 2 wrong today | 0, carried by type |
| Meanings of one approval status | 3 | 1 |
| Task records for interactive work | none | same as queued |

Dispatch path count, bot selection mechanism count and prompt contributor count are deliberately absent:
the audit found the first two coherent and showed the third was a count of producers, not mechanisms.
