/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — no-op stub provider for dev/testing without API keys
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | De-brand final pass: the reported provider name is now 'noop' (was the legacy stub label). getProviderName() returns 'noop'; telemetry/chat_tasks rows key on 'noop' going forward.
 */

import { createChildLogger } from '@/shared/logger';
import { LLMService, type SendRequestOptions, type LLMResponse } from './llm-service';

const logger = createChildLogger({ module: 'noop-provider' });

/**
 * @description Noop (no-op) LLM provider that mirrors user input back as a response.
 * Used for development and testing without requiring real API keys.
 * Simulates tool use when tools are provided and the message contains
 * a trigger phrase.
 */
export class NoopProvider extends LLMService {
  constructor() {
    super('noop', {});
    logger.info('Noop provider initialized');
  }

  /**
   * @description Send a request that mirrors the last user message back.
   * If tools are provided, simulates a natural completion without tool use.
   *
   * @param options - Request options
   * @returns Mirrored response with simulated token usage
   */
  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    this.requestCount++;
    const startTime = Date.now();

    logger.info(
      { messageCount: options.messages.length, hasTools: !!options.tools?.length },
      'Noop provider processing request',
    );

    const lastUserMessage = this.extractLastUserMessage(options);
    const responseText = this.buildResponse(lastUserMessage);
    const durationMs = Date.now() - startTime;

    logger.info({ durationMs, requestNumber: this.requestCount }, 'Noop provider request complete');

    return {
      content: [{ type: 'text', text: responseText }],
      usage: { inputTokens: 10, outputTokens: responseText.length },
      model: 'noop-v1',
      stopReason: 'end_turn',
    };
  }

  /**
   * @description Extract the last user message text from the request.
   *
   * @param options - Request options
   * @returns Last user message text or default
   */
  private extractLastUserMessage(options: SendRequestOptions): string {
    for (let i = options.messages.length - 1; i >= 0; i--) {
      const msg = options.messages[i];
      if (msg.role === 'user' && typeof msg.content === 'string') {
        return msg.content;
      }
    }
    return '(no message)';
  }

  /**
   * @description Build the stub response text.
   *
   * @param userMessage - The user's message to mirror
   * @returns Formatted stub response
   */
  private buildResponse(userMessage: string): string {
    return `[noop] You said: "${userMessage}". This is a stub response from the Noop provider.`;
  }
}