/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1: Node pool identity API — assign, release, status endpoints for hot-loading bot identities.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: require the configured machine secret on every /node route; validate bounded strict payloads; remove credential-bearing request logs; serialize lifecycle transitions; constrain persona reads; and restore credential/config snapshots on release or failed assignment.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrub abandoned assignment files when a pool process restarts with an active-session marker, preventing crash-resident credentials from becoming the next idle node's baseline.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createChildLogger } from '@/shared/logger';
import { requireServiceSecret } from '@/shared/middleware/authz';
import {
  applyNodeSession,
  NodePoolInputError,
  recoverAbandonedNodeSession,
  restoreNodeSession,
  type NodeSessionSnapshot,
} from './node-pool-session';

const logger = createChildLogger({ module: 'node-pool-routes' });
const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const credentialKey = /^[A-Z][A-Z0-9_]*$/;

const credentialsSchema = z.record(z.string().max(64 * 1024)).superRefine((value, ctx) => {
  const keys = Object.keys(value);
  if (keys.length > 64) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many credential fields' });
  for (const key of keys) {
    if (key.length > 128 || !credentialKey.test(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid credential field name', path: [key] });
    }
  }
});

const boundedToken = (maximum: number) => z.string().trim().min(1).max(maximum).regex(safeToken);
const assignmentRequestSchema = z.object({
  agentId: boundedToken(128),
  personaFile: z.string().trim().max(2048).optional(),
  agent: boundedToken(64),
  model: boundedToken(256),
  provider: boundedToken(128),
  credentials: credentialsSchema.optional().default({}),
}).strict();

type NodeAssignmentRequest = z.infer<typeof assignmentRequestSchema>;

/** @description Current non-secret assignment metadata for this node. */
export interface NodeAssignment {
  agentId: string;
  personaFile: string;
  agent: string;
  model: string;
  provider: string;
  assignedAt: string;
}

/** @description Node-pool lifecycle state shared with the worker runtime. */
export interface NodePoolState {
  nodeId: string;
  status: 'idle' | 'assigning' | 'active' | 'releasing';
  assignment: NodeAssignment | null;
  onAssign?: (assignment: NodeAssignment) => Promise<void>;
  onRelease?: () => Promise<void>;
  sessionSnapshot: NodeSessionSnapshot | null;
  transitionTail: Promise<void>;
}

/**
 * @description Creates the privileged node-pool control plane. The strict shared-secret
 * middleware applies to status as well as mutations so topology and assignment metadata
 * are not exposed. Assignment/release operations share a promise tail, preventing a
 * release from racing an in-flight onAssign hook.
 *
 * @param state - Mutable node-pool state shared with the worker runtime.
 * @returns Authenticated Express router for /assign, /release, and /status.
 */
export function createNodePoolRoutes(state: NodePoolState): Router {
  const router = Router();
  router.use(requireServiceSecret);
  router.post('/assign', async (req: Request, res: Response) => {
    await serializeTransition(state, () => assignNode(state, req, res));
  });
  router.post('/release', async (_req: Request, res: Response) => {
    await serializeTransition(state, () => releaseNode(state, res));
  });
  router.get('/status', (_req: Request, res: Response) => sendStatus(state, res));
  logger.info({ nodeId: state.nodeId }, 'Authenticated node pool routes registered');
  return router;
}

async function assignNode(state: NodePoolState, req: Request, res: Response): Promise<void> {
  const parsed = assignmentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid assignment request' });
    return;
  }
  if (state.status !== 'idle') {
    logger.warn({ nodeId: state.nodeId, status: state.status }, 'Rejected assignment for busy node');
    res.status(409).json({ success: false, error: 'Node must be released before assignment' });
    return;
  }
  await performAssignment(state, parsed.data, res);
}

async function performAssignment(
  state: NodePoolState,
  request: NodeAssignmentRequest,
  res: Response,
): Promise<void> {
  const startedAt = Date.now();
  state.status = 'assigning';
  logger.info(assignmentLogFields(state, request), 'Assigning node identity');
  try {
    const applied = applyNodeSession(request);
    state.sessionSnapshot = applied.snapshot;
    const assignment = buildAssignment(request, applied.personaFile);
    if (state.onAssign) await state.onAssign(assignment);
    state.assignment = assignment;
    state.status = 'active';
    logger.info({ ...assignmentLogFields(state, request), durationMs: Date.now() - startedAt }, 'Node assigned');
    res.json({ success: true, nodeId: state.nodeId, status: state.status, assignment });
  } catch (error) {
    handleAssignmentFailure(state, error, res);
  }
}

function handleAssignmentFailure(state: NodePoolState, error: unknown, res: Response): void {
  restoreNodeSession(state.sessionSnapshot);
  state.sessionSnapshot = null;
  state.assignment = null;
  state.status = 'idle';
  const expected = error instanceof NodePoolInputError;
  logger[expected ? 'warn' : 'error']({ err: error, nodeId: state.nodeId }, 'Node assignment failed');
  res.status(expected ? 400 : 500).json({
    success: false,
    error: expected ? error.message : 'Assignment failed',
  });
}

async function releaseNode(state: NodePoolState, res: Response): Promise<void> {
  if (state.status === 'idle') {
    res.json({ success: true, nodeId: state.nodeId, status: 'idle', message: 'Already idle' });
    return;
  }
  const previousAssignment = state.assignment;
  const startedAt = Date.now();
  state.status = 'releasing';
  try {
    if (state.onRelease) await state.onRelease();
    completeRelease(state);
    logger.info({
      nodeId: state.nodeId,
      previousAgentId: previousAssignment?.agentId,
      durationMs: Date.now() - startedAt,
    }, 'Node released and assignment files restored');
    res.json({ success: true, nodeId: state.nodeId, status: 'idle', previousAssignment });
  } catch (error) {
    completeRelease(state);
    logger.error({ err: error, nodeId: state.nodeId }, 'Node release hook failed; local secrets were cleared');
    res.status(500).json({ success: false, error: 'Release failed' });
  }
}

function completeRelease(state: NodePoolState): void {
  restoreNodeSession(state.sessionSnapshot);
  state.sessionSnapshot = null;
  state.assignment = null;
  state.status = 'idle';
}

function sendStatus(state: NodePoolState, res: Response): void {
  res.json({
    nodeId: state.nodeId,
    status: state.status,
    assignment: state.assignment,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage().rss,
  });
}

function assignmentLogFields(state: NodePoolState, request: NodeAssignmentRequest): Record<string, string> {
  return {
    nodeId: state.nodeId,
    agentId: request.agentId,
    agent: request.agent,
    model: request.model,
    provider: request.provider,
  };
}

function buildAssignment(request: NodeAssignmentRequest, personaFile: string): NodeAssignment {
  return {
    agentId: request.agentId,
    personaFile,
    agent: request.agent,
    model: request.model,
    provider: request.provider,
    assignedAt: new Date().toISOString(),
  };
}

async function serializeTransition(
  state: NodePoolState,
  operation: () => Promise<void>,
): Promise<void> {
  const next = state.transitionTail.then(operation, operation);
  state.transitionTail = next.then(() => undefined, () => undefined);
  await next;
}

/**
 * @description Creates the initial idle node-pool state. Credential snapshots and
 * the lifecycle serializer are intentionally internal and never included in status.
 * @returns Mutable state for the node-pool router and worker lifecycle hooks.
 */
export function createNodePoolState(): NodePoolState {
  if (process.env.NODE_POOL_MODE === 'true' && recoverAbandonedNodeSession()) {
    logger.warn('Removed credential files left by an interrupted node-pool assignment');
  }
  return {
    nodeId: process.env.NODE_ID || `node-${process.pid}`,
    status: 'idle',
    assignment: null,
    sessionSnapshot: null,
    transitionTail: Promise.resolve(),
  };
}
