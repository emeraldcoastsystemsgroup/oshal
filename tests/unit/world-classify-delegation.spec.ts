/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary regression guard for the world classify dispatch that carried no verified principal issuer: with delegation signing on, the controller's signed bot-node hop refused it before any network I/O ("User-bound delegation requires a verified principal issuer"). Covers: an owner with a verified issuer reaches the node as one signed POST whose token binds the owner, issuer, agent, method, path and body hash, with the instruction on `pattern` and only the prompt as `text`; an owner without an issuer is refused by the same signing client and nothing reaches the node; the rail is left unregistered for a signed hop when no verified issuer is on record, so a classify call dispatches nothing, and with exactly one on record it registers and the call arrives signed for that issuer.
 */

/**
 * The boundary under test is the signed controller-to-node hop of one classify chunk. Nothing inside it
 * is doubled: the REAL createWorldClassifyProvider (request shape, the owner's request identity), the REAL
 * executeBotOrInline chokepoint (entitlement in enforce mode, admission, dispatch, cost settle), the REAL
 * BotNodeClient with Ed25519 delegation signing on (principal resolution, the signed grant, the node:http
 * POST) and the REAL public-key verifier, over loopback HTTP. The rail cases add the REAL
 * registerWorldClassifyRail and the REAL analyzeBatch that calls the registered backend.
 *
 * SCOPED DOUBLES (real-boundary audit), all OUTSIDE that boundary:
 *  - The bot node: a local node:http listener that records each request and answers success. No model
 *    runs, and the node's own delegation gate is not exercised here (its guard is
 *    tests/unit/bot-node-delegation.spec.ts).
 *  - The pg pool: every query answers no rows, so the budget gate finds no caps and the cost-task settle
 *    joins nothing. It keeps the SQL it was asked, which is how the first case shows the chokepoint ran.
 *    Not evidence about budgets or the cost ledger.
 *  - The registry read and the classify bot's canonical provider record: fixtures injected through the
 *    provider's own seams (deps.registry, deps.canonicalStamp).
 *  - The verified-principal directory read (deps.verifiedIssuers): a canned answer. Not evidence about the
 *    oshal_verified_principals store.
 */

import * as http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/composition/app-context';
import { createWorldClassifyProvider, registerWorldClassifyRail, type WorldClassifyDeps } from '@/app/world-classify-provider';
import { BotNodeClient } from '@/features/agent-management';
import { analyzeBatch, configureWorldClassify, worldClassifyConfigured, type FeedItem } from '@/features/world-data';
import { createDelegationTokenIssuer, createDelegationTokenVerifier } from '@/shared/security/delegation-token';
import { DELEGATION_HTTP_HEADER } from '@/shared/security/delegation-http-policy';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';

const OWNER = 'auth0|world-classify-owner';
const ISSUER = 'https://identity.oshal.example.com';
const AGENT_ID = 'a0000000-0000-0000-0000-000000000099';
const INSTRUCTION = 'Return ONLY a MINIFIED JSON array, no prose.';
const PROMPT = 'Subject: NVIDIA\nItems:\n0. Nvidia beats estimates';
const BOT_ANSWER = '[{"i":0,"s":0.4,"e":[{"n":"NVIDIA","t":"org"}],"ev":{"t":"earnings","i":0.7}}]';
const OPTIONS = { botName: 'general-bot', callTimeoutMs: 10_000 };
const RAIL_ENV: NodeJS.ProcessEnv = { WORLD_CLASSIFY_OWNER_SUB: OWNER, WORLD_CLASSIFY_BOT: 'general-bot' };
const ITEMS: FeedItem[] = [{ title: 'Nvidia beats estimates', description: 'Record data-center revenue.', outlet: 'Test Wire', link: '', pubDate: '' }];
const NOW = 1_800_000_000;
const PAIR = generateKeyPairSync('ed25519');

interface BotNodeHit { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

let botNode: http.Server;
let client: BotNodeClient;
let hits: BotNodeHit[] = [];
let jti = 0;

/** The SQL the pool double was asked, in order. */
const poolSql: string[] = [];
/** The pg pool double: no budget caps to read, no ticket link for the cost-task settle to join. */
const ctx = { pool: { query: async (sql: string) => { poolSql.push(sql); return { rows: [] }; } } } as unknown as AppContext;

/** The local bot-node double: records each request it receives and answers success. */
async function startBotNode(): Promise<string> {
  botNode = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, response: BOT_ANSWER, cost: 0, model: 'fixture', provider: 'antigravity-cli', durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
    });
  });
  botNode.listen(0, '127.0.0.1');
  await new Promise((resolve) => botNode.once('listening', resolve));
  return `http://127.0.0.1:${(botNode.address() as AddressInfo).port}`;
}

/** The REAL controller client with Ed25519 delegation signing on, as production composes it. */
function delegatingClient(endpoint: string): BotNodeClient {
  return new BotNodeClient(() => endpoint, 5_000, {
    env: {},
    delegationIssuer: createDelegationTokenIssuer({
      env: {
        OSHAL_DELEGATION_SIGNING_KID: 'current',
        OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: PAIR.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        OSHAL_DELEGATION_TTL_SECONDS: '300',
      },
      nowEpochSeconds: () => NOW,
      generateJti: () => `nonce-world-classify-${++jti}`,
    }),
  });
}

/** Verify, with the public key, the token the controller signed onto one request the listener received. */
function verifiedClaims(hit: BotNodeHit) {
  const verifier = createDelegationTokenVerifier({
    env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ current: PAIR.publicKey.export({ format: 'pem', type: 'spki' }).toString() }) },
    nowEpochSeconds: () => NOW,
  });
  return verifier.verify(String(hit.headers[DELEGATION_HTTP_HEADER]), {
    iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', sub: OWNER, principal_iss: ISSUER, azp: AGENT_ID,
    task_id: String(hit.body.taskId), method: 'POST', path: '/api/swarm-execute',
    body_sha256: delegationRequestBodySha256(hit.body), scope: ['swarm:execute'],
  });
}

/** The fixture seams outside the boundary. `execute` is never injected, so the real chokepoint runs. */
const deps = (over: Partial<WorldClassifyDeps> = {}): WorldClassifyDeps => ({
  registry: () => [{ agentId: AGENT_ID, name: 'general-bot', port: 3099, container: 'general-bot', role: 'general/fallback', capabilities: [] }],
  botClient: client,
  canonicalStamp: async () => ({ providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low', providerConfigRequired: true }),
  ...over,
});

beforeAll(async () => {
  client = delegatingClient(await startBotNode());
  expect(client.isDelegationEnforced()).toBe(true);
});

beforeEach(() => {
  // What the chokepoint's entitlement gate reads: its fail-closed mode, and the owner as the deployment operator.
  vi.stubEnv('OSHAL_EXECUTE_ENTITLEMENT', 'enforce');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OWNER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  configureWorldClassify([]);
  hits = [];
  poolSql.length = 0;
});

afterAll(async () => {
  if (botNode) await new Promise((resolve) => botNode.close(resolve));
});

describe('a world classify chunk crosses the signed bot-node hop', () => {
  it('an owner with a verified issuer arrives as one signed POST bound to the owner and that issuer', async () => {
    const provider = createWorldClassifyProvider(ctx, { sub: OWNER, issuer: ISSUER }, OPTIONS, deps());
    const out = await provider.complete(PROMPT, INSTRUCTION);

    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect({ method: hit.method, url: hit.url }).toEqual({ method: 'POST', url: '/api/swarm-execute' });
    // The instruction rides the server-authored pattern channel; `text` is the prompt alone.
    expect(hit.body).toMatchObject({
      agentId: AGENT_ID, userSub: OWNER, principalIssuer: ISSUER, agenticMode: true, direct: true,
      pattern: INSTRUCTION, text: PROMPT, providerId: 'antigravity-cli',
    });
    expect(String(hit.body.taskId)).toMatch(/^world-classify-/);
    expect(verifiedClaims(hit)).toMatchObject({
      sub: OWNER, principal_iss: ISSUER, azp: AGENT_ID, method: 'POST', path: '/api/swarm-execute',
      body_sha256: delegationRequestBodySha256(hit.body),
    });
    expect(out).toEqual({ text: BOT_ANSWER });
    // The chokepoint carried the call, not a shortcut around it: its budget gate read caps, its cost settle ran after.
    expect(poolSql.join('\n')).toMatch(/oshal_budgets[\s\S]*ticket_task_links/);
  });

  it('an owner without an issuer is refused by the same signing client and nothing reaches the node', async () => {
    const provider = createWorldClassifyProvider(ctx, { sub: OWNER, issuer: null }, OPTIONS, deps());
    await expect(provider.complete(PROMPT, INSTRUCTION)).rejects.toThrow(/verified principal issuer/);
    expect(hits).toEqual([]);
  });
});

describe('the rail is registered for a signed hop only with a verified issuer', () => {
  it('no verified issuer on record: nothing is registered and a classify call dispatches nothing', async () => {
    const outcome = await registerWorldClassifyRail(ctx, RAIL_ENV, deps({ verifiedIssuers: async () => [] }));
    expect(outcome).toBe('no-verified-issuer');
    expect(worldClassifyConfigured()).toBe(false);
    expect(await analyzeBatch(ITEMS, 'NVIDIA')).toEqual([{ s: null, entities: [], event: null }]);
    expect(hits).toEqual([]);
  });

  it('exactly one verified issuer on record: registered, and the classify call arrives signed for it', async () => {
    const outcome = await registerWorldClassifyRail(ctx, RAIL_ENV, deps({ verifiedIssuers: async () => [ISSUER] }));
    expect(outcome).toBe('registered');
    expect(worldClassifyConfigured()).toBe(true);
    const rows = await analyzeBatch(ITEMS, 'NVIDIA');

    expect(hits).toHaveLength(1);
    expect(hits[0].body).toMatchObject({ agentId: AGENT_ID, userSub: OWNER, principalIssuer: ISSUER, direct: true });
    expect(verifiedClaims(hits[0])).toMatchObject({ sub: OWNER, principal_iss: ISSUER, azp: AGENT_ID });
    expect(rows).toEqual([{ s: 0.4, entities: [{ name: 'NVIDIA', type: 'org' }], event: { type: 'earnings', intensity: 0.7 } }]);
  });
});
