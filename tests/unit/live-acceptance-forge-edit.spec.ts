/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Bot Forge edit-in-place live case (scripts/lib/live-acceptance-forge-edit.js). Doubled half: an in-memory deploy route, swarm and Packs panel drive the verdicts - an edit in place passes, and each broken fact fails by name (a re-identified bot, a ticket type that follows the drifted descriptor, a version that does not move exactly one patch, a second manifest, a panel that does not say "Updated in place", a panel that never offers the button or posts the edit and shows no result); the Lab without Chromium is degraded, a non-operator or an unmounted Forge writes nothing, a refused first deploy and every cleanup miss are red, and cleanup removes files first, then the app, then the agents. Real half: the fixture-pack port (host runner forge port -> the container helper's three ops, the docker hop replaced by an in-process call) writes real files the REAL swarm-pack router deploys over loopback HTTP; the case's route-level facts hold there, it goes red when the edit loses its prior emission, its cleanup leaves no pack, manifest, persona, app or agent, and the Lab adapter's forge port writes into the signed-in caller's own packs directory. The live companion is `node scripts/operations/live-acceptance.js forge-edit` on the box.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { fakeApi, type FakeReply } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const forgeEdit = requireCjs('../../scripts/lib/live-acceptance-forge-edit.js');
const common = requireCjs('../../scripts/lib/live-acceptance-common.js');
const helper = requireCjs('../../scripts/lib/live-acceptance-container.js');
const runner = requireCjs('../../scripts/operations/live-acceptance.js');

const OWNER = 'fixture|forge-edit-owner';
const ORIGIN = 'http://127.0.0.1:35457';
const TAG_RE = /^testlab-live-forge-edit-[0-9a-f]{8}$/;
const PERSONA_DIR = path.resolve(process.cwd(), 'ai-lab/bot-personas');

/** The breakages a doubled world can carry, one per fact the case judges, plus cleanup faults. */
interface WorldOptions {
  operator?: boolean; packsStatus?: number; firstDeployStatus?: number;
  freshIds?: boolean; followDrift?: boolean; bumpBy?: number; siblingManifest?: boolean; notEdited?: boolean;
  toast?: (json: Record<string, unknown>) => string; agentDeleteStatus?: number; stickyPersona?: boolean; createdOwnerDir?: boolean;
  noButton?: boolean; noToast?: boolean;
}

/** What the doubled world holds: the pack on disk, the swarm's apps and agents, and an event log. */
interface WorldState {
  revision: number; manifests: Set<string>; personas: Set<string>; ownerDir: 'present' | 'absent';
  apps: Map<string, Record<string, unknown>>; agents: Set<string>; events: string[]; writes: number[]; deploys: number;
  prior: { ids: Map<string, string>; version: string; ticketType: string } | null;
}

/** "1.0.0" moved `by` patches. */
function bump(version: string, by: number): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + by}`;
}

/** The deploy route's answer for this world, writing what the real route writes (manifest, personas, the loaded app). */
function simulatedDeploy(state: WorldState, options: WorldOptions, tag: string): FakeReply {
  state.deploys += 1;
  state.events.push('deploy');
  if (!state.revision) return { status: 404, json: { error: 'pack not found' } };
  if (state.deploys === 1 && options.firstDeployStatus) return { status: options.firstDeployStatus, json: { error: 'app loader unavailable' } };
  const { prior } = state;
  const ids = new Map<string, string>(common.FORGE_BOTS.map((bot: string) => [`${tag}-${bot}`,
    (!options.freshIds && prior?.ids.get(`${tag}-${bot}`)) || randomUUID()]));
  const ticketType = (!options.followDrift && prior?.ticketType) || (state.revision === 1 ? tag : `${tag}-drift`);
  const version = prior ? bump(prior.version, options.bumpBy ?? 1) : '1.0.0';
  const manifest = prior && options.siblingManifest ? `${tag}-2.yaml` : `${tag}.yaml`;
  state.manifests.add(manifest);
  for (const name of ids.keys()) state.personas.add(`${name}.yaml`);
  const bots = [...ids].map(([name, agentId]) => ({ name, agentId }));
  state.apps.set(tag, { name: tag, version, status: 'active', manifestPath: `/app/workspace-shared/deployed-apps/${manifest}`,
    agentIds: [...ids.values()], description: common.forgeRevisionDescription(tag, state.revision), manifest: { name: tag, ticketType, bots } });
  for (const id of ids.values()) state.agents.add(id);
  state.prior = { ids, version, ticketType };
  return { status: 200, json: { ok: true, app: tag, ticketType, gated: false, version, edited: options.notEdited ? false : Boolean(prior),
    bots: [...ids.keys()], agentIds: bots, openUrl: `/cockpit/?app=${tag}` } };
}

/** The swarm routes the case reads and cleans up through, over this world's apps and agents. */
function swarmRoutes(state: WorldState, options: WorldOptions) {
  return {
    'GET /api/cli-tokens/whoami': () => ({ status: 200, json: { sub: OWNER, operator: options.operator !== false } }),
    'GET /api/swarm/packs': () => ({ status: options.packsStatus ?? 200, json: { packs: [] } }),
    'POST /api/swarm/packs/:name/deploy': ({ params }: { params: Record<string, string> }) => simulatedDeploy(state, options, params.name),
    'GET /api/swarm/apps': () => ({ status: 200, json: { apps: [...state.apps.values()].map((app) => ({ name: app.name })) } }),
    'GET /api/swarm/apps/:name': ({ params }: { params: Record<string, string> }) => (state.apps.has(params.name)
      ? { status: 200, json: { app: state.apps.get(params.name) } } : { status: 404, json: { error: 'App not found' } }),
    'DELETE /api/swarm/apps/:name': ({ params }: { params: Record<string, string> }) => {
      state.events.push('unload-app');
      if (!state.apps.delete(params.name)) return { status: 404, json: { error: 'App not found' } };
      return { status: 200, json: { unloaded: true, name: params.name } };
    },
    'GET /api/agents/:id/profile': ({ params }: { params: Record<string, string> }) => (state.agents.has(params.id)
      ? { status: 200, json: { agentId: params.id } } : { status: 404, json: { error: `Agent ${params.id} not found` } }),
    'DELETE /api/swarm/agents/:id': ({ params }: { params: Record<string, string> }) => {
      state.events.push('delete-agent');
      if ((options.agentDeleteStatus ?? 200) !== 200) return { status: options.agentDeleteStatus as number, json: { error: 'Internal server error' } };
      return state.agents.delete(params.id) ? { status: 200, json: { deleted: true, agentId: params.id } } : { status: 404, json: { error: 'Agent not found' } };
    },
  };
}

/** The fixture-pack port over this world's disk. */
function fakeForge(state: WorldState, options: WorldOptions) {
  return {
    write: async (tag: string, revision: number) => {
      expect(tag).toMatch(TAG_RE);
      state.writes.push(revision);
      state.revision = revision;
      const created = Boolean(options.createdOwnerDir) && state.ownerDir === 'absent';
      if (options.createdOwnerDir) state.ownerDir = 'present';
      return { files: ['pack.json', 'bots/checker.yml', 'bots/worker.yml'], createdOwnerDir: created, createdPacksRoot: false };
    },
    state: async () => ({ pack: state.revision ? 'present' : 'absent', ownerDir: state.ownerDir, packsRoot: 'present',
      manifests: [...state.manifests].sort(), personas: [...state.personas].sort() }),
    remove: async (_tag: string, prune: { ownerDir?: boolean }) => {
      state.events.push('remove-files');
      state.revision = 0;
      state.manifests.clear();
      if (prune?.ownerDir) state.ownerDir = 'absent';
      if (options.stickyPersona) return `still on disk after removal: persona ${[...state.personas][0]}`;
      state.personas.clear();
      return null;
    },
  };
}

/** What the Packs panel shows for a deploy answer (src/api/swarm-packs.html's toast, by default). */
function panelToast(json: Record<string, unknown>): string {
  return `✓ ${json.edited ? 'Updated in place' : 'Deployed'} — ${(json.bots as unknown[]).length} bots, ticket type "${json.ticketType}" · v${json.version}. Open app →`;
}

/** One browser session the doubled panel recorded. */
interface PanelSession { viewport: unknown; urls: string[]; dialogs: string[]; clicked: string[] }

/** A response object in the shape the case reads from Playwright's waitForResponse. */
function panelResponse(tag: string, reply: FakeReply) {
  return { status: () => reply.status, json: async () => reply.json, url: () => `${ORIGIN}/api/swarm/packs/${tag}/deploy`,
    request: () => ({ method: () => 'POST' }) };
}

/**
 * A doubled Packs panel page: its deploy button raises the confirm, and only an accepted confirm posts
 * the deploy (straight to this world's route, as the real page's fetch does) and fills the toast.
 */
function panelPage(record: PanelSession, state: WorldState, options: WorldOptions) {
  let onDialog: ((dialog: { message: () => string; accept: () => Promise<void> }) => void) | null = null;
  let respond: ((response: ReturnType<typeof panelResponse>) => void) | null = null;
  let toast = '';
  const element = (selector: string) => ({
    waitFor: async () => {
      if (options.noButton || !/^button\[data-deploy="testlab-live-forge-edit-[0-9a-f]{8}"\]$/.test(selector)) throw new Error(`no element ${selector}`);
    },
    getAttribute: async (name: string) => (name === 'data-i' ? '0' : null),
    innerText: async () => toast,
    click: async () => {
      const tag = /data-deploy="([^"]+)"/.exec(selector)![1];
      record.clicked.push(tag);
      let accepted = false;
      onDialog?.({ message: () => `Deploy "${tag}" into the swarm? A pack that is already live is UPDATED in place, not duplicated.`,
        accept: async () => { accepted = true; } });
      if (!accepted) return;
      const reply = simulatedDeploy(state, options, tag);
      toast = (options.toast ?? panelToast)(reply.json as Record<string, unknown>);
      respond?.(panelResponse(tag, reply));
    },
  });
  return {
    on: (event: string, handler: typeof onDialog) => { if (event === 'dialog') onDialog = handler; },
    goto: async (url: string) => { record.urls.push(url); return { status: () => 200 }; },
    locator: (selector: string) => ({ first: () => element(selector) }),
    waitForResponse: (predicate: (r: ReturnType<typeof panelResponse>) => boolean) =>
      new Promise((resolve) => { respond = (response) => { if (predicate(response)) resolve(response); }; }),
    waitForFunction: async () => { if (options.noToast) throw new Error('page.waitForFunction: Timeout 45000ms exceeded.'); },
    close: async () => undefined,
  };
}

/** The host runner's browser port, doubled: each session opens the doubled panel. */
function fakeBrowser(state: WorldState, options: WorldOptions, sessions: PanelSession[]) {
  return {
    session: async (fn: (s: { origin: string; newPage: () => Promise<unknown> }) => Promise<void>, opts: { viewport?: unknown } = {}) => {
      const record: PanelSession = { viewport: opts.viewport, urls: [], dialogs: [], clicked: [] };
      sessions.push(record);
      await fn({ origin: ORIGIN, newPage: async () => {
        const page = panelPage(record, state, options);
        const on = page.on;
        page.on = (event, handler) => on(event, handler && ((dialog) => { record.dialogs.push(dialog.message()); handler(dialog); }));
        return page;
      } });
    },
  };
}

/** A whole doubled world: the HTTP routes, the fixture port and (unless `lab`) the browser. */
function world(options: WorldOptions = {}, lab = false) {
  const state: WorldState = { revision: 0, manifests: new Set(), personas: new Set(), ownerDir: 'absent', apps: new Map(),
    agents: new Set(), events: [], writes: [], deploys: 0, prior: null };
  const sessions: PanelSession[] = [];
  const http = fakeApi(swarmRoutes(state, options));
  const ports = { api: http.api, ownerSub: OWNER, forge: fakeForge(state, options), ...(lab ? {} : { browser: fakeBrowser(state, options, sessions) }) };
  return { state, sessions, calls: http.calls, ports };
}

/** `agent <id>` receipt labels for a name -> agentId map, sorted. */
function agentLabels(ids: Record<string, string>): string[] {
  return Object.values(ids).map((id) => `agent ${id}`).sort();
}

/** The deploy POSTs that went through the runner's own HTTP port (the panel's go through the browser). */
function routeDeploys(calls: Array<{ method: string; path: string }>): number {
  return calls.filter((c) => c.method === 'POST' && /^\/api\/swarm\/packs\/[^/]+\/deploy$/.test(c.path)).length;
}

describe('Bot Forge edit-in-place live case, over a doubled deploy route, swarm and Packs panel', () => {
  it('passes an edit in place, and removes files, then the app, then both agents', async () => {
    const w = world();
    const result = await forgeEdit.run(w.ports);
    const tag = result.evidence.tag as string;
    expect(result.state, result.detail).toBe('pass');
    expect(tag).toMatch(TAG_RE);
    expect(result.detail).toContain(`kept both agentIds and ticket type ${tag}, moved the version 1.0.0 -> 1.0.1, and left one manifest (${tag}.yaml`);
    expect(result.detail).toContain('the Packs panel said "✓ Updated in place');
    expect(result.evidence.edit.agentIds).toEqual(result.evidence.first.agentIds);
    expect(w.state.writes).toEqual([1, 2]);
    expect(routeDeploys(w.calls)).toBe(1);
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]).toMatchObject({ viewport: forgeEdit.PANEL_VIEWPORT, urls: [`${ORIGIN}/api/swarm/packs/studio`], clicked: [tag] });
    expect(w.sessions[0].dialogs[0]).toContain('UPDATED in place');
    expect(w.state.events.slice(w.state.events.indexOf('remove-files'))).toEqual(['remove-files', 'unload-app', 'delete-agent', 'delete-agent']);
    expect(result.cleanup.removed.slice(0, 5)).toEqual([`forge-pack ${tag}`, `forge-manifest ${tag}.yaml`, `persona ${tag}-checker.yaml`,
      `persona ${tag}-worker.yaml`, `swarm-app ${tag}`]);
    expect(result.cleanup.removed.slice(5).sort()).toEqual(agentLabels(result.evidence.first.agentIds));
    expect(result.cleanup.kept.map((k: string) => k.split(' (')[0])).toEqual([`authorization-posture ${tag}`, `authorization-catalog ${tag}`]);
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
    expect([w.state.apps.size, w.state.agents.size, w.state.manifests.size, w.state.personas.size, w.state.revision]).toEqual([0, 0, 0, 0, 0]);
  });

  it('fails naming each bot the edit re-identified, and deletes both identity sets', async () => {
    const w = world({ freshIds: true });
    const result = await forgeEdit.run(w.ports);
    const { tag, first, edit } = result.evidence;
    expect(result.state).toBe('fail');
    for (const bot of ['checker', 'worker']) {
      const name = `${tag}-${bot}`;
      expect(result.detail).toContain(`${name} was re-identified by the edit: ${first.agentIds[name]} became ${edit.agentIds[name]}`);
    }
    expect(result.cleanup.removed.filter((r: string) => r.startsWith('agent ')).sort())
      .toEqual([...agentLabels(first.agentIds), ...agentLabels(edit.agentIds)].sort());
    expect(w.state.agents.size).toBe(0);
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
  });

  it('fails an edit whose ticket type follows the drifted descriptor', async () => {
    const result = await forgeEdit.run(world({ followDrift: true }).ports);
    const { tag } = result.evidence;
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`the edit moved the ticket type from ${tag} to ${tag}-drift; the drifted descriptor forked a second queue`);
    expect(result.detail).toContain(`the swarm loaded ticket type ${tag}-drift, not ${tag}`);
  });

  it('fails a version that does not move exactly one patch', async () => {
    for (const [bumpBy, version] of [[0, '1.0.0'], [2, '1.0.2']] as const) {
      const result = await forgeEdit.run(world({ bumpBy }).ports);
      expect(result.state).toBe('fail');
      expect(result.detail).toContain(`the edit reported version ${version}, not 1.0.1, one patch above 1.0.0`);
    }
  });

  it('fails an edit reported as a fresh deploy, which is what the panel reads', async () => {
    const result = await forgeEdit.run(world({ notEdited: true }).ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('the edit was reported as a fresh deploy (edited is not true)');
    expect(result.detail).toContain('the Packs panel said "✓ Deployed');
  });

  it('fails a second manifest, and removes both', async () => {
    const w = world({ siblingManifest: true });
    const result = await forgeEdit.run(w.ports);
    const { tag } = result.evidence;
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`deployed-apps holds [${tag}-2.yaml, ${tag}.yaml] for the pack, not exactly ${tag}.yaml`);
    expect(result.detail).toContain(`the swarm loaded the edit from ${tag}-2.yaml, not the one manifest ${tag}.yaml it loaded first`);
    expect(result.cleanup.removed).toEqual(expect.arrayContaining([`forge-manifest ${tag}.yaml`, `forge-manifest ${tag}-2.yaml`]));
    expect(w.state.manifests.size).toBe(0);
  });

  it('fails a panel that does not say "Updated in place", even when the route got the edit right', async () => {
    const result = await forgeEdit.run(world({ toast: () => '✓ Deployed — 2 bots' }).ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('the Packs panel said "✓ Deployed — 2 bots", not "Updated in place"');
    expect(result.detail).not.toContain('re-identified');
  });

  it('fails a panel that never offers the button, and one that posts the edit but shows no result', async () => {
    const missing = world({ noButton: true });
    const unposted = await forgeEdit.run(missing.ports);
    expect(unposted.state).toBe('fail');
    expect(unposted.detail).toContain('the Packs panel did not deploy the edit: no element button[data-deploy=');
    expect(missing.state.deploys).toBe(1);
    expect(unposted.cleanup).toMatchObject({ outstanding: [], errors: [] });
    const silent = await forgeEdit.run(world({ noToast: true }).ports);
    expect(silent.state).toBe('fail');
    expect(silent.detail).toContain('the Packs panel posted the edit but showed no result: page.waitForFunction: Timeout 45000ms exceeded.');
    expect(silent.detail).not.toContain('re-identified');
    expect(silent.evidence.edit).toMatchObject({ status: 200, edited: true, version: '1.0.1' });
  });

  it('is degraded from the Lab: the edit goes through the route and the panel leg is a named gap', async () => {
    const w = world({}, true);
    const result = await forgeEdit.run(w.ports);
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain("the Packs panel leg needs the host runner's browser port (a headless Chromium); run node scripts/operations/live-acceptance.js forge-edit");
    expect(routeDeploys(w.calls)).toBe(2);
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
  });

  it('writes nothing for a caller who is not an operator, or when the Forge packs routes are not mounted', async () => {
    for (const options of [{ operator: false }, { packsStatus: 404 }]) {
      const w = world(options);
      const result = await forgeEdit.run(w.ports);
      expect(result.state).toBe('unavailable');
      expect(result.detail).toContain('Nothing was written.');
      expect(w.state.writes).toEqual([]);
      expect(routeDeploys(w.calls)).toBe(0);
    }
  });

  it('cleans up after a refused first deploy and judges nothing more', async () => {
    const w = world({ firstDeployStatus: 503 });
    const result = await forgeEdit.run(w.ports);
    const { tag } = result.evidence;
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`The first deploy did not stand pack ${tag} up: POST /api/swarm/packs/${tag}/deploy answered HTTP 503 (app loader unavailable).`);
    expect(w.state.writes).toEqual([1]);
    expect(w.sessions).toEqual([]);
    expect(result.cleanup).toMatchObject({ removed: [`forge-pack ${tag}`], kept: [], outstanding: [], errors: [] });
  });

  it('turns an agent that will not delete, or a persona left on disk, into a red cleanup', async () => {
    const stuck = await forgeEdit.run(world({ agentDeleteStatus: 500 }).ports);
    expect(stuck.state).toBe('fail');
    expect(stuck.detail).toMatch(/CLEANUP INCOMPLETE: DELETE \/api\/swarm\/agents\/[0-9a-f-]{36} answered HTTP 500/);
    const sticky = await forgeEdit.run(world({ stickyPersona: true }).ports);
    expect(sticky.state).toBe('fail');
    expect(sticky.detail).toContain('CLEANUP INCOMPLETE: still on disk after removal: persona');
  });

  it('removes a packs directory the run created, once it is empty', async () => {
    const w = world({ createdOwnerDir: true });
    const result = await forgeEdit.run(w.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.cleanup.removed[0]).toBe('packs-owner-dir packs/<owner>');
    expect(w.state.ownerDir).toBe('absent');
  });
});

/** The swarm the real pack router loads into: a double for loadApp's record and agent rows. */
interface SwarmDouble { apps: Map<string, Record<string, unknown>>; agents: Set<string>; scopes: Array<string | null | undefined> }

/** loadApp, doubled: read the manifest the REAL route wrote and hold it as the app record and its agents. */
function loadIntoSwarm(swarm: SwarmDouble, manifestPath: string, scope?: { ownerSub?: string | null }): Record<string, unknown> {
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8')) as { name: string; version: string; description: string; bots: Array<{ agentId: string }> };
  swarm.scopes.push(scope?.ownerSub);
  swarm.apps.set(manifest.name, { name: manifest.name, version: manifest.version, status: 'active', manifestPath,
    description: manifest.description, agentIds: manifest.bots.map((bot) => bot.agentId), manifest });
  for (const bot of manifest.bots) swarm.agents.add(bot.agentId);
  return {};
}

/** The operator routes the case reads and cleans up through, over the swarm double; bearer only. */
function mountSwarmDoubles(app: express.Express, swarm: SwarmDouble): void {
  const signedIn = (req: Request, res: Response, next: NextFunction) => {
    if ((req as unknown as { oidc?: unknown }).oidc) next(); else res.status(401).json({ error: 'not_authenticated' });
  };
  app.get('/api/cli-tokens/whoami', signedIn, (_req, res) => { res.json({ sub: OWNER, operator: true }); });
  app.get('/api/swarm/apps', signedIn, (_req, res) => { res.json({ apps: [...swarm.apps.values()].map((a) => ({ name: a.name })) }); });
  app.get('/api/swarm/apps/:name', signedIn, (req, res) => {
    const record = swarm.apps.get(String(req.params.name));
    if (record) res.json({ app: record }); else res.status(404).json({ error: 'App not found' });
  });
  app.delete('/api/swarm/apps/:name', signedIn, (req, res) => {
    if (swarm.apps.delete(String(req.params.name))) res.json({ unloaded: true, name: req.params.name }); else res.status(404).json({ error: 'App not found' });
  });
  app.get('/api/agents/:id/profile', signedIn, (req, res) => {
    if (swarm.agents.has(String(req.params.id))) res.json({ agentId: req.params.id }); else res.status(404).json({ error: 'not found' });
  });
  app.delete('/api/swarm/agents/:id', signedIn, (req, res) => {
    if (swarm.agents.delete(String(req.params.id))) res.json({ deleted: true, agentId: req.params.id }); else res.status(404).json({ error: 'Agent not found' });
  });
}

describe('the fixture-pack port against real files and the REAL swarm-pack router', () => {
  const TOKEN = 'oshal_pat_fixture_forge_edit_0000';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-forge-live-'));
  const saved = process.env.OSHAL_WORKSPACE_ROOT;
  const swarm: SwarmDouble = { apps: new Map(), agents: new Set(), scopes: [] };
  let server: Server;
  let base = '';

  beforeAll(async () => {
    // The highest-priority workspace variable, so the route resolves this root whatever else is set.
    process.env.OSHAL_WORKSPACE_ROOT = root;
    const { createSwarmPackRoutes } = await import('../../src/app/routes/swarm-pack-routes');
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.headers.authorization === `Bearer ${TOKEN}`) (req as unknown as { oidc: unknown }).oidc = { user: { sub: OWNER } };
      next();
    });
    app.use('/api/swarm/packs', createSwarmPackRoutes({ loadApp: async (manifestPath, scope) => loadIntoSwarm(swarm, manifestPath, scope) }));
    mountSwarmDoubles(app, swarm);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.OSHAL_WORKSPACE_ROOT; else process.env.OSHAL_WORKSPACE_ROOT = saved;
  });

  afterEach(() => {
    // A safety net only: each case asserts first that the run itself left no persona behind.
    for (const file of fs.existsSync(PERSONA_DIR) ? fs.readdirSync(PERSONA_DIR) : []) {
      if (file.startsWith('testlab-live-forge-edit-')) fs.rmSync(path.join(PERSONA_DIR, file), { force: true });
    }
  });

  /** The host runner's ports: its real HTTP port, and its forge port through the container helper's ops (the docker hop run in-process). */
  function hostPorts() {
    const inProcess = { dispose: () => undefined, call: async (request: unknown) => ({ ok: true,
      ...(await helper.execute(helper.parseRequest(JSON.stringify(request)), { workspaceRoot: root, appRoot: process.cwd() })) }) };
    return { ...runner.httpPorts(base, TOKEN), ...runner.containerPorts(inProcess, OWNER), ownerSub: OWNER };
  }

  /** What is left anywhere for a tag: pack tree, deployed-apps entries, personas, app and agents. */
  function residue(tag: string) {
    const deployed = path.join(root, 'deployed-apps');
    return { packs: fs.existsSync(path.join(root, 'packs')), manifests: fs.existsSync(deployed) ? fs.readdirSync(deployed).filter((n) => n.startsWith(tag)) : [],
      personas: fs.readdirSync(PERSONA_DIR).filter((n) => n.startsWith(tag)), apps: swarm.apps.size, agents: swarm.agents.size };
  }

  it('holds every route-level fact against the real router, and leaves nothing behind', async () => {
    const result = await forgeEdit.run(hostPorts());
    const { tag } = result.evidence;
    expect(result.state, result.detail).toBe('degraded');
    expect(result.detail).toContain(`kept both agentIds and ticket type ${tag}, moved the version 1.0.0 -> 1.0.1, and left one manifest (${tag}.yaml`);
    expect(result.evidence.edit.agentIds).toEqual(result.evidence.first.agentIds);
    expect(result.evidence).toMatchObject({ manifests: [`${tag}.yaml`], loadedManifest: `${tag}.yaml`, appsForPack: [tag] });
    expect(swarm.scopes.slice(-2)).toEqual([OWNER, OWNER]);
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
    expect(result.cleanup.removed.slice(0, 2)).toEqual(['packs-root packs', 'packs-owner-dir packs/<owner>']);
    expect(residue(tag)).toEqual({ packs: false, manifests: [], personas: [], apps: 0, agents: 0 });
  });

  it('goes red against the real router when the edit is re-emitted as a first deploy, and deletes both identity sets', async () => {
    const ports = hostPorts();
    const write = ports.forge.write;
    // The edit loses its prior emission, so the real route mints fresh ids, restarts the version and follows the drift.
    ports.forge = { ...ports.forge, write: async (tag: string, revision: number) => {
      const out = await write(tag, revision);
      if (revision === 2) fs.rmSync(path.join(root, 'deployed-apps', `${tag}.yaml`));
      return out;
    } };
    const result = await forgeEdit.run(ports);
    const { tag, first, edit } = result.evidence;
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`${tag}-worker was re-identified by the edit`);
    expect(result.detail).toContain(`the edit moved the ticket type from ${tag} to ${tag}-drift; the drifted descriptor forked a second queue`);
    expect(result.detail).toContain('the edit reported version 1.0.0, not 1.0.1');
    expect(result.cleanup.removed.filter((r: string) => r.startsWith('agent ')).sort())
      .toEqual([...agentLabels(first.agentIds), ...agentLabels(edit.agentIds)].sort());
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
    expect(residue(tag)).toEqual({ packs: false, manifests: [], personas: [], apps: 0, agents: 0 });
  });

  it('writes only a fresh or its own fixture pack, which the real router lists as a deployable swarm pack, and removes only its own', async () => {
    const { forge, api } = hostPorts();
    const tag = common.mintTag('forge-edit');
    await expect(forge.write(tag, 2)).rejects.toThrow("is not this run's fixture; not edited");
    expect((await forge.write(tag, 1)).files).toEqual(['pack.json', 'bots/checker.yml', 'bots/worker.yml']);
    await expect(forge.write(tag, 1)).rejects.toThrow('already exists for this owner; not overwritten');
    const listed = ((await api('GET', '/api/swarm/packs')).json.packs as Array<Record<string, unknown>>).find((p) => p.name === tag);
    expect(listed).toMatchObject({ mode: 'swarm', ticketType: tag, bots: ['checker', 'worker'], liveAcceptanceFixture: tag });
    const descriptorPath = path.join(root, 'packs', common.forgeUserKey(OWNER), tag, 'pack.json');
    const descriptor = fs.readFileSync(descriptorPath, 'utf8');
    fs.writeFileSync(descriptorPath, JSON.stringify({ ...JSON.parse(descriptor), liveAcceptanceFixture: 'another-run' }));
    expect(await forge.remove(tag)).toBe(`pack ${tag} carries another fixture marker; not removed`);
    expect(fs.existsSync(descriptorPath)).toBe(true);
    fs.writeFileSync(descriptorPath, descriptor);
    expect(await forge.remove(tag, { ownerDir: true, packsRoot: true })).toBeNull();
    expect(await forge.state(tag)).toEqual({ pack: 'absent', ownerDir: 'absent', packsRoot: 'absent', manifests: [], personas: [] });
  });

  it('refuses a malformed forge request in the container helper before touching disk', () => {
    const tag = common.mintTag('forge-edit');
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ op: 'forge-pack-write', sub: OWNER, id: 'testlab-live-floater-0a1b2c3d', revision: 1 }, 'not a forge-edit fixture tag'],
      [{ op: 'forge-pack-state', sub: OWNER, id: '../../etc' }, 'not a forge-edit fixture tag'],
      [{ op: 'forge-pack-write', sub: OWNER, id: tag, revision: 3 }, 'a forge fixture revision is 1 or 2'],
      [{ op: 'forge-pack-remove', sub: OWNER, id: tag, prune: { everything: true } }, 'prune must carry only ownerDir and packsRoot booleans'],
      [{ op: 'forge-pack-remove', id: tag }, 'an owner subject is required'],
    ];
    for (const [request, message] of refused) expect(() => helper.parseRequest(JSON.stringify(request))).toThrow(message);
    expect(helper.FORGE_OPS.every((op: string) => helper.POOL_FREE_OPS.includes(op))).toBe(true);
    expect(fs.existsSync(path.join(root, 'packs'))).toBe(false);
  });

  it('binds the Lab forge port to the signed-in caller under this server\'s workspace root', async () => {
    const { labPorts } = await import('../../src/app/routes/test-lab-live-acceptance');
    const sub = 'fixture|lab-forge-owner';
    const runtime = { ownerSub: sub, issuer: 'https://issuer.example', apiBaseUrl: base, ctx: {} } as unknown as Parameters<typeof labPorts>[1];
    const { forge } = labPorts('sid=fixture', runtime) as { forge: ReturnType<typeof hostPorts>['forge'] };
    const tag = common.mintTag('forge-edit');
    const written = await forge.write(tag, 1);
    expect(fs.existsSync(path.join(root, 'packs', common.forgeUserKey(sub), tag, 'pack.json'))).toBe(true);
    expect(await forge.state(tag)).toMatchObject({ pack: 'present', manifests: [], personas: [] });
    expect(await forge.remove(tag, { ownerDir: written.createdOwnerDir, packsRoot: written.createdPacksRoot })).toBeNull();
    expect(fs.existsSync(path.join(root, 'packs'))).toBe(false);
  });
});
