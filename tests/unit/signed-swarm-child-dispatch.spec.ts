/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The refresher keeps the unit assigned until the node returns even after the child is cancelled (the node keeps working), and a child that has already ended is never sent to the node.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for build execution crossing the signed bot-node hop (signed-child-dispatch.ts). Drives the real SwarmExecutionLifecycleService.runExecutionPolicy with the signed dispatcher wired, a real BotNodeClient holding a locally generated Ed25519 key, the real endpoint resolver over the real registry, and a real loopback node that verifies every token against the public half and writes into the root folder it is handed. Only the execution policy runner (it just calls dispatchExecution) and the work-item store are doubled. Covers the seven endpoints, the token's owner binding, the allowlist refusal before any token, a throwing client with no mesh fallback, ownerless system work, the work-item refresher, and the unchanged mesh path without signing.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BotNodeClient, isControllerInlineContainer } from '@/features/agent-management';
import { createDelegationTokenVerifier } from '@/shared/security/delegation-token';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { CONTROLLER_SYSTEM_SUBJECT } from '@/shared/security/delegation-http-policy';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { DelegationTokenClaims } from '@/shared/types';
import { resolveBotNodeEndpoint } from '@/app/extensions/swarm/resolve-bot-node-endpoint';
import { getActiveRegistry, isBotAccessibleTo } from '@/app/extensions/swarm/swarm-bot-registry';
import {
  BUILD_EXECUTION_TARGETS,
  createSignedChildDispatcher,
  type SignedChildDispatcher,
} from '@/features/swarm-orchestration/services/signed-child-dispatch';
import { SwarmExecutionLifecycleService } from '@/features/swarm-orchestration/services/swarm-execution-lifecycle-service';

const KID = 'spec-signed-child-dispatch';
const PAIR = generateKeyPairSync('ed25519');
const OWNER = 'child-dispatch-owner-sub';
const ISSUER = 'https://issuer.fixture.invalid';
const ROOT_ID = '22222222-3333-4444-8555-666666666666';
const CODE_DEVELOPER = 'a0000000-0000-0000-0000-000000000002';
const OSHAL_DEVELOPER = 'de000000-0000-0000-0000-000000000001';
const SEVEN = {
  'a0000000-0000-0000-0000-000000000002': 'oshal-local-code-developer',
  'a0000000-0000-0000-0000-000000000003': 'oshal-local-code-reviewer',
  'a0000000-0000-0000-0000-000000000004': 'oshal-local-documentation-writer',
  'a0000000-0000-0000-0000-000000000005': 'oshal-local-test-engineer',
  'a0000000-0000-0000-0000-000000000008': 'oshal-local-devops',
  'a0000000-0000-0000-0000-00000000000c': 'oshal-local-research-bot',
  'a0000000-0000-0000-0000-00000000000e': 'oshal-local-tester-bot',
};

const pem = (key: KeyObject, type: 'pkcs8' | 'spki') => key.export({ format: 'pem', type }).toString();
const SIGNING_ENV = { OSHAL_DELEGATION_SIGNING_KID: KID, OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: pem(PAIR.privateKey, 'pkcs8') } as NodeJS.ProcessEnv;
const verifier = createDelegationTokenVerifier({ env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ [KID]: pem(PAIR.publicKey, 'spki') }) } });

interface ReceivedDispatch { body: Record<string, unknown>; claims?: DelegationTokenClaims; verifyError?: string }

let workspaceRoot: string;
let node: { baseUrl: string; received: ReceivedDispatch[]; delayMs: number; close: () => Promise<void> };

/**
 * @description A real loopback bot node: it verifies the delegation token against the public half,
 * writes a deliverable under the root folder it is handed (standing in for the node's engine), and
 * answers with the execution result.
 */
async function startNode(): Promise<typeof node> {
  const received: ReceivedDispatch[] = [];
  const state = { delayMs: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const record: ReceivedDispatch = { body };
      try {
        record.claims = verifier.verify(String(req.headers['x-oshal-delegation-token'] ?? ''), {
          iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', azp: String(body.agentId), task_id: String(body.taskId),
          method: 'POST', path: '/api/swarm-execute', body_sha256: delegationRequestBodySha256(body), scope: ['swarm:execute'],
          sub: String(body.userSub ?? CONTROLLER_SYSTEM_SUBJECT), principal_iss: String(body.principalIssuer ?? 'urn:oshal:system'),
        });
      } catch (err) {
        record.verifyError = err instanceof Error ? err.message : String(err);
      }
      received.push(record);
      const deliverables = path.join(workspaceRoot, String(body.workspaceFolderId), 'deliverables', 'src');
      fs.mkdirSync(deliverables, { recursive: true });
      fs.writeFileSync(path.join(deliverables, `${String(body.taskId)}.ts`), 'export const built = true;\n');
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          success: true, response: `built ${String(body.taskId)}`, cost: 0, model: 'node-model', provider: 'node-provider', durationMs: 1,
          usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }));
      }, state.delayMs);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    received,
    get delayMs() { return state.delayMs; },
    set delayMs(value: number) { state.delayMs = value; },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** A work-item store double that records every status write. Its SQL is guarded elsewhere. */
class WorkItems {
  readonly items = new Map<string, { workItemId: string; unitId: string; externalId: string; status: string; executionOutput?: unknown }>();
  readonly statusWrites: Array<{ workItemId: string; status: string; at: number }> = [];
  add(externalId: string, unitId: string) {
    this.items.set(unitId, { workItemId: `wi-${unitId}`, unitId, externalId, status: 'pending' });
  }
  async findByExternalIdAnyProvider(externalId: string) { return [...this.items.values()].filter((i) => i.externalId === externalId); }
  async updateStatus(workItemId: string, status: string) {
    this.statusWrites.push({ workItemId, status, at: Date.now() });
    for (const item of this.items.values()) if (item.workItemId === workItemId) item.status = status;
  }
  async setExecutionOutput(workItemId: string, output: unknown) {
    for (const item of this.items.values()) if (item.workItemId === workItemId) item.executionOutput = output;
  }
}

/** The endpoint the controller resolves, redirected at the socket to the loopback node. */
function clientFor(env: NodeJS.ProcessEnv | undefined, resolve = (id: string) => (realEndpoint(id) ? node.baseUrl : null)) {
  return new BotNodeClient(resolve, 5_000, env ? { env } : { env: {} as NodeJS.ProcessEnv });
}

function realEndpoint(agentId: string): string | null {
  return resolveBotNodeEndpoint(agentId, getActiveRegistry(), isControllerInlineContainer);
}

function childItem(childId: string, ownerSub: string | null) {
  return {
    externalId: childId, provider: 'direct', title: 'Build the CSV parser module', body: 'Parse rows.', status: 'approved', labels: [],
    rawPayload: {
      ticketId: childId, ownerSub, parentTicketId: ROOT_ID,
      metadata: { depth: 1, subtaskIndex: 1, siblingTitles: ['Build the schema validator module'], ...(ownerSub ? { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER } : {}) },
    },
  } as never;
}

function unitFor(childId: string) {
  return {
    unitId: `${childId}-unit-1`, title: 'Build the CSV parser module', description: 'Parse every row of the CSV input.',
    acceptanceCriteria: ['The parser returns one object per row'], labels: [], workType: 'implementation', parentUnitId: null, depth: 0,
  } as never;
}

/**
 * @description Runs the real execution lifecycle once for a child: the policy runner double calls
 * dispatchExecution exactly as the real runner's first attempt does and returns its output.
 */
async function runChild(opts: { childId: string; agentId: string; ownerSub: string | null; dispatcher?: SignedChildDispatcher; workItems: WorkItems; meshSends: unknown[] }) {
  opts.workItems.add(opts.childId, `${opts.childId}-unit-1`);
  let dispatched: unknown;
  const lifecycle = new SwarmExecutionLifecycleService({
    executionPolicyRunner: {
      run: async (_item: unknown, _input: unknown, workUnits: unknown, routing: { winner: { agentId: string } }, _policy: unknown, callbacks: { dispatchExecution: (r: unknown, w: unknown) => Promise<unknown> }) => {
        dispatched = await callbacks.dispatchExecution(routing, workUnits);
        return { workUnits, routing, verification: { status: 'passed' }, executionAttempts: 1, buildRegressionCount: 0, designRegressionCount: 0, policyDecisions: [], retryClasses: [] };
      },
    } as never,
    meshService: { send: async (envelope: unknown) => { opts.meshSends.push(envelope); } } as never,
    routingHandler: {} as never, subtaskHandler: {} as never, writebackHandler: {} as never,
    cyclePolicyService: {} as never, escalationStore: {} as never,
    workItemRepository: opts.workItems as never,
    getRegressionService: () => undefined, getGovernanceService: () => undefined,
    getSignedChildDispatch: () => opts.dispatcher,
    selectAgent: async () => { throw new Error('not used'); },
  });
  const routing = { winner: { agentId: opts.agentId, score: 1, reason: 'spec' }, ranked: [], strategy: 'catch-all' } as never;
  await runWithSystemIdentity(() => lifecycle.runExecutionPolicy(
    childItem(opts.childId, opts.ownerSub), {} as never, [unitFor(opts.childId)], routing, 'run-1', { maxRunDurationMs: 30_000 } as never, Date.now(), ROOT_ID,
  ));
  return dispatched;
}

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-child-dispatch-'));
  node = await startNode();
});

afterAll(async () => {
  await node.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('build execution crosses the signed bot-node hop while signing is configured', () => {
  it('each of the seven build specialists resolves to its own node, and documentation-writer is not a Jarvis target', () => {
    for (const [agentId, container] of Object.entries(SEVEN)) {
      expect(realEndpoint(agentId), `${container} has no dedicated endpoint`).toBe(`http://${container}:5000`);
      expect(BUILD_EXECUTION_TARGETS.has(agentId)).toBe(true);
    }
    expect([...BUILD_EXECUTION_TARGETS.keys()].sort()).toEqual([
      ...Object.keys(SEVEN), 'a0000000-0000-0000-0000-000000000018', 'a0000000-0000-0000-0000-000000000099',
    ].sort());
    expect(isBotAccessibleTo('a0000000-0000-0000-0000-000000000004', 'jarvis')).toBe(false);
  });

  it('sends one signed request bound to the owner and verified issuer, records the result, writes into the root folder, and publishes nothing', async () => {
    const workItems = new WorkItems();
    const meshSends: unknown[] = [];
    const childId = '33333333-4444-4555-8666-777777777771';
    const before = node.received.length;
    const output = await runChild({ childId, agentId: CODE_DEVELOPER, ownerSub: OWNER, workItems, meshSends,
      dispatcher: createSignedChildDispatcher({ botNodeClient: clientFor(SIGNING_ENV), workItemRepository: workItems as never }) });

    const sent = node.received.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].verifyError).toBeUndefined();
    expect(sent[0].claims).toMatchObject({ azp: CODE_DEVELOPER, task_id: childId, sub: OWNER, principal_iss: ISSUER });
    expect(sent[0].body).toMatchObject({ workspaceFolderId: ROOT_ID, agenticMode: true, agentId: CODE_DEVELOPER, taskId: childId });
    expect(String(sent[0].body.text)).toContain('Parse every row of the CSV input.');
    expect(String(sent[0].body.text)).toContain('The parser returns one object per row');
    expect(String(sent[0].body.text)).toContain('Build the schema validator module');

    expect(output).toMatchObject({ agentId: CODE_DEVELOPER, taskId: childId, content: `built ${childId}`, provider: 'node-provider', model: 'node-model' });
    const unit = workItems.items.get(`${childId}-unit-1`);
    expect(unit?.status).toBe('completed');
    expect(unit?.executionOutput).toEqual(output);
    expect(fs.existsSync(path.join(workspaceRoot, ROOT_ID, 'deliverables', 'src', `${childId}.ts`))).toBe(true);
    expect(meshSends).toHaveLength(0);
  });

  it.each([['oshal-developer', OSHAL_DEVELOPER], ['an unregistered id', 'f0000000-0000-0000-0000-000000000abc']])(
    'refuses a target outside the build-lane allowlist (%s) before any request is made',
    async (_label, agentId) => {
      const workItems = new WorkItems();
      const meshSends: unknown[] = [];
      const childId = `33333333-4444-4555-8666-77777777777${agentId === OSHAL_DEVELOPER ? '2' : '3'}`;
      const before = node.received.length;
      const output = await runChild({ childId, agentId, ownerSub: OWNER, workItems, meshSends,
        dispatcher: createSignedChildDispatcher({ botNodeClient: clientFor(SIGNING_ENV, () => node.baseUrl), workItemRepository: workItems as never }) });

      expect(node.received.length - before).toBe(0);
      expect(output).toMatchObject({ status: 'failed' });
      expect(String((output as { error: string }).error)).toMatch(/^child_target_not_allowlisted: /);
      expect(workItems.items.get(`${childId}-unit-1`)?.status).toBe('failed');
      expect(meshSends).toHaveLength(0);
    },
  );

  it('a client that throws under signing yields a failed output and still never falls back to the mesh', async () => {
    const workItems = new WorkItems();
    const meshSends: unknown[] = [];
    const childId = '33333333-4444-4555-8666-777777777774';
    const output = await runChild({ childId, agentId: CODE_DEVELOPER, ownerSub: OWNER, workItems, meshSends,
      dispatcher: createSignedChildDispatcher({ botNodeClient: clientFor(SIGNING_ENV, () => null), workItemRepository: workItems as never }) });

    expect(output).toMatchObject({ status: 'failed' });
    expect(workItems.items.get(`${childId}-unit-1`)?.status).toBe('failed');
    expect(meshSends).toHaveLength(0);
  });

  it('an ownerless child is dispatched as explicit system work', async () => {
    const workItems = new WorkItems();
    const childId = '33333333-4444-4555-8666-777777777775';
    const before = node.received.length;
    await runChild({ childId, agentId: CODE_DEVELOPER, ownerSub: null, workItems, meshSends: [],
      dispatcher: createSignedChildDispatcher({ botNodeClient: clientFor(SIGNING_ENV), workItemRepository: workItems as never }) });

    const [sent] = node.received.slice(before);
    expect(sent.verifyError).toBeUndefined();
    expect(sent.claims?.sub).toBe(CONTROLLER_SYSTEM_SUBJECT);
  });

  it('keeps the unit work item assigned until a slow node returns, even after the child is cancelled', async () => {
    const workItems = new WorkItems();
    const childId = '33333333-4444-4555-8666-777777777776';
    let status = 'in_process_build';
    node.delayMs = 900;
    const before = node.received.length;
    setTimeout(() => { status = 'cancelled'; }, 300);
    try {
      await runChild({ childId, agentId: CODE_DEVELOPER, ownerSub: OWNER, workItems, meshSends: [],
        dispatcher: createSignedChildDispatcher({
          botNodeClient: clientFor(SIGNING_ENV), workItemRepository: workItems as never,
          readTicketStatus: async () => status, refreshIntervalMs: 60,
        }) });
    } finally {
      node.delayMs = 0;
    }
    expect(node.received.length).toBe(before + 1);
    const assigned = workItems.statusWrites.filter((w) => w.status === 'assigned');
    // The node keeps working after the cancel, so the refreshes keep coming until it returns.
    const afterCancel = assigned.filter((w) => w.at > assigned[0].at + 300 + 150);
    expect(afterCancel.length).toBeGreaterThanOrEqual(3);
    const unit = workItems.items.get(`${childId}-unit-1`)!;
    expect(unit.status).toBe('completed');
    expect(workItems.statusWrites[workItems.statusWrites.length - 1].status).toBe('completed');
  });

  it('never sends a child that has already ended to the node', async () => {
    const workItems = new WorkItems();
    const childId = '33333333-4444-4555-8666-777777777775';
    const before = node.received.length;
    const output = await runChild({ childId, agentId: CODE_DEVELOPER, ownerSub: OWNER, workItems, meshSends: [],
      dispatcher: createSignedChildDispatcher({
        botNodeClient: clientFor(SIGNING_ENV), workItemRepository: workItems as never, readTicketStatus: async () => 'cancelled',
      }) });
    expect(node.received).toHaveLength(before);
    expect(output).toMatchObject({ status: 'failed', error: expect.stringContaining('child_ticket_stopped') });
    const unit = workItems.items.get(`${childId}-unit-1`)!;
    expect(unit.status).toBe('failed');
    expect(workItems.statusWrites.some((w) => w.status === 'assigned')).toBe(false);
  });

  it('without signing the lifecycle sends execution over the mesh exactly as before', async () => {
    const workItems = new WorkItems();
    const meshSends: Array<{ toAgentId: string }> = [];
    const childId = '33333333-4444-4555-8666-777777777777';
    const before = node.received.length;
    const unsigned = createSignedChildDispatcher({ botNodeClient: clientFor(undefined), workItemRepository: workItems as never });
    workItems.add(childId, `${childId}-unit-1`);
    const pending = runChild({ childId, agentId: CODE_DEVELOPER, ownerSub: OWNER, workItems, meshSends, dispatcher: unsigned });
    // Stand in for the worker on the mesh path: store the unit's output once the envelope is sent.
    for (let i = 0; i < 50 && meshSends.length === 0; i += 1) await new Promise((done) => setTimeout(done, 20));
    const unit = workItems.items.get(`${childId}-unit-1`)!;
    unit.executionOutput = { content: 'from the mesh worker' };
    unit.status = 'completed';
    const output = await pending;

    expect(unsigned.isEnforced()).toBe(false);
    expect(meshSends).toHaveLength(1);
    expect(meshSends[0]).toMatchObject({ toAgentId: CODE_DEVELOPER });
    expect(node.received.length - before).toBe(0);
    expect(output).toEqual({ content: 'from the mesh worker' });
  });
});
