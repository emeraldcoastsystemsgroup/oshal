# The Stem-Cell Model — what OSHAL actually is

> The whole idea in 60 seconds.

OSHAL is a **stem cell for AI applications**. A stem cell is undifferentiated — it can
become any kind of cell. OSHAL's core is the same: it provides everything an AI app needs
(a cockpit UI, authentication, RAG, a job queue, cost tracking, and multi-vendor LLM
execution) but is **deliberately generic** — it doesn't know or care what app it's running.

You don't fork the core to build your app. You **declare** your app, and the platform
differentiates into it at load time.

## The one mechanism

An app is a single YAML file in [`swarm-apps/`](../swarm-apps/). It declares the app's bots,
their personas, tools, UI ribbon, routes, database migrations, and workflow. Drop the file in →
the framework loads it and the app is live. Remove the file → it retires. **No core code changes.**

```
OSHAL core (generic: UI · auth · RAG · queue · cost · 5 LLM harnesses)
        │
        │  swarm-apps/your-app.yaml  ← the differentiation signal
        ▼
   Your App  (branded cockpit at /cockpit/?app=your-app)
```

That's the stem-cell property: **the core is undifferentiated; the manifest is the DNA that
turns it into a specific app.**

## The proof

The repo ships **nine distinct apps running on the same untouched core** — a K-12 study
companion (Little Monsters), an incident-RCA workflow, a federal capture process, an email
summarizer, and more. None of them forked the core. See the
[app gallery](../README.md#example-apps--one-core-zero-forks) and build your own in ten minutes
with the [tutorial](build-your-own-swarm-app.md).

`codex-packer` takes it one step further: it *interviews* an operator and **emits a new app
manifest automatically** — so a non-engineer can mint a new app by conversation.

## Why this is the bet

Most agent frameworks are **libraries** you import and assemble into one app. OSHAL is a
**running platform** where apps are declared, not built. That matters because:

- **Speed:** a new app is a YAML file and a persona, not a new codebase. Ship in an afternoon.
- **Reuse:** every harness, provider, and tool you add is instantly reachable by every app.
- **Durability:** because each bot independently picks its harness/provider/model, you can
  reroute around price and capability shifts in the model market **without rewriting any app**.
- **Seed → platform with no rewrite:** the same manifest that is "your app" on a laptop becomes
  "a tenant's configuration" or "a product in the catalog" when you host it for many customers
  (see [ADR 035](adr/035-multi-tenant-saas-foundation.md)). Going from one to many is a wrapping
  job, not a rebuild.

## In one sentence

**OSHAL's differentiated value is that its core is undifferentiated** — everything specific (the
app, the brand, eventually the tenant) is declared on top, so the same seed serves a solo builder
and a multi-school platform alike.
