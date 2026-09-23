/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Resolve final prompt tool and
 *   capability scopes from the same persisted agent-tool assignments used by runtime authorization.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: advertise AUTO assignments only, translate them through an explicit runtime map, and attach exact per-operation scopes plus side-effect-free completion.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Resolve call-time brokered application tools by their exact persisted names. These names feed only the protected prompt authority record; execution remains in the controller MCP broker and never enters the bot-node native registry.
 */

import type { AgentToolRepository } from '@/entities/tool';
import { createChildLogger } from '@/shared/logger';
import type { PromptAuthorizationResolver } from '@/features/swarm-orchestration';
import {
  ANY_BOT_COMPLETION_SCOPE,
  ANY_BOT_COMPLETION_TOOL,
  anyBotRuntimeToolFor,
  anyBotRuntimeToolScope,
} from '@/shared/llm-runtime';

const logger = createChildLogger({ module: 'prompt-authorization-resolver' });

/**
 * @description Creates a fail-closed prompt authority resolver over persisted enabled tools.
 * A missing repository lets the prompt layer fall back to server-authored persona declarations;
 * a repository failure returns no tools so a transient database fault cannot widen model privilege.
 * @param repository - Agent-tool repository backed by the runtime database.
 * @returns Resolver, or undefined when this runtime has no database repository.
 */
export function createPromptAuthorizationResolver(
  repository: AgentToolRepository | undefined,
): PromptAuthorizationResolver | undefined {
  if (!repository) return undefined;
  return async (workloadId) => {
    try {
      const tools = (await repository.getAutoExecutableTools(workloadId))
        .filter((tool) => tool.enabled);
      const mappedTools = tools.flatMap((tool) => {
        const runtimeName = anyBotRuntimeToolFor(tool.name);
        if (!runtimeName) {
          logger.warn({ workloadId, persistedTool: tool.name }, 'Unmapped runtime tool denied');
          return [];
        }
        return [{ tool, runtimeName }];
      });
      const allowedTools = [...new Set([
        ANY_BOT_COMPLETION_TOOL,
        ...mappedTools.map(({ runtimeName }) => runtimeName),
      ])];
      const scopes = mappedTools.flatMap(({ tool }) => [
        ...tool.skills.map((skill) => `capability:${skill}`),
        ...(tool.authGroup ? [`auth-group:${tool.authGroup}`] : []),
      ]);
      logger.info({ workloadId, toolCount: allowedTools.length }, 'Resolved prompt authorization');
      return {
        allowedTools,
        scopes: [...new Set([
          ANY_BOT_COMPLETION_SCOPE,
          ...mappedTools.map(({ runtimeName }) => anyBotRuntimeToolScope(runtimeName)),
          ...scopes,
        ])],
      };
    } catch (error) {
      logger.error({ err: error, workloadId }, 'Prompt authorization resolution failed closed');
      return {
        allowedTools: [ANY_BOT_COMPLETION_TOOL],
        scopes: [ANY_BOT_COMPLETION_SCOPE, 'authorization-resolution-failed'],
      };
    }
  };
}

/**
 * @description Resolves the exact non-system AUTO grants exposed by the controller MCP bridge.
 * Unlike native runtime authorization, these names are not translated into bot-node handlers:
 * the protected direct path keeps its native registry empty and the controller revalidates every
 * brokered action immediately before ToolExecutorService runs it.
 * @param repository - Authoritative agent-tool assignments shared with the controller.
 * @returns Resolver, or undefined when this runtime has no database repository.
 */
export function createBrokeredPromptAuthorizationResolver(
  repository: AgentToolRepository | undefined,
): PromptAuthorizationResolver | undefined {
  if (!repository) return undefined;
  return async (workloadId) => {
    try {
      const tools = (await repository.getAutoExecutableTools(workloadId))
        .filter((tool) => tool.enabled && Boolean(tool.registeredBy) && tool.registeredBy !== 'system');
      return {
        allowedTools: [...new Set(tools.map((tool) => tool.name))],
        scopes: [...new Set(tools.flatMap((tool) => [
          `tool:${tool.name}`,
          ...tool.skills.map((skill) => `capability:${skill}`),
          ...(tool.authGroup ? [`auth-group:${tool.authGroup}`] : []),
        ]))],
      };
    } catch (error) {
      logger.error({ err: error, workloadId }, 'Brokered prompt authorization resolution failed closed');
      return { allowedTools: [], scopes: ['authorization-resolution-failed'] };
    }
  };
}
