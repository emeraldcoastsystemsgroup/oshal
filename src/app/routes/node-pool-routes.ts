/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1: Node pool identity API — assign, release, status endpoints for hot-loading bot identities
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { buildClineConfig, buildClineGlobalState, type CredentialBag } from '@/features/llm-provider';

const logger = createChildLogger({ module: 'node-pool-routes' });

/**
 * @description Current assignment state for this node.
 */
interface NodeAssignment {
  agentId: string;
  personaFile: string;
  agent: string;
  model: string;
  provider: string;
  assignedAt: string;
}

/**
 * @description Node pool state — tracks current assignment and provides lifecycle hooks.
 */
interface NodePoolState {
  nodeId: string;
  status: 'idle' | 'assigning' | 'active' | 'releasing';
  assignment: NodeAssignment | null;
  onAssign?: (assignment: NodeAssignment) => Promise<void>;
  onRelease?: () => Promise<void>;
}

/**
 * @description Creates the node pool routes for hot-loading bot identities.
 * Only registered when NODE_POOL_MODE=true.
 *
 * @param state - Mutable node pool state shared with the server runtime
 * @returns Express router with /node/assign, /node/release, /node/status
 */
export function createNodePoolRoutes(state: NodePoolState): Router {
  const router = Router();

  /**
   * POST /node/assign — Hot-load a bot identity onto this node.
   *
   * The allocator calls this when it wants this node to become a specific bot.
   * The node loads the persona, configures the agent/provider, subscribes to
   * the bot's Redis stream channel, and starts consuming work.
   */
  router.post('/assign', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ nodeId: state.nodeId, body: req.body }, 'POST /node/assign');

    if (state.status === 'active' || state.status === 'assigning') {
      logger.warn({ nodeId: state.nodeId, currentStatus: state.status }, 'Node already assigned — reject');
      res.status(409).json({
        success: false,
        error: `Node is ${state.status} as ${state.assignment?.agentId}. Release first.`,
      });
      return;
    }

    const { agentId, personaFile, agent, model, provider, credentials, toolAuthorizations, ttlSeconds } = req.body || {};

    if (!agentId || !agent || !model || !provider) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: agentId, agent, model, provider',
      });
      return;
    }

    try {
      state.status = 'assigning';

      const assignment: NodeAssignment = {
        agentId,
        personaFile: personaFile || '',
        agent,
        model,
        provider,
        assignedAt: new Date().toISOString(),
      };

      // 1. Load persona if personaFile provided
      if (personaFile) {
        loadPersona(personaFile, agentId);
      }

      // 2. Write Cline config for the assigned provider/model
      const creds: CredentialBag = credentials || {};
      writeClineSessionConfig(provider, model, creds);

      // 3. Call the onAssign hook (server runtime wires this to SwarmAgentWorker channel swap)
      if (state.onAssign) {
        await state.onAssign(assignment);
      }

      state.assignment = assignment;
      state.status = 'active';

      logger.info({
        nodeId: state.nodeId,
        agentId,
        agent,
        model,
        provider,
        durationMs: Date.now() - startedAt,
      }, 'Node assigned successfully');

      res.json({
        success: true,
        nodeId: state.nodeId,
        status: 'active',
        assignment,
      });
    } catch (error) {
      state.status = 'idle';
      state.assignment = null;
      logger.error({ err: error, nodeId: state.nodeId }, 'Node assignment failed');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Assignment failed',
      });
    }
  });

  /**
   * POST /node/release — Release the current bot identity and return to idle.
   */
  router.post('/release', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ nodeId: state.nodeId, currentAssignment: state.assignment?.agentId }, 'POST /node/release');

    if (state.status === 'idle') {
      res.json({ success: true, nodeId: state.nodeId, status: 'idle', message: 'Already idle' });
      return;
    }

    try {
      state.status = 'releasing';
      const previousAssignment = state.assignment;

      // Call the onRelease hook (unsubscribe from Redis channels, stop worker)
      if (state.onRelease) {
        await state.onRelease();
      }

      // Clear persona
      clearPersona();

      state.assignment = null;
      state.status = 'idle';

      logger.info({
        nodeId: state.nodeId,
        previousAgentId: previousAssignment?.agentId,
        durationMs: Date.now() - startedAt,
      }, 'Node released — now idle');

      res.json({
        success: true,
        nodeId: state.nodeId,
        status: 'idle',
        previousAssignment,
      });
    } catch (error) {
      logger.error({ err: error, nodeId: state.nodeId }, 'Node release failed');
      // Force idle even on error — better than stuck in releasing state
      state.status = 'idle';
      state.assignment = null;
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Release failed',
      });
    }
  });

  /**
   * GET /node/status — Returns the current node state.
   */
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      nodeId: state.nodeId,
      status: state.status,
      assignment: state.assignment,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().rss,
    });
  });

  logger.info({ nodeId: state.nodeId }, 'Node pool routes registered');
  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @description Loads a persona YAML and writes bot-persona.json — same as bot-entrypoint.sh Step 2.
 */
function loadPersona(personaFile: string, agentId: string): void {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';

  if (!fs.existsSync(personaFile)) {
    logger.warn({ personaFile, agentId }, 'Persona file not found — using agentId as identity');
    // Write minimal persona
    const minimal = { name: agentId, role: 'worker', agentId, perspective: '', capabilities: '' };
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'bot-persona.json'), JSON.stringify(minimal, null, 2));
    return;
  }

  try {
    // Read YAML using js-yaml (same approach as ClineProvider._messagesToTask)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    const parsed = yaml.load(fs.readFileSync(personaFile, 'utf8')) as Record<string, unknown>;

    const persona = {
      name: parsed.name || agentId,
      role: parsed.role || 'worker',
      agentId: parsed.agent_id || agentId,
      perspective: parsed.perspective || '',
      capabilities: Array.isArray(parsed.capabilities) ? (parsed.capabilities as string[]).join(',') : '',
      maxConcurrent: parsed.max_concurrent || 3,
      scope: parsed.scope || 'shared',
      selectorDescriptor: parsed.selector_descriptor || '',
      personaFile,
    };

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'bot-persona.json'), JSON.stringify(persona, null, 2));
    logger.info({ personaFile, name: persona.name, agentId }, 'Persona loaded for node assignment');
  } catch (error) {
    logger.error({ err: error, personaFile }, 'Failed to load persona YAML');
    throw error;
  }
}

/**
 * @description Clears the bot persona from the config directory.
 */
function clearPersona(): void {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const personaPath = path.join(configDir, 'bot-persona.json');
  if (fs.existsSync(personaPath)) {
    fs.unlinkSync(personaPath);
    logger.info('Cleared bot persona on release');
  }
}

/**
 * @description Writes Cline session config for the assigned provider/model.
 */
function writeClineSessionConfig(provider: string, model: string, credentials: CredentialBag): void {
  const configDir = process.env.CLINE_CONFIG_DIR || path.join(process.env.HOME || '/root', '.cline');

  const config = buildClineConfig(provider, model, credentials);
  if (config) {
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    logger.info({ configPath, provider, model }, 'Wrote Cline config.json for assignment');
  }

  const globalState = buildClineGlobalState(provider, model, credentials);
  const gsPath = path.join(configDir, 'data', 'globalState.json');
  fs.mkdirSync(path.dirname(gsPath), { recursive: true });

  // Merge with existing globalState (preserve non-provider fields)
  let existing: Record<string, unknown> = {};
  try { if (fs.existsSync(gsPath)) existing = JSON.parse(fs.readFileSync(gsPath, 'utf8')); } catch { /* ignore */ }
  fs.writeFileSync(gsPath, JSON.stringify({ ...existing, ...globalState }, null, 2));
  logger.info({ gsPath, provider, model }, 'Wrote Cline globalState.json for assignment');
}

/**
 * @description Creates the initial node pool state for the server runtime.
 */
export function createNodePoolState(): NodePoolState {
  const nodeId = process.env.NODE_ID || `node-${process.pid}`;
  return {
    nodeId,
    status: 'idle',
    assignment: null,
  };
}
