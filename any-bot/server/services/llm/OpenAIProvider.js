/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OpenAI-COMPATIBLE: constructor honors config.baseUrl (drives any chat-completions gateway — a user's BYO endpoint, LiteLLM, LM Studio, Ollama, Groq, …); added generateResponse() matching the BedrockProvider/Cline contract so TaskController can drive a BYO-LLM connection with no special-casing.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bound OpenRouter reasoning to a low, non-disclosed budget for interactive completions, normalized multipart text, and fail explicitly when a gateway returns reasoning tokens without a final answer.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | A turn spent attempting a tool call is no longer thrown away. generateResponse now reads tool_calls AND the legacy function_call field, surfaces them as tool_use blocks, and - because it declares no tools, so any call is one the model invented from the system prompt's "you have access to N tools" - completes the exchange once with a truthful no-tools-available result to obtain a direct answer; a gateway-filtered malformed attempt, which leaves no call id to answer, restates the constraint as a user turn instead. Measured live on generativelanguage.googleapis.com 2026-09-22: gemini-2.5-flash and gemini-3.8-flash both return { role, tool_calls } with no content key, and 3.8-flash also returns finish_reason "function_call_filter: MALFORMED_FUNCTION_CALL" with message keys [extra_content, role]. The empty-answer error and warning now name provider, model, finish_reason and output tokens, report an ABSENT finish_reason as absent instead of defaulting the diagnostic to "stop" (that default is what made the genuinely empty turn read as a normal completion), and carry a content-free fingerprint of the response SHAPE in the message string, because the console transport prints only the message and drops metadata. Usage accumulates across both legs and honours an endpoint-reported total_tokens rather than assuming input + output.
 */

/**
 * OpenAI Provider
 * Implements LLMService for OpenAI's GPT models
 */

const OpenAI = require('openai');
const LLMService = require('./LLMService');
const logger = require('../../utils/logger');

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
  }

  /**
   * @description Single-shot completion matching the BedrockProvider/ClineProvider
   * generateResponse() contract, so TaskController can drive an OpenAI-compatible
   * endpoint (incl. a per-user BYO-LLM connection) with no special-casing. Returns
   * the same { content, contentBlocks, stopReason, usage, cost, latency, model,
   * provider } shape the other providers return.
   * @param {Array<{role:string,content:string}>} messages - conversation turns
   * @param {Object} [options] - { systemPrompt, maxTokens, temperature }
   * @returns {Promise<Object>} the standard generateResponse result object
   */
  async generateResponse(messages, options = {}) {
    const startTime = Date.now();
    const formatted = (messages || [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    if (options.systemPrompt) formatted.unshift({ role: 'system', content: String(options.systemPrompt) });
    if (formatted.length === 0) throw new Error('No valid messages with content to send to the LLM endpoint');

    const request = {
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature !== undefined ? options.temperature : this.temperature,
      messages: formatted,
      // OpenRouter reasoning models can otherwise spend the provider's entire free-tier output
      // allowance on hidden reasoning and return an empty final message. Keep a bounded reasoning
      // budget while excluding chain-of-thought from the application response. OpenRouter documents
      // this unified request field for its OpenAI-compatible chat endpoint.
      ...(isOpenRouterBaseUrl(this.baseUrl) ? {
        reasoning: { effort: options.reasoningEffort || 'low', exclude: true },
      } : {}),
    };
    const completion = await this.client.chat.completions.create(request);

    const choice = completion.choices?.[0];
    let content = normalizeTextContent(choice?.message?.content);
    let stopReason = choice?.finish_reason || 'stop';
    // `stopReason` defaults to 'stop' to keep the result contract stable, but the DIAGNOSTIC must
    // never launder an absent field into a normal completion. Measured 2026-09-22: the intermittent
    // empty turn comes back as a choice with NO finish_reason and a message whose only key is
    // `role`; the default made the log read `finish_reason "stop"`, which is why the first reading
    // of this failure went looking for a model that had answered normally.
    const reportedFinishReason = choice?.finish_reason || '(absent)';
    const usage = addUsage(emptyUsage(), completion.usage);
    // A turn can come back carrying ONLY function/tool-call parts and no text at all. That is not
    // an empty turn — the answer is in `tool_calls` (or the legacy `function_call`), fields the
    // text extractor cannot see. Reading them is what stops a paid completion being dropped.
    const toolCalls = normalizeToolCalls(choice?.message);

    // The same root cause has two shapes, and BOTH were measured live on 2026-09-22. The model is
    // told in prose that it has tools (the OSHAL system prompt says so) while this request declares
    // none, so it tries to call one anyway: either the call comes back in `tool_calls`, or the
    // gateway filters a malformed attempt and returns a message with neither text nor tool calls
    // (`finish_reason: "function_call_filter: MALFORMED_FUNCTION_CALL"`, message keys
    // `["extra_content","role"]`). Either way the turn is billed and unreadable, so both recover
    // the same way: say plainly that no tool is available and ask for a direct answer.
    if (!content && attemptedToolCall(choice, toolCalls)) {
      logger.warn(
        'OpenAI-compatible endpoint attempted a tool call and returned no text '
        + `(${this.model} @ ${this.endpointLabel}, finish_reason "${reportedFinishReason}", `
        + `${toolCalls.length} readable call(s)) — asking once for a direct answer`,
        {
          model: this.model,
          endpoint: this.endpointLabel,
          stopReason: reportedFinishReason,
          toolCalls: toolCalls.map((call) => call.name),
        },
      );
      const resolved = await this.resolveUnsolicitedToolCalls(request, choice?.message, toolCalls);
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

    return {
      content,
      contentBlocks: [
        // Surfaced, never hidden: a caller that can run a tool loop sees exactly what was requested.
        ...toolCalls.map((call) => ({
          type: 'tool_use', id: call.id, name: call.name, input: call.input,
        })),
        { type: 'text', text: content },
      ],
      stopReason,
      usage,
      cost: 0,
      latency,
      model: this.model,
      provider: this.baseUrl ? 'byo-llm' : 'openai',
    };
  }

  /**
   * @description Answers a turn that came back as tool calls when this request offered NO tools.
   *
   * generateResponse never sends a `tools` array (see the request built above), so any function
   * call in the response is one the model invented from prose in the prompt — the OSHAL system
   * prompt tells it that tools exist, and some models act on that even with nothing declared.
   * Measured on generativelanguage.googleapis.com 2026-09-22: gemini-3.8-flash returns
   * `{ role: 'assistant', tool_calls: [...] }` with no `content` key at all.
   *
   * There is nothing to execute, so this completes the exchange the protocol's own way — the
   * assistant turn, then one `tool` result per call stating truthfully that no tool was available —
   * and asks for a direct answer. It is ONE bounded continuation, not a blind retry: it runs only
   * when the first response carried tool calls and no text, and a failure falls through to the
   * honest empty-answer error rather than looping.
   * @param {Object} request - the original chat-completions request (tool-less by construction)
   * @param {Object} assistantMessage - the raw assistant message that carried the tool calls
   * @param {Array<{id:string,name:string,rawArguments:string}>} toolCalls - the normalized calls
   * @returns {Promise<{content:string,stopReason:string,usage:Object}|null>} the follow-up, or null
   */
  async resolveUnsolicitedToolCalls(request, assistantMessage, toolCalls) {
    // With readable calls there is a tool_call_id to answer, so the exchange is completed the
    // protocol's own way. A filtered/malformed attempt leaves no id to answer — there the only
    // available move is to restate the constraint as a user turn.
    const continuation = toolCalls.length > 0
      ? [
        { role: 'assistant', content: assistantMessage?.content ?? null, tool_calls: assistantMessage.tool_calls },
        ...toolCalls.map((call) => ({
          role: 'tool', tool_call_id: call.id, content: NO_TOOL_AVAILABLE_RESULT,
        })),
      ]
      : [{ role: 'user', content: NO_TOOL_AVAILABLE_INSTRUCTION }];
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
 * @description Normalizes an assistant message's function/tool calls into the tool_use shape the
 * rest of the harness speaks.
 *
 * Reads BOTH the current `tool_calls` array and OpenAI's deprecated single `function_call` field,
 * because "OpenAI-compatible" gateways are not uniform about which one they emit and a call sitting
 * in the field this did not check is indistinguishable from an empty turn. Arguments that are not
 * valid JSON are kept verbatim under `raw` rather than dropped — a malformed argument is still
 * evidence of what the model tried to do.
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
      const rawArguments = typeof call.function.arguments === 'string' ? call.function.arguments : '';
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
