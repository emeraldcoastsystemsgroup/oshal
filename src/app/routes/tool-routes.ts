/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool registry routes for Layer 1 Tools Framework
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched tool-controller import to feature barrel and normalized legacy timestamp format
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added deregisterDynamicToolUI + DELETE /api/tools/dynamic/:toolName for swarm-app toggle
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D11: POST /runtime/register and DELETE /runtime/:toolName now 409 when the tool is provided by an ACTIVE app (injected manifestToolOwner port). These routes sit behind serviceSecretOr(requiresAuth) — reachable by ANY signed-in user and every bot node — and were a second write door straight past manifest ownership: POST repointed an app's tool at an arbitrary endpoint/CLI command, DELETE removed it. Manifest registration does not come through here, so failing closed costs the framework nothing.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Fail closed on tool control-plane writes: catalog/runtime mutations and executor inventory require an operator; dynamic UI registration is operator-only until an owner-bound per-bot delegation protocol exists.
 */

import { Router, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { ToolController, RuntimeToolRegistrationService } from '@/features/tool-registry';
import { CreateToolSchema } from '@/entities/tool';
import { AuthMode, InstallMethod, ToolType } from '@/shared/types/tool';
import { createChildLogger } from '@/shared/logger';
import { requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'tool-routes' });

/**
 * In-memory store for dynamically registered bot UI tools.
 * Operators may POST to /api/tools/register with a TTL; the cockpit ribbon
 * fetches GET /api/tools/dynamic and renders them as iframe buttons. Bot-node
 * service credentials cannot mutate this process-global map because the fleet
 * secret does not establish a bot identity or ownership boundary.
 * When the TTL expires the tool is removed and the button disappears.
 */
interface DynamicToolEntry {
  toolName: string;
  serverUrl: string;
  description: string;
  registeredBy: string;
  registeredAt: number;
  ttlMs: number;
  ui?: {
    sidebarIcon?: string;
    sidebarLabel?: string;
    sidebarSection?: string;
    route?: string;
    iframeUrl?: string;
  };
}

const dynamicTools = new Map<string, DynamicToolEntry>();

/**
 * ADR-085 generic per-user visibility for app dynamic tools (replaces the app-specific
 * enrollment filter that lived here before the LM carve-out). An app's manifest declares
 * `ui.dynamic.visibility: { endpoint, pattern }`; the swarm-app loader registers it here.
 * GET /dynamic loopback-calls the endpoint with the caller's session; the app answers
 * `{ keys: [...] }` — the exact toolNames that caller may see — and every registered tool
 * matching the glob that isn't listed is hidden. FAIL-CLOSED on any error.
 */
interface DynamicToolVisibility { endpoint: string; pattern: string }
const dynamicToolVisibility = new Map<string, DynamicToolVisibility>();

/** Register an app's per-user visibility rule (loader calls on activate). */
export function registerDynamicToolVisibility(appName: string, rule: DynamicToolVisibility): void {
  dynamicToolVisibility.set(appName, rule);
  logger.info({ appName, ...rule }, 'Dynamic tool visibility rule registered');
}

/** Remove an app's visibility rule (loader calls on deactivate/unload). Idempotent. */
export function deregisterDynamicToolVisibility(appName: string): void {
  dynamicToolVisibility.delete(appName);
}

/** Glob → RegExp for the visibility pattern (supports * only — tool names are simple). */
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/**
 * Apply every registered visibility rule to a tool list for one caller. Loopback-calls
 * each rule's endpoint forwarding the caller's cookie (same trick as the Test Lab): the
 * request runs exactly as the signed-in user, so the app's own auth + scoping decide.
 */
async function applyVisibilityRules<T extends { toolName: string }>(
  tools: T[],
  cookie: string | undefined,
): Promise<T[]> {
  if (dynamicToolVisibility.size === 0) return tools;
  const selfBase = `http://localhost:${process.env.PORT || '5000'}`;
  let filtered = tools;
  for (const [appName, rule] of dynamicToolVisibility) {
    const re = globToRegExp(rule.pattern);
    if (!filtered.some((t) => re.test(t.toolName))) continue; // nothing to filter for this app
    let allowed: Set<string> | null = null;
    try {
      const res = await fetch(`${selfBase}${rule.endpoint}`, {
        headers: cookie ? { cookie } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as { keys?: string[] };
        if (Array.isArray(body?.keys)) allowed = new Set(body.keys.map(String));
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, appName }, 'Visibility endpoint unreachable — failing CLOSED for its pattern');
    }
    // fail-closed: no valid answer → empty allow-list → all matching tools hidden
    const allow = allowed ?? new Set<string>();
    filtered = filtered.filter((t) => !re.test(t.toolName) || allow.has(t.toolName));
  }
  return filtered;
}

const RuntimeExecutorSchema = z.object({
  toolName: z.string().min(1).optional(),
  executorType: z.enum(['builtin', 'cli', 'api', 'mcp']),
  cliCommand: z.string().min(1).optional(),
  apiEndpoint: z.string().min(1).optional(),
  mcpServerName: z.string().min(1).optional(),
  builtinKey: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.executorType === 'cli' && !value.cliCommand) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cliCommand'], message: 'cliCommand is required for cli executors' });
  }
  if (value.executorType === 'api' && !value.apiEndpoint) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiEndpoint'], message: 'apiEndpoint is required for api executors' });
  }
  if (value.executorType === 'mcp' && !value.mcpServerName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mcpServerName'], message: 'mcpServerName is required for mcp executors' });
  }
  if (value.executorType === 'builtin' && !value.builtinKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['builtinKey'], message: 'builtinKey is required for builtin executors' });
  }
});

const RuntimeToolRegistrationSchema = z.object({
  tool: z.record(z.unknown()).optional(),
  executor: RuntimeExecutorSchema.optional(),
}).passthrough();

/** Remove expired entries. */
function pruneExpired(): void {
  const now = Date.now();
  for (const [name, entry] of dynamicTools) {
    if (now - entry.registeredAt > entry.ttlMs) {
      dynamicTools.delete(name);
    }
  }
}

/**
 * @description Creates and configures routes for tool registry operations.
 * All routes are prefixed with /api/tools in the main router.
 *
 * @param controller - ToolController instance from composition root
 * @returns Configured Express Router
 */
export function createToolRoutes(
  controller: ToolController,
  runtimeToolRegistrationService?: RuntimeToolRegistrationService,
  // Kept for call-site compat; was consumed by the LM per-class visibility filter
  // (carved out, ADR-085). Reuse when the generic visibility hook lands.
  _pool?: import('pg').Pool,
  /** ADR-085 D11: resolves the ACTIVE app that provides a tool name, if any. Injected from
   *  server.ts (SwarmAppService) rather than imported, because the service already imports from
   *  this module — a direct import would close a cycle. Absent (bot-node / tests) = no guard. */
  manifestToolOwner?: (toolName: string) => Promise<string | null>,
): Router {
  const router = Router();

  /**
   * @description Refuse to let a runtime call clobber a tool an ACTIVE app owns (ADR-085 D11).
   *
   * These routes are mounted behind `serviceSecretOr(requiresAuth)`, so ANY signed-in user and
   * every bot node can reach them. Without this check they are a second write door straight past
   * manifest ownership: POST repoints an app's tool at an arbitrary endpoint or CLI command
   * (`runtime_tool_executors` upserts ON CONFLICT DO UPDATE), and DELETE removes it outright. The
   * load-time uniqueness guard would be theatre while this door stayed open.
   *
   * Manifest-driven registration does NOT come through here — SwarmAppService calls the
   * registration service directly — so failing closed costs the framework nothing.
   *
   * @param toolName - The tool the caller wants to register over or delete.
   * @param res - Response to 409 on.
   * @returns True when the request was rejected (caller must return immediately).
   */
  const rejectIfManifestOwned = async (toolName: string, res: any): Promise<boolean> => {
    if (!manifestToolOwner) return false;
    const owner = await manifestToolOwner(toolName);
    if (!owner) return false;
    logger.warn({ toolName, owner }, 'Runtime tool write REFUSED — tool is owned by an active app');
    res.status(409).json({
      error: `Tool "${toolName}" is provided by the active app "${owner}" — a runtime call may not ` +
        `repoint or remove it. Change the app's manifest and reload it instead.`,
      toolName,
      owner,
    });
    return true;
  };

  // ── Dynamic tool registration (operator control plane) ─────────────────

  /** POST /api/tools/register — an exact operator registers a UI surface with a TTL. */
  router.post('/register', requiresOperator, (req, res) => {
    const { toolName, serverUrl, description, registeredBy, ttlMs, ui } = req.body;
    if (!toolName) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }

    const entry: DynamicToolEntry = {
      toolName,
      serverUrl: serverUrl || '',
      description: description || '',
      registeredBy: registeredBy || 'unknown',
      registeredAt: Date.now(),
      ttlMs: ttlMs || 7200000,
      ui: ui || undefined,
    };

    dynamicTools.set(toolName, entry);
    logger.info({ toolName, registeredBy: entry.registeredBy }, 'Dynamic tool registered');
    res.status(201).json({ registered: true, toolName });
  });

  /** GET /api/tools/dynamic — cockpit ribbon fetches active bot UIs, filtered per-caller
   *  by any manifest-declared visibility rules (ADR-085 generic hook — the app's own
   *  endpoint decides which of its dynamic tools this user may see; fail-closed). */
  router.get('/dynamic', async (req, res) => {
    pruneExpired();
    const tools = Array.from(dynamicTools.values()).map(t => ({
      toolName: t.toolName,
      description: t.description,
      registeredBy: t.registeredBy,
      expired: false,
      ui: t.ui,
    }));
    const visible = await applyVisibilityRules(tools, req.headers.cookie);
    res.json({ tools: visible });
  });

  /** DELETE /api/tools/dynamic/:toolName — remove a registered UI (used by swarm-app toggle) */
  router.delete('/dynamic/:toolName', requiresOperator, (req, res) => {
    const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
    const removed = dynamicTools.delete(toolName);
    logger.info({ toolName, removed }, 'Dynamic tool deregister');
    res.json({ deregistered: removed, toolName });
  });

  // ── Runtime executable tool registration ────────────────────────────────

  const registerRuntimeTool = async (req: any, res: any) => {
    if (!runtimeToolRegistrationService) {
      res.status(503).json({ error: 'Runtime tool registration is not available in this process' });
      return;
    }

    try {
      const parsed = parseRuntimeToolRegistration(req.body);
      if (await rejectIfManifestOwned(parsed.executor.toolName, res)) return;
      const result = await runtimeToolRegistrationService.registerRuntimeTool(parsed.tool, parsed.executor);
      res.status(result.created ? 201 : 200).json({
        registered: true,
        created: result.created,
        tool: result.tool,
        executor: result.executor,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Invalid runtime tool registration',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'Runtime tool registration failed');
      res.status(400).json({ error: message });
    }
  };

  router.post('/runtime/register', requiresOperator, registerRuntimeTool);
  router.post('/register-runtime', requiresOperator, registerRuntimeTool);

  router.get('/runtime', requiresOperator, async (_req, res) => {
    if (!runtimeToolRegistrationService) {
      res.status(503).json({ error: 'Runtime tool registration is not available in this process' });
      return;
    }
    const executors = await runtimeToolRegistrationService.listRuntimeExecutors();
    res.json({ executors, count: executors.length });
  });

  router.delete('/runtime/:toolName', requiresOperator, async (req, res) => {
    if (!runtimeToolRegistrationService) {
      res.status(503).json({ error: 'Runtime tool registration is not available in this process' });
      return;
    }
    const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
    if (await rejectIfManifestOwned(toolName, res)) return;
    const result = await runtimeToolRegistrationService.deregisterRuntimeTool(toolName);
    res.json({ toolName, ...result });
  });

  // ── Metadata routes (must come before parameterized routes) ─────────────
  router.get('/metadata/categories', controller.getCategories);
  router.get('/metadata/auth-groups', controller.getAuthGroups);

  // Search route
  router.get('/search', controller.searchTools);

  // CRUD routes
  router.get('/', controller.getAllTools);
  router.get('/list', controller.getAllTools);  // alias — bots call /api/tools/list
  router.get('/:id', controller.getToolById);
  router.post('/', requiresOperator, controller.createTool);
  router.put('/:id', requiresOperator, controller.updateTool);
  router.delete('/:id', requiresOperator, controller.deleteTool);

  logger.info('Tool routes registered (with dynamic registration support)');
  return router;
}

function parseRuntimeToolRegistration(body: unknown) {
  const envelope = RuntimeToolRegistrationSchema.parse(body);
  const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const toolPayload = envelope.tool ?? bodyRecord;
  const executorPayload = envelope.executor ?? bodyRecord;
  const executor = RuntimeExecutorSchema.parse(executorPayload);
  const name = readString((toolPayload as Record<string, unknown>).name)
    ?? readString(executor.toolName);
  if (!name) {
    throw new Error('Runtime tool registration requires tool.name or executor.toolName');
  }

  const tags = Array.isArray((toolPayload as Record<string, unknown>).tags)
    ? ((toolPayload as Record<string, unknown>).tags as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  const defaultAuthMode = (toolPayload as Record<string, unknown>).defaultAuthMode
    ?? (executor.executorType === 'builtin' ? AuthMode.AUTO : AuthMode.ASK);

  const rawToolPayload = toolPayload as Record<string, unknown>;
  const tool = CreateToolSchema.parse({
    ...rawToolPayload,
    name,
    displayName: readString(rawToolPayload.displayName) ?? name,
    type: rawToolPayload.type ?? inferToolType(executor.executorType),
    category: readString(rawToolPayload.category) ?? 'runtime',
    description: readString(rawToolPayload.description) ?? `Runtime registered tool: ${name}`,
    registeredBy: readString(rawToolPayload.registeredBy)
      ?? readString(bodyRecord.registeredBy)
      ?? 'runtime-api',
    installSpec: rawToolPayload.installSpec ?? { method: InstallMethod.NONE },
    inputSchema: rawToolPayload.inputSchema ?? { type: 'object', properties: {} },
    defaultAuthMode,
    requiresApproval: rawToolPayload.requiresApproval
      ?? executor.executorType !== 'builtin',
    tags: Array.from(new Set([...tags, 'runtime-registered'])),
  });

  return {
    tool,
    executor: {
      ...executor,
      toolName: name,
      runtimeRegistered: true,
      registeredAt: new Date().toISOString(),
    },
  };
}

function inferToolType(executorType: 'builtin' | 'cli' | 'api' | 'mcp'): ToolType {
  if (executorType === 'api') return ToolType.API;
  if (executorType === 'mcp') return ToolType.MCP;
  return ToolType.CLI;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Register a tool UI directly (in-process registration path used by the
 * swarm-app loader for manifest ui.static/dynamic surfaces).
 */
export function registerDynamicToolUI(toolName: string, label: string, icon: string, iframeUrl: string, registeredBy: string = 'swarm-app'): void {
  dynamicTools.set(toolName, {
    toolName,
    serverUrl: '',
    description: label,
    registeredBy,
    registeredAt: Date.now(),
    ttlMs: Number.MAX_SAFE_INTEGER, // never expires for in-process tools
    ui: {
      sidebarIcon: icon,
      sidebarLabel: label,
      sidebarSection: 'top',
      route: `tool-${toolName}`,
      iframeUrl,
    },
  });
  logger.info({ toolName, label, iframeUrl }, 'Dynamic tool UI registered in ribbon');
}

/**
 * @description Removes a previously-registered in-process tool UI from the
 * cockpit ribbon. Used by SwarmAppService.toggleApp() when an application
 * is flipped to inactive — each ribbon icon the app owns gets removed here.
 * Safe to call on unknown toolNames (returns false).
 * @param toolName - the tool name used at registration time
 * @returns true if an entry was removed, false if no matching entry existed
 */
export function deregisterDynamicToolUI(toolName: string): boolean {
  const removed = dynamicTools.delete(toolName);
  if (removed) logger.info({ toolName }, 'Dynamic tool UI deregistered');
  return removed;
}

/**
 * @description Lists the current in-memory dynamic tool names — used by
 * SwarmAppService to determine which tools an app owns on reload.
 * @returns array of tool names currently registered
 */
export function listDynamicToolNames(): string[] {
  return Array.from(dynamicTools.keys());
}
