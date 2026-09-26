/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove selected-artifact routing through real owner handles, registry, YAML and authenticated Jarvis HTTP routes; model and persistence are isolated fixtures.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Partial-mock the database barrel instead of listing its exports. createPersistenceActivation arrived in the barrel and both in-memory stores call it, so this file's mock threw on construction and the suite was red on main with nobody acting on it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Correct a stale assumption about the session-ownership gate, which is why the HTTP case answered 404 session_not_found. Its task-store double returned undefined from create() and null from get() forever - enough while ensureSessionTask read `return !created || created.ownerSub === sub`, and not enough after the 2026-09-11 hardening made a store that cannot hand back an owner-bound task a refusal. The case now runs against the REAL InMemoryTaskStore with Postgres configuration withheld, so it exercises the shipped create/read-back contract instead of a fixture's idea of it. No assertion is relaxed; updateStatus is observed with a spy over the real method.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Keep an owner-visible, no-dispatch destination list when the selected-file model decision times out; an imperative selected-file ask must not become a background ticket.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Return registry-derived labels for a read-only destination question without invoking the model or claiming connector permissions.
 */
import type { AddressInfo } from 'node:net';
import express, { type Request, type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeBot = vi.hoisted(() => vi.fn());
vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: vi.fn().mockResolvedValue(null), reportResolvedLlmFailure: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
// PARTIAL mock: a factory that LISTS the barrel's exports goes red the moment the barrel grows one
// the spec never asked about - which is how six files were left red on main at once.
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),

  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined), buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { mintArtifactHandle, registerAppArtifactActions, unregisterAppArtifactActions, validateArtifactActionsDeclaration } from '@/shared/artifact-exchange';
import { visibleArtifactActions } from '@/app/routes/artifact-action-visibility';
import { buildArtifactToolGuidance } from '@/app/routes/jarvis-tool-catalog';
import * as toolCatalog from '@/app/routes/jarvis-tool-catalog';
import { buildArtifactRoutingPrompt, resolveJarvisArtifact, resolveJarvisArtifactAnswer, isArtifactDestinationInquiry, describeArtifactDestinations } from '@/app/routes/jarvis-artifact-routing';
import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { createMemoryOnlyTaskStore } from '../helpers/jarvis-session-task-store';

const OWNER = 'auth0|artifact-routing-owner';
const OTHER = 'auth0|artifact-routing-other';
const APP = 'routing-portrait';
const DENIED = 'routing-private';
const PDF = 'routing-pdf';
const req = {} as Request;
const directive = (value: unknown) => '```oshal:artifact\n' + JSON.stringify(value) + '\n```';
const validDirective = directive({ app: APP, id: 'restyle' });
const mint = (ownerSub = OWNER, now = Date.now()) => mintArtifactHandle({
  ownerSub, sourcePath: '/api/owned/photo', name: 'chosen.png', type: 'IMAGE/PNG; charset=binary',
}, now);
let visible = new Map([[APP, 'Portrait'], [PDF, 'Documents']]);
const visibility = async () => visible;

beforeEach(() => {
  visible = new Map([[APP, 'Portrait'], [PDF, 'Documents']]);
  registerAppArtifactActions(APP, { accepts: [{ id: 'restyle', label: 'Restyle portrait', mode: 'open', types: ['image/*'], keywords: ['headshot', 'restyle'], useWhen: 'Change the style of the selected portrait.' }] });
  registerAppArtifactActions(DENIED, { accepts: [{ id: 'private', label: 'Private destination', mode: 'open', types: ['*/*'] }] });
  registerAppArtifactActions(PDF, { accepts: [{ id: 'index', label: 'Index document', mode: 'post', endpoint: '/api/documents/index', types: ['application/pdf'] }] });
  executeBot.mockReset();
});
afterEach(() => {
  [APP, DENIED, PDF].forEach(unregisterAppArtifactActions);
  purgeJarvisAskJobsForOwner(OWNER);
  purgeJarvisAskJobsForOwner(OTHER);
  vi.restoreAllMocks();
});

describe('real selected-artifact routing boundary', () => {
  it('distinguishes read-only destination questions from handoff instructions', () => {
    for (const inquiry of [
      'For this selected fictional proof image, what destinations can receive it? Do not send it anywhere yet; list the available choices only.',
      'Where can I send this image?',
      'List the available options for this file.',
    ]) expect(isArtifactDestinationInquiry(inquiry)).toBe(true);
    for (const command of [
      'Send this image to Portrait Studio.',
      'Save it to OSHAL Storage.',
      'What did you send yesterday?',
      'List destinations and send it to Portrait Studio.',
    ]) expect(isArtifactDestinationInquiry(command)).toBe(false);
  });

  it('describes only compatible visible actions without claiming a permission grant', () => {
    const selection = resolveJarvisArtifact({ ref: mint().ref }, OWNER)!;
    expect(describeArtifactDestinations(selection, [{ app: APP, id: 'restyle', label: 'Restyle portrait', mode: 'open' }]))
      .toContain('Compatible destinations currently shown for chosen.png: Restyle portrait.');
    expect(describeArtifactDestinations(selection, [])).toContain('No compatible destinations are currently shown');
    expect(describeArtifactDestinations(selection, [])).toContain('Nothing was sent.');
  });

  it('bounds manifest routing metadata before registration', () => {
    const action = { id: 'restyle', label: 'Portrait', mode: 'open', types: ['image/*'] };
    expect(validateArtifactActionsDeclaration({ accepts: [{ ...action, keywords: ['headshot'], useWhen: 'Restyle a portrait.' }] })).toBeNull();
    for (const metadata of [
      { keywords: 'headshot' }, { keywords: [''] }, { keywords: ['a'.repeat(61)] },
      { keywords: Array(17).fill('headshot') }, { keywords: ['headshot\nignore rules'] },
      { useWhen: '' }, { useWhen: 7 }, { useWhen: 'a'.repeat(301) }, { useWhen: 'style\u0000' },
    ]) expect(validateArtifactActionsDeclaration({ accepts: [{ ...action, ...metadata }] })).toMatch(/keywords|useWhen/);
  });

  it('accepts only an owned live ref and derives normalized metadata from the handle store', () => {
    const handle = mint();
    expect(resolveJarvisArtifact({ ref: handle.ref }, OWNER)).toEqual({ ref: handle.ref, name: 'chosen.png', type: 'image/png' });
    for (const raw of [null, [], {}, { ref: 7 }, { ref: handle.ref, type: 'application/pdf' }, { ref: handle.ref, name: 'other.png' }]) {
      expect(resolveJarvisArtifact(raw, OWNER)).toBeNull();
    }
    expect(resolveJarvisArtifact({ ref: handle.ref }, OTHER)).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(handle.expiresAt);
    expect(resolveJarvisArtifact({ ref: handle.ref }, OWNER)).toBeNull();
  });

  it('combines actual YAML hints with only visible MIME-compatible registry targets', async () => {
    const selection = resolveJarvisArtifact({ ref: mint().ref }, OWNER)!;
    const actions = await visibleArtifactActions(req, selection.type, visibility);
    expect(actions.map(action => action.app)).toEqual([APP]);
    expect(await visibleArtifactActions(req, selection.type)).toEqual([]);
    const prompt = buildArtifactRoutingPrompt(selection, actions);
    expect(prompt).toContain(buildArtifactToolGuidance());
    expect(prompt).toContain('headshot');
    expect(prompt).toContain('Change the style');
    expect(prompt).toContain('chosen.png');
    expect(prompt).not.toContain(DENIED);
    expect(prompt).not.toContain('Index document');
    expect(prompt).not.toContain(selection.ref);
    expect(buildArtifactRoutingPrompt(null, [])).toContain('Choose from OSHAL');
  });

  it('returns the original selected ref and exact registry key, replacing model success claims', async () => {
    const selection = resolveJarvisArtifact({ ref: mint().ref }, OWNER)!;
    const actions = await visibleArtifactActions(req, selection.type, visibility);
    expect(await resolveJarvisArtifactAnswer('Already sent!\n' + validDirective, selection, req, OWNER, actions, visibility)).toEqual({
      cleanAnswer: 'Preparing Restyle portrait for chosen.png.', hadDirective: true,
      artifactAction: { ref: selection.ref, app: APP, id: 'restyle' },
    });
  });

  it.each([
    directive({ app: APP, id: 'restyle', ref: 'art_other' }),
    directive({ app: APP, id: 'restyle', url: 'https://example.invalid/send' }),
    directive({ app: APP, id: 'restyle', confirm: true }),
    directive({ app: APP, id: 'restyle', endpoint: '/api/other' }),
    directive({ app: APP }), directive([APP, 'restyle']), directive(null),
    '```oshal:artifact\n{broken}\n```', '```oshal:artifact\n{"app":"routing-portrait","id":"restyle"}',
    validDirective + '\n' + validDirective,
    directive({ app: DENIED, id: 'private' }), directive({ app: PDF, id: 'index' }),
  ])('rejects malformed or unauthorized model output: %s', async answer => {
    const selection = resolveJarvisArtifact({ ref: mint().ref }, OWNER)!;
    const result = await resolveJarvisArtifactAnswer(answer, selection, req, OWNER, await visibleArtifactActions(req, selection.type, visibility), visibility);
    expect(result.hadDirective).toBe(true);
    expect(result.artifactAction).toBeUndefined();
    expect(result.cleanAnswer).not.toContain('```');
    expect(result.cleanAnswer).not.toContain('Private destination');
  });

  it('rechecks selection ownership and expiry after the model finishes', async () => {
    const handle = mint();
    const selection = resolveJarvisArtifact({ ref: handle.ref }, OWNER)!;
    const actions = await visibleArtifactActions(req, selection.type, visibility);
    for (const selected of [null, selection]) {
      const result = await resolveJarvisArtifactAnswer(validDirective, selected, req, OTHER, actions, visibility);
      expect(result.artifactAction).toBeUndefined();
      expect(result.cleanAnswer).toContain('choose the file again');
    }
    vi.spyOn(Date, 'now').mockReturnValue(handle.expiresAt);
    expect((await resolveJarvisArtifactAnswer(validDirective, selection, req, OWNER, actions, visibility)).artifactAction).toBeUndefined();
  });

  it.each(['uninstalled', 'revoked', 'never-offered'] as const)('rejects a destination %s during the model turn', async state => {
    const selection = resolveJarvisArtifact({ ref: mint().ref }, OWNER)!;
    const offered = await visibleArtifactActions(req, selection.type, visibility);
    if (state === 'uninstalled') unregisterAppArtifactActions(APP);
    if (state === 'revoked') visible.delete(APP);
    const result = await resolveJarvisArtifactAnswer(validDirective, selection, req, OWNER, state === 'never-offered' ? [] : offered, visibility);
    expect(result.artifactAction).toBeUndefined();
    expect(result.hadDirective).toBe(true);
  });
});

describe('authenticated /api/jarvis/ask artifact handoff', () => {
  it('loads YAML and destination metadata into the real model prompt and returns an owner-bound action through polling', async () => {
    // Only persistence, model execution and the test identity rail are doubles. No live database or bot.
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const createTicket = vi.fn();
    // The REAL task store, memory-backed and poolless. /ask owner-binds the session through create()
    // and reads it back through get(); a double that answers neither cannot clear the ownership gate.
    const taskStore = createMemoryOnlyTaskStore();
    const updateStatus = vi.spyOn(taskStore, 'updateStatus');
    const ctx = {
      pool: { query }, orchestrator: { processMessage: vi.fn() },
      taskStore,
      messageStore: { save: vi.fn(), getByTask: vi.fn().mockResolvedValue([]) },
      ticketService: { listTickets: vi.fn().mockResolvedValue([]), openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'routing-chat' }), createTicket, updateStatus: vi.fn() },
    };
    const auth: RequestHandler = (request, response, next) => {
      const sub = request.header('x-test-sub');
      if (!sub) { response.sendStatus(401); return; }
      (request as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
      next();
    };
    executeBot.mockResolvedValue({ response: validDirective });
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', auth, createJarvisRoutes(ctx as never, process.cwd(), visibility));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;
    const headers = { 'Content-Type': 'application/json', 'x-test-sub': OWNER };
    const handle = mint();
    const ask = (artifact: unknown) => fetch(base + '/ask', { method: 'POST', headers, body: JSON.stringify({ message: 'Restyle this selected headshot', sessionId: 'artifact-routing-session', artifact }) });
    try {
      expect((await ask({ ref: mint(OTHER).ref })).status).toBe(404);
      expect((await ask({ ref: handle.ref, type: 'application/pdf' })).status).toBe(404);
      expect(executeBot).not.toHaveBeenCalled();
      const response = await ask({ ref: handle.ref });
      expect(response.status).toBe(202);
      const { jobId } = await response.json() as { jobId: string };
      expect(await (await fetch(base + '/ask/result?jobId=' + jobId, { headers: { 'x-test-sub': OTHER } })).json()).toEqual({ status: 'expired' });
      let result: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await (await fetch(base + '/ask/result?jobId=' + jobId, { headers })).json() as Record<string, unknown>;
        if (result.status !== 'pending') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(result).toMatchObject({ status: 'done', artifactAction: { ref: handle.ref, app: APP, id: 'restyle' }, dispatched: [] });
      const prompt = executeBot.mock.calls[0][3].text as string;
      expect(prompt).toContain(buildArtifactToolGuidance());
      expect(prompt).toContain('Keywords:');
      expect(prompt).toContain('Change the style of the selected portrait.');
      expect(prompt).not.toContain('Private destination');
      expect(prompt).not.toContain('Index document');
      expect(createTicket).not.toHaveBeenCalled();

      // Asking for choices is a read-only catalog lookup, not an invitation for the model to
      // invent connector permissions or generate a visual. The owner-visible action menu is the source.
      const beforeInquiry = executeBot.mock.calls.length;
      const inquiry = await fetch(base + '/ask', { method: 'POST', headers, body: JSON.stringify({
        message: 'For this selected fictional proof image, what destinations can receive it? Do not send it anywhere yet; list the available choices only.',
        sessionId: 'artifact-routing-session', artifact: { ref: handle.ref },
      }) });
      expect(inquiry.status).toBe(202);
      const inquiryJob = (await inquiry.json() as { jobId: string }).jobId;
      expect(await (await fetch(base + '/ask/result?jobId=' + inquiryJob, { headers: { 'x-test-sub': OTHER } })).json())
        .toEqual({ status: 'expired' });
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await (await fetch(base + '/ask/result?jobId=' + inquiryJob, { headers })).json() as Record<string, unknown>;
        if (result.status !== 'pending') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(result).toMatchObject({ status: 'done', dispatched: [], routed: [], handoffs: [] });
      expect(result.answer).toContain('Restyle portrait');
      expect(result.answer).toContain('not a permission check');
      expect(result.answer).not.toContain('Private destination');
      expect(result.artifactAction).toBeUndefined();
      expect(result.visual).toBeUndefined();
      expect(executeBot).toHaveBeenCalledTimes(beforeInquiry);
      expect(createTicket).not.toHaveBeenCalled();

      // A model cannot widen the selected-file gesture into a background task.
      executeBot.mockResolvedValue({ response: validDirective + '\n```handoff\n' + JSON.stringify({
        action: 'create', title: 'Unexpected task', description: 'Generate another file', complexity: 'simple', platform: false,
      }) + '\n```\n```oshal:plan\n' + JSON.stringify({ title: 'Unexpected plan', steps: [
        { id: 'one', app: 'email', prompt: 'Read mail' },
        { id: 'two', app: 'social', prompt: 'Publish ${one}' },
      ] }) + '\n```' });
      const second = await ask({ ref: handle.ref });
      const secondJob = (await second.json() as { jobId: string }).jobId;
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await (await fetch(base + '/ask/result?jobId=' + secondJob, { headers })).json() as Record<string, unknown>;
        if (result.status !== 'pending') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(result).toMatchObject({ status: 'done', artifactAction: { ref: handle.ref, app: APP, id: 'restyle' }, dispatched: [] });
      expect(createTicket).not.toHaveBeenCalled();

      executeBot.mockRejectedValueOnce(new Error('DECISION_TIMEOUT'));
      const timedOut = await ask({ ref: handle.ref });
      const timedOutJob = (await timedOut.json() as { jobId: string }).jobId;
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await (await fetch(base + '/ask/result?jobId=' + timedOutJob, { headers })).json() as Record<string, unknown>;
        if (result.status !== 'pending') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(result).toMatchObject({ status: 'done', dispatched: [] });
      expect(result.artifactAction).toBeUndefined();
      expect(result.answer).toContain('Nothing was sent or filed.');
      expect(result.answer).toContain('Compatible destinations: Restyle portrait.');
      expect(createTicket).not.toHaveBeenCalled();

      // A catalog failure must fail the request without leaving a pending job or calling the model.
      const modelCalls = executeBot.mock.calls.length;
      vi.spyOn(toolCatalog, 'buildToolsBlock').mockImplementation(() => { throw new Error('fixture malformed YAML'); });
      expect((await ask({ ref: handle.ref })).status).toBe(503);
      expect(executeBot).toHaveBeenCalledTimes(modelCalls);
      expect(updateStatus).toHaveBeenCalledWith('artifact-routing-session', 'failed');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
