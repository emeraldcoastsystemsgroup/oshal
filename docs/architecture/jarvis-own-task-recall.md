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

## On a CLI brain: the Antigravity host tool loop (as built, 2026-09-27)

The recall tools are bot-node registry tools. A CLI brain does not receive them as native tools
or through the controller MCP bridge. The Antigravity wrapper provisions that bridge only for a
protected application execution, and the bridge lists no `system` tool, which both recall tools
are. They reach the turn through the agentic host loop in
`any-bot/server/controllers/AgenticController.js`: the prompt lists them in the XML tool format, the
model replies with one XML call, the loop runs it through the request-scoped registry for the
caller and sends the fenced result back in the next provider call.

The automated case `jarvis-cross-thread-recall` found this failing on the Antigravity brain
(2026-09-27 18:00 UTC). The single agy turn ran 10 min 45 s and ended with `jetski: no output
produced - a tool required the "read_file" permission that headless mode cannot prompt for`.
The recall tools never ran. agy is an agent with its own tools (file, command, browser and web), and
it answered the host prompt with those tools instead of an XML call. The prompt's Cline section also
tells a model to `read_file` under `/app/server`. A local run with the wrapper's argument vector and
an invocation-private HOME showed the pattern. On the host prompt, agy's first step was a native
`run_command`. A native `view_file` outside `--add-dir` returns the live error word for word. The
denied path from the live run cannot be recovered, because the wrapper then discarded the
stream-json step events and removed the private HOME, which held agy's log.

For a direct (interactive) dispatch, the bot-node handler now sets `hostToolsOnly`. The agentic loop
forwards that flag to its provider call and to no other call. `AntigravityCLIWrapper` then runs agy
as a custom agent that exists only in the invocation's private HOME,
(`~/.gemini/config/agents/oshal-host-tools/agent.md`: `excludeDefaultComponents: true`,
`inheritCustomizations: false`, no `tools`). The run passes `--agent oshal-host-tools` and an empty
permission allow list, and omits `--mode accept-edits`. `--sandbox` and the single `--add-dir <task
workspace>` stay. agy then has no native tool to use, so the host loop's tools are the only way to
run one. Ticket (non-direct) turns keep their existing workspace shape, and protected executions
keep the MCP bridge. A failed turn's diagnostic now names each denied tool and its target.

Measured on the operator workstation with agy 1.2.8 (the same version the image pins) and
`gemini-3.8-flash-low`: the three calls of a two-tool recall took 6.8 s
(`conversation_query`), 8.1 s (`conversation_fetch`) and 9.9 s (`attempt_completion` with the
codeword), 24.8 s in total. Jarvis's decision window is 75 s. The same prompt without the agent
spent 22,463 input tokens on its first call and went straight to a native command; with the agent
it spent 9,794. Asked outright to use `view_file`, `run_command` and `search_web`, the agent called
none and said that none was available.

**Locally proven:** `tests/unit/antigravity-host-tool-loop.spec.ts` runs the real handler marker,
AgenticController loop, provider and wrapper against a real child process, over a real registry, and
completes the two-tool recall for the caller. `tests/unit/antigravity-bot-runtime.spec.ts` pins the
permission scope of every mode as a closed set. Both are attached to `jarvis-routing` and
`jarvis-cross-thread-recall`. **Not yet live-proven:** the deployed bot node answering the case.
Run `node scripts/operations/jarvis-recall-live-proof.js` after the next deploy.

## Late answers, honest errors and where a turn's time goes (as built, 2026-09-27)

After the host-tool-loop fix was deployed (core `078ec127`, image `df9357df0bc9`), the automated case
recalled correctly and still went red. `conversation_query` and `conversation_fetch` each ran once,
and the bot's own frames held the codeword. But `/api/jarvis/ask` had already answered at its 75 s
decision window: "I could not get an answer just now — my model provider did not respond in time."
That sentence was false. The bot had not failed and was still working. Its answer reached the api at
20:11:39.674, 196 s after the ask registered its thread (20:08:23.967), and then reached no one.

**What changed.** A conversational turn (not a work request, no selected file) that outlives the
window now keeps its ask job `pending`. `/ask/result` adds `progress` ("Still working on it — the
answer will appear here when it is ready.") and `expiresInMs` (how long the job is still kept). The
route keeps awaiting the SAME turn. When the turn returns, its answer takes the normal success path
into the same thread (`persistJarvisTurn` on the asked session) and becomes the job's answer. If the
turn fails, the job reports that failure's own message. The page keeps following a turn that
carries `progress` for `expiresInMs` instead of stopping after ~5 minutes, and the answer replaces the
note in the same bubble. The selected-file branch and the work-request filing branch did not change.

The `/ask` session gate now separates a store that could not answer from a refusal. A thrown task
store (live: `Connection terminated due to connection timeout` during the 36-bot cold start) returns
a retryable `503 session_unavailable` with `Retry-After: 5` and writes nothing. A foreign-owner or
read-back refusal still returns 404 `session_not_found`. `/ask/result` does the same: `503
result_unavailable`, not `expired`. On the same box a result poll hit `timeout exceeded when trying to
connect` at 20:08:39.603. `jarvis-cross-thread-recall` now judges delivery into thread B (see
docs/test-lab.md). Guards: `tests/unit/jarvis-late-answer.spec.ts`,
`tests/unit/jarvis-ask-session-gate-postgres.spec.ts` (the store's own pool exhausted on a private
PostgreSQL, so pg-pool's acquire timeout fires), `tests/unit/jarvis-ask-session-ownership.spec.ts`,
and the still-working case in `tests/unit/jarvis-dashboard-browser.spec.ts`.

**Where the deploy-verify ask's time went.** Read-only `docker logs --timestamps` of
`oshal-local-api` and `oshal-local-jarvis-bot`, for task `deploy-verify-dc674760-…`. The question was
"Reply with the single word ready."

| Stage | From → to (UTC) | Time | Evidence |
|---|---|---|---|
| api turn assembly (tools, catalog, open work, brain, Haven) | 20:05:27.808 → 20:05:32.868 | 5.1 s | `Task created (postgres)` → `Dispatching work to bot node` |
| transport + delegation | → 20:05:33.701 | 0.8 s | `HTTP delegation authorized`, `Executing envelope` |
| bot event loop held before the model call | 20:05:34.154 → 20:07:02.939 | 88.8 s | first `[ADR-127] DEMO_MODE: launching antigravity-cli` (provider entry) → second (wrapper entry); `[TokenChase] owner store snapshot failed: ENOENT … .db-shm` at 20:07:02.902 |
| agy + model | 20:07:02.939 → 20:07:23.810 | 20.9 s | `Turn 1 metrics: 35369 tokens`, one call, no tools |
| bot event loop held after the answer | 20:07:23.892 → 20:07:57.468 | 33.6 s | `Any-bot execution completed` carries pino time 20:07:23.892 but reached docker at 20:07:57.468; the api logged `bot-node-client … durationMs 143902` at 20:07:57.524 |

The bot spent 20.9 s of its 143.9 s in the model. Two stretches account for 122.4 s: 88.8 s before
the model call and 33.6 s after the answer. In both, the event loop did nothing else, and nothing
was logged or sent. The only code between the two launch lines is the model-gateway check, which
has a 3 s socket timeout, and the prompt join. Token Chase capture is on
(`TOKEN_CHASE_CAPTURE=true`). Its open-frame and final writers run in `setImmediate`. The final
writer runs after `finishRun` and before the response is flushed. Each writer copies the caller's
encrypted owner store into the run's `.tokenchase/store-objects` with synchronous file reads, hashes
and writes (`src/features/token-chase/services/owner-store-snapshot.ts`, `walkStoreDirectory`). The
operator's store (`/app/api-data/career-hunter-data/default/<sub>`) is 1.6 GB in 19,287 files. The
deploy-verify ask's `store-objects` holds 1.2 GB in 19,279 objects, and so does its
`jarvis-summary-…` follow-up. The frame-1 snapshot still ended incomplete (`ENOENT` on the SQLite
`-shm` file).

The recall ask on the same box shows the same pattern. Its model calls took 13.6 s, 9.7 s and 4.6 s,
and its tools about 2 s. The gap before the first call was 81 s, overlapping the first frame of a
concurrent `jarvis-summary` run on the same bot. Later gaps were 3.9 s and 4.6 s, when the objects
already existed. The final writer took 6.1 s. `bot-node-client` logged `durationMs 130184`.

One more fact from the same logs. The deploy-verify question has no question marker, so
`looksLikeWorkRequest` classified it as work. At 20:06:46.224 the window filed it with the swarm
(`jarvis-build-handoff … build handed to the swarm without a model turn`). The verify's "Jarvis
answered in 79s" was that acknowledgement, not an answer.

No change was made to the turn's latency here. Nearly all of it is the Token Chase checkpoint writer
(ADR-046), and bounding or moving that changes the capture and replay contract. That is outside this
route.

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
