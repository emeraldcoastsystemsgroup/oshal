/**
 * Live/loopback competitive-evidence generator for the OSHAL "connectors" category.
 *
 * Two proofs, both exercising REAL production code (no hardcoded passes):
 *
 *  1. connector-marketplace-smoke — loopback-mounts the real
 *     createConnectorMarketplaceRoutes over a real ConnectorMarketplaceService behind a
 *     fakeAuth middleware, fires GET /api/connectors/marketplace, and asserts the ADR-067
 *     catalog returns 200 with totals.entries >= 40 and blocked == 0.
 *
 *  2. connector-five-live-reads — loads 5 real connector specs from swarm-apps/connectors/
 *     and drives each one's GET (read-only) resource through the real spec-generated
 *     ConnectorClient with a per-user broker-resolved credential (bearer TokenProvider /
 *     apiKey value) injected at build time and a request-capturing fetch stub. It asserts
 *     that, for all 5, the brokered read reaches the spec baseUrl+path with method GET and
 *     carries the resolved per-user credential in the correct place (Authorization bearer,
 *     apiKey header, or apiKey query). This is brokered-token READ-SHAPE validation — it
 *     does NOT use real external provider credentials and does NOT hit external APIs.
 *
 * On ANY failed assertion the generator console.errors the failures, sets exitCode=1, and
 * writes NO evidence doc.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnectorMarketplaceRoutes } from '@/app/routes/connector-marketplace-routes';
import { ConnectorMarketplaceService } from '@/app/connectors/runtime/marketplace';
import { buildClientFromSpec, loadConnectorSpec, type ConnectorSpec, type SpecResource } from '@/app/connectors/runtime/spec';

const USER_SUB = 'proof-user-connectors';
const BROKER_TOKEN = 'brokered-oauth-token-proof-not-a-real-secret';
const BROKER_KEY = 'brokered-api-key-proof-not-a-real-secret';

/**
 * Mask the stand-in broker credential values in RENDERED output only. Assertions above
 * still compare against the real BROKER_TOKEN/BROKER_KEY, so proof integrity is intact;
 * this only keeps credential-shaped strings (e.g. `api_key=...`, `Bearer ...`) out of the
 * committed evidence so the secret scanner / gitleaks stay clean.
 */
function redact(text: string): string {
  return text.split(BROKER_TOKEN).join('***redacted-broker-token***').split(BROKER_KEY).join('***redacted-broker-key***');
}
const CONNECTORS_DIR = path.join('swarm-apps', 'connectors');

/** Five real connector specs + a param-free GET read resource, spanning oauth2/apiKey shapes. */
const READ_PICKS: Array<{ provider: string; resource: string }> = [
  { provider: 'github', resource: 'me' },
  { provider: 'slack', resource: 'list-channels' },
  { provider: 'stripe', resource: 'list-customers' },
  { provider: 'coingecko', resource: 'coins-markets' },
  { provider: 'tmdb', resource: 'search-movies' },
];

type CapturedRequest = { url: string; method: string; headers: Record<string, string> };
type ReadResult = {
  provider: string;
  resource: string;
  authType: ConnectorSpec['auth']['type'];
  method: string;
  url: string;
  credentialSite: string;
  credentialPresent: boolean;
  paramFreePath: boolean;
  passed: boolean;
};

function fakeAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { oidc?: unknown }).oidc = {
    isAuthenticated: () => true,
    user: { sub: USER_SUB, oid: USER_SUB, email: 'connectors-proof@example.test', name: 'Connectors Proof' },
  };
  next();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function buildMarketplaceApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(fakeAuth);
  const marketplace = new ConnectorMarketplaceService({
    specDir: path.join(process.cwd(), CONNECTORS_DIR),
    statePath: path.join(tmpdir(), `oshal-connectors-proof-state-${process.pid}.json`),
    cachePath: path.join(tmpdir(), `oshal-connectors-proof-cache-${process.pid}.json`),
  });
  const ctx = {
    connectorMarketplaceService: marketplace,
    connectorSpecToolService: {},
    toolRegistryService: {},
    dynamicToolExecutorRegistry: {},
  };
  app.use('/api/connectors', createConnectorMarketplaceRoutes(ctx as any));
  return app;
}

async function getJson(baseUrl: string, pathName: string): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}${pathName}`, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

type MarketplaceProof = { status: number; totals: Record<string, number>; entryCount: number; blocked: number };

async function proveMarketplace(baseUrl: string): Promise<MarketplaceProof> {
  const res = await getJson(baseUrl, '/api/connectors/marketplace');
  const data = res.body?.data || {};
  const totals = data.totals || {};
  const entryCount = Number(totals.entries || 0);
  const blocked = Number(totals.blocked ?? -1);
  const failures: string[] = [];
  if (res.status !== 200) failures.push(`GET /api/connectors/marketplace expected 200, got ${res.status}`);
  if (res.body?.success !== true) failures.push('marketplace response.success !== true');
  if (entryCount < 40) failures.push(`totals.entries expected >= 40, got ${entryCount}`);
  if (blocked !== 0) failures.push(`totals.blocked expected 0, got ${blocked}`);
  if (failures.length) throw new Error(`marketplace smoke failed: ${failures.join('; ')}`);
  return { status: res.status, totals, entryCount, blocked };
}

/** True when the resource path has no `{placeholder}` segments (a param-free read path). */
function isParamFreePath(resource: SpecResource): boolean {
  return !/\{[^}]+\}/.test(resource.path);
}

/** Assert the brokered credential landed where the connector-client applyAuth would put it. */
function credentialSiteFor(spec: ConnectorSpec, captured: CapturedRequest): { site: string; present: boolean } {
  switch (spec.auth.type) {
    case 'oauth2':
      return { site: 'Authorization: Bearer', present: captured.headers.Authorization === `Bearer ${BROKER_TOKEN}` };
    case 'basic':
      return { site: 'Authorization: Basic', present: (captured.headers.Authorization || '').startsWith('Basic ') };
    case 'apiKeyHeader':
      return { site: `header:${spec.auth.header}`, present: captured.headers[spec.auth.header] === BROKER_KEY };
    case 'apiKeyQuery':
      return { site: `query:${spec.auth.param}`, present: captured.url.includes(`${spec.auth.param}=${encodeURIComponent(BROKER_KEY)}`) };
    default:
      return { site: 'none', present: true };
  }
}

async function proveOneRead(pick: { provider: string; resource: string }): Promise<ReadResult> {
  const spec = loadConnectorSpec(path.join(process.cwd(), CONNECTORS_DIR, `${pick.provider}.yaml`));
  const resource = spec.resources.find((r) => r.name === pick.resource);
  if (!resource) throw new Error(`${pick.provider}: resource '${pick.resource}' not found in spec`);
  if (resource.method !== 'GET') throw new Error(`${pick.provider}.${pick.resource} is ${resource.method}, not a GET read`);
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    captured.push({ url: String(url), method: init?.method || 'GET', headers: (init?.headers || {}) as Record<string, string> });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  // Per-user broker resolution shape: a bearer TokenProvider (ADR-056 getValidAccessToken for USER_SUB)
  // plus an apiKey value; the spec declares only the auth SHAPE, the credential is injected here.
  const specClient = buildClientFromSpec(spec, { token: async () => BROKER_TOKEN, apiKeyValue: BROKER_KEY, fetchImpl });
  await specClient.call(pick.resource, {});
  if (captured.length === 0) throw new Error(`${pick.provider}.${pick.resource}: no HTTP request was issued`);
  const req = captured[0];
  const expectedUrl = `${spec.baseUrl.replace(/\/$/, '')}${resource.path.startsWith('/') ? '' : '/'}${resource.path}`;
  const { site, present } = credentialSiteFor(spec, req);
  const paramFree = isParamFreePath(resource);
  const passed = req.method === 'GET' && req.url.startsWith(expectedUrl) && present && paramFree;
  return {
    provider: pick.provider,
    resource: pick.resource,
    authType: spec.auth.type,
    method: req.method,
    url: req.url,
    credentialSite: site,
    credentialPresent: present,
    paramFreePath: paramFree,
    passed,
  };
}

async function proveFiveReads(): Promise<ReadResult[]> {
  const results: ReadResult[] = [];
  for (const pick of READ_PICKS) results.push(await proveOneRead(pick));
  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    throw new Error(`five-live-reads failed for: ${failed.map((r) => `${r.provider}.${r.resource}`).join(', ')}`);
  }
  return results;
}

function renderMarketplaceMd(proof: MarketplaceProof, generatedAt: Date): string {
  return [
    `# Connector Marketplace And Smoke Evidence - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - loopback HTTP execution of the real ADR-067 connector marketplace route (`createConnectorMarketplaceRoutes`) over a real `ConnectorMarketplaceService` built from the on-disk `swarm-apps/connectors/*.yaml` specs, behind a fakeAuth middleware.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Result',
    '',
    'Status: passed',
    '',
    'A signed-in caller reaching `/api/connectors/marketplace` gets the audited ADR-067 catalog: real connector specs are discovered, audited, and summarized, and none are blocked by the audit gate.',
    '',
    '## Live Route Proof',
    '',
    `- Endpoint: \`GET /api/connectors/marketplace\` returned HTTP ${proof.status}.`,
    `- Catalog size: \`totals.entries\` = ${proof.entryCount} audited connector entries (gate: >= 40).`,
    `- Audit health: \`totals.blocked\` = ${proof.blocked} (gate: == 0 — no spec failed the audit gate).`,
    `- Additional totals: available=${proof.totals.available ?? 0}, enabled=${proof.totals.enabled ?? 0}, highRisk=${proof.totals.highRisk ?? 0}, writeCapable=${proof.totals.writeCapable ?? 0}, actionCount=${proof.totals.actionCount ?? 0}.`,
    '',
    '## Checks',
    '',
    '| Check | Evidence | Result |',
    '|---|---|---|',
    `| Route returns 200 | GET /api/connectors/marketplace -> ${proof.status} | ${proof.status === 200 ? 'pass' : 'fail'} |`,
    `| Catalog >= 40 entries | totals.entries=${proof.entryCount} | ${proof.entryCount >= 40 ? 'pass' : 'fail'} |`,
    `| No blocked connectors | totals.blocked=${proof.blocked} | ${proof.blocked === 0 ? 'pass' : 'fail'} |`,
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-connectors-live.ts',
    '```',
    '',
    '## Limits',
    '',
    'This is a loopback/integration-tier proof: the real marketplace route module and marketplace service run in-process, exercising genuine spec discovery + audit over the shipped `swarm-apps/connectors/*.yaml` files. Authentication is stubbed by a fakeAuth middleware (MOCK_OIDC is false on the live container, so a direct authed call is impossible; loopback-mounting the real route is the accepted approach). No Postgres, no OIDC provider, and no external connector APIs are contacted; enable/disable state is written to a throwaway temp path, not the deployment state file.',
    '',
  ].join('\n');
}

function renderFiveReadsMd(results: ReadResult[], generatedAt: Date): string {
  const passCount = results.filter((r) => r.passed).length;
  return [
    `# Connector Five Live Reads - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - loopback read-shape execution of 5 real connector specs through the spec-generated `ConnectorClient`, with a per-user broker-resolved credential injected at build time and a request-capturing fetch stub.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Scope',
    '',
    'This validates the ADR-065/ADR-067 brokered read shape for five real connector definitions from `swarm-apps/connectors/`:',
    '',
    '- read-only, param-free `GET` resources only (no write actions),',
    '- credentials are NOT baked into the spec; the per-user broker resolution shape (bearer `TokenProvider` / apiKey value, keyed to the signed-in caller) is injected at `buildClientFromSpec` time,',
    '- each read is asserted to reach the spec `baseUrl`+path with method `GET` and to carry the resolved per-user credential in the correct place.',
    '',
    'This is brokered-token read-shape validation, matching the claim scope of the prior connector-five-live-reads proof. It intentionally does NOT use real external provider credentials and does NOT contact external provider APIs (the outbound fetch is captured, not sent).',
    '',
    '## Result',
    '',
    `${passCount} pass, ${results.length - passCount} fail, 0 skip (of ${results.length} connectors)`,
    '',
    '## Read-Shape Probe Matrix',
    '',
    '| Provider | Resource | Auth shape | Method | Broker credential site | Present | Result |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.provider} | ${r.resource} | ${r.authType} | ${r.method} | ${r.credentialSite} | ${r.credentialPresent ? 'yes' : 'no'} | ${r.passed ? 'pass' : 'fail'} |`),
    '',
    '## Per-Read URLs',
    '',
    ...results.map((r) => `- ${r.provider}.${r.resource}: \`${r.method} ${r.url}\` (broker credential in ${r.credentialSite}).`),
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-connectors-live.ts',
    '```',
    '',
    '## Limits',
    '',
    'This is a loopback/integration-tier read-shape proof. The real connector spec loader (`loadConnectorSpec`) and the real spec-generated HTTP client (`buildClientFromSpec` -> `ConnectorClient.request`) run in-process, so auth injection, URL construction, and method are genuinely exercised. The per-user broker token is a stand-in value (the broker/Postgres `oshal_connections` lookup and OAuth refresh are NOT invoked), and the outbound `fetch` is captured by a stub rather than sent to the external provider. No real external provider credentials are used; this proves the brokered read WIRING, not live third-party account reads.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const app = buildMarketplaceApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const marketplace = await proveMarketplace(baseUrl);
    const reads = await proveFiveReads();

    const generatedAt = new Date();
    const outDir = path.join(process.cwd(), 'docs', 'evidence');
    mkdirSync(outDir, { recursive: true });

    const smokeBase = `connector-marketplace-smoke-${dateStamp(generatedAt)}`;
    const readsBase = `connector-five-live-reads-${dateStamp(generatedAt)}`;
    const smokeMd = path.join(outDir, `${smokeBase}.md`);
    const smokeJson = path.join(outDir, `${smokeBase}.json`);
    const readsMd = path.join(outDir, `${readsBase}.md`);
    const readsJson = path.join(outDir, `${readsBase}.json`);

    writeFileSync(smokeMd, redact(renderMarketplaceMd(marketplace, generatedAt)), 'utf8');
    writeFileSync(smokeJson, redact(JSON.stringify({ proofTier: 'live', generatedAt: generatedAt.toISOString(), marketplace }, null, 2)), 'utf8');
    writeFileSync(readsMd, redact(renderFiveReadsMd(reads, generatedAt)), 'utf8');
    writeFileSync(readsJson, redact(JSON.stringify({ proofTier: 'live', generatedAt: generatedAt.toISOString(), passed: reads.length, total: reads.length, reads }, null, 2)), 'utf8');

    console.log(JSON.stringify({
      ok: true,
      smokeMd,
      readsMd,
      entryCount: marketplace.entryCount,
      blocked: marketplace.blocked,
      reads: reads.map((r) => `${r.provider}.${r.resource}=${r.passed ? 'pass' : 'fail'}`),
    }, null, 2));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
