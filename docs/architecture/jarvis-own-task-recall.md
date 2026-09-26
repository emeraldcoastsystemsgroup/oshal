# Jarvis own-task recall

The source provides a way for Jarvis to look up the caller's own prior conversations and Jarvis work
items without loading their history into every turn. The capability is deliberately two-step:

1. `conversation_query` searches the caller's conversation titles/messages and work-item
   titles/results and returns only selection metadata. `conversations` carry task id, title,
   status, kind, timestamps and a cockpit link; `tasks` (rows of `jarvis_tasks`) carry task id,
   title, status, kind, timestamps and the conversation the item was filed from. Every entry names
   its `source` (`conversation` or `jarvis-task`). It never returns a message snippet, an answer
   body, a task result or a failure note.
2. `conversation_fetch` accepts one task id (and optionally its `source`) and returns that
   conversation's recorded messages as `conversation`, or that work item's recorded result and
   failure note as `task`. An unknown or foreign id returns `conversation: null, task: null`.

Both tools run through the bot-node's normal persisted-tool binding, exact operation scope, and
identity-stamped Postgres pool. The adapters (`ChatSearchSource`, `JarvisTaskRecallSource` in
`src/features/global-search`) keep an owner predicate of their own, and independently the
database refuses another owner's rows: `chat_tasks` and `jarvis_tasks` are FORCE row-level
security on their owner column, and the `chat_messages` policy calls `oshal_owns_task` on the same
connection. The message read carries no owner predicate at all, so that policy is its only wall.
The bot role uses column-level grants only (`BOT_COLUMN_PRIVILEGES` in
`scripts/governance/provision-app-role.mjs` and `docs/governance/app-role-provisioning.sql`); it is
not granted table-wide access. `jarvis_tasks` used to be created only lazily by the api, so
`scripts/migrations/100-jarvis-tasks-base-schema.sql` now creates it, with its owner policy,
before the role provisioner's final phase names it.

Protected results follow the same read boundary the message-history route and the OPEN WORK block
apply. A bot-node tool has the caller's subject and no verified actor to re-check current
application rights, so the shared `canReadProtectedResult` decision is evaluated with an actor
resolver that refuses: a conversation carrying protected execution lineage, and a work item whose
own id, ticket or conversation carries it, are left out of the list, and fetch returns
`withheld: 'protected_result'` instead of their content. A foreign id never reaches that check,
so the marker says nothing about another owner's records.

This separation keeps broad Jarvis questions cheap and bounded. A list result helps Jarvis choose a
record, and only an explicit fetch brings message content or a task result into the current
answer. Missing or foreign records are not retried with another owner and are not treated as
evidence that a caller never discussed the topic.

The Jarvis persona (`ai-lab/bot-personas/oshal-assistant.yaml`) tells Jarvis to recall through
these two tools, in the same turn, before it defers to an app, asks the user to repeat themselves
or says it does not know; `tests/unit/jarvis-persona-recall.spec.ts` pins that rule. The persona
keeps `allowed_tools: []`, so it grants nothing: the per-bot grant below is still required.

## Installed acceptance boundary (2026-09-26)

The real-PostgreSQL two-owner guard passed 24/24 over both the application and bot roles,
including the case where only database RLS can refuse the other caller's rows. The signed-in
live Jarvis check is still **red**. One owner thread recorded a fictional codeword, then a
separate thread requested it without repeating it. Jarvis dispatched a work item, but its
completed result said no conversation search tools or scopes were authorized. The bot-node's
auto-executable view contained zero tools and its workspace listed
`conversation-query` and `conversation-fetch` as not installed. Registration, handler mapping,
persona guidance and local isolation tests do not install a per-bot grant. No live recall,
other-user access or real-history fetch is claimed. Enable only those two read-only tools
through the normal tool-control grant after operator approval, then repeat the signed-in
two-thread check before closing the backlog item.

## Invariant preamble cache seam

The OpenAI-compatible provider accepts an optional provider-owned invariant cache. Its key covers
the endpoint, model, credential fingerprint, system prompt and declared tool schemas, so a persona
or tool change cannot reuse a stale handle and two credentials cannot share one. The cache factory
receives only that system/tool contract; task messages are never eligible for caching. A valid
handle is sent as `extra_body.cached_content` while task history remains in `messages`. Expired,
invalidated, unsupported or failed handles take the ordinary full-preamble path.

The source guard proves request shape, key invalidation, single-flight creation and full-send
fallback. It does not claim that a deployed provider has created a handle or measured a token/time
saving; those remain installed/provider evidence for the backlog item.
