/**
 * Live loopback proof for the flagship domain workflows.
 *
 * ADR-085 completion state: all five flagship domains (career + email/comms +
 * finance + home + social) ship as oshal-applications store packages — each
 * carved with its read surface + approval-gated action loop intact, exercised by
 * its package tests + the live deploy battery. What this run still proves LIVE
 * against the kernel: (1) the carved-domain attestation (the migration plan
 * documents every flagship carve and the kernel hard-mounts none of them), and
 * (2) the kernel-resident comms approval loop — the LinkedIn AI Content
 * Assistant's read surface + its no-post confirmation gate — executed through
 * the real Express route module with an authenticated proof user. This avoids
 * external provider credentials while still exercising production route code.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { createLinkedInAssistantRoutes } from '@/app/routes/linkedin-assistant-routes';
import type { AppContext } from '@/app/composition/app-context';

type QueryEvent = {
  sql: string;
  params: unknown[];
};

type TicketEvent = {
  ticketId: string;
  status: string;
  metadata?: unknown;
};

type Probe = {
  domain: 'comms';
  id: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  expectedStatus: number;
  expectedJson?: Record<string, unknown>;
  description: string;
};

type ProbeResult = Probe & {
  status: number;
  response: Record<string, unknown>;
  passed: boolean;
  queryCount: number;
  ticketEvents: TicketEvent[];
};

const USER_SUB = 'proof-user-flagship-workflows';

function fakeAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { oidc?: unknown }).oidc = {
    isAuthenticated: () => true,
    user: {
      sub: USER_SUB,
      oid: USER_SUB,
      email: 'flagship-proof@example.test',
      name: 'Flagship Workflow Proof',
    },
  };
  next();
}

function compactSql(sql: unknown): string {
  return (typeof sql === 'string' ? sql : String(sql)).replace(/\s+/g, ' ').trim();
}

function createProbeContext(queryEvents: QueryEvent[], ticketEvents: TicketEvent[]): AppContext {
  const pool = {
    async query(sql: unknown, params: unknown[] = []) {
      const text = compactSql(sql);
      queryEvents.push({ sql: text, params });

      // (career_hunter_applications stubs removed: career-hunter carved to the app store,
      //  ADR-085 Wave 3 #1 — its flagship approval loop ships in the package.)

      if (/SELECT institution FROM oshal_finance_items/i.test(text)) {
        return { rows: [], rowCount: 0 };
      }

      if (/SELECT \(aggregate IS NOT NULL\) AS has_data/i.test(text)) {
        return { rows: [], rowCount: 0 };
      }

      if (/FROM oshal_connections/i.test(text)) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  const ticketService = {
    async updateStatus(ticketId: string, status: string, metadata?: unknown) {
      ticketEvents.push({ ticketId, status, metadata });
      return { id: ticketId, status };
    },
  };

  return { pool, ticketService } as unknown as AppContext;
}

function buildApp(ctx: AppContext): express.Express {
  const app = express();
  const apiDir = path.join(process.cwd(), 'src', 'api');
  app.use(express.json({ limit: '1mb' }));
  app.use(fakeAuth);
  // (/api/career-hunter removed: carved to the app store, ADR-085 Wave 3 #1 — its
  //  flagship read + approval loop ships in the package.)
  // (/api/email removed: the Email Summarizer carved to the app store, ADR-085 Wave 3 —
  //  its read + no-send approval loop ships in the package. That completed the flagship
  //  carves: career + email + finance + home + social ALL ship as store packages.)
  // The kernel-resident comms approval loop still proves LIVE here: the LinkedIn AI
  // Content Assistant (read surface + its own no-post confirmation gate).
  app.use('/api/linkedin-assistant', createLinkedInAssistantRoutes(ctx, apiDir));
  return app;
}

const probes: Probe[] = [
  // (career probes removed: career-hunter carved to the app store, ADR-085 Wave 3 #1.)
  // (email probes removed: the Email Summarizer carved to the app store, ADR-085 Wave 3 —
  //  its connector-CTA read + the no-send 428 approval gate ride the packaged /api/email.)
  // (home probes removed: home carved to the app store, ADR-085 Wave 2.)
  // (social probes removed: the Social app carved to the app store, ADR-085 Wave 2 — its
  //  read + no-post approval loop ships in the package's tests.)
  {
    domain: 'comms',
    id: 'linkedin-assistant-read',
    method: 'GET',
    path: '/api/linkedin-assistant/drafts',
    expectedStatus: 200,
    expectedJson: { drafts: 'array' },
    description: 'Kernel-resident content-assistant read surface returns structured drafts for a clean account.',
  },
  {
    domain: 'comms',
    id: 'linkedin-assistant-approval-gate',
    method: 'POST',
    path: '/api/linkedin-assistant/drafts/1/publish',
    body: {},
    expectedStatus: 428,
    expectedJson: { error: 'confirmation_required', guard: 'no-post' },
    description: 'Publish is blocked by explicit confirmation (no-post) before draft lookup or provider work.',
  },
];

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected === 'array') return Array.isArray(actual);
  if (expected === 'object') return Boolean(actual) && typeof actual === 'object' && !Array.isArray(actual);
  return actual === expected;
}

function expectedJsonMatches(response: Record<string, unknown>, expected?: Record<string, unknown>): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => valueMatches(response[key], value));
}

async function request(baseUrl: string, probe: Probe): Promise<{ status: number; response: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${probe.path}`, {
    method: probe.method,
    headers: { 'Content-Type': 'application/json' },
    body: probe.method === 'POST' ? JSON.stringify(probe.body ?? {}) : undefined,
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: response.status, response: body };
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

/**
 * The carved-domain attestation: every flagship domain must be documented in the store
 * migration plan AND must not be hard-mounted by the kernel (its package owns the mount).
 * Fails loud on either drift — a flagship surface silently reappearing in the kernel or
 * disappearing from the plan turns this evidence red.
 */
function proveCarvedDomains(): Array<{ domain: string; app: string; documented: boolean; kernelUnmounted: boolean }> {
  const plan = readFileSync(path.join(process.cwd(), 'docs', 'apps', 'swarm-store-migration-plan.md'), 'utf8');
  const server = readFileSync(path.join(process.cwd(), 'src', 'app', 'server.ts'), 'utf8');
  const rows = [
    { domain: 'career', app: 'career-hunter', mount: "app.use('/api/career-hunter'," },
    { domain: 'comms/email', app: 'email-summarizer', mount: "app.use('/api/email'," },
    { domain: 'finance', app: 'finance', mount: "app.use('/api/finance'," },
    { domain: 'home', app: 'home', mount: "app.use('/api/home'," },
    { domain: 'social', app: 'social', mount: "app.use('/api/social'," },
  ].map(({ domain, app, mount }) => ({
    domain,
    app,
    documented: plan.includes(app),
    kernelUnmounted: !server.includes(mount),
  }));
  for (const row of rows) {
    if (!row.documented) throw new Error(`migration plan no longer documents ${row.app}`);
    if (!row.kernelUnmounted) throw new Error(`kernel still hard-mounts the ${row.domain} surface (${row.app})`);
  }
  return rows;
}

function renderMarkdown(
  carvedDomains: ReturnType<typeof proveCarvedDomains>,
  results: ProbeResult[],
  queryEvents: QueryEvent[],
  ticketEvents: TicketEvent[],
  generatedAt: Date,
): string {
  const passCount = results.filter((result) => result.passed).length;
  return [
    `# Flagship Workflows Evidence - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - loopback HTTP execution of the real kernel-resident comms-assistant Express route module with an authenticated proof user and clean-account connector state, plus the carved-domain attestation.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Result',
    '',
    `Passed ${passCount}/${results.length} live read/action probes on the kernel-resident comms assistant. ALL FIVE flagship domains — career + email + finance + home + social — ship as store packages (ADR-085), each carved with its read surface + approval loop intact.`,
    '',
    '## Carved Flagship Domains (attested)',
    '',
    '| Domain | Store package | Documented in plan | Kernel unmounted |',
    '|---|---|---|---|',
    ...carvedDomains.map((row) => `| ${row.domain} | ${row.app} | ${row.documented ? 'yes' : 'NO'} | ${row.kernelUnmounted ? 'yes' : 'NO'} |`),
    '',
    '## Live Probe Matrix',
    '',
    '| Domain | Probe | Route | Status | Evidence | Result |',
    '|---|---|---|---:|---|---|',
    ...results.map((result) => {
      const evidence = [
        result.description,
        result.response.error ? `error=${String(result.response.error)}` : '',
        result.response.guard ? `guard=${String(result.response.guard)}` : '',
        result.ticketEvents.length ? `ticket=${result.ticketEvents.map((event) => event.status).join(',')}` : '',
      ].filter(Boolean).join('; ');
      return `| ${result.domain} | ${result.id} | ${result.method} ${result.path} | ${result.status} | ${evidence} | ${result.passed ? 'pass' : 'fail'} |`;
    }),
    '',
    '## Approval And Guard Evidence',
    '',
    '- (Career approval moved to the career-hunter store package at the ADR-085 Wave 3 carve — its approval loop is exercised by the package tests + the live deploy battery.)',
    '- (Email approval moved to the email-summarizer store package at the ADR-085 Wave 3 carve — its `no-send` 428 gate rides the packaged /api/email/send; the kernel Twilio CLI keeps its own no-send gate, proven by risky-write-guards. `no-charge` + `no-device-write` + `no-post` ship with the finance/payments + home + social store packages.)',
    '- The kernel-resident LinkedIn AI Content Assistant returns an explicit approval receipt LIVE here: `no-post` (confirmation_required) before draft lookup or any provider write.',
    '- The read surface is exercised first, proving a clean account returns structured data instead of dead screens.',
    '',
    'Ticket events:',
    '',
    '```json',
    JSON.stringify(ticketEvents, null, 2),
    '```',
    '',
    'DB query evidence:',
    '',
    '```json',
    JSON.stringify(queryEvents.map((event) => ({ sql: event.sql.slice(0, 220), params: event.params })), null, 2),
    '```',
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-flagship-workflows-live.ts',
    '```',
    '',
    '## Limits',
    '',
    'This is a live route-level clean-account proof. Credentialed external account reads remain covered by connector-specific live-read evidence; the five carved flagship packages are exercised by their own package tests + the live deploy battery. This run proves the kernel-resident comms assistant is mounted, readable, and approval-gated without relying on real provider secrets — and attests the carved-domain state fail-loud.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const carvedDomains = proveCarvedDomains();
  const queryEvents: QueryEvent[] = [];
  const ticketEvents: TicketEvent[] = [];
  const ctx = createProbeContext(queryEvents, ticketEvents);
  const app = buildApp(ctx);

  await new Promise((resolve) => setTimeout(resolve, 25));
  queryEvents.length = 0;

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const results: ProbeResult[] = [];
    for (const probe of probes) {
      const beforeQueryCount = queryEvents.length;
      const beforeTicketCount = ticketEvents.length;
      const { status, response } = await request(baseUrl, probe);
      const queryCount = queryEvents.length - beforeQueryCount;
      const ticketSlice = ticketEvents.slice(beforeTicketCount);
      const passed = status === probe.expectedStatus && expectedJsonMatches(response, probe.expectedJson);
      results.push({ ...probe, status, response, passed, queryCount, ticketEvents: ticketSlice });
    }

    const failed = results.filter((result) => !result.passed);
    if (failed.length) {
      console.error(JSON.stringify({ failed, results }, null, 2));
      process.exitCode = 1;
      return;
    }

    const generatedAt = new Date();
    const outDir = path.join(process.cwd(), 'docs', 'evidence');
    mkdirSync(outDir, { recursive: true });
    const basename = `flagship-workflows-${dateStamp(generatedAt)}`;
    const mdPath = path.join(outDir, `${basename}.md`);
    const jsonPath = path.join(outDir, `${basename}.json`);
    writeFileSync(mdPath, renderMarkdown(carvedDomains, results, queryEvents, ticketEvents, generatedAt), 'utf8');
    writeFileSync(jsonPath, JSON.stringify({
      proofTier: 'live',
      generatedAt: generatedAt.toISOString(),
      carvedDomains,
      passed: results.length,
      total: results.length,
      results,
      queryEvents,
      ticketEvents,
    }, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, mdPath, jsonPath, passed: results.length }, null, 2));
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
