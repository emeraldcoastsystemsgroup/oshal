/**
 * Live loopback proof for the Token Chase estimated-vs-actual demo route.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { createTokenChaseRoutes } from '@/app/routes/token-chase-routes';
import type { AppContext } from '@/app/composition/app-context';

type ProofPayload = {
  variant?: {
    baseline?: { costUsd?: number; costEstimated?: boolean };
    variant?: { costUsd?: number; costEstimated?: boolean };
    diff?: { costDeltaUsd?: number; accuracy?: number; equivalent?: boolean };
    tier?: string;
  };
  noTokenSpend?: boolean;
};

function fakeAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { oidc?: unknown }).oidc = {
    isAuthenticated: () => true,
    user: {
      sub: 'proof-user-token-chase',
      email: 'proof@example.test',
      name: 'Token Chase Proof',
    },
  };
  next();
}

function fakeContext(): AppContext {
  return {
    pool: {
      async query() {
        throw new Error('Token Chase demo proof must not touch the database.');
      },
    },
  } as unknown as AppContext;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(fakeAuth);
  app.use('/api/token-chase', createTokenChaseRoutes(path.join(process.cwd(), 'src', 'api'), fakeContext()));
  return app;
}

async function requestDemo(baseUrl: string): Promise<{ status: number; body: ProofPayload }> {
  const response = await fetch(`${baseUrl}/api/token-chase/demo/comparison`);
  const body = await response.json() as ProofPayload;
  return { status: response.status, body };
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

function assertProof(status: number, body: ProofPayload): void {
  const result = body.variant;
  if (status !== 200) throw new Error(`expected HTTP 200, got ${status}`);
  if (!body.noTokenSpend) throw new Error('expected noTokenSpend=true');
  if (!result?.baseline?.costEstimated) throw new Error('baseline cost must be estimated');
  if (result.variant?.costEstimated) throw new Error('variant cost must be actual, not estimated');
  if (!(Number(result.baseline.costUsd) > 0)) throw new Error('baseline cost must be positive');
  if (!(Number(result.variant?.costUsd) > 0)) throw new Error('variant cost must be positive');
  if (!(Number(result.diff?.costDeltaUsd) < 0)) throw new Error('variant must be cheaper than baseline');
  if (result.diff?.equivalent !== true) throw new Error('variant must be equivalent');
  if (result.tier !== 'equivalent-cheaper') throw new Error(`expected tier equivalent-cheaper, got ${result.tier}`);
}

function renderMarkdown(status: number, body: ProofPayload, generatedAt: Date): string {
  const result = body.variant!;
  return [
    `# Token Chase Estimated vs Actual Demo - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - loopback HTTP execution of the real Token Chase Express route; the demo path reports no token spend.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Scope',
    '',
    'This proves the Cost Control demo route returns a visible estimated baseline cost, an actual variant cost, and a cheaper equivalent verdict without spending live provider tokens.',
    '',
    '## Result',
    '',
    `HTTP status: ${status}`,
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Baseline estimated cost | ${result.baseline?.costUsd} |`,
    `| Variant actual cost | ${result.variant?.costUsd} |`,
    `| Cost delta | ${result.diff?.costDeltaUsd} |`,
    `| Accuracy | ${result.diff?.accuracy} |`,
    `| Equivalent | ${result.diff?.equivalent} |`,
    `| Verdict | ${result.tier} |`,
    '',
    'Raw payload:',
    '',
    '```json',
    JSON.stringify(body, null, 2),
    '```',
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-token-chase-demo-live.ts',
    '```',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { status, body } = await requestDemo(baseUrl);
    assertProof(status, body);
    const generatedAt = new Date();
    const outDir = path.join(process.cwd(), 'docs', 'evidence');
    mkdirSync(outDir, { recursive: true });
    const basename = `token-chase-demo-${dateStamp(generatedAt)}`;
    const mdPath = path.join(outDir, `${basename}.md`);
    const jsonPath = path.join(outDir, `${basename}.json`);
    writeFileSync(mdPath, renderMarkdown(status, body, generatedAt), 'utf8');
    writeFileSync(jsonPath, JSON.stringify({
      proofTier: 'live',
      generatedAt: generatedAt.toISOString(),
      status,
      ...body,
    }, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, mdPath, jsonPath, status }, null, 2));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
