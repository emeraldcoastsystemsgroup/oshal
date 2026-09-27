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

## Invariant preamble cache (as built, 2026-09-27)

Every Jarvis conversation used to re-send the same invariant preamble, the system prompt and the
tool declarations, before the model saw a word the user typed. The direct conversational path now
serves that preamble from one provider-side cache handle shared across conversations.

**Where it lives.** `any-bot/server/services/llm/invariant-prompt-cache.js` is the content-keyed,
single-flight cache with expiry and negative caching. `gemini-context-cache.js` is the Gemini
adapter: it creates the `cachedContents` resource and exports the one process-shared cache.
`OpenAIProvider.js` resolves the default, shapes the request and owns the fallback.

**When it applies.** A provider whose base URL is the Gemini OpenAI-compatible surface (a path
ending in `/v1beta/openai`) uses the shared cache by default; `TaskController._buildByoLlm` builds
exactly that provider for a BYO connection, so the Jarvis bot-node gets it with no controller
change. Every other endpoint sends the full preamble as before. `OSHAL_INVARIANT_PROMPT_CACHE=off`
disables the default; `OSHAL_INVARIANT_PROMPT_CACHE_TTL_SECONDS` and
`OSHAL_INVARIANT_PROMPT_CACHE_NEGATIVE_TTL_SECONDS` bound the positive and negative entries
(`.env.example` documents all three).

**Key.** Endpoint, model, a sha256 fingerprint of the provider's own API key, the system prompt
and the declared tool schemas. A persona or tool-set change is a new key and a new handle; two
credentials never share one; the key itself is safe to log.

**Handle.** `POST {native base}/cachedContents` with `model: models/<id>`, `systemInstruction`
(the system prompt), `tools[0].functionDeclarations` (the declared tools, same name, description
and schema the chat request would have declared) and `ttl` (the positive TTL plus one minute, so
the local entry always expires first). The API key travels in the `x-goog-api-key` header, never
in the URL or body. The body never contains a user or assistant turn.

**Request shape.** A handle-carrying chat request sends `extra_body.google.cached_content`, the
nesting Google documents for its OpenAI-compatible surface (the Node `openai` client passes
`extra_body` through verbatim), omits the system message, and omits `tools` / `tool_choice`
because the handle holds them and Gemini refuses tools beside a cached content. Task history
stays in `messages`, from this task only. The local tool boundary is unchanged: every call the
model makes is still authorized against the same resolved boundary, so an undeclared name is
refused and a declared one executes exactly as with the declarations on the wire.

**Fallback.** If the first leg carrying a handle fails, the handle is invalidated and negatively
cached, and the turn is re-sent once with the full system message and tools. A later leg's failure
is never replayed, because a tool may already have executed. A refused creation (Google's
context-caching documentation sets a minimum token count per model for an explicit cache, so a
short preamble is refused) is remembered for the negative TTL and every turn in that window is a
plain full send, not a create-then-fail.

**Measurement plumbing.** The provider's call-log line prints `input`, `output` and `cached`
tokens and the cache state (`hit`, `created`, `refused`, `none`, `disabled`, `fallback`);
`cached` is the endpoint-reported `prompt_tokens_details.cached_tokens`. The direct path's
metrics fold (`any-bot/server/utils/direct-response-metrics.js`) records `inputTokens`,
`outputTokens`, `cacheReads`, `cacheHits` and `promptCache` in the task's `apiMetrics`; the
bot-node handler bills that split through `recordCost`, so `chat_tasks.total_input_tokens` is a
real input count rather than the old total-as-input, and relays `cacheReadTokens` on the HTTP
usage block.

**Locally proven** (all attached to the `jarvis-routing` Test Lab scenario):
`tests/unit/invariant-prompt-cache.spec.ts` (key, negative caching, wire nesting, no tools or
system on a handle-carrying request, one full-send fallback, no later-leg replay),
`tests/unit/gemini-context-cache.spec.ts` (the adapter, the header credential, the kill switch,
one shared instance), `tests/unit/invariant-prompt-cache-protocol-seam.spec.ts` (the real
`openai` client and `TaskController.processMessage` against a loopback Gemini surface: one create
for two owners' new tasks, re-creation on a tool-set, system-prompt or credential change, the
boundary with no tools on the wire, a rejected handle answered from one full send and not
re-created within the negative TTL, no cross-task text) and
`tests/unit/invariant-prompt-cache-usage-accounting.spec.ts`.

**Not proven here.** That the real Google endpoint accepts the create for the installed preamble,
that its compat surface reports `cached_tokens`, and the before/after numbers. Those are the
operator's measurement: Jarvis reasons on the caller's own resolved brain, `/api/jarvis` needs a
signed-in session, and per the installed acceptance note above the bot-node's auto-executable
tool view is empty until the tool grant, so until then only the system line would be cached and a
short preamble is refused for size. Record, for several fresh conversations with the kill switch
off and on: `total_input_tokens` and `usage_by_model` from `chat_tasks`, `duration_ms` from
`oshal_cost_events`, and the jarvis bot's `OpenAI-compatible call` lines (input, cached, state,
latency).
