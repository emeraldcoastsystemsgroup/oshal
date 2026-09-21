/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the whole chat-to-surface loop over one real origin so a browser can walk it: the unmodified cockpit shell (which self-boots the real relay), the real bundled surface-bridge contract at /dist/surface-bridge.js, the real Forge surface as the reference app, the real swarmbot chat rail with a controllable SSE stream, and the REAL message route over in-memory task/message stores seeded with one task per user so a relayed selection meets the shipped ownership guard rather than a stub.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { createMessageRoutes } from '@/app/routes/message-routes';
import { InMemoryMessageStore } from '@/entities/message';
import { InMemoryTaskStore } from '@/entities/task';
import { startWorkspaceNavigationFixture } from './workspace-navigation';

const ROOT = process.cwd();

/** The reference app this fixture walks: the Forge, whose manifest declares a real surface.ops allow-list. */
export const REFERENCE_APP = 'codex-packer';
/** The bot the cockpit points the rail at (any id — the fixture answers its profile). */
export const REFERENCE_AGENT_ID = 'c0de0000-0000-4000-8000-00000000f0f9';
/** The signed-in caller every request in this fixture carries. */
export const CALLER_SUB = 'auth0|surface-bridge-user-a';
/** A DIFFERENT user, who owns one seeded task the caller must never be able to post into. */
export const OTHER_SUB = 'auth0|surface-bridge-user-b';
/** The task id owned by {@link OTHER_SUB}. */
export const FOREIGN_TASK_ID = 'task-owned-by-user-b';

/** One observed POST /api/send-message, as the REAL route answered it. */
export interface RecordedSend {
  taskId: string;
  text: string;
  status: number;
}

/** One observed orchestrator turn — proof the message reached the conversation, not just the route. */
export interface RecordedTurn {
  taskId: string;
  text: string;
}

/**
 * @description Read the reference app's REAL surface.ops allow-list out of its shipped manifest.
 * The relay enforces this list, so the fixture must not invent one.
 * @returns The declared op names.
 */
export function referenceAllowList(): string[] {
  const manifest = loadYaml(
    readFileSync(resolve(ROOT, 'swarm-apps/codex-packer.yaml'), 'utf8'),
  ) as { surface?: { ops?: string[] } };
  return manifest.surface?.ops ?? [];
}

/**
 * @description Bundle the REAL surface-bridge contract the way vite.config.ts does, so the cockpit
 * relay imports the shipped normalizer/resolver from /dist/surface-bridge.js instead of a twin.
 * @returns The ES-module bundle source.
 */
async function bundleContract(): Promise<string> {
  const result = await build({
    entryPoints: [resolve(ROOT, 'src/features/surface-bridge/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    alias: { '@': resolve(ROOT, 'src') },
  });
  return result.outputFiles[0].text;
}

/** Session identity for every request — the real message route reads req.oidc.user.sub. */
function sessionUser(sub: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = { user: { sub, email: 'maintainer@emeraldcoastsystemsgroup.com' } };
    next();
  };
}

/** The synthesised UI profile the cockpit fetches for ?app=codex-packer, carrying the real allow-list. */
function referenceProfile() {
  return {
    name: REFERENCE_APP,
    displayName: 'Bot Forge',
    defaultView: 'tool-forge',
    hideChatPanel: false,
    hideAssistant: true,
    hideStatusBar: false,
    // synthesiseProfile forwards manifest.surface.ops here; the relay's allow-list IS this field.
    surfaceOps: referenceAllowList(),
    chatBots: [{ agentId: REFERENCE_AGENT_ID, name: 'Forge packer' }],
    chatAgent: { agentId: REFERENCE_AGENT_ID },
    ribbon: {
      items: [{ id: 'tool-forge', label: 'Forge', section: 'home', toolUi: { iframeUrl: '/api/forge' } }],
      dynamicTools: { allow: [] },
    },
  };
}

/** Serve the pages the loop needs: the unmodified shell, the contract bundle, the surface, the rail. */
function pages(app: express.Application, contractBundle: () => string): void {
  app.get(['/cockpit/', '/cockpit/index.html'], (_req, res) =>
    res.sendFile(resolve(ROOT, 'src/pages/cockpit/index.html')));
  app.get('/dist/surface-bridge.js', (_req, res) => res.type('application/javascript').send(contractBundle()));
  app.get('/api/forge', (_req, res) => res.sendFile(resolve(ROOT, 'src/api/forge.html')));
  app.get('/swarmbot/chat', (_req, res) => res.sendFile(resolve(ROOT, 'src/pages/swarmbot-chat/index.html')));
  app.use('/swarmbot/chat', express.static(resolve(ROOT, 'src/pages/swarmbot-chat')));
  app.use('/swarmbot/shared', express.static(resolve(ROOT, 'src/pages/shared')));
  app.use('/chat-assets', express.static(resolve(ROOT, 'src/pages/chat/ui')));
}

/** The reads the Forge surface and the chat rail make while booting. Nothing here is a bridge seam. */
function bootReads(app: express.Application, agentProfile: Record<string, unknown>): void {
  app.get('/api/auth/user', (_req, res) => res.json({ sub: CALLER_SUB, guestMode: false }));
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [] }));
  app.get('/api/swarm/apps/pending', (_req, res) => res.json({ pending: [] }));
  app.get('/api/agents', (_req, res) => res.json({ agents: [{ id: REFERENCE_AGENT_ID, name: 'Forge packer', status: 'online' }] }));
  app.get(`/api/agents/${REFERENCE_AGENT_ID}/profile`, (_req, res) => res.json({ profile: agentProfile }));
  app.get(`/api/agents/${REFERENCE_AGENT_ID}/tools`, (_req, res) => res.json({ tools: [] }));
  app.get('/api/providers', (_req, res) => res.json([]));
}

/**
 * @description Start the whole chat-to-surface loop on one local origin.
 * @returns The fixture origin, everything the shipped code did, and a complete shutdown.
 */
export async function startSurfaceBridgeRoundTripFixture() {
  const contract = await bundleContract();
  const taskStore = new InMemoryTaskStore();
  const messageStore = new InMemoryMessageStore();
  await taskStore.create({ taskId: FOREIGN_TASK_ID, title: 'User B thread', processingMode: 'agentic', ownerSub: OTHER_SUB });

  const sends: RecordedSend[] = [];
  const turns: RecordedTurn[] = [];
  const createdTaskIds: string[] = [];
  const streams = new Map<string, Response[]>();

  const ctx = {
    taskStore,
    messageStore,
    ticketService: {},
    workspaceService: { resolveTaskOwner: async (taskId: string) => (await taskStore.get(taskId))?.ownerSub ?? null },
    orchestrator: {
      processMessage: async (taskId: string, text: string) => {
        turns.push({ taskId, text });
        return { success: true, response: 'ok' };
      },
    },
    pool: {},
  } as never;

  const fixture = await startWorkspaceNavigationFixture((app) => {
    app.use(express.json());
    app.use(sessionUser(CALLER_SUB));
    pages(app, () => contract);
    bootReads(app, { agentId: REFERENCE_AGENT_ID, name: 'Forge packer', providerId: 'noop', modelId: 'noop' });
    app.post('/api/tasks', async (_req, res) => {
      const taskId = `task-owned-by-user-a-${createdTaskIds.length + 1}`;
      await taskStore.create({ taskId, title: 'Rail thread', processingMode: 'agentic', ownerSub: CALLER_SUB });
      createdTaskIds.push(taskId);
      res.json({ taskId });
    });
    app.get('/api/stream/:taskId', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: streaming-event\ndata: {"type":"connection"}\n\n');
      const open = streams.get(req.params.taskId) ?? [];
      open.push(res);
      streams.set(req.params.taskId, open);
      req.on('close', () => { streams.set(req.params.taskId, (streams.get(req.params.taskId) ?? []).filter((r) => r !== res)); });
    });
    // Observe what the REAL route answered without standing in front of it.
    app.post('/api/send-message', (req, res, next) => {
      const body = req.body as { taskId?: string; text?: string };
      res.on('finish', () => sends.push({ taskId: String(body?.taskId ?? ''), text: String(body?.text ?? ''), status: res.statusCode }));
      next();
    });
    // The SHIPPED message route — its ownership guard is what a cross-user selection has to meet.
    app.use('/api', createMessageRoutes(ctx));
  });

  Object.assign(fixture.state.profiles, { [REFERENCE_APP]: referenceProfile() as never });

  const foreign = express();
  foreign.get('/forge-attempt', (_req, res) => res.type('html').send(FOREIGN_PAGE));
  const foreignServer = foreign.listen(0, '127.0.0.1');
  await new Promise<void>((done) => foreignServer.once('listening', done));

  return {
    origin: fixture.origin,
    foreignOrigin: `http://127.0.0.1:${(foreignServer.address() as AddressInfo).port}`,
    sends,
    turns,
    createdTaskIds,
    allowedOps: referenceAllowList(),
    /**
     * @description Push one assistant reply down the rail's live stream, exactly as the swarm does.
     * @param taskId - The conversation the reply belongs to.
     * @param text - The raw reply text, surface fence included.
     * @returns How many open streams received it.
     */
    pushAssistantReply(taskId: string, text: string): number {
      const open = streams.get(taskId) ?? [];
      const payload = JSON.stringify({ type: 'message', message: { text } });
      for (const res of open) res.write(`event: streaming-event\ndata: ${payload}\n\n`);
      return open.length;
    },
    /**
     * @description How many live streams the rail currently holds for one conversation.
     * @param taskId - The conversation to count.
     * @returns The number of attached EventSource connections.
     */
    streamCount(taskId: string): number {
      return (streams.get(taskId) ?? []).length;
    },
    close: async () => {
      for (const open of streams.values()) for (const res of open) res.end();
      foreignServer.closeAllConnections();
      await new Promise<void>((done) => foreignServer.close(() => done()));
      await fixture.close();
    },
  };
}

/**
 * A page on ANOTHER origin that posts perfectly-formed bridge envelopes at the cockpit shell, one
 * in each direction. The browser stamps the real origin on them, which is what makes this a
 * forged-origin case rather than a hand-set field a fake window would have believed. It is loaded
 * two ways: as a stray frame the shell never embedded, and AS the app-surface frame itself
 * (a surface that navigated off-origin), where only the relay's origin check stands in the way.
 */
const FOREIGN_PAGE = `<!doctype html><meta charset="utf-8"><title>foreign</title><script>
  var who = 'forged-from-' + (new URLSearchParams(location.search).get('as') || 'unknown');
  var base = { channel: 'oshal-surface-bridge', v: 1, app: 'codex-packer' };
  var drive = Object.assign({ op: 'render_options', prompt: who,
    options: [{ id: who, label: 'Forged option' }] }, base);
  var speak = Object.assign({ op: 'select', optionId: who, from: 'render_options' }, base);
  for (var target of [window.parent, window.top]) {
    target.postMessage(drive, '*');
    target.postMessage(speak, '*');
  }
</script>`;
