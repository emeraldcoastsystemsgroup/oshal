<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — full plan to migrate the standalone ai-plan (C:\Projects\ai-plan, :8060) into a native OSHAL app bundle (planner bot + cockpit surface + plan ticketType), retiring the standalone Docker stack.
-->

# AI-Plan — Native Migration Plan

> **Status — 2026-06-17: PLANNED, not started.** Awaiting operator sign-off.
> Legacy app still runs standalone at `C:\Projects\ai-plan` → `docker compose` → `localhost:8060`
> (container `ai-plan`). It stays up until each native surface reaches parity, then we retire it.

**Goal:** retire the standalone ai-plan Python app and rebuild **100% of its functionality** as a native OSHAL
**app bundle** (ADR-038): an AI-built, human-in-the-loop project planner. Describe a goal → a **Planner** bot
drafts a sequenced plan where every task carries a human action, an AI action, an owner, a due date, and
dependencies. Then you **talk to the plan** — a per-task **Clerk** and a plan-level **Planner** turn casual
notes ("did this today", "deadline slipped two weeks", "add a step for analytics") into **typed proposals you
approve or reject**, every applied change writing a dated audit line.

## What the legacy app does (parity target)

Source map (`C:\Projects\ai-plan\aiplan\`):

| Legacy module | Responsibility | Native OSHAL home |
|---|---|---|
| `app.py` | stdlib HTTP server, routing, auth gating, inline HTML/CSS/JS UI | `ai-plan-routes.ts` + a cockpit surface |
| `auth.py` | bcrypt + HS256 JWT cookie (job-hunter-2 / SSO compatible) | **delete** — OSHAL OIDC + `user_sub` (career-hunter already on this) |
| `store.py` | SQLite (users, plans, tasks, chat) — every op owner-scoped | Postgres tables keyed `(tenant_id, user_sub)` |
| `agent.py` | Planner / Clerk / Planner-chat via `codex exec --output-schema` | the **planner bot** (ADR-036), structured-output via the harness |

Note the legacy schema already carries an **Automator** lane (`automatable`, `auto_lang`, `auto_script`,
`auto_run`, …) — a task can carry a runnable script the AI generated. Port it (Phase 6), don't drop it.

## Architecture (ADR-036 bot-owned, ADR-038 bundle)

- **The planner bot owns the domain.** All three roles are **LLM reasoning → they run on the bot** (cost +
  per-bot model/harness settings apply), never the controller. Each emits **forced-JSON output** re-validated
  server-side (edit targets must be real task ids, fields whitelisted to `EDITABLE`, status/priority
  enum-checked) — the model's JSON is never trusted blindly, exactly as the legacy app does.
  - `run_planner(goal, context)` → `{title, summary, phases[], tasks[]}`
  - `run_clerk(plan, task, thread, message)` → `{reply, kind, log_line, status_suggestion, task_edits[]}`
  - `run_planner_chat(...)` → as Clerk plus `new_tasks[]` (cross-task reasoning)
- **Transport (ADR-036):** interactive (draft plan, talk-to-task, apply) → **direct sync**
  `BotNodeClient.execute(agentId, prompt)` → bot `POST /api/swarm-execute`, cost auto-tracked. No queue.
  Optional scheduled "nudge stale tasks / re-plan" → a dedicated `plan` ticketType + workflow → same bot.
- **Data model — Postgres, keyed `(tenant_id, user_sub)`** (mirror career-hunter): tables `plans`, `tasks`
  (composite PK `(plan_id, id)`, slug ids unique within a plan), `chat` (per-task threads + plan-level thread
  where `task_id` is null; `role='system'` rows are the dated change-log). Migration script under
  `scripts/migrations/`. `EDITABLE` set ported verbatim.
- **Auth:** drop the bespoke JWT entirely — OSHAL OIDC owns sessions; `user_sub` replaces `users.id`. The
  legacy SSO trick (shared cookie with job-hunter-2) is moot once both live in OSHAL.

## The legacy views → native surfaces

| Legacy route(s) | Native surface / route | Phase |
|---|---|---|
| `GET /` multi-list workspace (tabs), `GET/POST /api/plans/{new,delete,rename}`, `GET /api/plans` | `plan-workspace.html` + `/api/ai-plan/plans` CRUD (per-user list of plans, open several as tabs) | **1** |
| describe-a-goal → Planner drafts plan (`POST /api/plan` seed) | `POST /api/ai-plan/draft` → planner bot `run_planner`, persisted | **2** |
| `GET /plan` board: phases, tasks, owner/due/status/priority, human/AI action | `plan-board.html` + `GET /api/ai-plan/plan` | **3** |
| per-task **Clerk** chat + typed proposals (`/api/plan/chat`, `/api/plan/apply`) | task chat panel + `POST /api/ai-plan/chat` / `/apply` → bot `run_clerk`; apply writes audit line | **4** |
| plan-level **Planner** thread + `new_tasks[]` | plan chat tab + `run_planner_chat`; cross-task edits | **5** |
| Automator lane (`auto_script` / `auto_run` generate + show) | task "script" affordance + Automator bot role | **6** |

## Phases + testable milestones

- **Phase 1 — Bundle + plan CRUD** *(testable: create/rename/delete plans, open several as tabs, all owner-scoped)*.
  Stand up the `ai-plan` app bundle: manifest, planner-bot persona + container + registry entry, Postgres
  tables + migration, the plans list route + workspace surface. No AI yet.
- **Phase 2 — Draft a plan (Planner)** *(testable: type a goal, the bot drafts a sequenced plan with phases +
  tasks carrying human/AI action, owner, due, deps; persisted; cost in `chat_tasks`)*.
- **Phase 3 — Plan board** *(testable: the board renders phases/tasks with all fields; edit a field directly)*.
- **Phase 4 — Talk to a task (Clerk)** *(testable: leave a note on a task → typed proposal → Apply or Just-log;
  apply writes a dated audit line; cross-task edits validated)*.
- **Phase 5 — Talk to the plan (Planner-chat)** *(testable: a plan-level note adds tasks / updates several;
  validated server-side)*.
- **Phase 6 — Automator + retire** *(testable: a task generates a runnable script with its run command; legacy
  :8060 stack stopped)*.

Each phase: native route(s) + surface, `npx tsc --noEmit` clean, rebuilt + deployed + verified on real data,
committed, operator notified it's testable. Legacy stack stays up until Phase 6.

## Done-when (the whole migration)
`/cockpit/?app=ai-plan` lets a signed-in user describe a goal, get an AI-drafted sequenced plan, manage several
plans as tabs, talk to any task or the whole plan in plain language, approve/reject typed proposals with a dated
audit trail, and generate per-task automation scripts — all backed by per-user `(tenant_id, user_sub)` Postgres
state, with the planner bot owning the reasoning (cost in `chat_tasks`). The standalone :8060 container is
stopped and removed; SSO/JWT code is gone (OSHAL OIDC owns sessions).

## Security / accountability checklist
- All `/api/ai-plan/*` routes wrapped in `requiresAuth`; every store op owner-scoped at the data layer (not just UI).
- All three AI roles run on the bot (cost + settings); outputs re-validated/whitelisted before any write.
- No bespoke JWT/secret on disk — OSHAL OIDC + `user_sub`.
