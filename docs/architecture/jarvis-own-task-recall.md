# Jarvis own-task recall

Jarvis can look up the caller's own prior conversations without loading their history into every
turn. The capability is deliberately two-step:

1. `conversation_query` searches the caller's title/message record and returns only selection
   metadata: task id, title, status, kind, timestamps, and a cockpit link. It never returns a
   message snippet or answer body.
2. `conversation_fetch` accepts one task id selected by the caller and returns that conversation's
   recorded messages. An unknown or foreign task returns `conversation: null`.

Both tools run through the bot-node's normal persisted-tool binding, exact operation scope, and
identity-stamped Postgres pool. `chat_tasks.owner_sub` is checked in the task query, while the
`chat_messages` policy independently calls `oshal_owns_task` on the same connection. The bot role
uses column-level grants only; it is not granted table-wide access.

This separation keeps broad Jarvis questions cheap and bounded. A list result helps Jarvis choose a
record, and only an explicit fetch brings message content into the current answer. Missing or
foreign records are not retried with another owner and are not treated as evidence that a caller
never discussed the topic.

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
