/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Internal tool bridge for the Claude Code MCP server:
 *                     |                             | list a bot's swarm-registered tools and execute one
 *                     |                             | through the SAME server-side executor, user-scoped.
 */

/**
 * @description
 * Service-secret-gated endpoints that let the Claude Code harness reach a bot's
 * swarm-registered (agent_tools) framework/app tools — which it otherwise cannot,
 * because the CLI harness only sees Bash + static MCP servers, not the OSHAL tool
 * registry. The companion stdio bridge `scripts/oshal-tools-mcp.mjs` calls these:
 *
 *   GET  /api/tools/for-agent/:agentId  → the bot's enabled tools (MCP tools/list)
 *   POST /api/tools/execute             → run one tool user-scoped (MCP tools/call)
 *
 * Execution flows through ToolExecutorService — the same path the function-calling
 * harnesses use — so it is consistent, user-scoped (OSHAL_USER_SUB), and audited.
 * Mounted under /api/tools behind serviceSecretOr(requiresAuth).
 */
import { Router, type Request, type Response } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { AgentToolRepository } from '@/entities/tool';
import { ToolExecutorService } from '@/features/chat-orchestration';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { emitAuditEvent } from '@/features/governance';

const logger = createChildLogger({ module: 'internal-tool-bridge' });

/**
 * Audit one tool execution to the append-only access trail. Best-effort and non-throwing
 * (delegates to emitAuditEvent); no-ops without a pool. Exported for unit coverage of the
 * event mapping. Instrumenting the bridge here audits every tool a persona/harness bot runs
 * user-scoped, which is the main "bots acting on user accounts" path.
 */
export async function emitToolAudit(
  pool: Pool | null | undefined,
  actorSub: string | null,
  toolName: string,
  agentId: string,
  outcome: 'ok' | 'error',
): Promise<boolean> {
  if (!pool) return false;
  return emitAuditEvent(pool, {
    actorSub,
    action: 'tool.execute',
    resourceType: 'tool',
    resourceId: toolName,
    decision: outcome === 'ok' ? 'allow' : 'info',
    metadata: { agentId, outcome },
  });
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema as Record<string, unknown>;
  if (typeof schema === 'string' && schema.trim()) {
    try {
      const parsed = JSON.parse(schema) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* fall through */ }
  }
  return { type: 'object', properties: {} };
}

export function createInternalToolBridgeRoutes(ctx: AppContext): Router {
  const router = Router();
  const repo = new AgentToolRepository(ctx.pool);
  const executor = new ToolExecutorService({
    streamManager: ctx.streamManager,
    workspaceService: ctx.workspaceService,
    dynamicToolExecutorRegistry: ctx.dynamicToolExecutorRegistry,
    connectorToolExecutor: ctx.connectorSpecToolService,
  });

  /** GET /api/tools/for-agent/:agentId — enabled (auth_mode != off) registry tools for the MCP tools/list. */
  router.get('/for-agent/:agentId', async (req: Request, res: Response): Promise<void> => {
    try {
      const tools = await repo.getEnabledTools(String(req.params.agentId));
      // Only bridge swarm-app/framework tools (registered_by != 'system'). The
      // 'system' baseline tools (bash, read-file, write-file, fetch, google-search,
      // execute_command, …) are Claude Code natives or live in the base MCP config;
      // exposing them here would shadow the real ones and the server-side executor
      // can't run them ("Tool 'bash' is not supported by the server-side executor").
      const appTools = tools.filter((t) => t.registeredBy && t.registeredBy !== 'system');
      res.json({
        tools: appTools.map((t) => ({
          name: t.name,
          description: [t.description, t.usageInstructions ? `Usage: ${t.usageInstructions}` : '']
            .filter(Boolean).join(' ').slice(0, 1024),
          inputSchema: normalizeSchema(t.inputSchema),
        })),
      });
    } catch (err) {
      logger.error({ err, agentId: req.params.agentId }, 'tool bridge for-agent failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** POST /api/tools/execute — { agentId, toolName, input, taskId } → run one tool, user-scoped. */
  router.post('/execute', async (req: Request, res: Response): Promise<void> => {
    const { agentId, toolName, input, taskId } = (req.body || {}) as {
      agentId?: string; toolName?: string; input?: Record<string, unknown>; taskId?: string;
    };
    if (!agentId || !toolName) {
      res.status(400).json({ error: 'agentId and toolName are required' });
      return;
    }
    // Acting user: the trusted service-stamped sub (x-oshal-user-sub), else a session caller.
    const userSub = getTrustedServiceUserSub(req)
      ?? (typeof (req.body as { userSub?: unknown }).userSub === 'string' ? String((req.body as { userSub?: string }).userSub) : undefined);
    try {
      const output = await executor.executeTool(
        String(taskId || `mcp-${agentId}`),
        String(toolName),
        input && typeof input === 'object' ? input : {},
        String(agentId),
        userSub,
      );
      void emitToolAudit(ctx.pool, userSub ?? null, String(toolName), String(agentId), 'ok');
      res.json({ output });
    } catch (err) {
      logger.error({ err, agentId, toolName }, 'tool bridge execute failed');
      void emitToolAudit(ctx.pool, userSub ?? null, String(toolName), String(agentId), 'error');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
