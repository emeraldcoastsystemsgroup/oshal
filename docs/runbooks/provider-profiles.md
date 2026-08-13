# Provider profiles — running the swarm on one API key

**Who this is for:** you hold a key from one vendor — xAI (Grok), Groq, DeepSeek, Mistral,
Together, or a local Ollama box — and you want the swarm to run on it instead of the default
Codex OAuth session (Claude Code remains mounted as the per-bot override / failover).

**Status:** the env path below is traced through the code and every referenced line is current.
It has **not** been proven end-to-end by a completed ticket on a non-default provider — the same
caveat [local-llm-profile.md](./local-llm-profile.md) carries for Ollama. Treat the "flip the fleet"
section as a procedure to verify on your box, not a shipped profile.

## The default: codex, sized to your ChatGPT plan

The fleet default is **openai-codex on `gpt-5.5`** (operator directive 2026-08-12) via the
bind-mounted `~/.codex` ChatGPT login. Codex plans meter by **plan limits, not per-token bills**,
so the model choice decides how fast a plan burns. Pick by tier in `.env`:

| ChatGPT plan | `CODEX_MODEL` | `CODEX_REASONING_EFFORT` | why |
|---|---|---|---|
| **Pro ($200/mo)** | `gpt-5.5` *(default)* | `high` *(default)* | The fleet floor. Verified live on a ChatGPT login. |
| **Plus ($20/mo)** | `gpt-5.4` | `medium` | Half the per-token burn of 5.5 (API list: $2.50/$15 vs $5/$30 per M tokens) — 5.5 exhausts a Plus plan's weekly limits fast. |
| any | `gpt-5.6-sol` | — | **Don't.** Frontier interactive model, heaviest burn — fine in your own terminal, never as a fleet default. |

Two footguns, both enforced by `tests/unit/codex-default-floor.spec.ts`:

- **`gpt-5.3-codex` is the API-key model name.** A ChatGPT-account login 400s on it — it must not
  reappear as a default anywhere.
- **Reasoning effort is pinned per spawn.** The per-task codex home copies the *host*
  `~/.codex/config.toml`, and a host-side `model_reasoning_effort` tuned for sol (`ultra`) is
  rejected with a 400 by gpt-5.5/gpt-5.4. Both codex wrappers therefore pass
  `-c model_reasoning_effort=$CODEX_REASONING_EFFORT` (default `high`) on every spawn.

## The rule: a provider is not a harness

OSHAL separates **who serves the tokens** (provider) from **what process makes the call**
(harness). See [ADR-033](../adr/033-multi-harness-execution-framework.md) and
[ADR-005](../adr/005-cline-cli-only-provider.md).

| harness | what it is | providers it can serve |
|---|---|---|
| `cline` | the generic Cline CLI wrapper | **every API-key provider in the catalog** |
| `codex-cli` | spawns the `codex` binary | OpenAI/Codex only |
| `claude-code` | spawns the `claude` binary | Anthropic only — the factory *throws* on any other `apiType` |
| `gemini-cli` | spawns the `gemini` binary | Google only |
| `a2a` | JSON-RPC to an external agent | n/a — the remote owns its reasoning |
| `noop` | test stub | none |

Grok is not a harness. There is no Grok CLI adapter and none is needed: **Grok reaches bots through
the `cline` harness**, exactly the way Ollama does.

The swarm controller itself never calls an LLM ([two runtimes](../../CLAUDE.md)), so "the core"
needs no key at all. Everything below is about the bot nodes.

## The env block

```bash
# .env — never commit a real key; .env is gitignored and the publish gate is fail-closed
XAI_API_KEY=xai-...
FORCE_LLM_PROVIDER=xai
FORCE_LLM_MODEL=grok-4
```

What each one does, and where:

1. `FORCE_LLM_PROVIDER` is a **hard override** — it bypasses `global-config.json` entirely
   ([provider-runtime.ts:446-452](../../src/app/composition/provider-runtime.ts#L446-L452)).
2. `xai` matches no harness factory, so provider resolution falls through to the Cline CLI path
   carrying `configuredProvider: 'xai'`
   ([provider-runtime.ts:652-668](../../src/app/composition/provider-runtime.ts#L652-L668)).
3. `ClineRuntimeConfigSyncService` writes Cline's runtime config from those env vars plus a
   credential bag that already collects `XAI_API_KEY`
   ([cline-runtime-config-sync-service.ts:88-94](../../src/features/llm-provider/services/cline-runtime-config-sync-service.ts#L88-L94),
   [:385](../../src/features/llm-provider/services/cline-runtime-config-sync-service.ts#L385)).
4. The config builder emits `provider: 'xai'` + `xaiApiKey` for both plan and act mode
   ([cline-config-builder.ts:143-149](../../src/features/llm-provider/services/cline-config-builder.ts#L143-L149),
   [:414-419](../../src/features/llm-provider/services/cline-config-builder.ts#L414-L419)).
5. The Cline CLI is already in the image — no install step
   ([Dockerfile.oshal:132](../../Dockerfile.oshal#L132)).

No code change, no rebuild. Swap the three values for any row in the next table.

## Provider → credentials

The authority is the `switch` in
[cline-config-builder.ts](../../src/features/llm-provider/services/cline-config-builder.ts) —
if a provider is not a case there, it falls to a generic passthrough and is unverified.

| `FORCE_LLM_PROVIDER` | env vars it reads |
|---|---|
| `xai` | `XAI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `sambanova` | `SAMBANOVA_API_KEY` |
| `nebius` | `NEBIUS_API_KEY` |
| `asksage` | `ASKSAGE_API_KEY` |
| `requesty` | `REQUESTY_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `openai` / `openai-native` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `vertex` | `VERTEX_PROJECT_ID`, `VERTEX_REGION` |
| `azure` | `AZURE_API_KEY`, `AZURE_ENDPOINT`, `AZURE_DEPLOYMENT_ID`, `AZURE_API_VERSION` |
| `bedrock` | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `ollama` | `OLLAMA_HOST` (no key) |
| `lmstudio` | `LMSTUDIO_HOST` (no key) |
| `litellm` | `LITELLM_BASE_URL` (no key) |

Model ids live in
[provider-definitions.ts](../../src/features/llm-provider/services/provider-definitions.ts) and
[provider-catalog.ts](../../src/features/llm-provider/services/provider-catalog.ts) — the catalog
carries the fuller per-vendor list (for xAI: the Grok 4, Grok 4.1 Fast, Grok 3 and Grok Code
families).

## The catch: a harness-pinned bot ignores all of the above

[`resolveHarnessForAgent`](../../src/app/composition/provider-runtime.ts#L954) returns a harness the
moment a registry entry declares `harnessType`, and it **never reads `FORCE_LLM_PROVIDER`**. The
precedence rule is stated once, in
[bot-provider-precedence.ts:84-89](../../src/shared/llm-runtime/bot-provider-precedence.ts#L84-L89):

1. a registry `harnessType` other than `cline` — wins outright;
2. the per-agent DB provider;
3. the registry `apiType`;
4. the deployment default (`FORCE_LLM_PROVIDER`, then `global-config.json`).

Count what your tree actually pins before assuming the env will take:

```bash
grep -oE "harnessType: *'[a-z0-9-]+'" src/app/extensions/swarm/swarm-bot-registry-local.ts \
  | sort | uniq -c | sort -rn
```

As of this writing the local registry pins `claude-code` or `codex-cli` on all but two of its
entries and pins `cline` on none — so a Grok key alone would leave nearly every bot spawning
`claude` or `codex` and failing auth. `swarm-bot-registry.ts` has two `cline` bots.

To move a bot onto the profile, edit its registry entry in **both**
[swarm-bot-registry.ts](../../src/app/extensions/swarm/swarm-bot-registry.ts) and
[swarm-bot-registry-local.ts](../../src/app/extensions/swarm/swarm-bot-registry-local.ts):

```ts
{ agentId: '...', name: 'my-bot', harnessType: 'cline', apiType: 'xai', /* ... */ }
```

`apiType` is what the Cline harness writes as its configured provider
([provider-runtime.ts:516](../../src/app/composition/provider-runtime.ts#L516)), so it overrides
`FORCE_LLM_PROVIDER` per bot — which is also how you run a mixed fleet (some bots on Grok, some on
Claude) rather than an all-or-nothing switch.

## Gotchas that will cost you an hour

- **A container created before the env var existed does not have it.** Compose declares the var on
  the shared bot env, but a pre-existing container keeps its old environment — verified for
  `OLLAMA_HOST` in [local-llm-profile.md](./local-llm-profile.md). Recreate the ones that matter:
  `docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api`.
- **Per-service compose overrides beat the shared default.** Many bot services set
  `FORCE_LLM_PROVIDER: openai-codex` inline in
  [docker-compose.oshal-local.yml](../../docker-compose.oshal-local.yml); the shared block's value
  never reaches them.
- **`FORCE_LLM_MODEL` applies to Cline-routed providers only.** A `codex-cli` or `claude-code` bot
  takes its model from `CODEX_MODEL` / `CLAUDE_CODE_MODEL` instead
  ([provider-runtime.ts:95-106](../../src/app/composition/provider-runtime.ts#L95-L106)).
- **The `claude-code` harness cannot be repointed.** Its factory throws when `apiType` is anything
  other than `claude-code` — by design; use `harnessType: 'cline'` to route elsewhere.
- **Keys go in `.env` and nowhere else.** This repo is public-track with a fail-closed pre-push
  gate; a key in a doc, a fixture, or a compose file is an incident, not a lint error.

## Verify it actually took

```bash
# 1. the env reached the container (prints a prefix only — never echo a whole key)
docker exec oshal-local-api sh -c 'echo "${XAI_API_KEY}" | cut -c1-6'

# 2. the harness that got built for a bot
docker logs oshal-local-api 2>&1 | grep -E "HARNESS_FACTORIES|resolveHarnessForAgent"
#    expect: "creating Cline CLI harness" — NOT "using per-bot harness override" with claude-code
```

3. The only proof that counts: run a real ticket, then read the attributed model out of Postgres —
   `chat_tasks` holds the per-call cost and model, and is the canonical source over any log
   estimate. A ticket that completes with a `grok-*` model attributed is the end-to-end proof this
   runbook is still missing.

## Related

- [local-llm-profile.md](./local-llm-profile.md) — the same pattern for Ollama, with a live-verified
  bring-up
- [layer0-provider-framework.md](../architecture/layer0-provider-framework.md) — the provider
  registry, per-user encrypted key storage, and the `/api/config/*` endpoints behind the cockpit's
  provider settings
- [building-a-bot.md](../building-a-bot.md) — the two sanctioned bot shapes, and why BYOK on the
  swarm default login is the norm
- [ADR-033](../adr/033-multi-harness-execution-framework.md) — why harness and provider are
  separate layers
