/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — POST /api/workflow-studio/assist: the talk-to-build seam (ADR-039). Hands the operator's words + the current graph to the reason-only workflow-assistant bot (agent 051), parses its single `workflow-graph` block, auto-lays-out positions, and saves the validated definition server-side so the canvas can redraw it as the operator talks.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Concierge form: renamed the route to POST /chat (the standard concierge transport, like movies/spotify) so the bot is reached the documented way; the brain runs via the orchestrator (executeBotOrInline), BYOK on the swarm default login. See docs/building-a-bot.md.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Talk-to-build now fires the surface dock: `message` strips the workflow-graph (and any other) fence but PRESERVES the reply's optional oshal:surface fence (stripBotFencesExceptSurface), so the studio's talk-to-build client can relay those bridge ops to its own co-resident surface dock and then strip the fence before display. Previously message stripped ALL fences, so the V3 persona's oshal:surface ops were silently discarded (dock never fired) — the surface fence is a control channel the client, not the server, consumes here (the shell relay refuses a to_surface from a non-chat-rail frame).
 */

import { Router, type Request, type Response } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import {
  WorkflowStudioService,
  type WorkflowStudioNode,
  type WorkflowStudioEdge,
} from '@/features/workflow-studio';
import { createChildLogger } from '@/shared/logger';
import { executeBotOrInline } from './inline-bot-execution';

const logger = createChildLogger({ module: 'workflow-studio-assist-routes' });

/** The reason-only Workflow Studio builder bot (persona workflow-assistant.yaml, registry id 051). */
const WORKFLOW_ASSISTANT_AGENT_ID = 'a0000000-0000-0000-0000-000000000051';

const botClient = new BotNodeClient(createRegistryEndpointResolver());

/** A node/edge graph as emitted by the bot (positions are added here, not by the bot). */
export interface EmittedGraph {
  name?: string;
  description?: string;
  nodes: Array<{ id: string; type: string; title?: string; description?: string; config?: Record<string, unknown> }>;
  edges: Array<{ id?: string; source: string; target: string; label?: string; condition?: string }>;
}

/**
 * @description The authenticated caller's OIDC sub, or null when unauthenticated.
 * @param req - Express request
 * @returns the caller sub or null
 */
function callerSub(req: Request): string | null {
  return (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub ?? null;
}

/**
 * @description Extract the single `workflow-graph` JSON object from the bot's reply. Accepts a
 * ```workflow-graph fenced block, a generic ```json block, or a bare top-level object. Returns
 * null when the bot emitted prose only (e.g. a clarifying question) or nothing parseable.
 * @param reply - the bot's raw text response
 * @returns the parsed graph or null
 */
export function parseGraphBlock(reply: string): EmittedGraph | null {
  if (!reply) return null;
  const candidates = [
    ...extractFencedBlocks(reply, 'workflow-graph'),
    ...extractFencedBlocks(reply, 'json'),
    ...extractFencedBlocks(reply, ''),
  ];
  const bare = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  if (bare.includes('{')) {
    candidates.push(bare);
  }

  for (const candidate of candidates) {
    const graph = parseGraphCandidate(candidate);
    if (graph) {
      return graph;
    }
  }
  return null;
}

function extractFencedBlocks(reply: string, language: string): string[] {
  const escaped = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = language
    ? new RegExp(`\`\`\`${escaped}\\s*([\\s\\S]*?)\`\`\``, 'gi')
    : /```\s*([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(reply)) !== null) {
    const candidate = String(match[1] ?? '').trim();
    if (candidate.includes('{')) {
      blocks.push(candidate);
    }
  }
  return blocks;
}

function parseGraphCandidate(candidate: string): EmittedGraph | null {
  if (!candidate || !candidate.includes('{')) return null;
  try {
    const obj = JSON.parse(candidate.trim());
    if (obj && Array.isArray(obj.nodes) && obj.nodes.length > 0) return obj as EmittedGraph;
    return null;
  } catch {
    return null;
  }
}

/** Matches a complete fenced ``` block, capturing its info string (chars up to the first newline). */
const FENCED_BLOCK = /```([^\n`]*)\n?[\s\S]*?```/g;

/**
 * @description Strips every fenced ``` code block from a bot reply EXCEPT the `oshal:surface` control
 * fence, which is left intact so the browser talk-to-build client can relay its bridge ops to the
 * studio's OWN surface dock and then strip the fence before display. The builder emits a mandatory
 * `workflow-graph` block (parsed + rendered on the canvas here) and MAY emit an optional
 * `oshal:surface` block; the graph block — and any stray code block — is control syntax the operator
 * must never see, but the surface block is consumed CLIENT-side (the shell relay refuses a to_surface
 * from a non-chat-rail frame, so a same-iframe self-drive, not a server strip, is the correct path).
 * @param reply - the bot's raw text response
 * @returns the reply with graph/other fences removed and the oshal:surface fence preserved
 */
export function stripBotFencesExceptSurface(reply: string): string {
  return String(reply ?? '')
    .replace(FENCED_BLOCK, (whole: string, info: string) =>
      (/^\s*oshal:surface\b/i.test(String(info)) ? whole : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @description Lay the bot's nodes out in a simple top-down column so the saved definition has the
 * `position` the schema requires (the bot reasons about flow, not pixels). The operator can drag
 * afterward; ids are stable so refinements re-use these slots.
 * @param graph - the emitted graph
 * @returns nodes + edges shaped for WorkflowStudioService.saveDefinition
 */
function toStudioGraph(graph: EmittedGraph): { nodes: WorkflowStudioNode[]; edges: WorkflowStudioEdge[] } {
  const nodes = graph.nodes.map((n, i) => ({
    id: String(n.id),
    type: n.type,
    title: String(n.title || n.type || `Step ${i + 1}`),
    description: String(n.description || ''),
    position: { x: 320, y: 80 + i * 130 },
    config: (n.config && typeof n.config === 'object') ? n.config : {},
  })) as WorkflowStudioNode[];
  const edges = (graph.edges || []).map((e, i) => ({
    id: String(e.id || `e-${e.source}-${e.target}-${i}`),
    source: String(e.source),
    target: String(e.target),
    ...(e.label ? { label: String(e.label) } : {}),
    ...(e.condition ? { condition: String(e.condition) } : {}),
  })) as WorkflowStudioEdge[];
  return { nodes, edges };
}

/**
 * @description Builds the prompt handed to the reason-only builder bot. The persona owns the output
 * contract; this just supplies the request and the current graph for refinement context.
 * @param description - the operator's spoken/typed request this turn
 * @param current - the current definition (may be null on the first turn)
 * @returns the prompt text
 */
function buildPrompt(description: string, current: { name?: string; nodes?: unknown[]; edges?: unknown[] } | null): string {
  const currentGraph = current && Array.isArray(current.nodes) && current.nodes.length
    ? JSON.stringify({ name: current.name, nodes: current.nodes, edges: current.edges })
    : '(none — this is a new workflow)';
  return [
    `Operator request: ${description}`,
    '',
    `Current graph (JSON): ${currentGraph}`,
    '',
    'Emit your prose summary then exactly one `workflow-graph` block per your output contract. If the request is too vague to graph, ask ONE clarifying question and emit no block.',
  ].join('\n');
}

/**
 * @description Routes for the talk-to-build concierge. Mount at /api/workflow-studio behind
 * requiresAuth. POST /chat is the standard concierge transport (brain via the orchestrator).
 * @param ctx - application context (orchestrator + pool)
 * @returns an Express router exposing POST /chat
 */
export function createWorkflowStudioAssistRoutes(ctx: AppContext): Router {
  const router = Router();
  const service = new WorkflowStudioService();

  router.post('/chat', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }
    const description = String((req.body?.description ?? '')).trim();
    const definitionId = req.body?.definitionId ? String(req.body.definitionId) : null;
    if (!description) {
      res.status(400).json({ success: false, error: 'A description is required.' });
      return;
    }

    try {
      // Resolve (or create) the draft the bot is refining.
      let definition = definitionId ? await service.getDefinition(definitionId) : null;
      if (!definition) {
        definition = await service.createDefinition({ description });
      }

      logger.info({ sub, definitionId: definition.id, descLen: description.length }, 'Workflow assist request');

      const result = await executeBotOrInline(ctx, botClient, WORKFLOW_ASSISTANT_AGENT_ID, {
        text: buildPrompt(description, definition),
        taskId: `wfstudio-${sub}`,
        workspaceFolderId: `wfstudio-${sub}`,
        agentId: WORKFLOW_ASSISTANT_AGENT_ID,
        agenticMode: true,
        direct: true,
        userSub: sub,
      });

      const prose = String(result.response ?? '');
      const graph = parseGraphBlock(prose);

      // No graph → the bot asked a clarifying question (or said nothing usable). Hand the prose back
      // (fence-safe: a surface fence is preserved for the client, any code fence is stripped).
      if (!graph) {
        res.json({ success: true, needsInput: true, definitionId: definition.id, message: stripBotFencesExceptSurface(prose) });
        return;
      }

      // Persist the bot's graph (server-side Zod validation is the safety net — a bad graph 422s).
      const { nodes, edges } = toStudioGraph(graph);
      const saved = await service.saveDefinition({
        id: definition.id,
        name: String(graph.name || definition.name || 'Untitled Workflow'),
        description: graph.description ? String(graph.description) : definition.description,
        nodes,
        edges,
      });

      logger.info({ sub, definitionId: saved.id, nodeCount: nodes.length }, 'Workflow assist applied');
      res.json({
        success: true,
        definitionId: saved.id,
        definition: saved,
        // Strip the graph fence (and any code block) but KEEP the optional oshal:surface fence so the
        // talk-to-build client relays its bridge ops to the dock, then strips it before display.
        message: stripBotFencesExceptSurface(prose),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workflow assist failed';
      logger.error({ err: error, sub }, 'Workflow assist failed');
      res.status(422).json({ success: false, error: message });
    }
  });

  return router;
}
