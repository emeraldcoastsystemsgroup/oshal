/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Marked LocalHostAgent sends as interactionMode=task so swarm/task execution keeps the strict workspace-oriented launch contract
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Implemented LocalHostAgent — concrete default host runtime extending BaseAgent
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | IMP-2: Added optional executionScopeId parameter to processMessage for child/review context isolation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: Keep persisted agent names and roles out of the trusted host prompt prefix; persona data is contained by BaseAgent.
 */

import { createChildLogger } from '@/shared/logger';
import type { LLMService } from '@/features/llm-provider';
import { BaseAgent, type BaseAgentDeps } from './base-agent';

const logger = createChildLogger({ module: 'local-host-agent' });

/**
 * @description Dependencies specific to LocalHostAgent.
 */
export interface LocalHostAgentDeps extends BaseAgentDeps {
  getProvider: () => LLMService;
}

/**
 * @description Concrete default host runtime for single-machine deployments.
 * Builds local system prompts and delegates LLM execution to the composition-root provider.
 * SwarmAgent extends this to add delegation and coordination.
 */
export class LocalHostAgent extends BaseAgent {
  protected readonly getProvider: () => LLMService;

  constructor(deps: LocalHostAgentDeps) {
    super({ ...deps, identity: { ...deps.identity, topology: 'localhost' } });
    this.getProvider = deps.getProvider;
  }

  /**
   * @description Initializes the agent and logs provider info.
   */
  async initialize(): Promise<void> {
    await super.initialize();
    const provider = this.getProvider();
    logger.info(
      {
        agentId: this.identity.agentId,
        provider: provider.getProviderName(),
        model: this.profile.modelId,
      },
      'LocalHostAgent initialized with provider',
    );
  }

  /**
   * @description Sends a message through the resolved LLM provider.
   * @param userMessage - User message text
   * @param taskId - Optional task ID for workspace isolation
   * @param executionScopeId - Optional scope ID for child/review ticket context isolation
   * @returns LLM response content as text
   */
  async processMessage(userMessage: string, taskId?: string, executionScopeId?: string): Promise<string> {
    const provider = this.getProvider();
    const systemPrompt = this.getSystemPrompt();

    logger.info(
      {
        agentId: this.identity.agentId,
        provider: provider.getProviderName(),
        taskId,
        executionScopeId: executionScopeId || undefined,
        promptLength: systemPrompt.length,
      },
      'Processing message via LocalHostAgent',
    );

    const response = await provider.sendRequest({
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      providerId: this.profile.providerId || undefined,
      model: this.profile.modelId || undefined,
      taskId,
      agentId: this.identity.agentId,
      interactionMode: 'task',
      executionScopeId: executionScopeId || undefined,
    });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
  }

  /**
   * @description Builds a local-host-scoped system prompt by prepending host context.
   */
  override getSystemPrompt(): string {
    const base = super.getSystemPrompt();
    // Identity names and roles may originate in persisted operator-managed records. BaseAgent
    // already renders that persona through the prompt-containment pipeline; repeating either value
    // here would move attacker-controlled newlines back outside the containment boundary.
    const hostContext = '[Host Runtime: localhost]';
    return `${hostContext}\n\n${base}`;
  }

  /**
   * @description Graceful shutdown — disconnects provider if needed.
   */
  async shutdown(): Promise<void> {
    logger.info({ agentId: this.identity.agentId }, 'LocalHostAgent shutting down');
    await super.shutdown();
  }
}
