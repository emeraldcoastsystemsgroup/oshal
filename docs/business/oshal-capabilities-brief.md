# OSHAL — Capabilities Brief

**Open Swarm Harness Agent LLM** · Multi-agent orchestration platform
Prepared 2026-06-15 · Emerald Coast Systems Group / Agentic Federal

---

## In one line

OSHAL is a platform that turns a business process into a **swarm of accountable AI
bots** — each running a different agent harness against a different LLM, each acting
on a user's *own* connected accounts (Gmail, LinkedIn, X, GitHub, Dropbox, Facebook),
under a per-user security model where no bot ever holds the master keys.

## What it is

A **swarm controller** accepts tickets and dispatches work to **bot-node workers**.
Each worker runs a real agent harness — **Cline, Claude Code, OpenAI Codex, or Google
Gemini** — so the platform is not locked to one model or one vendor. Bots
collaborate over a Redis mesh, and every unit of LLM work is cost-tracked per call.

The platform ships as a **single Docker image** that boots as either the controller or
a bot node, so the same artifact scales from a laptop to a cluster.

## The several functions it has been configured to perform

OSHAL is organized into **application bundles** — each bundle is a category of work
packaged as {connectors + provider CLIs + bot(s) + a cockpit surface}.

| Function | What it does | State |
|---|---|---|
| **Connectors hub** | One-click OAuth to a user's own accounts; tokens encrypted per-user, grouped by purpose. Google, LinkedIn, X, Outlook/M365, Facebook, **Facebook Pages**, **GitHub**, **Dropbox** — all live. | **Live** |
| **Social / personal-branding** | AI-drafts posts in your voice, you approve, it publishes to **LinkedIn, X, and Facebook Pages**. **Social Signals** turns your inbox into a free social feed (platform email notifications → captured → AI-organized) since the platforms paywalled/killed feed APIs. Plus a Content Studio (trends + news → perspective). | **Live** |
| **Intelligent Communication** | A bot reads your email (Gmail/Outlook) on your behalf and summarizes/triages — short-lived token, never your master key. A 15-min cron captures all mail into a timestamped store. | **Live** |
| **Presentations** | Type a topic → the bot drafts an outline → a real **PowerPoint (.pptx)** is generated and saved to your chosen storage. Replaces Presenton. | **Live** |
| **Storage** | A chat **Assistant** ("make me a repo", "save my files to Dropbox", "where do files save?") + settings to route generated **code vs files** to GitHub / Dropbox / local + a file browser. You own the storage; OSHAL routes to it. | **Live** |
| **Swarm packer** | Describe a business process in plain English; `codex-packer` interviews you and emits a self-contained bot or multi-bot swarm — **downloadable as a zip** or **deployed live** with its own ticket queue. | **Live** |
| **DevOps / Vault** | A privileged swarm where a `vault-bot` pulls short-lived, scoped cloud credentials from HashiCorp Vault per task, acts on infrastructure, then wipes the session — the controlled "real creds, real results" loop. | **Private Preview** (designed + facade live; runtime is the build) |

## Why it is differentiated

- **Bring-your-own-everything.** Not locked to one LLM (5 harnesses) or one cloud.
  Local models (Ollama, LM Studio, LiteLLM) run fully offline; hosted vendors plug in
  the same way.
- **The bot owns the domain.** Each bot fetches its own data with the user's connector
  token, reasons on its own LLM (so cost + settings are captured), and a cockpit surface
  is just a *view* over the bot's store. No shortcut data-fetching that bypasses
  accountability.
- **Per-user security by construction.** Connector tokens are encrypted at rest and
  scoped to the signed-in user. A **token broker** keeps the master encryption key on the
  controller only — bots receive short-lived, single-user tokens and never the master
  key, so a compromised swarm leaks at most one user's one short-lived token.
  **Envelope encryption** (per-user data keys) is built and ready to switch on, so no
  single key can decrypt every user's data.
- **Process → product in minutes.** The packer turns a whole business process into one
  self-contained, governed bot with its own approval-gated ticket queue.
- **Human-in-the-loop where it matters.** Nothing posts, sends, or changes production
  without an explicit human approval click.

## Who it's for

Teams that want to operationalize AI agents against **real accounts and real
infrastructure** — marketing/personal-branding, communications triage, code & storage
automation, and (next) controlled DevOps — without handing a black-box vendor their
credentials or losing per-user accountability.

---

*This brief is a capabilities summary. For the precise built/live/connected state and the
delivery plan, see [oshal-as-is-to-be-delivery.md](oshal-as-is-to-be-delivery.md).*
