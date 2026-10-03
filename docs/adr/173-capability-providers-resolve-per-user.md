# ADR-173: Capability providers resolve per user — text to speech, speech to text, image and video

Date: 2026-10-03
Status: **Accepted — 2026-10-03, operator decision.** The operator approved D1 to D12 as written ("Approve all 12 as written"). Nothing in the Decision is built yet; slices S1 to S5 are the build.

The Context records core `main` `3f06817f` (docs-only commits since) and store `main` `25c87a29`, with read-only observations of the operator's box on 2026-10-03. Paths marked `store:` are in the `oshal-applications` repository.

Related: [ADR-034](034-bidirectional-config-ownership-sync.md) (config ownership tiers),
[ADR-036](036-bot-owned-application-architecture.md) (the bot owns the domain; cost capture),
[ADR-070](070-multi-provider-video-generation.md) (free-first video, per-user GCP billing),
[ADR-082](082-video-series-pipeline.md) (the image vendor behind an interface),
[ADR-127](127-demo-mode-cli-brain-and-user-provider-preference.md) (a preference is not an authorization),
[ADR-130](130-codex-cli-storyboard-image-provider.md) (the render bot's harness picks the image rail; "Not built (phase 2)"),
[ADR-148](148-swarm-root.md) (the operator gate),
[ADR-162](162-a-bots-brain-is-layered-records.md) (the layered records this ADR extends to media).

## Context

### The request

On 2026-10-03 a free-tier Google key was proposed for removal. It turned out to back the default speech-to-text,
the Gemini voice wherever an application names it, the operator's LLM lane and Career Hunter's Google search.
Removing it would have broken each of them. Providers are being chosen by which key exists and by environment
selectors, not by configuration.

The operator's direction, verbatim:

> "we again have hard coded a api provider... so like isn't that configurable why is it all or nothing. we really
> need to just set the text to speech provider on a user by user basis.. and they can select any provider
> available including portal default.. same with image provider and video provider... and that's their
> default... by default we use the swarm defaults where available.... don't just blast it in... this is a core
> change... but the right thing to do is the user configures their default tts provider and default image and
> default video so if the application's preferred model isn't available or the bot's configured model isn't
> available there is the user fall back.. and of course bots can be configured per user to have specific api llms
> as well... that's always been the case.. it just got a little muddy were we have to generalize this isn't just
> for me and what i want its for anyone... so this stuff has to be configured."

Two facts matter for what follows. The default voice does not run on the free key: it runs on the swarm's Google
service account. And a user's own per-bot LLM setting, which the message treats as long-standing, has not existed;
ADR-162 names it a follow-up.

### What exists today

Each fact below is cited to the file and line at the commits above.

| | Text to speech | Speech to text | Image | Video |
|---|---|---|---|---|
| Providers in code | `browser`, `gemini-tts`, `google-cloud-tts`, `openai-tts` | `browser`, `gemini-stt`, `google-cloud-stt`, `local-stt` | `codex` (OpenAI images), `comfyui`, `vertex`, `openrouter`, `codex-cli`, `antigravity-cli`; outside the resolver, an Imagen client with no caller and the any-bot `vertexAITools` `generate-image` tool on the service account, registered only when `AGENT_MCP_TOOLS` is set (unset in every container on the box) | Veo; Google Vids on the series owner's own node; ComfyUI, deck-to-video and Veo providers in a loop nothing calls; the any-bot `generate-video` tool, registered the same way |
| What picks one | the request, then the caller's saved choice, then the swarm default in a file | the swarm default in a file | `STORYBOARD_IMAGE_PROVIDER`, else `codex` outside demo mode, else (in demo mode) the render bot's harness | nothing: each surface hard-wires its provider |
| Moving the swarm default | edit `config-seed/global-config.json`, restart the api | same | set `STORYBOARD_IMAGE_PROVIDER` and recreate the api to name an image API; in demo mode, a provider-switch write that changes the render bot's provider (its own row, else the fleet default) moves the rail (`antigravity-cli`, `codex-cli`, or a refusal) with no restart, and moves that bot's text brain with it | not possible |
| Per user | provider and voice (`voice_user_prefs`) | none in core | none | none |
| Per bot | none | none | only through the render bot's text harness | none |
| Per application | a manifest `voice:` block that nothing reads | same | none | none |
| Spend recorded | no | no | OpenRouter only, by four store packages | Veo, by Video Studio |
| Provider unavailable | the call returns a `fallback` and the client speaks with the browser | the service tries the other server providers in registration order | the call throws and refuses to fall back to a paid provider | the call throws |

#### Text to speech

- **Credentials.**
  - `gemini-tts` reads the Google API key from the environment (`google-cloud-auth.ts:306-309`,
    `gemini-tts-provider.ts:87-113`).
  - `google-cloud-tts` gets its token from `getGoogleAccessToken` (`google-cloud-tts-provider.ts:77`): a workspace
    OAuth profile, else the service account named by `GOOGLE_APPLICATION_CREDENTIALS` (`google-cloud-auth.ts:191-208`).
    It has no API-key branch, and the file's own comment says the Cloud speech APIs reject API keys
    (`google-cloud-auth.ts:210-216`). On the operator's box the OAuth profile is absent, the service-account file is
    present, and the provider list reports `google-cloud-tts` configured. The default voice is therefore billed to
    the service account's project, not served from the free key.
  - `openai-tts` reads `OPENAI_API_KEY` from the environment (`openai-tts-provider.ts:110-119`) and is registered only
    because `config-seed/global-config.json:18-25` declares it. It is not configured on the box.
  - No TTS provider accepts a per-user connector or a bring-your-own credential. A store tool reaches for an AWS Polly
    module that exists in neither repository (`store: little-monsters/tools/studyContentTool.js:48-53`), so that path is
    always unavailable.
- **Selection** (`POST /api/voice/synthesize`), first match wins:
  1. a `providerId` in the request body; an unknown id logs a warning and falls to the default
     (`voice-service.ts:193-201`);
  2. the caller's saved choice (`voice-controller.ts:72-83`, resolver at `voice-routes.ts:68-79`);
  3. `voice.tts.default` in `config-seed/global-config.json:9`, merged over the code default
     (`voice-config-loader.ts:23-40`, `:84-101`);
  4. the browser, when the default id is not registered (`tts-provider-registry.ts:129-133`).
  The registry is a singleton that reads its config once (`tts-provider-registry.ts:39-41`, `:145-150`), so a new
  swarm default needs a restart. Server-side renders use `tts.serverSide` (`global-config.json:10`).
- **Per user.** `voice_user_prefs(user_sub, tts_provider, tts_voice)` with forced row-level security
  (`voice-prefs-store.ts:43-94`, `scripts/migrations/112-owner-column-rls.sql:104`), written by `POST /api/voice/prefs`
  (`voice-routes.ts:121-151`; 404 for an unregistered provider, 400 for an unconfigured one) and shown in the Jarvis
  "Spoken voice" panel (`src/api/jarvis-ambient-ui.js:129-215`). Beyond sign-in the route has no permission check
  (`server-auxiliary-routes.ts:277`), so any signed-in user can pick a provider that runs on a swarm credential. The
  table was empty on the box. Little Monsters keeps its voice in the browser's `localStorage`
  (`store: little-monsters/tools/voice-settings.html:122-124`).
- **Per application.** The `dnd`, `game-show`, `little-monsters`, `lora` and `video` manifests declare a `voice:`
  block (for example `store: little-monsters/oshal-app.yaml:396-398` names `gemini-tts`). Nothing in either repository
  reads it: the registry's `resolveForApp(appConfig)` is only ever called with no app config
  (`video-render-service.ts:59`, `voice-service.ts:194-195`). [ADR-075](075-little-monsters-onboarding-and-enhancements.md)
  assumes the manifest "already sets `tts: gemini-tts`"; it has no effect. Little Monsters' read-aloud posts
  `{text, voice}` with no provider (`store: little-monsters/tools/lm-voice.js:85-88`), so it gets the caller's saved
  choice, else the box default.
- **Callers that bypass the user's choice.** Inside the server, with no identity and ignoring saved choices: video
  narration (`video-render-service.ts:59`) and deck narration (`deck-to-video-provider.ts:92`). Store code with hard-coded
  chains:
  D&D tries `google-cloud-tts`, `openai-tts`, `gemini-tts` in turn and moves on for unconfigured providers and for
  throttles, 5xx responses and timeouts (`store: dnd/lib/dnd-media-service.js:33-37`, `:108-126`, `:155-167`); Game Show
  uses the first configured of `gemini-tts`, `google-cloud-tts` (`store: game-show/routes/game-show-routes.js:86`,
  `store: game-show/lib/media-service.js:30-43`).
- **Voice ids belong to a provider.** The controller applies a saved voice only beside its saved provider because
  "voice ids are provider-specific" (`voice-controller.ts:72-74`). Little Monsters offers Gemini voice names
  (`store: little-monsters/tools/voice-settings.html:63-70`); D&D allows only OpenAI-style names
  (`store: dnd/lib/dnd-media-service.js:29-32`).
- **When the provider is unavailable.** The route returns `fallback: 'unconfigured'` or `'failed'` and tries no other
  server provider (`voice-service.ts:226-255`); clients then speak with the browser
  (`store: little-monsters/tools/lm-voice.js:93-105`).
  Video narration leaves the scene silent (`video-render-service.ts:70-73`).
- **Spend.** No TTS or STT cost is recorded in the voice code or in any core caller of it.

#### Speech to text

- **Credentials.** `gemini-stt` (the default) reads the Google API key from the environment
  (`gemini-stt-provider.ts:47-74`). `google-cloud-stt` uses the service account only, plus a project and a location
  (`google-cloud-stt-provider.ts:45-73`, `:212-240`). `local-stt` is the on-host sidecar, free, configured by
  `SPEAKER_DIARIZATION_URL` and `SPEAKER_SERVICE_KEY` (`local-stt-provider.ts:62-70`). Its status means the URL and
  key are known, not that the sidecar transcribes (`local-stt-provider.ts:72-88`). Compose builds the sidecar from
  source (`docker-compose.oshal-local.yml:883-886`); the published image has no `/v1/transcribe` (BACKLOG, "The
  published speaker-diarization image predates its source and has no `/v1/transcribe`").
- **Selection.** An explicit `providerId` from server code, else `voice.stt.default` (`global-config.json:34`,
  `gemini-stt`), else the browser. `POST /api/voice/transcribe` passes neither a provider nor an identity
  (`voice-controller.ts:45-56`), and guests may call it (`guest-capability-matrix.ts:111-120`).
- **Failover.** When the default-resolved provider fails or is unconfigured, the service tries the other server
  providers in registration order (`voice-service.ts:117-129`). That order follows the default config:
  `gemini-stt`, `google-cloud-stt`, `local-stt` (`voice-config-loader.ts:41-61`). The paid Cloud provider is tried
  before the free on-host one. The failover was built after Gemini's free tier hit its quota and every dictation
  failed (guard `tests/unit/voice-stt-failover.spec.ts`).
- **Per user and per bot.** None in core. Calling Assistant keeps its own per-person `sttProvider`
  (`store: calling-assistant/oshal-app.yaml:54`, candidate list `store: calling-assistant/routes/routes.js:42`, passed at
  `store: calling-assistant/routes/service.js:122`).
- **Pinned.** `ambient-speaker-routes.ts:450-452` names `google-cloud-stt` for word timestamps, and an explicit
  provider gets no failover. Little Monsters' lecture transcription calls `resolveForApp()` with no config
  (`store: little-monsters/routes/education-voice-routes.js:117`).

#### Image

- **Providers.** `codex` (OpenAI `gpt-image-1` on the swarm's platform key, paid, none held on the box), `comfyui` (free,
  not set up), `vertex` (paid, needs a cloud-platform token the caller hands in), `openrouter` (paid, key set, not
  selected), `codex-cli` and `antigravity-cli` (free, subscription-included, on the render bot) (`storyboard-image-providers.ts`,
  `storyboard-antigravity-image-provider.ts:192`). The interface already carries `costClass`, `available()` ("cheap: no
  generation") and an optional `healthCheck()` because "key-presence lies" (`storyboard-image-providers.ts:76-99`).
  Outside the resolver there are two more: an Imagen client that nothing calls (`image-client.ts:47`), and the any-bot
  `vertexAITools` `generate-image` tool, which mints a service-account token (`vertexAITools.js:31-42`) with no
  `VEO_ALLOW_SWARM_BILLING` check and is registered only when `AGENT_MCP_TOOLS` is set (`startup-swarm-runtime.js:656`). A
  provisioned bot gets that variable from its manifest's `mcp_tools` (`ProvisioningManager.js:572`); no compose service
  sets it, and it was unset in every container on the box.
- **Selection** (`storyboard-image-default.ts:115-121`): `STORYBOARD_IMAGE_PROVIDER` if set; else `codex` outside demo
  mode; else the render bot's own harness picks the rail (ADR-130). The render bot is `STORYBOARD_CLI_IMAGE_BOT_ID`,
  default general-bot (`storyboard-cli-image-wiring.ts:55`, `:185`). The command-line rails need `DEMO_MODE` and an
  operator caller, and `isDeploymentOperatorSub(undefined)` is false (`deployment-mode.ts:42-44`). On the box the rail
  is `antigravity-cli`.
- **Settings.** None per user or per application, and per bot only indirectly, through the render bot's own text harness
  (above). ADR-130 "Not built (phase 2)" is a per-bot image setting and image APIs selectable per bot; the BACKLOG entry
  "Images phase 2: a per-bot image setting, and image APIs as bot-level choices (ADR-130)" is open.
- **Callers that drop the user.** Switchboard and D&D call the resolver with no `userSub`
  (`store: switchboard/routes/switchboard-compose-routes.js:193`, `store: dnd/lib/dnd-media-service.js:245`). With the
  render bot on a command-line rail, both are refused as "not configured" for everyone, the operator included. These pass
  it: the core series pipeline (`series-pipeline.ts:392`, `storyboard-frames.ts:337`), Portrait Studio
  (`store: portrait-studio/routes/portrait-studio-routes.js:111`) and Create's region edit
  (`store: create/routes/create-region-edit-routes.js:182`).
- **Who pays for `vertex`.** The token comes from the caller's `google` connector (`series-orchestrator.ts:86-91`) or
  `gcp` connector (`store: video/routes/video-routes.js:497-511`), or from the swarm service account only when
  `VEO_ALLOW_SWARM_BILLING` is `true`. With the flag set, the series conductor uses it in place of the owner's `google`
  token (`series-orchestrator.ts:90`); Video Studio's storyboard route uses it only when the caller has no `gcp` token
  (`store: video/routes/video-routes.js:499-503`). The `gcp` connector's default scope is read-only
  (`connector-provider-registry.ts:121`) and both `gcp` connections on the box hold it. Two places assume `codex` when the
  selector is unset (`series-orchestrator.ts:89`, `store: video/routes/video-routes.js:498`).
- **When unavailable.** The resolver throws "Refusing to fall back to a paid provider you did not ask for"
  (`storyboard-image-providers.ts:754`, `:782`). Spend is recorded by `recordStoryboardImageCost`
  (`storyboard-image-cost.ts:51`) into `chat_tasks` and `oshal_cost_events` only when a provider reports a vendor cost,
  which only `openrouter` does, and only by Portrait Studio, Create, Switchboard and D&D. The paid `codex` and `vertex`
  providers report no cost, the command-line rails report `costUsd: null`, and the core series storyboard stage records
  nothing (`storyboard-frames.ts:304`).
- **Variables compose does not pass.** `docker-compose.oshal-local.yml` passes `STORYBOARD_IMAGE_PROVIDER` (line 336) but
  does not list `COMFYUI_URL` or `VEO_ALLOW_SWARM_BILLING`, so setting them in `.env` has no effect.

#### Video

- Veo takes the caller's token when one is passed and the swarm service account only when `VEO_ALLOW_SWARM_BILLING` is
  `true` (`veo-client.ts:57-69`), as ADR-070's second hard rule requires. Video Studio's `POST /generate` renders
  through `generateClip`, which passes no caller token (`store: video/routes/video-routes.js:266-290`,
  `video-render-service.ts:157`, `veo-client.ts:172-174`). With the flag unset (compose does not pass it), generation throws
  before any vendor call. Video Studio does record Veo cost (`store: video/routes/video-routes.js:205-212`).
- The Video Series render stage runs Google Vids on the series owner's own node (`series-dispatch.ts:157-166`): per user
  by construction, with no choice.
- ADR-070's free-first loop (`runFreeFirstLoop`, `generation-loop.ts:69`) and its ComfyUI, deck-to-video and Veo
  providers have no runtime caller in either repository.
- There is no selector. Each surface hard-wires its provider.

#### The LLM records this ADR copies

- `oshal_user_llm_prefs` holds a user's general preference. The ids are `LLM_PREFERENCE_IDS`
  (`user-brain-resolution.ts:54`); a missing or unknown value means `auto` (`:355-370`).
- `oshal_bot_provider_switch` holds the reserved `fleet-default` row and per-bot rows, plus an administrator-written
  `fallback_order` (migrations `147` and `148`, `provider-switch-store.ts:48-135`). Every identity reads it; the table's
  own policy lets only an operator write. A write refreshes the snapshot, so no restart is needed
  (`provider-switch-routes.ts:154-160`); the routes admit operator browser sessions and refuse a service secret
  (`provider-switch-routes.ts:206-216`, `:229-231`).
- Per-user credentials live in `oshal_connections`, encrypted under each user's own data key
  (`connector-token-crypto.ts:2-12`); a bring-your-own LLM is provider `any-llm` (`byo-llm-routes.ts:1-21`). The swarm's
  own keys have a config-aware reader, `getSwarmApiKey` (`swarm-credentials.ts:215`), but only the image providers and
  vision-describe call it (`storyboard-image-providers.ts:599`, `:631`; `vision-describe-service.ts:118`). The LLM ladder's
  swarm-key rungs read the environment directly, as the speech providers do: the operator lane through `laneKeyFromEnv`
  (`openai-compat-lanes.ts:68-74`, `free-tier-rotation.ts:813`) and the platform OpenRouter lane
  (`free-tier-rotation.ts:482`).
- A user's turn resolves in `resolveUserBrain` (`user-brain-resolution.ts:453-467`): the named choice if usable, then the
  demo command-line default for the operator (`DEMO_CLI_ORDER`, `:65`, `:460`), then the hosted ladder
  (`free-tier-rotation.ts:855-876`).
- What is offered is what resolves. `cliBrainOffer` (`user-brain-resolution.ts:123-166`) is asked by the options list
  (`llm-preference-routes.ts:108-162`) and by the resolver, and `PUT /api/settings/llm-default` answers 409 with the
  missing piece for an unavailable option (`llm-preference-routes.ts:211-242`).
- A bot resolves to its own row, then the fleet row for a bot the registry runs on an LLM harness, then the registry; an
  unknown id fails closed (`bot-provider-switch.ts:312-338`, `:179`).
- A user's choice meets a bot's row in `stampRemoteBrain` (`inline-bot-execution.ts:270-362`): an explicit
  `byoLlmConnection` or `providerId` wins; with no user, the administrator's rows apply; otherwise the user's choice is
  stamped on the dispatch as a command-line harness, `bot-default` (the bot's own record) or a hosted connection. Protected
  application dispatch and Jarvis call the same resolver, `resolveUserBrain`, and apply its result themselves instead of
  through `stampRemoteBrain`: protected dispatch in `supportedProtectedRequest` (`extensions/swarm/index.ts:800-809`,
  `manifest-worker-application-execution.ts:100-170`), and Jarvis at `jarvis-orchestrator.ts:360-389`, whose `cli` or
  hosted result `stampRemoteBrain` then leaves unchanged (`inline-bot-execution.ts:276`).
- A user's per-bot LLM setting does not exist: ADR-162 §2 lists it as "follow-up — does not exist yet"
  (`162-a-bots-brain-is-layered-records.md:58`), and there is no table or route for it.

### What is wrong

- **G1. The swarm default is a file or an environment variable.** For images on a demo deployment with
  `STORYBOARD_IMAGE_PROVIDER` unset, it is instead a by-product of the render bot's LLM switch row (its own, else the
  fleet default). Changing the file or a variable means a restart or a container recreate, and some variables never reach
  the container. The switch-row write needs no restart, but it can only move images between `codex-cli` and
  `antigravity-cli` (any other harness is refused), and it moves that bot's text brain with them. Video has none. ADR-162
  §7 already requires one write with no restart for LLM.
- **G2. Only TTS has a user setting, and nothing else shares its table.** STT, image and video have none; Calling
  Assistant and Little Monsters each keep their own setting in their own place.
- **G3. The application's declared preference is ignored.** Five manifests declare a `voice:` block that nothing reads,
  and two apps hard-code ordered chains instead.
- **G4. Callers drop the user.** The call sites listed above never say whose call it is, so a user default cannot apply
  to them, and on the box two of them refuse for everyone.
- **G5. Who pays is accidental.** Any signed-in user can pick a provider that bills the swarm, and it is the default for
  every caller; STT falls from a free tier to a paid provider before the free on-host one; no speech spend is recorded;
  Veo is blocked by a flag compose does not pass.
- **G6. "Available" is not one question.** It is a key or file check for speech, a mix of configuration and real probes
  for images, an operator carve for command-line rails and a caller token for Vertex and Veo. Only LLM command-line
  brains share one function between the options list and the resolver.
- **G7. A user's per-bot LLM choice does not exist,** and a user's general preference sits above the administrator's
  per-bot rows (ADR-162 §2), the reverse of the order the operator described for those two.
- **G8. One free-tier key is load-bearing and invisible.** It backs the default STT, `gemini-tts` where named, the
  operator LLM lane (`openai-compat-lanes.ts:30-34`) and Career Hunter's Google search
  (`store: career-hunter/engine/jobhunter/config.py:176`).

## Decision

Four capabilities, text to speech (`tts`), speech to text (`stt`), `image` and `video`, resolve a provider through one
order, from records, and LLM is aligned to it (D11). The operator approved every item below as written on 2026-10-03.
Each carries its reason, and the alternative that was considered beside it.

Terms. A *rung* is one step of the order. A *principal* is the identity a call is made for. The *swarm default* is shown
to users as "Portal default". *Operator* and *administrator* name the same role here: the identity `requiresOperator`
admits, which is swarm root and admin roles plus the break-glass allowlist (ADR-148).

### Decisions at a glance

| | Question | Decided | Considered |
|---|---|---|---|
| D1 | Order | Application, bot, user default, swarm default, refuse | The user's own choices above the application's |
| D2 | Storage | Per-user, per-user-per-bot, swarm and offer tables | An image column on the switch rows plus a table per capability |
| D3 | "Available" | One function per capability, shared by list and resolver | Filter the picker only |
| D4 | Who pays | A cost class on each provider; users pick swarm-paid only by grant; record speech spend | Open picker; class is a label |
| D5 | Fallback | Only when unavailable; never to a different payer; never on a runtime failure | Also on a runtime failure, within the same class or to free |
| D6 | Swarm defaults | Rows: one operator write, no restart | Keep the file and the environment |
| D7 | "The bot" | The calling surface's accountable bot; the render bot for command-line image rails | A bot rung only for calls that run on a node |
| D8 | The caller | Every call carries the principal; a guard enforces it | Pass it only where a caller has it |
| D9 | TTS voice | Store provider and voice together | Store the provider alone |
| D10 | Application preference | A `capabilities:` manifest block; falls through, or fails closed with `required: true` | Ignore the old `voice:` blocks |
| D11 | LLM | Add the user's per-bot rung; general preference below administrator rows | Add the per-bot rung only |
| D12 | The free Google key | Optional credential; STT default to `local-stt` | Keep Gemini as the STT default |

### D1. One resolution order for all four capabilities — decided

**Decided.** The same five rungs, top to bottom, for every capability:

| Rung | Record | Governs |
|---|---|---|
| 1. Application | the manifest `capabilities:` block (D10) | calls made by that application |
| 2a. User, per bot | a per-user per-bot row (D2) | that user's calls through that bot |
| 2b. Administrator, per bot | a swarm row whose scope is the bot (D2) | everyone's calls through that bot |
| 3. User default | a per-user row; no row means "portal default", which skips the rung | that user's calls |
| 4. Swarm default | the swarm row whose scope is `fleet-default` | every call nothing above governs |
| 5. Refuse | none | a message naming what is missing |

A rung is used when it has a setting and that setting's provider is available to this caller (D3). Otherwise the next
rung is tried, subject to D5. Each resolution reports the rung that answered (`app`, `user-bot`, `bot-row`,
`user-default`, `swarm-default`), as ADR-162 does for a bot's provider (`162-a-bots-brain-is-layered-records.md:118-120`).

Example, an illustration of the rule and not observed behaviour: a signed-in user triggers narration in an application
whose manifest prefers `gemini-tts`. Rung 1 is skipped because the Google key is not set. Rung 2: the application's bot has
no row and the user has no per-bot choice. Rung 3: the user chose `openai-tts`, which is available and was granted (D4), so
it speaks with that and reports `user-default`. Both providers are `swarm-paid`, so D5 allows the skip.

**Why.** It is the order the operator described: the application's preference, then the bot's, then the user's own
default as the fallback, with the swarm default behind it. One order for four capabilities is one resolver, one
explanation ("which rung chose this?") and one place to test. Today the orders differ: TTS is request, then user, then
swarm default and ignores the application; STT is the swarm default alone; image is an environment variable, then `codex`
outside demo mode, else the render bot's harness; video has none.

**Considered.** Order by owner, as ADR-162 does for LLM: the user's own choices (per bot, then default) above the
application's preference and the administrator's row. A user could then always override an application, including its
voice, and an application could no longer guarantee a provider.

**Note.** ADR-162 puts a user's general LLM preference above the administrator's per-bot rows. D11 moves it below them,
so LLM follows this order of rungs; for LLM a user with no row is on `auto`, which walks the user's own ladder rather than
skipping to the portal default (D11).

### D2. Storage: four small tables that mirror the LLM records — decided

**Decided.** Table names are chosen in S1; the shapes are:

- **A per-user table** keyed `(user_sub, capability)`, holding `provider_id` and an `options` jsonb (voice, model).
  Forced row-level security, owner or operator, the policy of migrations `112-owner-column-rls.sql` and
  `122-user-llm-preference.sql`. It absorbs `voice_user_prefs`:
  existing rows are copied across and the old table is left in place.
- **A per-user per-bot table** keyed `(user_sub, agent_id, capability)`, same columns and policy. Its capability set
  includes `llm`, which is the missing per-user per-bot rung (D11).
- **One swarm table** keyed `(scope_id, capability)`, where `scope_id` is `fleet-default` or an agent id, mirroring
  `oshal_bot_provider_switch` (migration `147`): every identity may read it; the table's own policy lets only the operator
  identity, or server work running under the system identity, write it (`147-bot-provider-switch.sql:63-73`), so the
  database refuses a signed-in non-operator's write whatever the route does. `updated_by` records who. The voice
  block of `global-config.json` and the existing selectors become the seed: with no row for a `(scope, capability)`
  pair, the swarm default is the provider the file or the selector names today; D4 and D5 still apply.
- **A small provider-offer table** keyed `(capability, provider_id)`, holding who a provider is offered to (D4), its unit
  price for recording spend (D4) and an optional quota label; same read and write policy as the swarm table.

Rows hold provider ids and options, never a secret (ADR-162 §5). A write validates the provider id against that
capability's registry first, as the switch routes do; the database constraint only refuses shapes no validator would
produce. For LLM, a user's general preference stays in `oshal_user_llm_prefs` and the administrator rows stay in
`oshal_bot_provider_switch`; only the per-bot rung is new.

**Why.** LLM already works this way, so the pattern, the policies and the snapshot refresh are known and tested. One table
keyed by capability avoids four copies with four resolvers, and `options` lets TTS carry a voice and LLM carry a model
without a column per capability.

**Considered.** Extend what exists: add an image column to the switch rows (the smallest proposal in the "Images phase 2"
BACKLOG entry), keep `voice_user_prefs` for TTS, and add a table per capability. Smaller first step, but each capability
gets its own table, route and resolver, STT and video still have no home, and image and video get no user default.

### D3. "Available" is one function per capability, shared by the list and the resolver — decided

**Decided.** For each capability, one function answers "may this caller use this provider now?" and, when not, names
the missing piece. It follows `cliBrainOffer` (`user-brain-resolution.ts:123-166`) and is called by the options list and
the resolver, so an option cannot be offered that a call would not run on. It checks, cheapest first:

1. the provider is registered;
2. a credential this caller may use exists, read through the reader the call uses: the swarm's credential through
   `getSwarmApiKey`, or `getSwarmPlatformApiKey` for OpenAI's platform API (`swarm-credentials.ts:215`, `:268`), because
   `getSwarmApiKey('openai')` can return the ChatGPT subscription token, which the platform's image and model endpoints
   refuse, or the Google service-account token readers for the Cloud speech, `vertex` and Veo providers
   (`getGoogleAccessToken`, `getGoogleCloudPlatformAccessToken`, `getVertexAccessToken`); or the caller's own connector;
3. policy: the operator has not switched the provider off, a user-written choice satisfies D4's grant, and the
   command-line image rails keep their ADR-127 carve;
4. a cheap health probe where one exists, cached briefly with the interval a setting. Today that is the image providers'
   `healthCheck()`; the speech providers and Veo have a configuration check only.

The list shows unavailable providers, disabled, with the missing piece. Saving one answers 409 with that detail, as
`PUT /api/settings/llm-default` does (`llm-preference-routes.ts:211-242`); `POST /api/voice/prefs` answers 400 today.

**Why.** For command-line LLM brains the options list and the resolver drifted until a user could select an option and
have every later turn refused (`user-brain-resolution.ts:127-132`); one function fixed that. Media has the same split:
the speech providers' `getStatus` checks that a key or file exists, `local-stt` says its own status does not promise
transcription (`local-stt-provider.ts:72-78`), and the image providers record that "key-presence lies"
(`storyboard-image-providers.ts:93-99`).

**Considered.** Leave availability inside each provider and filter only the picker. Cheaper, and the picker and the
resolver can again disagree.

### D4. Who pays: every provider has a cost class — decided

**Decided.**

- Each provider declares one class: `free` (no one is billed: on-host, in the browser, or a subscription already paid, as
  ADR-130 classes the command-line image rails), `swarm-paid` (the swarm's vendor credential carries the call, including a
  vendor's free tier on that credential; the class says whose credential, because that credential's billing can change
  with no code change), or `user-paid` (the caller's own connector or bring-your-own credential).
- Whoever writes a choice decides who pays. Choices the operator writes (the swarm default, the administrator's per-bot
  row, the manifest of an installed application) may name a provider of any class. Choices a user writes
  (their default and their per-bot choices) may name a `swarm-paid` provider only when the operator has granted it;
  without the grant it is listed as unavailable ("not offered to you") and saving it answers 409. The grant is an
  operator-written offer row (D2) that offers the provider to the operator only (the default for `swarm-paid`), to every
  signed-in user, or to no one.
- A guest has no rows and no grant, so it resolves what the operator wrote. That is how guests are served now
  (`guest-capability-matrix.ts:118-120`).
- TTS and STT spend is recorded as image spend is: a cost event in `chat_tasks` and `oshal_cost_events` carrying the
  accountable bot and the caller (`recordStoryboardImageCost`, `storyboard-image-cost.ts:51`). The amount is the call's
  units (characters, audio seconds) times the unit price on the provider's offer row (D2), never a literal in code. A `free`
  call writes no spend event of its own. A shared free-tier quota is labelled as such in the list.
- The command-line image rails keep their ADR-127 carve, `DEMO_MODE` and an exact `OSHAL_OPERATOR_SUBS` subject, which is
  stricter than the operator role; this ADR widens none of who may run a command-line harness.

**Why.** Any signed-in user can pick `google-cloud-tts` today (`voice-routes.ts:121-151`), it runs on the swarm's service
account, it is the default for every caller, and nothing records the spend. ADR-162 §5 keeps credentials with their owner,
ADR-070's second hard rule bills paid video to the caller's own GCP, and ADR-127 makes a preference select only what the
user may already use. A class on each provider makes who pays visible in the list, enforceable by D3 and testable.

**What it changes.** A non-operator user can no longer choose a `swarm-paid` provider for themselves without a grant. They
still hear and speak through whatever the operator set as the swarm default, as they do today, so `google-cloud-tts` keeps
speaking to everyone while the operator keeps it as the default.

**Considered.** Keep the open picker: any signed-in user may pick any registered provider and the class is a label. Spend
is still recorded. Nothing changes for users; the operator relies on the vendor's own limits.

### D5. Fallback crosses a rung only when a provider is unavailable — decided

**Decided.**

- A rung that names a provider is skipped only when that provider is unavailable (D3). A provider that was available and
  then fails at call time fails the call clearly, under the retry rules its own rail already has; the resolver does not
  move to another provider.
- A skip never lands on a different payer: the next provider must be `free` or in the same cost class as the one it
  replaces. Otherwise the call is refused at rung 5, naming the missing piece.
- Browser speech stays a choice the client makes after a refusal (`store: little-monsters/tools/lm-voice.js:93-105`); the
  server does not substitute it silently.
- This applies to the four media capabilities. LLM failover stays as migration `148` defines it: an
  administrator-written `fallback_order` on the switch rows (the bot's row, else the fleet row, else the environment).

**Why.** Today's STT walks registration order, which tries the paid Cloud provider before the free on-host one
(`voice-service.ts:117-129`), so a free-tier quota wall silently becomes a paid call. D&D's chain also moves on throttles
and timeouts (`store: dnd/lib/dnd-media-service.js:108-126`). Images already fail closed. A call whose provider is known and
whose bill is attributable can be explained.

**What it costs.** The STT failover was built to keep dictation working when Gemini's free tier ran out. Under D5 that case
is handled by D12, which moves the default off the quota-limited tier, not by failover. A user who picks Gemini themselves
will see a failed transcription at the quota wall. `tests/unit/voice-stt-failover.spec.ts` asserts the old behaviour and is
rewritten in S1.

**Considered.** Also allow a failover on a runtime failure, but only to a `free` provider or one in the same cost class.
That keeps the Gemini-quota behaviour and D&D's chain and never lands on a different payer, at the price that a user can be
served by a provider they did not pick. A variant is the LLM pattern: an operator-written fallback order on the swarm row
(migration `148`), so a failover is something the operator wrote down.

### D6. Swarm defaults are rows — decided

**Decided.** The swarm default for each capability is a swarm row (D2) that the operator writes in one call from the
config-admin page, effective without a restart: the write refreshes the snapshot in the writing process and the rest read it
on the snapshot's interval, the `provider-switch` pattern (`provider-switch-routes.ts:154-160`). The route admits operator
browser sessions and refuses a service secret (as `provider-switch-routes.ts:206-216` does), and the table's own policy
refuses a write from any identity other than the operator or the system identity. The acceptance test is ADR-162 §7's:
moving the swarm's speech-to-text from one provider to another is one write, with no pull request, image deploy or restart.

**Why.** A TTS or STT default change is a bind-mounted file and an api restart (`tts-provider-registry.ts:39-41`), an image
default is an environment variable and a recreate, or on a demo deployment with the selector unset a by-product of the
render bot's LLM switch row, some of those variables never reach the container, and video has no default (G1).

**Considered.** Keep the file and the environment and add the user layers only. The operator still cannot move a default
from the cockpit, and the environment selectors (S5) cannot be retired.

### D7. "The bot" for controller-side media calls — decided

**Decided.** The bot rung uses the accountable bot of the calling application surface, the identity ADR-036 already
requires for cost: Switchboard's comms bot and D&D's DM bot already carry their spend this way
(`store: switchboard/routes/switchboard-compose-routes.js:200`, `store: dnd/lib/dnd-media-service.js:228`). For the
command-line image rails it is the render bot (`STORYBOARD_CLI_IMAGE_BOT_ID`); with no image row for it, its own harness
keeps picking the rail as ADR-130 phase 1 does. A call with no bot skips rung 2.

**Why.** Most TTS, STT and image calls run in the controller with no bot turn, so "the bot's setting" has no meaning until
one bot is named, and the call sites already name one for cost.

**Considered.** Define the bot rung only for calls that run on a bot node, which today is the command-line image rails. It
is smaller, but an administrator then cannot give an application's bot its own voice or image provider.

### D8. Every capability call carries the caller's principal — decided

**Decided.** The resolver takes the caller's principal (the user's subject), the application and the bot as required
inputs. Scheduled or swarm-owned work passes an explicit system principal and resolves the operator-written rungs only. The
callers that drop or ignore the user today are fixed in S1 (the core route `POST /api/voice/transcribe`
(`voice-controller.ts:45-56`), which S1's live proof routes through the resolver) and in S4 (the rest): video narration
(`video-render-service.ts:59`) and deck narration (`deck-to-video-provider.ts:92`), the D&D and Game Show voice chains,
Little Monsters' lecture transcription (`store: little-monsters/routes/education-voice-routes.js:117`), Switchboard and D&D
images, and Video Studio's Veo call (`veo-client.ts:172-174`). A guard spec fails when the resolver is called without a
principal.

**Why.** A user default can only apply to a call that says whose it is. On the box, the missing `userSub` already makes
Switchboard and D&D images refuse for everyone (G4).

**Considered.** Pass the principal only where a caller already has one and let the rest resolve operator-written rungs. No
store changes, but a user's default then applies on some surfaces and not on others.

### D9. TTS stores provider and voice together — decided

**Decided.** Every TTS choice (a user default, a per-bot choice, a swarm row, an application preference) is a
`(provider, voice)` pair, because a voice id belongs to its provider (`voice-controller.ts:72-74`). When resolution lands
on a different provider than the pair named, the voice is dropped and the landing provider's own default voice is used
(`defaultVoice` in its config). A voice id is never sent to a provider that did not list it.

**Why.** Little Monsters offers Gemini voice names and D&D allows only OpenAI-style names (Context). A bare voice id sent to
the wrong provider is a failed call or the wrong voice.

**Considered.** Store the provider alone and leave the voice a client setting, as Little Monsters does in `localStorage`
today. Smaller, but the voice does not follow the user across devices and an administrator cannot set it.

### D10. Applications declare a preference in a manifest block — decided

**Decided.** A top-level `capabilities:` block in an application manifest replaces the `voice:` block that nothing
reads. Per capability it lists one or more preferred `(provider, voice or model)` pairs in order. By default the preference
falls through to the next rung when none of its pairs is available; `required: true` fails the call closed instead. An
explicit provider named by server code (the speaker route's `google-cloud-stt`, Calling Assistant's `sttProvider`) is a
required preference, as today: its own failure surfaces and it is never switched. During migration the old `voice:` block
is read as a preference, with a log line per manifest. The shape, not yet built:

```yaml
capabilities:
  tts:
    prefer:
      - { provider: google-cloud-tts, voice: en-US-Chirp3-HD-Algenib }
      - { provider: openai-tts, voice: cedar }
    required: false
```

**Why.** The operator wants the application's preferred provider first, and the existing declarations are dead: ADR-075
assumed Little Monsters used `gemini-tts` and nothing did, while D&D and Game Show hard-code ordered chains in code.

**What it changes.** Reading the old `voice:` blocks as preferences changes behaviour for the packages that name a
provider. Little Monsters' read-aloud, today the caller's saved choice else the box default, would prefer `gemini-tts` while
the Google key exists; D&D and Game Show would prefer what their blocks name. The word `capabilities` already names a bot's
string list one level down (`swarm-apps/types.ts:243`); the manifest-level block is a different key.

**Considered.** Ignore the old `voice:` blocks and let each package re-declare under the new key, so nothing moves until a
package author acts; or name the block `providers:` to avoid the collision.

### D11. LLM: the user's per-bot choice is added, and the general preference sits below administrator rows — decided

**Decided.**

- Add the missing rung: a user's own per-bot LLM choice, stored in the per-user per-bot table (D2) and resolved ahead of the
  administrator's per-bot row. The operator expects this to exist ("bots can be configured per user to have specific api
  llms as well... that's always been the case"); it does not (Context).
- Move the user's general preference below the administrator's per-bot rows, so the LLM order matches D1.
- Existing general preferences stay in `oshal_user_llm_prefs` and keep their meaning, so no one's saved choice changes.
  `auto` stays "walk the user's ladder"; it is not "portal default". For the operator of a demo box it resolves the demo
  command-line default (`DEMO_CLI_ORDER`, `user-brain-resolution.ts:65`, `:460`) before any administrator row is read, so
  mapping `auto` to "portal default" would change an effective brain.
- The reorder changes an effective brain only where an administrator has written a per-bot row; the operator's box held the
  fleet-default row and no per-bot rows on 2026-10-03. Where one exists, S3 lists the affected users and bots first. A user
  who had named a general preference is pinned with an equal user per-bot row, so their effective brain does not change; a
  user on `auto` follows the administrator's row, which is the point of the order.
- A command-line harness named by an administrator row is available only inside the ADR-127 carve, as `cliBrainOffer`
  already decides (D3), so a caller outside the carve skips that rung to their hosted ladder exactly as today.
- LLM failover is unchanged (D5).

**Why.** The user-per-bot rung is what the operator described and what ADR-162 §2 names a follow-up. One order for LLM and
media is one thing to explain, and an administrator's per-bot row, which a user's named preference overrides today, would
then hold for that bot.

**Considered.** Keep ADR-162's order for LLM (the user's general preference above administrator per-bot rows) and add only
the per-bot rung. No effective brain changes anywhere; the cost is two orders to explain and to test.

### D12. The free Google key becomes an optional provider credential — decided

**Decided.** Within the four capabilities the key is the credential of two providers, `gemini-stt` and `gemini-tts`.
Removing it makes those two unavailable, shown with the missing piece (D3), and changes nothing else in the four. In S1,
after a live transcription through `local-stt` shows it works on this box, the operator writes the swarm STT row to
`local-stt` (free, on-host), so the key can be removed without breaking voice input. The shipped seed in
`config-seed/global-config.json` is not changed, because the published sidecar image lacks `/v1/transcribe` (Context) and a
fresh install may run it.

The key also backs two things outside this ADR: the operator LLM lane (`OSHAL_OPERATOR_LLM_PROVIDER`,
`openai-compat-lanes.ts:30-34`, the first follow-up ADR-162 names) and Career Hunter's Google search
(`store: career-hunter/engine/jobhunter/config.py:176`, which also needs a search-engine id). They keep reading it, so
removing the key stays unsafe for those two until each is moved by its own change.

**Why.** The key's reach is invisible today: the default STT, the Gemini voice where an application names it (Game Show's
first candidate, D&D's third), the lane and the search all rest on one free tier. After S5 nothing in the four
capabilities reads the key except those two providers.

**Considered.** Keep `gemini-stt` as the swarm STT default and apply D5 as written. No change to what users get, but a
quota wall surfaces as a failed transcription and the key stays load-bearing for voice input. Or move the default to
`google-cloud-stt`, which is paid, on the service account.

## Consequences

- **What users get.** A "My defaults" card beside "My default brain" (`src/api/utilities.html:141-160`) lists, for each
  capability, what is available to them and, for each unavailable provider, why. By default every user follows the swarm
  default ("portal default"), as the operator asked.
- **What changes for existing behaviour,** each named so none is a surprise:
  - STT stops failing over to any other provider on a runtime error (a provider that was available and then fails, fails
    the call), and D&D's chain stops moving on throttles and timeouts (D5).
  - The swarm STT default moves to `local-stt` by one operator write (D12).
  - The old `voice:` blocks become live preferences (D10); Little Monsters' read-aloud, D&D and Game Show are affected.
  - TTS and STT spend appears in the cost views (D4).
  - A non-operator user can choose a swarm-paid provider only when the operator has granted it; without the grant it is
    listed as unavailable ("not offered to you") and saving it answers 409 (D4).
  - Switchboard and D&D images work for the operator on the command-line rails once they pass the user (D8).
  - For LLM, the user's general preference moves below an administrator's per-bot row (D11, S3): where an operator has
    written a per-bot row, users on `auto` follow it and users with a named preference are pinned by an equal user
    per-bot row; the operator's box held no per-bot rows on 2026-10-03.
- **What does not change.** The ADR-127 carve for command-line harnesses, ADR-162's administrator rows and `fallback_order`,
  the rule that no row means today's behaviour (ADR-162 §4), and the rule that no credential is stored in these tables.
- **Cost of building.** Four tables with migrations and real-role security specs; a registry and an availability function
  for each capability, and one resolver shared by the four; a user card, a config-admin card and per-bot panels; one store
  pull request per package that calls a media capability (application code lives in the store, CLAUDE.md Rule 0c); a
  guard for each decision.
- **Scope.** This ADR builds nothing. It supersedes the scope of the BACKLOG entry "Images phase 2: a per-bot image
  setting, and image APIs as bot-level choices (ADR-130)", which stays and points here, and it carries the user per-bot
  preference that ADR-162 names as a follow-up. ADR-130 and ADR-162 each carry a dated one-line pointer to this ADR
  (2026-10-03); neither decision is rewritten. The slice that builds the image part updates ADR-130's "Not built (phase 2)"
  paragraph, and S3 amends ADR-162 §2 when it builds the per-bot rung and the reorder.
- **Docs.** Each slice updates its collateral (the voice docs, the ADR index status, the BACKLOG entry) in the same change.

## Alternatives considered

- **A table per capability, no shared resolver.** The BACKLOG's smallest image proposal plus today's `voice_user_prefs`
  (D2). Each capability repeats the table, the routes and the resolver, and the order can differ between them.
- **One preferences blob on the user's profile.** It gives up per-row security, the operator-only write policy on the swarm
  layer and per-row validation.
- **Per-user provider credentials for media.** A different feature (ADR-049, "bring your keys"): the rows here name
  providers, and a `user-paid` provider uses a connector the user already holds. A bring-your-own speech or image key can
  later be added as a `user-paid` provider without changing the order.

## Rollout (slices with done-when)

Each slice is accepted on its own, in this order; S2 and S3 may overlap once S1 is in. Every slice ships behaviour tests
with the change, registers a runnable scenario in the AI Test Lab (`test-lab-scenarios.ts` or a feature module) with
`regressionTests` references, and records "locally tested" and "live-proven" separately (CLAUDE.md, "Tests accompany new
functionality"). Database claims are proved against the real enforcing role and schema, not a mock (CLAUDE.md,
"Integration-boundary corollary").

- **S1. Registry, availability, cost classes, swarm rows and spend (core).** Provider declarations with a cost class and an
  availability function per capability (D3, D4); the swarm table and the offer table, seeded from `global-config.json`
  and the existing selectors (D2, D6); the operator route and config-admin card; unit prices and spend recording for TTS and
  STT (D4); the STT runtime failover rewritten (D5); the resolver with a required principal (D8) and D9's voice rule, wired
  to the core callers that exist today.
  - Done when (tested): a real-Postgres spec on the enforcing role shows every identity reads the swarm rows and a
    non-operator write is refused by the table; a spec over the real snapshot shows a swarm write changes the next
    resolution with no restart; for each capability a spec shows the options list and the resolver agree for every provider;
    `voice-stt-failover.spec.ts` is rewritten to D5 and a spec shows a failed `gemini-stt` reaches no other provider
    (neither `google-cloud-stt` nor `local-stt`) and returns its own failure; a spec shows that a TTS pair whose provider is
    unavailable lands on the next provider with that provider's `defaultVoice`, and no call sends a voice id the landing
    provider does not list; a TTS call and an STT call each write a cost event with the bot and caller; a guard fails when
    a core call site calls the resolver without a principal.
  - Done when (live): on the box a recorded clip transcribes through `local-stt` with the expected text; the operator then
    writes the swarm STT row to `local-stt` with no restart, and the next Jarvis dictation's result names `local-stt` while
    its log line names the rung `swarm-default`.
- **S2. User defaults.** The per-user table with `voice_user_prefs` copied across, routes mirroring
  `/api/settings/llm-default`, the "My defaults" card, the offer rows and the operator's grant control; the Spoken voice
  panel's `GET`/`POST /api/voice/prefs` read and write the per-user table through the same availability function (D3, D4).
  - Done when (tested): a real-Postgres spec shows a user reads and writes only their own rows; a swarm-paid provider is
    absent from a non-granted user's available list and saving it answers 409; `POST /api/voice/prefs` answers 409 for a
    swarm-paid provider without a grant, and a choice saved through it is the one the next call resolves; a browser test
    drives the card; a migration spec copies a `voice_user_prefs` row and leaves its source.
  - Done when (live): a non-operator test user picks a free provider and the next call reports `user-default`; without a
    grant a swarm-paid provider shows unavailable for that user; after the operator's grant it can be saved.
- **S3. The bot rung.** Administrator per-bot rows (operator route and per-bot panel), the per-user per-bot table with its
  routes and panel, D7's bot identity for controller-side calls, and for LLM the user per-bot rung and, per D11, the
  reorder with its pin migration.
  - Done when (tested): a spec over the real snapshot shows the administrator's per-bot row beats the user default for that
    bot and the user's per-bot choice beats the administrator's row; a spec through `stampRemoteBrain` shows a user's per-bot
    LLM choice stamped on the dispatch; a migration spec lists and pins each affected user and bot.
  - Done when (live): two users, one bot, two effective brains, shown from each dispatch record and `chat_tasks` row, and
    `/api/agents` reports the rung.
- **S4. Application preference and principals (core and store).** The `capabilities:` block in the manifest loader, with the
  old `voice:` blocks read as preferences and logged; every caller passes the principal, application and bot (D8): video and
  deck narration in core, and one store pull request each for Switchboard, D&D, Game Show, Video Studio's Veo call and
  Little Monsters; the hard-coded chains become declarations.
  - Done when (tested): loader specs for the block (valid, `required`, an unknown provider refused with its reason); a spec
    per caller shows it passes the principal; the principal guard now scans the store packages' call sites; `required: true`
    fails closed and the default falls through.
  - Done when (live): on the box, with the render bot on `antigravity-cli`, a Switchboard compose image and a D&D cutaway
    render for the operator, which both refuse today; D&D narration follows its manifest preference; a non-operator's
    Switchboard compose image and D&D cutaway use their own image default (neither manifest declares an image preference).
- **S5. Retire the selectors.** `STORYBOARD_IMAGE_PROVIDER` stops being read outside the seed loader, and the two `codex`
  assumptions (`series-orchestrator.ts:89`, `store: video/routes/video-routes.js:498`) are removed; the hard-coded store
  chains are gone; compose stops listing the selector; ADR-130's "Not built (phase 2)" paragraph and the BACKLOG entry
  "Images phase 2" are updated in the same change.
  - Done when (tested): a guard fails if any source reads a capability selector variable outside the seed loader.
  - Done when (live): with the Google key removed from the box for the proof and restored after it (the operator LLM lane
    and Career Hunter's search still read it, are down for that window and are not part of this proof), the picker shows
    `gemini-stt` and `gemini-tts` unavailable with the missing piece and voice input and output still work on the swarm
    defaults.

## References

- Code cited above: `src/features/voice/`, `src/features/voice-providers/`, `src/features/video-generation/services/`,
  `src/app/routes/` (`voice-routes.ts`, `user-brain-resolution.ts`, `llm-preference-routes.ts`, `inline-bot-execution.ts`),
  `src/shared/llm-runtime/bot-provider-switch.ts`, `src/app/extensions/swarm/routes/provider-switch-routes.ts`,
  `src/app/extensions/swarm/index.ts`, `src/app/series-orchestrator.ts`, `src/app/series-pipeline.ts`,
  `src/app/series-dispatch.ts`, `src/app/server-auxiliary-routes.ts`, `src/app/storyboard-cli-image-wiring.ts`,
  `src/features/swarm-apps/types.ts`, `src/features/llm-provider/services/swarm-credentials.ts`,
  `src/features/agent-management/services/provider-switch-store.ts`,
  `src/features/swarm-orchestration/services/manifest-worker-application-execution.ts`,
  `src/features/vision-describe/services/vision-describe-service.ts`, `src/shared/middleware/guest-capability-matrix.ts`,
  `src/shared/deployment-mode.ts`, `any-bot/server/services/tools/vertexAITools.js`,
  `any-bot/server/app-modules/startup-swarm-runtime.js`, `any-bot/server/services/ProvisioningManager.js`,
  `docker-compose.oshal-local.yml`, `config-seed/global-config.json`, `tests/unit/voice-stt-failover.spec.ts`, and the
  migrations `112-owner-column-rls.sql`, `122`, `147` and `148` in `scripts/migrations/`.
- Surfaces: `src/api/utilities.html` ("My default brain"), `src/api/jarvis-ambient-ui.js` ("Spoken voice"),
  `src/pages/config-admin/config-admin-fleet-default.js`.
- Store packages cited: `dnd`, `game-show`, `little-monsters`, `lora`, `calling-assistant`, `switchboard`, `video`,
  `portrait-studio`, `create` and `career-hunter`.
- BACKLOG: [Images phase 2](../BACKLOG.md) and the build entry "Capability providers per user (ADR-173) — build slices".
