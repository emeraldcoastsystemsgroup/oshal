# Building and Registering a Bot

**Status:** Current execution pattern (2026-08-06)

**Author:** maintainer@emeraldcoastsystemsgroup.com

This is the canonical guide for adding a bot to the oshal swarm. A bot is a registered,
cost-attributed identity with a persona and an accountable transport. Do not create a one-off route
that silently invokes a model or provider under an unrelated identity.

## Read this execution limit first

Unattended Cline, Claude Code, Codex, and Gemini CLI execution is operationally disabled. The CLI
adapter types remain in the registry for compatibility and future sandbox work, but their public and
controller-direct execution paths fail closed before task lookup, persona/memory assembly, or
workspace creation.

A mounted `~/.claude`, `~/.codex`, or `~/.gemini` OAuth file—and a successful auth-status
response—proves credential presence only. It does not authorize autonomous execution.

Current work must use one of these rails:

- **Hosted/BYO inference** for model reasoning. A caller's authorized `byoLlmConnection` is
  request-scoped and never changes the bot's stored default.
- **Schema-bounded deterministic server provider intent** for an exact external read/action. The
  handler consumes the minimum connector credential outside the model runtime and completes before
  persona, memory, task, or workspace side effects.

Re-enable a local CLI only after an audited oshal-brokered sandbox enforces immutable request-start
handler generations and exact operation scopes while keeping authentication and connector
credentials outside the model-visible process and workspace.

## A bot takes one of two forms

| | Dedicated bot node | Inline concierge |
|---|---|---|
| Runs in | Its own `BOT_RUNTIME=bot-node` container | The `oshal-api` process through the orchestrator |
| Reached by | `BotNodeClient.execute()` to `/api/swarm-execute` | The application's authenticated `POST /chat` route |
| Use for | Isolation, long work, a dedicated store, or a validated deterministic provider intent | Reasoning over already authorized/redacted data |
| Must not do | Run an autonomous local CLI or receive a generic credential carrier | Receive connector credentials/provider intents, run a shell, or become a control-plane shortcut |
| Cost capture | `chat_tasks` under the bot `agentId` | Same |

Both forms are registered swarm identities. The transport differs; authorization, caller ownership,
prompt containment, tool allowlists, and cost attribution do not.

## Identity and registry rules

- Use one collision-free UUID and one name across the persona, both registries, and any manifest.
  Boot-time `validatePersonaIdentities()` fails on duplicates or mismatches.
- Register in both `swarm-bot-registry.ts` and `swarm-bot-registry-local.ts`; one profile must not
  silently lose the bot.
- A dedicated node's `container` is its service name and its port is unique. An inline concierge's
  `container` is `oshal-api`.
- `harnessType`/`apiType` describe configured runtime compatibility and precedence. They do not
  bypass the autonomous-CLI preflight. Do not copy a legacy CLI harness entry and assume an OAuth
  mount makes it runnable.
- Internal or privileged bots should declare `accessRoles: ['operator', 'swarm']`. Omit that field
  for ordinary user-facing domain bots only after reviewing Jarvis/catalog visibility.

Provider precedence remains server-owned:

1. A non-generic registry `harnessType` pins the configured provider.
2. For an unpinned entry, the per-agent database record wins.
3. Registry `apiType` is the next fallback.
4. `FORCE_LLM_PROVIDER`/global configuration is the deployment default and first-boot seed.

That precedence selects configuration; it never converts a disabled CLI into an authorized
execution rail. The Config Admin UI must show the server's effective provider/source rather than
re-deriving precedence in browser code.

## Credentials and provider actions

Never add a vendor or connector key to a bot environment to make it work. Never put `creds`,
`credentials`, `OSHAL_CRED_*`, or `.oshal-cred-*` in a generic request or workspace.

Connector credentials remain in an exact server-side operation:

1. authenticate the caller and derive their exact subject server-side;
2. parse a closed, versioned provider intent and reject unknown fields;
3. bind the dedicated handler identity and exact operation scope;
4. resolve only the caller-owned connection for that operation;
5. invoke the deterministic handler without a shell or model-authored arguments; and
6. pass only the normalized/redacted result to hosted/BYO inference.

See [connector-backed-apps.md](connector-backed-apps.md) for the complete operation recipe.

## Dedicated bot-node recipe

1. **Registry:** add the same identity to both registry files. Set a dedicated container name,
   unique port, role, capabilities, and access roles. Choose a currently authorized hosted/BYO rail;
   a legacy CLI harness value remains fail-closed.
2. **Compose:** add a `BOT_RUNTIME=bot-node` service using the common bot image/environment. Set
   `BOT_NAME`, `AGENT_ID`, `BOT_PERSONA_FILE`, and capabilities. Do not add connector keys or a
   writable CLI-auth propagation path.
3. **Persona:** create `ai-lab/bot-personas/<name>.yaml` with matching `agent_id`, bounded purpose,
   output contract, capabilities, routing terms, and only the tools it is allowed to see.
4. **Provider operation, if needed:** extend the closed provider-intent parser/executor and its
   dedicated identity mapping. Do not create a generic CLI wrapper or pass a credential map.
5. **Transport:** call `BotNodeClient.execute(agentId, request)` through the existing authenticated
   route. Owner identity, task/workspace identity, capabilities, and authority bindings are
   server-derived and immutable for that dispatch.
6. **Evidence:** test denial before side effects, caller ownership, allowed/denied tools, prompt
   containment, deterministic operation parsing, redaction, and cost attribution.

## Inline concierge recipe

Use an inline bot only for reasoning over data the authenticated route already obtained safely. An
inline request cannot carry connector credentials or a deterministic provider intent; those require
a dedicated audited handler.

1. Register the identity in both registries with `container: 'oshal-api'`.
2. Create the persona with a strict output contract. It should transform provided data, not fetch an
   account through a hidden shell or credential.
3. Mount an authenticated `POST /chat` route. Derive the exact caller subject, load caller-owned
   non-secret context, resolve an authorized hosted/BYO inference connection when needed, and call
   `executeBotOrInline` without any generic credential field:

   ```ts
   const result = await executeBotOrInline(ctx, botClient, AGENT_ID, {
     text: prompt,
     taskId: `myapp-${sub}`,
     workspaceFolderId: `myapp-${sub}`,
     agentId: AGENT_ID,
     agenticMode: true,
     direct: true,
     userSub: sub,
     byoLlmConnection,
   });
   ```

4. Validate the bot's structured output and persist only to an owner-scoped application store.
5. Return cost/usage under the bot identity. Never fall back to a controller-local CLI.

## New-bot checklist

- [ ] One UUID/name across persona, both registries, and manifest; duplicate validation passes.
- [ ] Dedicated node or inline concierge chosen explicitly; no bespoke third execution path.
- [ ] Exact caller ownership and access roles enforced at every entry point.
- [ ] Hosted/BYO inference or a closed deterministic provider intent selected.
- [ ] No unattended Cline/Claude Code/Codex/Gemini CLI assumption.
- [ ] OAuth/auth-file presence treated as diagnostics, not execution authority.
- [ ] No `creds`, `credentials`, `OSHAL_CRED_*`, or `.oshal-cred-*` model/workspace carrier.
- [ ] Persona has a bounded purpose, strict output contract, and minimum tool authorization.
- [ ] Prompt/memory/tool containment and denial-before-side-effects tests pass.
- [ ] Typecheck and focused tests pass; a human can exercise the safe rail locally.

## References

- [ADR-019](adr/019-per-bot-container-architecture.md) — per-bot container architecture.
- [ADR-033](adr/033-multi-harness-execution-framework.md) — historical multi-harness framework;
  current CLI execution is fail-closed as described above.
- [ADR-036](adr/036-bot-owned-application-architecture.md) — accountable bot-owned domains.
- [SECURITY-HARDENING.md](security/SECURITY-HARDENING.md) — current containment posture.
