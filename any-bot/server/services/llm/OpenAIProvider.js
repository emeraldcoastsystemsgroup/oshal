/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OpenAI-COMPATIBLE: constructor honors config.baseUrl (drives any chat-completions gateway — a user's BYO endpoint, LiteLLM, LM Studio, Ollama, Groq, …); added generateResponse() matching the BedrockProvider/Cline contract so TaskController can drive a BYO-LLM connection with no special-casing.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bound OpenRouter reasoning to a low, non-disclosed budget for interactive completions, normalized multipart text, and fail explicitly when a gateway returns reasoning tokens without a final answer.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | A turn spent attempting a tool call is no longer thrown away. generateResponse now reads tool_calls AND the legacy function_call field and surfaces both as tool_use blocks. Because it declares no tools, any call is one the model invented from the system prompt's "you have access to N tools", so a call carrying its own id completes the exchange once with a truthful no-tools-available result to obtain a direct answer; a gateway-filtered malformed attempt, which leaves no call id to answer, restates the constraint as a user turn instead. A call read out of the legacy function_call field was surfaced but did NOT complete that way - that field carries no id, and the continuation built for it was not a valid tool exchange, so it fell through to the empty-answer error; entry 5 is what makes that shape complete. Measured live on generativelanguage.googleapis.com 2026-09-22: gemini-2.5-flash and gemini-3.8-flash both return { role, tool_calls } with no content key, and 3.8-flash also returns finish_reason "function_call_filter: MALFORMED_FUNCTION_CALL" with message keys [extra_content, role]. The empty-answer error and warning now name provider, model, finish_reason and output tokens, report an ABSENT finish_reason as absent instead of defaulting the diagnostic to "stop" (that default is what made the genuinely empty turn read as a normal completion), and carry a content-free fingerprint of the response SHAPE in the message string, because the console transport prints only the message and drops metadata. Usage accumulates across both legs and honours an endpoint-reported total_tokens rather than assuming input + output.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The tool-call continuation now builds its replayed assistant turn FROM the normalized calls instead of passing the raw tool_calls array through, because the two do not line up: normalizeToolCalls synthesizes call_${index} for a call that arrived without an id and for the legacy function_call field (which has no tool_calls array at all), and drops a call with no function name. Replaying the raw array while answering the normalized ids produced an assistant turn and a tool turn that disagreed in three shapes - a legacy function_call, a tool_calls entry with no id, and several calls of which one was unnamed - and a chat-completions gateway rejects that pairing with a 400, which landed in the continuation's catch. The recovery entry 4 claims therefore never happened for those shapes, and the caller was billed for two legs to receive the same empty-answer error. A call with no function name is not replayed at all: there is no name to attribute a result to, so it cannot be answered, and a declared-but-unanswered call is the same 400. rawArguments, which is the text replayed verbatim, now also carries arguments a gateway sent already parsed - the wire format is a JSON string, and dropping a non-string to '' told the model it had called with no arguments when it had not.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | The direct conversational path now DECLARES the tools it was given and runs the exchange to a real answer. generateResponse read only model and max_tokens, so options.tools, options.enforceToolBoundary and options.authorizedScopes - all three passed by TaskController:418-422 and AgenticController:410-413 - arrived and were discarded: the system prompt promised N tools while the request declared none, which is the upstream cause entry 4 recovers from. Tools are now formatted through the same formatFunctions sendRequest already used, and a tool_calls response is executed through a caller-supplied executeTool channel and fed back until the model answers (MAX_DECLARED_TOOL_ROUNDS legs, then one final leg after a truthful budget-exhausted result). enforceToolBoundary and authorizedScopes became the enforcement ADR-122 and the SEC-05 dispatch-capability pair describe: nothing executes unless the caller asserted enforceToolBoundary, the name is in the exact declared set, the exact tool:<name> / control:attempt_completion scope is held, and an execution channel exists - every other call is refused and the refusal is told to the model rather than executed. Absence is never authority, matching normalizeAllowedTools/normalizeAuthorizedScopes. A request with no declared tools behaves exactly as before, including entry 4's unsolicited-call recovery.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Add the optional invariant-prompt cache seam. It keys only the system/tool preamble, strips no task history, sends provider handles through `extra_body.cached_content`, and falls back to the full prompt on expiry, unsupported endpoints or cache errors.
 */

/**
 * OpenAI Provider
 * Implements LLMService for OpenAI's GPT models
 */

const OpenAI = require('openai');
const LLMService = require('./LLMService');
const logger = require('../../utils/logger');
// The SAME scope primitives the controllers capture capabilities with. Re-deriving the rule here
// would let the two drift; importing it means the provider refuses exactly what
// `authorizeCapability` would refuse, one layer earlier.
const {
  hasOperationScope,
  normalizeAuthorizedScopes,
  requiredScope,
} = require('../../utils/dispatch-capabilities');
const { buildInvariantPromptCacheKey } = require('./invariant-prompt-cache');

/**
 * @description Concrete LLMService implementation that adapts OpenAI's
 * Chat Completions API to the harness's provider-agnostic interface, so the
 * rest of the system can request completions, stream tokens, and invoke tools
 * without knowing which vendor is behind them. Normalizes OpenAI's response
 * and function-calling shapes into the common content/usage/cost contract.
 */
class OpenAIProvider extends LLMService {
  /**
   * @description Initializes the provider with caller-supplied credentials and
   * generation settings, validating the config and constructing the OpenAI
   * client up front so per-request setup stays cheap. Falls back to sensible
   * defaults when model/limits are omitted.
   * @param {Object} config - Provider configuration.
   * @param {string} config.apiKey - OpenAI API key used to authenticate requests.
   * @param {string} [config.model] - Model id to target; defaults to 'gpt-4-turbo-preview'.
   * @param {number} [config.maxTokens] - Max completion tokens; defaults to 4096.
   * @param {number} [config.temperature] - Sampling temperature; defaults to 0.7.
   */
  constructor(config) {
    super('openai', config);
    
    this.validateConfig();
    
    // baseUrl makes this provider OpenAI-COMPATIBLE rather than OpenAI-only: any
    // gateway that speaks the chat-completions API (a user's Bring-Your-Own-LLM
    // endpoint, LiteLLM, LM Studio, Ollama, Together, Groq, …) is driven by passing
    // its base URL here. Omit it and the SDK defaults to api.openai.com.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.baseUrl = config.baseUrl || null;
    this.endpointLabel = safeEndpointLabel(this.baseUrl);

    this.model = config.model || 'gpt-4-turbo-preview';
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature !== undefined ? config.temperature : 0.7;
    // Optional because most OpenAI-compatible endpoints do not implement Gemini context caching.
    // A configured cache is a provider-owned handle factory; absent/failed factories leave the
    // ordinary full-send request untouched.
    this.invariantPromptCache = config.invariantPromptCache || null;
  }

  /**
   * @description Single-shot completion matching the BedrockProvider/ClineProvider
   * generateResponse() contract, so TaskController can drive an OpenAI-compatible
   * endpoint (incl. a per-user BYO-LLM connection) with no special-casing. Returns
   * the same { content, contentBlocks, stopReason, usage, cost, latency, model,
   * provider } shape the other providers return.
   * @param {Array<{role:string,content:string}>} messages - conversation turns
   * @param {Object} [options] - { systemPrompt, maxTokens, temperature, tools,
   *   enforceToolBoundary, authorizedScopes, executeTool }
   * @returns {Promise<Object>} the standard generateResponse result object
   */
  async generateResponse(messages, options = {}) {
    const startTime = Date.now();
    const formatted = (messages || [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    if (options.systemPrompt) formatted.unshift({ role: 'system', content: String(options.systemPrompt) });
    if (formatted.length === 0) throw new Error('No valid messages with content to send to the LLM endpoint');

    // The boundary is resolved ONCE, from the options this request arrived with, and is the only
    // thing consulted for the rest of the exchange. That is what keeps a multi-leg tool loop bound
    // to the capability set the caller captured at request start rather than to anything a later
    // leg could influence.
    const boundary = resolveDispatchToolBoundary(options);
    const cached = await this.resolveInvariantPromptCache(formatted, options, boundary);
    const request = this.buildChatRequest(cached.messages, {
      ...options,
      ...(cached.extraBody ? { extraBody: cached.extraBody } : {}),
    }, boundary);
    const exchange = await this.runDeclaredToolExchange(request, boundary);
    const completion = exchange.completion;

    const choice = completion.choices?.[0];
    let content = exchange.content;
    let stopReason = choice?.finish_reason || 'stop';
    // `stopReason` defaults to 'stop' to keep the result contract stable, but the DIAGNOSTIC must
    // never launder an absent field into a normal completion. Measured 2026-09-22: the intermittent
    // empty turn comes back as a choice with NO finish_reason and a message whose only key is
    // `role`; the default made the log read `finish_reason "stop"`, which is why the first reading
    // of this failure went looking for a model that had answered normally.
    const reportedFinishReason = choice?.finish_reason || '(absent)';
    const usage = exchange.usage;
    // A turn can come back carrying ONLY function/tool-call parts and no text at all. That is not
    // an empty turn — the answer is in `tool_calls` (or the legacy `function_call`), fields the
    // text extractor cannot see. Reading them is what stops a paid completion being dropped.
    const toolCalls = exchange.toolCalls;

    // A turn can still end on an unanswerable tool call: on a tool-less request the model invents
    // one from the prompt's prose, and on a declared-tool request the round budget can run out
    // mid-plan. BOTH shapes of the tool-less case were measured live on 2026-09-22 — either the
    // call comes back in `tool_calls`, or the gateway filters a malformed attempt and returns a
    // message with neither text nor tool calls (`finish_reason:
    // "function_call_filter: MALFORMED_FUNCTION_CALL"`, message keys `["extra_content","role"]`).
    // Either way the turn is billed and unreadable, so all of them recover the same way: state
    // plainly why no tool ran and ask for a direct answer.
    if (!content && attemptedToolCall(choice, toolCalls)) {
      // Replay from the conversation the LAST leg actually sent, not the original messages: when
      // a declared-tool exchange ran, the tool results are in there and dropping them would ask
      // the model to answer without the work it just did.
      const resolved = await this.recoverUnsolicitedToolTurn(
        { ...request, messages: exchange.messages },
        { choice, toolCalls, boundary, reportedFinishReason },
      );
      if (resolved) {
        content = resolved.content;
        stopReason = resolved.stopReason;
        addUsage(usage, resolved.usage);
      }
    }

    // The BYO endpoint owns the user's billing; we report tokens but not a $cost we
    // cannot know (their per-token price is theirs, not ours). cost stays 0 here.
    // Logged AFTER any continuation so the figure is everything this call actually spent.
    const latency = Date.now() - startTime;
    logger.info(`OpenAI-compatible call (${this.model} @ ${this.endpointLabel}): ${latency}ms, ${usage.totalTokens} tokens`);

    if (!content) {
      this.throwEmptyAnswerFailure({ completion, choice, reportedFinishReason, usage, toolCalls });
    }

    return {
      content,
      contentBlocks: toResultBlocks(toolCalls, content),
      stopReason,
      usage,
      cost: 0,
      latency,
      model: this.model,
      provider: this.baseUrl ? 'byo-llm' : 'openai',
    };
  }

  /**
   * @description Resolve a provider-side cache handle for the invariant system/tool preamble.
   * Only the first system message and the declared tool definitions enter the cache key. User and
   * assistant messages remain in the request, so a cached Jarvis turn cannot replay another task.
   * @param {Array<Object>} formatted - System message followed by task-scoped messages.
   * @param {Object} options - Provider options and optional cache override.
   * @param {Object} boundary - Captured declared tool boundary.
   * @returns {Promise<{messages:Array<Object>, extraBody?:Object}>}
   */
  async resolveInvariantPromptCache(formatted, options, boundary) {
    const cache = options.invariantPromptCache || this.invariantPromptCache;
    const system = formatted[0];
    if (!cache || !system || system.role !== 'system' || typeof cache.getHandle !== 'function') {
      return { messages: formatted };
    }
    const tools = boundary.definitions || [];
    const key = buildInvariantPromptCacheKey({
      endpoint: this.baseUrl,
      model: this.model,
      apiKey: cache.apiKey || undefined,
      systemPrompt: system.content,
      tools,
    });
    let handle = null;
    try {
      handle = await cache.getHandle({
        key,
        systemPrompt: system.content,
        tools,
        model: this.model,
        endpoint: this.baseUrl,
      });
    } catch (error) {
      logger.warn(`Invariant prompt cache unavailable; sending full preamble: ${error.message}`);
    }
    if (typeof handle !== 'string' || handle.trim().length === 0) return { messages: formatted };
    return {
      // The provider-side handle represents only this system/tool preamble. Preserve every
      // non-system message, including all task history, exactly as supplied by the caller.
      messages: formatted.slice(1),
      extraBody: { cached_content: handle },
    };
  }

  /**
   * @description Builds the chat-completions request for one conversational turn.
   * @param {Array<Object>} formatted - the conversation, system prompt already prepended
   * @param {Object} options - the generateResponse options
   * @param {Object} boundary - the resolved dispatch tool boundary for this request
   * @returns {Object} the request body
   */
  buildChatRequest(formatted, options, boundary) {
    return {
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature !== undefined ? options.temperature : this.temperature,
      messages: formatted,
      // Declaring the tools the caller was given is the whole point: the OSHAL system prompt tells
      // the model it has N tools, and until this landed the request declared none — so the model
      // either invented a call (entry 4's recovery) or, far more often, told the operator it could
      // not reach live data and to go use the application instead. Same formatter sendRequest uses.
      ...(boundary.definitions.length > 0
        ? { tools: this.formatFunctions(boundary.definitions), tool_choice: 'auto' }
        : {}),
      // OpenRouter reasoning models can otherwise spend the provider's entire free-tier output
      // allowance on hidden reasoning and return an empty final message. Keep a bounded reasoning
      // budget while excluding chain-of-thought from the application response. OpenRouter documents
      // this unified request field for its OpenAI-compatible chat endpoint.
      ...(isOpenRouterBaseUrl(this.baseUrl) ? {
        reasoning: { effort: options.reasoningEffort || 'low', exclude: true },
      } : {}),
      ...(options.extraBody && typeof options.extraBody === 'object'
        ? { extra_body: options.extraBody } : {}),
    };
  }

  /**
   * @description Logs the attempted-tool-call turn and asks once for a direct answer.
   *
   * The wrapper around {@link resolveUnsolicitedToolCalls} so generateResponse stays orchestration.
   * @param {Object} request - the chat-completions request as the last leg sent it
   * @param {{choice:Object,toolCalls:Array,boundary:Object,reportedFinishReason:string}} facts
   * @returns {Promise<{content:string,stopReason:string,usage:Object}|null>} the follow-up, or null
   */
  async recoverUnsolicitedToolTurn(request, facts) {
    const { choice, toolCalls, boundary, reportedFinishReason } = facts;
    logger.warn(
      'OpenAI-compatible endpoint attempted a tool call and returned no text '
      + `(${this.model} @ ${this.endpointLabel}, finish_reason "${reportedFinishReason}", `
      + `${toolCalls.length} readable call(s)) — asking once for a direct answer`,
      {
        model: this.model, endpoint: this.endpointLabel,
        stopReason: reportedFinishReason, toolCalls: toolCalls.map((call) => call.name),
      },
    );
    return this.resolveUnsolicitedToolCalls(request, choice?.message, toolCalls, boundary);
  }

  /**
   * @description Reports, and then throws, a completion that produced no usable answer.
   *
   * Extracted verbatim from generateResponse to keep that method within the repo's function-length
   * rule once the tool exchange moved into it; every string, field and log target is unchanged, and
   * openai-compat-tool-call-extraction.spec.ts pins all of them.
   * @param {{completion:Object,choice:Object,reportedFinishReason:string,usage:Object,toolCalls:Array}} facts
   * @returns {never} always throws EMPTY_FINAL_ANSWER
   */
  throwEmptyAnswerFailure({ completion, choice, reportedFinishReason, usage, toolCalls }) {
    const reasoning = choice?.message?.reasoning || choice?.message?.reasoning_content;
    const hadReasoning = Boolean(reasoning || choice?.message?.reasoning_details?.length);
    const detail = describeEmptyAnswer({
      model: this.model,
      endpoint: this.endpointLabel,
      stopReason: reportedFinishReason,
      outputTokens: usage.outputTokens,
      toolCallCount: toolCalls.length,
      attemptedToolCall: attemptedToolCall(choice, toolCalls),
      hadReasoning,
    });
    // The structure goes in the MESSAGE, not only the metadata: the console transport
    // (utils/logger.js) prints `${timestamp} [${level}]: ${message}` and drops the meta object
    // entirely, so a fingerprint left in metadata would never reach `docker logs` — which is
    // exactly where someone looks when this recurs.
    const structure = describeResponseStructure(completion, choice);
    logger.warn(
      `OpenAI-compatible endpoint returned no final answer — ${detail}; response shape: ${JSON.stringify(structure)}`,
      {
        model: this.model,
        endpoint: this.endpointLabel,
        stopReason: reportedFinishReason,
        outputTokens: usage.outputTokens,
        toolCalls: toolCalls.map((call) => call.name),
        hadReasoning,
        responseStructure: structure,
      },
    );
    // The message names the provider, the model and WHY the turn produced nothing, because it is
    // the string that reaches the caller and the swarm log; a bare "no final answer" told the
    // next reader only that something went wrong somewhere. The phrase itself is load-bearing and
    // must not be reworded away: reportResolvedLlmFailure matches it (with EMPTY_FINAL_ANSWER)
    // to decide whether a free/platform lane may rotate.
    const error = new Error(`OpenAI-compatible endpoint returned no final answer — ${detail}`);
    error.code = 'EMPTY_FINAL_ANSWER';
    throw error;
  }

  /**
   * @description Runs the chat exchange, executing declared tool calls until the model answers.
   *
   * With no tools declared this is exactly one API call and the old single-shot behaviour is
   * unchanged — which is why a tool-less caller sees byte-identical behaviour to before, including
   * entry 4's recovery for a call the model invented.
   *
   * With one, a `tool_calls` response is settled (executed, or refused with a stated reason) and
   * fed back as `tool` messages so the model can produce a final answer. The budget is bounded:
   * after {@link MAX_DECLARED_TOOL_ROUNDS} executed rounds the calls are refused with a truthful
   * budget-exhausted result and one last leg is taken for an answer, so a model that loops on
   * tools cannot spend the caller's tokens without limit.
   * @param {Object} request - the fully built chat-completions request, tools already declared
   * @param {Object} boundary - the resolved dispatch tool boundary for this request
   * @returns {Promise<{completion:Object,content:string,toolCalls:Array,usage:Object,messages:Array}>}
   */
  async runDeclaredToolExchange(request, boundary) {
    const messages = [...request.messages];
    const usage = emptyUsage();
    let executing = boundary.engaged;
    let roundsLeft = MAX_DECLARED_TOOL_ROUNDS;
    for (;;) {
      const completion = await this.client.chat.completions.create({ ...request, messages });
      addUsage(usage, completion.usage);
      const choice = completion.choices?.[0];
      const content = normalizeTextContent(choice?.message?.content);
      const toolCalls = normalizeToolCalls(choice?.message);
      if (toolCalls.length === 0 || !executing) {
        return { completion, content, toolCalls, usage, messages };
      }
      const exhausted = roundsLeft <= 0;
      const settled = await settleDeclaredCalls(boundary, toolCalls, exhausted, this.endpointLabel);
      if (settled.final !== null) {
        return { completion, content: settled.final, toolCalls: [], usage, messages };
      }
      messages.push(assistantToolTurn(choice?.message, toolCalls), ...settled.messages);
      // One further leg is taken so the refusal can be answered; then the exchange stops.
      if (exhausted) executing = false;
      roundsLeft -= 1;
    }
  }

  /**
   * @description Answers a turn that came back as tool calls this request cannot execute.
   *
   * Two shapes reach here. When the caller declared NO tools, any function call in the response is
   * one the model invented from prose in the prompt — the OSHAL system prompt tells it that tools
   * exist, and some models act on that even with nothing declared. Measured on
   * generativelanguage.googleapis.com 2026-09-22: gemini-3.8-flash returns
   * `{ role: 'assistant', tool_calls: [...] }` with no `content` key at all. When tools WERE
   * declared, this is the tail of an exchange whose round budget ran out.
   *
   * Either way there is nothing left to execute, so this completes the exchange the protocol's own
   * way — the assistant turn, then one `tool` result per call stating truthfully which of the two
   * situations it is — and asks for a direct answer. It is ONE bounded continuation, not a blind
   * retry: it runs only when the response carried tool calls and no text, and a failure falls
   * through to the honest empty-answer error rather than looping.
   *
   * Both halves of that pair are built from `toolCalls`, so the ids answered are by construction
   * the ids declared. `assistantMessage` contributes only its text content — never its raw
   * `tool_calls`, whose ids are not the ids this answers.
   * @param {Object} request - the chat-completions request as the last leg sent it
   * @param {Object} assistantMessage - the raw assistant message that carried the tool calls; only
   *   its `content` is used, because its call ids are not the normalized ones being answered
   * @param {Array<{id:string,name:string,rawArguments:string}>} toolCalls - the normalized calls
   * @param {Object} [boundary] - the resolved tool boundary, so the stated reason is the true one
   * @returns {Promise<{content:string,stopReason:string,usage:Object}|null>} the follow-up, or null
   */
  async resolveUnsolicitedToolCalls(request, assistantMessage, toolCalls, boundary) {
    // Say which it actually is. Telling a model "this request offered no tools" when it was handed
    // seventeen is the same class of lie that caused this bug in the first place.
    const result = boundary && boundary.definitions.length > 0
      ? NO_FURTHER_TOOL_RESULT : NO_TOOL_AVAILABLE_RESULT;
    const instruction = boundary && boundary.definitions.length > 0
      ? NO_FURTHER_TOOL_INSTRUCTION : NO_TOOL_AVAILABLE_INSTRUCTION;
    // With readable calls there is a tool_call_id to answer, so the exchange is completed the
    // protocol's own way. A filtered/malformed attempt leaves no id to answer — there the only
    // available move is to restate the constraint as a user turn.
    //
    // The replayed assistant turn is built FROM the normalized calls, never from the raw
    // `assistantMessage.tool_calls`. The two are not interchangeable: normalizeToolCalls
    // synthesizes an id (`call_${index}`) for a call that arrived without one, and reads the
    // legacy `function_call` field that has no `tool_calls` array behind it at all. Passing the
    // raw array through while answering the normalized ids produced an assistant turn and a tool
    // turn that did not line up — an id answered that the assistant turn never declared, or a
    // declared id left unanswered — which every chat-completions gateway rejects with a 400. That
    // landed in the catch below, so the recovery never happened and the caller was billed twice
    // for the empty answer it got anyway. Building both halves from one list is what makes the
    // pairing an invariant rather than a coincidence.
    //
    // A call the endpoint sent with no function name is absent here by construction
    // (normalizeToolCalls filters it) and is therefore NOT replayed. That is deliberate: there is
    // no name to attribute a result to, so it cannot be answered, and an unanswered call in the
    // replay is the same 400. It is not lost — its tokens are in the usage total, and it is part
    // of what made attemptedToolCall true and brought us here.
    const continuation = toolCalls.length > 0
      ? [
        assistantToolTurn(assistantMessage, toolCalls),
        ...toolCalls.map((call) => ({
          role: 'tool', tool_call_id: call.id, content: result,
        })),
      ]
      : [{ role: 'user', content: instruction }];
    try {
      const completion = await this.client.chat.completions.create({
        ...request,
        messages: [...request.messages, ...continuation],
      });
      const choice = completion.choices?.[0];
      return {
        content: normalizeTextContent(choice?.message?.content),
        stopReason: choice?.finish_reason || 'stop',
        usage: completion.usage,
      };
    } catch (err) {
      logger.warn('OpenAI-compatible tool-call continuation failed', {
        model: this.model,
        endpoint: this.endpointLabel,
        error: err && err.message,
      });
      return null;
    }
  }

  /**
   * Get provider name
   */
  get providerName() {
    return this.provider;
  }

  /**
   * Send request to GPT
   */
  async sendRequest(options) {
    const {
      messages,
      tools = [],
      stream = false,
      onChunk = null,
      systemPrompt = null,
    } = options;

    this.requestCount++;

    // Format messages for OpenAI
    const formattedMessages = this.formatMessagesForOpenAI(messages, systemPrompt);
    
    // Format tools for OpenAI (function calling)
    const formattedTools = tools.length > 0 ? this.formatFunctions(tools) : undefined;

    // Build request parameters
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: formattedMessages,
    };

    // Add tools if provided
    if (formattedTools) {
      params.tools = formattedTools;
      params.tool_choice = 'auto';
    }

    // Add streaming
    if (stream) {
      params.stream = true;
    }

    try {
      logger.info(`Sending request to OpenAI (${this.model})`);
      logger.debug(`Messages: ${formattedMessages.length}, Tools: ${formattedTools ? formattedTools.length : 0}`);

      if (stream) {
        return await this.handleStreaming(params, onChunk);
      } else {
        return await this.handleNonStreaming(params);
      }
    } catch (err) {
      logger.error(`OpenAI API error: ${err.message}`);
      throw new Error(`LLM request failed: ${err.message}`);
    }
  }

  /**
   * Handle non-streaming response
   */
  async handleNonStreaming(params) {
    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    // Extract content and function calls
    const content = [];
    
    if (choice.message.content) {
      content.push({
        type: 'text',
        text: choice.message.content,
      });
    }

    if (choice.message.tool_calls) {
      choice.message.tool_calls.forEach((toolCall) => {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments),
        });
      });
    }

    // Calculate cost
    const cost = this.calculateCost(
      response.usage.prompt_tokens,
      response.usage.completion_tokens
    );

    logger.info(`OpenAI response: ${response.usage.completion_tokens} tokens, $${cost.toFixed(6)}`);

    return {
      content,
      stopReason: choice.finish_reason,
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        cacheWrites: 0, // OpenAI doesn't expose cache stats
        cacheReads: 0,
        cost,
      },
      model: response.model,
    };
  }

  /**
   * Handle streaming response
   */
  async handleStreaming(params, onChunk) {
    const stream = await this.client.chat.completions.create(params);

    let fullText = '';
    const toolCalls = new Map();
    let usage = null;
    let finishReason = null;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      if (!delta) continue;

      // Handle text content
      if (delta.content) {
        fullText += delta.content;
        if (onChunk) {
          onChunk(delta.content);
        }
      }

      // Handle tool calls
      if (delta.tool_calls) {
        delta.tool_calls.forEach((toolCall) => {
          const index = toolCall.index;
          
          if (!toolCalls.has(index)) {
            toolCalls.set(index, {
              id: toolCall.id || '',
              name: toolCall.function?.name || '',
              arguments: '',
            });
          }
          
          const existing = toolCalls.get(index);
          if (toolCall.id) existing.id = toolCall.id;
          if (toolCall.function?.name) existing.name = toolCall.function.name;
          if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
        });
      }

      // Capture finish reason
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }

      // Capture usage (if available - OpenAI may provide at end)
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    // Build content array
    const content = [];
    
    if (fullText) {
      content.push({
        type: 'text',
        text: fullText,
      });
    }

    // Add parsed tool calls
    for (const [_, toolCall] of toolCalls) {
      try {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: JSON.parse(toolCall.arguments),
        });
      } catch (err) {
        logger.error(`Failed to parse tool arguments: ${err.message}`);
      }
    }

    // Estimate usage if not provided (OpenAI streaming may not always include it)
    if (!usage) {
      const estimatedInput = Math.ceil(fullText.length / 4); // Rough estimate
      const estimatedOutput = Math.ceil(fullText.length / 4);
      usage = {
        prompt_tokens: estimatedInput,
        completion_tokens: estimatedOutput,
        total_tokens: estimatedInput + estimatedOutput,
      };
      logger.warn('OpenAI usage not provided in stream, using estimates');
    }

    const cost = this.calculateCost(usage.prompt_tokens, usage.completion_tokens);

    logger.info(`OpenAI streaming complete: ${usage.completion_tokens} tokens, $${cost.toFixed(6)}`);

    return {
      content,
      stopReason: finishReason || 'stop',
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cacheWrites: 0,
        cacheReads: 0,
        cost,
      },
      model: this.model,
    };
  }

  /**
   * Format messages for OpenAI's format
   */
  formatMessagesForOpenAI(messages, systemPrompt = null) {
    const formatted = [];
    
    // Add system prompt if provided
    if (systemPrompt) {
      formatted.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    messages.forEach((msg) => {
      // Skip task messages (use as system prompt)
      if (msg.type === 'task') {
        return;
      }

      // Determine role
      let role = 'user';
      if (msg.say === 'say' && msg.type !== 'task') {
        role = msg.images || msg.files ? 'user' : 'assistant';
      }

      formatted.push({
        role,
        content: msg.text || '',
      });
    });

    return formatted;
  }

  /**
   * Format tools for OpenAI function calling
   */
  formatFunctions(tools) {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    }));
  }

  /**
   * Calculate cost for OpenAI models
   * Pricing as of Nov 2025
   */
  calculateCost(tokensIn, tokensOut) {
    // GPT-4 Turbo pricing (per million tokens)
    let inputPrice, outputPrice;
    
    if (this.model.includes('gpt-4')) {
      inputPrice = 10.0;
      outputPrice = 30.0;
    } else if (this.model.includes('gpt-3.5')) {
      inputPrice = 0.5;
      outputPrice = 1.5;
    } else {
      // Default to GPT-4 pricing
      inputPrice = 10.0;
      outputPrice = 30.0;
    }

    const inputCost = (tokensIn / 1000000) * inputPrice;
    const outputCost = (tokensOut / 1000000) * outputPrice;

    return inputCost + outputCost;
  }
}

/**
 * The tool result sent back when a model calls a tool this request never offered. It is the literal
 * truth of the situation, not a stand-in answer, so the model re-plans instead of waiting on a
 * result that can never arrive.
 */
const NO_TOOL_AVAILABLE_RESULT = JSON.stringify({
  error: 'no_tools_available',
  detail: 'This request offered no tools, so nothing was executed. Answer the user directly, in text, '
    + 'using only what is already in this conversation.',
});

/**
 * The same statement as a user turn, for a filtered or malformed call that left no tool_call_id to
 * answer. Still a statement of fact about the request, not a hint about what to say.
 */
const NO_TOOL_AVAILABLE_INSTRUCTION = 'No tools are available in this request, so no tool call can '
  + 'be executed and any you attempted did not run. Answer the previous message directly, in plain '
  + 'text, using only what is already in this conversation.';

/**
 * The tool result sent back when tools WERE declared but this request's tool budget is spent. The
 * distinction matters: the model must not be told it had no tools when it did.
 */
const NO_FURTHER_TOOL_RESULT = JSON.stringify({
  error: 'tool_budget_exhausted',
  detail: 'This request has used its tool budget, so nothing further was executed. Answer the user '
    + 'directly, in text, using the tool results already in this conversation.',
});

/** The same statement as a user turn, for a call that left no tool_call_id to answer. */
const NO_FURTHER_TOOL_INSTRUCTION = 'This request has used its tool budget, so no further tool call '
  + 'can be executed and any you attempted did not run. Answer the previous message directly, in '
  + 'plain text, using the tool results already in this conversation.';

/**
 * How many rounds of declared tool calls one completion may execute before the budget is stated to
 * the model and the exchange is closed out with a final leg. Bounded on purpose: an unbounded loop
 * over a caller's endpoint is their money, and a model that re-requests the same tool forever is a
 * shape that has to terminate without a human.
 */
const MAX_DECLARED_TOOL_ROUNDS = 4;

/**
 * @description The provider-agnostic content blocks for one answered turn.
 *
 * Tool calls are surfaced, never hidden: a caller that runs its own tool loop sees exactly what was
 * requested, even on a turn this adapter already settled.
 * @param {Array<{id:string,name:string,input:Object}>} toolCalls - the last leg's normalized calls
 * @param {string} content - the final text
 * @returns {Array<Object>} tool_use blocks followed by the text block
 */
function toResultBlocks(toolCalls, content) {
  return [
    ...toolCalls.map((call) => ({
      type: 'tool_use', id: call.id, name: call.name, input: call.input,
    })),
    { type: 'text', text: content },
  ];
}

/**
 * @description Resolves, once per request, what this exchange is permitted to execute.
 *
 * This is the provider half of the SEC-05 pair the controllers already implement: the controller
 * captures the capability set at request start ({@link captureDispatchCapabilities}) and
 * re-authorizes each operation ({@link authorizeCapability}); this rebinds the SAME statement at
 * the provider boundary, which is what ADR-122 means by rebinding the exact tools and scopes
 * around untrusted model output.
 *
 * Absence is never authority, exactly as `normalizeAllowedTools` / `normalizeAuthorizedScopes`
 * decided for the primitives beneath: a caller that does not assert `enforceToolBoundary`, declares
 * no tools, or supplies no execution channel gets an exchange that executes nothing at all.
 *
 * `engaged` only says whether a tool exchange is possible at all (something was declared). Whether
 * any individual call may RUN is decided per call by {@link authorizeDeclaredCall}, so there is one
 * place to read, and to break, for each rule.
 * @param {Object} options - the generateResponse options as the caller passed them
 * @returns {{definitions:Array,declared:Set<string>,scopes:Set<string>,enforced:boolean,
 *   execute:Function|null,engaged:boolean}} the resolved boundary
 */
function resolveDispatchToolBoundary(options) {
  const definitions = (Array.isArray(options.tools) ? options.tools : [])
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name.length > 0);
  const declared = new Set(definitions.map((tool) => tool.name));
  // The controller hands over the very Set its capabilities were captured with; an array from any
  // other caller is normalized by the same primitive, and anything else denies every scope.
  const scopes = options.authorizedScopes instanceof Set
    ? options.authorizedScopes
    : normalizeAuthorizedScopes(options.authorizedScopes);
  const enforced = options.enforceToolBoundary === true;
  const execute = typeof options.executeTool === 'function' ? options.executeTool : null;
  return { definitions, declared, scopes, enforced, execute, engaged: declared.size > 0 };
}

/**
 * @description Decides whether one model-requested call may reach the execution channel.
 *
 * The four refusals are the four ways a call can be outside what this request can honour - the
 * caller never asserted the boundary, the name was never declared, its exact operation scope is not
 * held, or there is no channel to run it through - and each is stated back to the model rather than
 * silently dropped — a model that is told why it was refused
 * answers the user, and one that is ignored retries.
 * @param {Object} boundary - the resolved boundary for this request
 * @param {string} name - the tool name the model asked for
 * @returns {{allowed:boolean,error?:string}} the decision
 */
function authorizeDeclaredCall(boundary, name) {
  if (!boundary.enforced) {
    return { allowed: false, error: 'This request did not assert a tool boundary, so no tool was executed.' };
  }
  if (!boundary.declared.has(name)) {
    return { allowed: false, error: `Tool '${name}' was not offered on this request and was not executed.` };
  }
  if (!hasOperationScope(boundary.scopes, name)) {
    return { allowed: false, error: `Missing exact operation scope: ${requiredScope(name)}` };
  }
  if (!boundary.execute) {
    return { allowed: false, error: 'No tool execution channel was provided for this request, so nothing was executed.' };
  }
  return { allowed: true };
}

/**
 * @description Settles every tool call in one round into `tool` messages to feed back.
 *
 * A refusal and a failure are both results, not exceptions: the model gets a stated reason and can
 * answer, which is the difference between the operator seeing an answer and seeing "that didn't
 * work". An executor that signals `final` ends the exchange with its content — that is the
 * `attempt_completion` control, which is an answer rather than a side effect.
 * @param {Object} boundary - the resolved boundary for this request
 * @param {Array<{id:string,name:string,input:Object}>} toolCalls - the round's normalized calls
 * @param {boolean} exhausted - true when the round budget is spent and nothing may execute
 * @param {string} endpointLabel - endpoint name for the log line only
 * @returns {Promise<{messages:Array,final:string|null}>} the tool messages, or a final answer
 */
async function settleDeclaredCalls(boundary, toolCalls, exhausted, endpointLabel) {
  const messages = [];
  for (const call of toolCalls) {
    const outcome = exhausted
      ? { ok: false, error: 'This request has used its tool budget; nothing further was executed.' }
      : await settleOneDeclaredCall(boundary, call, endpointLabel);
    if (outcome.final === true && typeof outcome.content === 'string') {
      return { messages, final: outcome.content };
    }
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: outcome.ok
        ? String(outcome.result ?? '')
        : JSON.stringify({ error: 'tool_call_refused', detail: String(outcome.error || 'refused') }),
    });
  }
  return { messages, final: null };
}

/**
 * @description Authorizes one call and, only then, hands it to the caller's execution channel.
 *
 * Throws whatever the channel throws: a request-invalidating condition (a capability replaced or
 * revoked since request start, a caller authorization that lapsed) must end the request, not
 * become a refusal the model answers around.
 * @param {Object} boundary - the resolved boundary for this request
 * @param {{id:string,name:string,input:Object}} call - one normalized tool call
 * @param {string} endpointLabel - endpoint name for the log line only
 * @returns {Promise<{ok:boolean,result?:unknown,error?:string,final?:boolean,content?:string}>}
 */
async function settleOneDeclaredCall(boundary, call, endpointLabel) {
  const decision = authorizeDeclaredCall(boundary, call.name);
  if (!decision.allowed) {
    logger.warn(`Refused a model tool call outside this request's boundary (${call.name} @ ${endpointLabel}): ${decision.error}`);
    return { ok: false, error: decision.error };
  }
  // The channel's contract is: a REFUSAL or a tool failure comes back as `{ ok: false }` and is
  // told to the model, while a THROW means the request itself is no longer authorized — a
  // capability replaced or revoked since request start, or a caller authorization that lapsed
  // mid-exchange. Those must not be caught here. Swallowing them into a per-call refusal is
  // exactly how a tool loop defeats assertDispatchCapabilitiesCurrent: the request would carry on
  // and answer, having been told its own authority was invalidated.
  const outcome = await boundary.execute(call.name, call.input, { callId: call.id });
  if (!outcome || typeof outcome !== 'object') {
    logger.warn(`Tool execution channel returned no outcome for ${call.name} @ ${endpointLabel}`);
    return { ok: false, error: `Tool '${call.name}' returned no result.` };
  }
  return outcome;
}

/**
 * @description Rebuilds the assistant turn that requested tools, from the NORMALIZED calls.
 *
 * Built from the normalized calls rather than copied from the raw message so the ids on the
 * assistant turn always match the ids on the `tool` replies — including for the legacy
 * `function_call` shape, which carries no ids of its own and would otherwise be unanswerable.
 * @param {Object} [assistantMessage] - the raw assistant message
 * @param {Array<{id:string,name:string,rawArguments:string}>} toolCalls - the normalized calls
 * @returns {Object} an assistant message the endpoint will accept as the call turn
 */
function assistantToolTurn(assistantMessage, toolCalls) {
  return {
    role: 'assistant',
    content: assistantMessage?.content ?? null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.rawArguments || '{}' },
    })),
  };
}

/**
 * Finish reasons a gateway uses when the model tried to call a function and the attempt, rather
 * than the answer, ended the turn — including Google's `MALFORMED_FUNCTION_CALL` /
 * `function_call_filter`, and OpenAI's legacy `function_call`.
 */
const TOOL_CALL_FINISH_REASON = /function[_\s-]?call|tool[_\s-]?calls?/i;

/**
 * @description Did this turn end because the model tried to use a tool rather than answer?
 *
 * True when there are readable calls, and ALSO when the gateway filtered a malformed attempt and
 * returned a message with neither text nor calls — the second shape is invisible in the message
 * body and only the finish reason names it.
 * @param {Object} [choice] - the first choice of the completion
 * @param {Array} toolCalls - the normalized calls read out of that choice
 * @returns {boolean} true when the turn was spent attempting a tool call
 */
function attemptedToolCall(choice, toolCalls) {
  if (toolCalls.length > 0) return true;
  return TOOL_CALL_FINISH_REASON.test(String(choice?.finish_reason || ''));
}

/** @description A zeroed usage record in the shared provider shape. */
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheCreationTokens: 0, cacheReads: 0 };
}

/**
 * @description Folds one OpenAI-compatible `usage` block into a running total, so a turn that took
 * a continuation reports every token it spent rather than only the last leg's.
 * @param {Object} totals - the accumulator, mutated and returned
 * @param {Object} [usage] - a raw `completion.usage` block, if the endpoint returned one
 * @returns {Object} the accumulator
 */
function addUsage(totals, usage) {
  const input = usage?.prompt_tokens || 0;
  const output = usage?.completion_tokens || 0;
  totals.inputTokens += input;
  totals.outputTokens += output;
  // Vendors differ: Google's compatibility surface counts thinking tokens in `total_tokens` but not
  // in `completion_tokens`, so the reported total is NOT always input + output. Prefer what the
  // endpoint reported and only compute a total when it reported none.
  totals.totalTokens += usage?.total_tokens || (input + output);
  return totals;
}

/**
 * @description The argument payload EXACTLY as the endpoint sent it, as a wire-format string.
 *
 * `rawArguments` is not a convenience copy: it is the text replayed verbatim into the assistant
 * turn of the tool-call continuation, so it must be what arrived, never a re-serialization of the
 * parsed `input` (which would silently rewrite key order, number formatting and any argument that
 * failed to parse). The chat-completions wire format is a JSON string and that path is a straight
 * pass-through. Some OpenAI-compatible gateways emit `arguments` already parsed; serializing that
 * object once here is the only way it survives into the replay, and the alternative — dropping it
 * to an empty string — would tell the model it called with no arguments when it did not.
 * @param {*} value - `call.function.arguments` as the endpoint returned it
 * @returns {string} the wire-format argument string, or '' when there is nothing to carry
 */
function toRawArguments(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

/**
 * @description Normalizes an assistant message's function/tool calls into the tool_use shape the
 * rest of the harness speaks.
 *
 * Reads BOTH the current `tool_calls` array and OpenAI's deprecated single `function_call` field,
 * because "OpenAI-compatible" gateways are not uniform about which one they emit and a call sitting
 * in the field this did not check is indistinguishable from an empty turn. Arguments that are not
 * valid JSON are kept verbatim under `raw` rather than dropped — a malformed argument is still
 * evidence of what the model tried to do.
 *
 * Two properties of the returned list are relied on by resolveUnsolicitedToolCalls and must not be
 * relaxed: `id` is ALWAYS a usable string (synthesized as `call_${index}` when the endpoint sent
 * none, which is also the only id the legacy `function_call` shape can have), and `name` is always
 * a non-empty string, because a call without one is filtered out here. Those two together are what
 * let the continuation build a protocol-valid assistant turn out of this list alone.
 * @param {Object} [message] - `choice.message` as the endpoint returned it
 * @returns {Array<{id:string,name:string,input:Object,rawArguments:string}>} normalized calls
 */
function normalizeToolCalls(message) {
  const raw = Array.isArray(message?.tool_calls)
    ? message.tool_calls
    : message?.function_call ? [{ id: null, function: message.function_call }] : [];
  return raw
    .filter((call) => call && call.function && call.function.name)
    .map((call, index) => {
      const rawArguments = toRawArguments(call.function.arguments);
      let input;
      try { input = rawArguments ? JSON.parse(rawArguments) : {}; } catch { input = { raw: rawArguments }; }
      return { id: String(call.id || `call_${index}`), name: String(call.function.name), input, rawArguments };
    });
}

/**
 * @description One sentence naming the provider, the model and the reason a completion carried no
 * usable answer. This is what a human reads in the log and in the surfaced error, so it states the
 * cause rather than the symptom.
 * @param {{model:string,endpoint:string,stopReason:string,outputTokens:number,toolCallCount:number,attemptedToolCall:boolean,hadReasoning:boolean}} facts
 * @returns {string} the human-readable cause
 */
function describeEmptyAnswer(facts) {
  const why = facts.toolCallCount > 0
    ? `it answered with ${facts.toolCallCount} tool call(s) and no text, and the follow-up for a direct answer produced none either`
    : facts.attemptedToolCall
      ? 'it spent the turn on a tool call that this request never offered and the gateway returned no readable call, '
        + 'and the follow-up for a direct answer produced none either'
      : facts.hadReasoning
        ? 'it returned reasoning tokens but no final message'
        : 'the response carried no text, no tool calls and no reasoning';
  return `${facts.model} @ ${facts.endpoint} finished with "${facts.stopReason}" after `
    + `${facts.outputTokens} output token(s): ${why}`;
}

/**
 * @description A content-free fingerprint of a completion's SHAPE, for the log.
 *
 * The empty-answer failure is intermittent (measured 2026-09-22: four calls to the same model on
 * the same config, two empty and two fine), so the only way the next occurrence becomes evidence
 * instead of a shrug is if the adapter records what came back at the moment it could not read it.
 * Keys, types, flags and counts ONLY — never prompt or completion text, and nothing key-shaped.
 * @param {Object} [completion] - the raw chat-completions response
 * @param {Object} [choice] - the first choice within it
 * @returns {Object} a loggable structural fingerprint
 */
function describeResponseStructure(completion, choice) {
  const message = choice?.message;
  const content = message?.content;
  return {
    topLevelKeys: completion && typeof completion === 'object' ? Object.keys(completion).sort() : null,
    choiceCount: Array.isArray(completion?.choices) ? completion.choices.length : null,
    choiceKeys: choice && typeof choice === 'object' ? Object.keys(choice).sort() : null,
    messageKeys: message && typeof message === 'object' ? Object.keys(message).sort() : null,
    contentType: content === null ? 'null' : Array.isArray(content) ? 'array' : typeof content,
    contentLength: typeof content === 'string' ? content.length : Array.isArray(content) ? content.length : null,
    contentPartTypes: Array.isArray(content)
      ? content.map((part) => (part && typeof part === 'object' ? String(part.type) : typeof part))
      : null,
    toolCallCount: Array.isArray(message?.tool_calls) ? message.tool_calls.length : null,
    usageKeys: completion?.usage && typeof completion.usage === 'object'
      ? Object.keys(completion.usage).sort() : null,
    refusal: typeof message?.refusal === 'string' ? 'present' : null,
  };
}

/** @description True only for OpenRouter's hosted OpenAI-compatible API. */
function isOpenRouterBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/** @description Normalizes string or multipart OpenAI-compatible final content without exposing reasoning. */
function normalizeTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' || part.type === 'output_text') return String(part.text || part.content || '');
      return '';
    })
    .join('')
    .trim();
}

/** @description Privacy-safe endpoint label for logs; strips path, query, and user-info. */
function safeEndpointLabel(baseUrl) {
  if (!baseUrl) return 'api.openai.com';
  try { return new URL(baseUrl).hostname.toLowerCase() || 'compatible-endpoint'; }
  catch { return 'compatible-endpoint'; }
}

module.exports = OpenAIProvider;
