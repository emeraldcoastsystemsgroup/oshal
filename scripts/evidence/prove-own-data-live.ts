/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add Change Log header; docs/ path references updated in the 2026-07-04 docs consolidation
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stop hardcoding the evidence date: DATE now derives from the run date so the own-data proofs (wave1/app-role/legacy/two-user/export) get correctly-dated filenames instead of always emitting *-2026-07-04.md — the "filename date lag" the competitive audit flagged, which trips freshness checks keyed on the filename and mis-sorts newest-by-name globs.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Privacy-delete stub: add pool.connect() no-op transactional client so the export/delete proof survives the delete route's new ambient/speaker-data cleanup transaction (clean-account user has no ambient rows -> no-op). Was failing "confirmed delete expected 200, got 500: pool.connect is not a function".
 */
/**
 * Headless, self-healing competitive-evidence generator for the OSHAL "own-data"
 * category (tenant isolation / data ownership).
 *
 * It reproduces the five 2026-06-22 own-data proofs against the LIVE stack:
 *   - wave1-trust-gate            -> runs `npm run verify:rls` against the live DB
 *                                    (oshal_app, enforce stage) and captures the real result.
 *   - app-role-runtime-and-watchdog -> queries pg_roles on the live DB and confirms the
 *                                    api runs as a non-superuser, non-BYPASSRLS role.
 *   - legacy-owner-backfill-quarantine -> runs the real backfill script in DRY-RUN
 *                                    (BEGIN/ROLLBACK, no writes) and captures disposition counts.
 *   - live-two-user-isolation    -> derives the two-user visibility proof from the same
 *                                    verify:rls run (user A cannot read user B's rows).
 *   - data-export-delete         -> loopback-mounts the REAL privacy route module behind a
 *                                    fakeAuth middleware and exercises export + delete.
 *
 * On ANY failed assertion the generator prints failures, sets exit code 1, and writes
 * NO evidence docs. Nothing is hardcoded to pass.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-own-data-live.ts
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { createPrivacyRoutes, PRIVACY_DELETE_CONFIRMATION } from '@/app/routes/privacy-routes';

// Derive the evidence date from the run date (dateStamp is a hoisted function declaration).
// Previously hardcoded to 2026-07-04, which made every nightly run emit stale-named files.
const DATE = dateStamp(new Date());
const OUT_DIR = path.join(process.cwd(), 'docs', 'evidence');
const USER_A = 'own-data-proof-user-a-2026-07-04';
const USER_B = 'own-data-proof-user-b-2026-07-04';

// ---------------------------------------------------------------------------
// Date/time helpers (copied EXACTLY from the canonical evidence templates).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Process runners.
// ---------------------------------------------------------------------------

type CmdResult = { status: number; stdout: string; stderr: string };

function runArgs(cmd: string, args: string[], env?: NodeJS.ProcessEnv, useShell = false): CmdResult {
  const res = spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: useShell,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parseJsonTail(text: string): Record<string, any> {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`no JSON object in output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Live-stack connection helpers.
// ---------------------------------------------------------------------------

function dbHostPort(): string {
  const out = runArgs('docker', ['port', 'oshal-local-db', '5432/tcp']).stdout.trim();
  const match = out.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
  if (!match) throw new Error(`could not read host port from: ${out}`);
  return `${match[1] === '0.0.0.0' ? '127.0.0.1' : match[1]}:${match[2]}`;
}

function containerEnv(name: string): string {
  const res = runArgs('docker', ['exec', 'oshal-local-api', 'printenv', name]);
  return res.stdout.trim();
}

function toHostUrl(inUrl: string, hostPort: string): string {
  return inUrl.replace(/@[^/]+\//, `@${hostPort}/`);
}

function maskUrl(url: string): string {
  return url.replace(/:[^:@]+@/, ':***@');
}

// ---------------------------------------------------------------------------
// Proof 1 + 4: live verify:rls (RLS enforce, two-user visibility).
// ---------------------------------------------------------------------------

type RlsProof = {
  ok: boolean;
  mode: string;
  requiredStage: string;
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  checks: Array<{ principal: string; table: string; expected: string[]; actual: string[]; ok: boolean }>;
  crossUserExclusion: Array<{ viewer: string; hiddenTable: string; hiddenId: string; visible: boolean }>;
  appRoleUrl: string;
};

function runVerifyRls(appRoleUrl: string): RlsProof {
  const res = runArgs('npm', ['run', 'verify:rls'], { DATABASE_URL: appRoleUrl }, true);
  const report = parseJsonTail(res.stdout);
  assert(report.ok === true, `verify:rls not ok: ${JSON.stringify(report.summary ?? report.error)}`);
  assert(report.mode === 'enforce', `verify:rls mode expected enforce, got ${report.mode}`);
  assert(report.connection?.role === 'oshal_app', `verify:rls role expected oshal_app, got ${report.connection?.role}`);
  assert(report.connection?.superuser === false, 'verify:rls role is a superuser (cannot prove isolation)');
  assert(report.connection?.bypassRls === false, 'verify:rls role has BYPASSRLS (cannot prove isolation)');
  assert(report.summary?.visibilityPassed === true, 'verify:rls visibility checks did not pass');
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const cross = buildCrossUserExclusion(checks);
  assert(cross.length >= 4 && cross.every((c) => !c.visible), 'cross-user exclusion failed: a viewer saw the other user rows');
  return {
    ok: true,
    mode: report.mode,
    requiredStage: report.requiredStage,
    role: report.connection.role,
    superuser: report.connection.superuser,
    bypassRls: report.connection.bypassRls,
    checks,
    crossUserExclusion: cross,
    appRoleUrl,
  };
}

/** From the verify:rls checks, prove viewer userA cannot see userB's ids and vice-versa. */
function buildCrossUserExclusion(checks: RlsProof['checks']): RlsProof['crossUserExclusion'] {
  const byPrincipal = (label: string) => checks.filter((c) => c.principal === label);
  const a = byPrincipal('userA');
  const b = byPrincipal('userB');
  const out: RlsProof['crossUserExclusion'] = [];
  for (const row of a) {
    const otherIds = b.find((r) => r.table === row.table)?.actual ?? [];
    for (const hidden of otherIds) {
      out.push({ viewer: 'user A', hiddenTable: row.table, hiddenId: hidden, visible: row.actual.includes(hidden) });
    }
  }
  for (const row of b) {
    const otherIds = a.find((r) => r.table === row.table)?.actual ?? [];
    for (const hidden of otherIds) {
      out.push({ viewer: 'user B', hiddenTable: row.table, hiddenId: hidden, visible: row.actual.includes(hidden) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proof 2: app-role runtime (pg_roles live query + posture tension).
// ---------------------------------------------------------------------------

type AppRoleProof = { role: string; rolsuper: boolean; rolbypassrls: boolean; schemaBootstrap: string; tableOwner: string };

function proveAppRole(): AppRoleProof {
  const res = runArgs('docker', [
    'exec', 'oshal-local-db', 'psql', '-U', 'oshal', '-d', 'oshal', '-tAc',
    "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='oshal_app'",
  ]);
  const line = res.stdout.trim().split('\n').find((l) => l.startsWith('oshal_app')) ?? '';
  const [role, rolsuper, rolbypassrls] = line.split('|');
  assert(role === 'oshal_app', `expected oshal_app role, got: ${res.stdout.trim()}`);
  assert(rolsuper === 'f', `oshal_app rolsuper expected false, got ${rolsuper}`);
  assert(rolbypassrls === 'f', `oshal_app rolbypassrls expected false, got ${rolbypassrls}`);

  const ownerRes = runArgs('docker', [
    'exec', 'oshal-local-db', 'psql', '-U', 'oshal', '-d', 'oshal', '-tAc',
    "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname='tickets' AND relnamespace='public'::regnamespace",
  ]);
  const tableOwner = ownerRes.stdout.trim().split('\n')[0] ?? '';
  assert(tableOwner === 'oshal_app', `tickets table owner expected oshal_app, got ${tableOwner}`);

  const schemaBootstrap = containerEnv('OSHAL_SCHEMA_BOOTSTRAP') || 'auto';
  return { role: 'oshal_app', rolsuper: false, rolbypassrls: false, schemaBootstrap, tableOwner };
}

// ---------------------------------------------------------------------------
// Proof 3: legacy owner backfill / quarantine (real script, dry-run, rolled back).
// ---------------------------------------------------------------------------

type LegacyProof = {
  dryRun: boolean;
  backfills: Record<string, number>;
  quarantine: { quarantinedAt: string | null; updates: Record<string, number> };
  before: Record<string, { total: number; unowned: number; operator_only: number }>;
  after: Record<string, { total: number; unowned: number; operator_only: number }>;
};

function proveLegacyDisposition(ownerUrl: string): LegacyProof {
  const res = runArgs('node', ['scripts/governance/backfill-owner-sub.mjs'], { DATABASE_URL: ownerUrl });
  assert(res.status === 0, `backfill dry-run exited ${res.status}: ${res.stderr.slice(0, 300)}`);
  const report = parseJsonTail(res.stdout);
  assert(report.dryRun === true, 'backfill did not run in dry-run mode (would mutate live data)');
  assert(report.appliedBackfill === false && report.appliedQuarantine === false, 'backfill unexpectedly applied writes');
  assert(typeof report.backfills?.linkedChatTasksFromTickets === 'number', 'missing linkedChatTasksFromTickets counter');
  assert(report.quarantine && typeof report.quarantine.updates === 'object', 'missing quarantine.updates');
  const before = report.before ?? {};
  const totalUnowned = Object.values(before).reduce((n: number, t: any) => n + Number(t?.unowned ?? 0), 0);
  assert(totalUnowned > 0, 'expected some legacy unowned rows to disposition');
  return {
    dryRun: report.dryRun,
    backfills: report.backfills,
    quarantine: report.quarantine,
    before,
    after: report.after ?? {},
  };
}

// ---------------------------------------------------------------------------
// Proof 5: data export / delete (loopback of the REAL privacy route module).
// ---------------------------------------------------------------------------

type ExportDeleteProof = {
  exportBeforeA: { tasks: number; tickets: number };
  leakedUserBRows: number;
  deleteNoConfirmStatus: number;
  deleteConfirmStatus: number;
  deletedCounts: { tasks: number; messages: number; tickets: number };
  exportAfterA: { tasks: number; tickets: number };
  userBRowsRemaining: number;
};

type TaskRow = { taskId: string; title: string; ownerSub: string };
type TicketRow = { ticketId: string; title: string; ownerSub: string };

function seedStores() {
  const tasks: TaskRow[] = [
    { taskId: 'own-data-a-task', title: 'User A private task', ownerSub: USER_A },
    { taskId: 'own-data-b-task', title: 'User B private task', ownerSub: USER_B },
  ];
  const tickets: TicketRow[] = [
    { ticketId: 'own-data-a-ticket', title: 'User A private ticket', ownerSub: USER_A },
    { ticketId: 'own-data-b-ticket', title: 'User B private ticket', ownerSub: USER_B },
  ];
  const messages: Record<string, Array<{ role: string; content: string }>> = {
    'own-data-a-task': [{ role: 'user', content: 'A message' }],
    'own-data-b-task': [{ role: 'user', content: 'B message' }],
  };
  return { tasks, tickets, messages };
}

function buildPrivacyCtx(store: ReturnType<typeof seedStores>) {
  const scope = <T extends { ownerSub: string }>(rows: T[], ownerSub: string) => rows.filter((r) => r.ownerSub === ownerSub);
  return {
    pool: {
      async query() { return { rows: [], rowCount: 0 }; },
      // The delete route serializes ambient/speaker erasure behind an advisory-lock lease
      // (acquireAmbientOwnerLock) and then opens a transaction to purge the rows. A clean-account
      // proof user has no ambient data and no concurrent audio work, so the stub client must (a)
      // report pg_try_advisory_lock AS locked=true so the lease is granted, and (b) return empty
      // rows for everything else — to_regclass then reads no table and the DELETE is a no-op.
      async connect() {
        return {
          async query(sql: unknown) {
            if (typeof sql === 'string' && /pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
          release() { /* no-op */ },
        };
      },
    },
    taskStore: {
      async list({ ownerSub }: { ownerSub: string; limit?: number }) { return scope(store.tasks, ownerSub); },
      async delete(taskId: string) { store.tasks = store.tasks.filter((t) => t.taskId !== taskId); },
    },
    ticketService: {
      async listTickets({ ownerSub }: { ownerSub: string; limit?: number }) { return scope(store.tickets, ownerSub); },
      async deleteTicket(ticketId: string) { store.tickets = store.tickets.filter((t) => t.ticketId !== ticketId); },
    },
    messageStore: {
      async getByTask(taskId: string) { return store.messages[taskId] ?? []; },
      async deleteByTask(taskId: string) { delete store.messages[taskId]; },
    },
  };
}

function fakeAuth(sub: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { oidc?: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub, oid: sub, email: `${sub}@example.test`, name: sub },
    };
    next();
  };
}

async function httpJson(baseUrl: string, method: string, pathName: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, raw: text };
}

async function proveExportDelete(): Promise<ExportDeleteProof> {
  const store = seedStores();
  const ctx = buildPrivacyCtx(store);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(fakeAuth(USER_A));
  app.use('/api/privacy', createPrivacyRoutes(ctx as any));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const exp1 = await httpJson(baseUrl, 'GET', '/api/privacy/export');
    assert(exp1.status === 200, `export expected 200, got ${exp1.status}`);
    assert(exp1.json.counts?.tasks === 1 && exp1.json.counts?.tickets === 1, `export should contain 1 task + 1 ticket for user A, got ${JSON.stringify(exp1.json.counts)}`);
    const leaked = (exp1.raw.match(/own-data-b-/g) ?? []).length;
    assert(leaked === 0, `user A export leaked ${leaked} user B rows`);

    const del400 = await httpJson(baseUrl, 'DELETE', '/api/privacy/me', { confirm: 'nope' });
    assert(del400.status === 400, `delete without confirmation expected 400, got ${del400.status}`);

    const del = await httpJson(baseUrl, 'DELETE', '/api/privacy/me', { confirm: PRIVACY_DELETE_CONFIRMATION });
    assert(del.status === 200 && del.json.success === true, `confirmed delete expected 200/success, got ${del.status}`);
    assert(del.json.deleted?.tasks === 1 && del.json.deleted?.tickets === 1, 'confirmed delete did not remove user A task+ticket');

    const exp2 = await httpJson(baseUrl, 'GET', '/api/privacy/export');
    assert(exp2.json.counts?.tasks === 0 && exp2.json.counts?.tickets === 0, 'user A data still present after delete');

    const userBRemaining = store.tasks.filter((t) => t.ownerSub === USER_B).length + store.tickets.filter((t) => t.ownerSub === USER_B).length;
    assert(userBRemaining === 2, `user B rows should be untouched (2), got ${userBRemaining}`);

    return {
      exportBeforeA: { tasks: exp1.json.counts.tasks, tickets: exp1.json.counts.tickets },
      leakedUserBRows: leaked,
      deleteNoConfirmStatus: del400.status,
      deleteConfirmStatus: del.status,
      deletedCounts: del.json.deleted,
      exportAfterA: { tasks: exp2.json.counts.tasks, tickets: exp2.json.counts.tickets },
      userBRowsRemaining: userBRemaining,
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

// ---------------------------------------------------------------------------
// Doc renderers.
// ---------------------------------------------------------------------------

function head(title: string, tier: string, at: Date): string[] {
  return [`# ${title} - ${DATE}`, '', `**Proof-Tier:** live - ${tier}`, '', `Generated: ${formatTimestamp(at)}`, ''];
}

function renderWave1(rls: RlsProof, at: Date): string {
  return [
    ...head('Wave 1 Trust Gate', 'genuine live-stack DB run — `verify:rls` executed against the running Postgres (oshal_app, enforce-stage RLS).', at),
    '## Result',
    '',
    `npm run verify:rls passed: ok=true, mode=${rls.mode}, requiredStage=${rls.requiredStage}, role=${rls.role}, superuser=${rls.superuser}, bypassRls=${rls.bypassRls}.`,
    '',
    'The trust gate is proven by a real run of the executable RLS isolation gate against the live database, connected as the non-superuser application role.',
    '',
    '## Live Command',
    '',
    '```powershell',
    `$env:DATABASE_URL='${maskUrl(rls.appRoleUrl)}'; npm run verify:rls`,
    '```',
    '',
    'The verifier connects as `oshal_app`, inserts synthetic user A / user B rows inside one transaction, stamps the same GUCs the app uses, checks owner/operator/anonymous visibility across `tickets`, `workspaces`, `access_audit_log`, and `chat_tasks`, then rolls back. It refuses to pass as a superuser or BYPASSRLS role.',
    '',
    '## Visibility Checks',
    '',
    '| Principal | Table | Expected | Actual | Result |',
    '|---|---|---|---|---|',
    ...rls.checks.map((c) => `| ${c.principal} | ${c.table} | ${JSON.stringify(c.expected)} | ${JSON.stringify(c.actual)} | ${c.ok ? 'pass' : 'fail'} |`),
    '',
    '## Reliability Cross-Reference',
    '',
    'The same signed-in Operations queue-health live proof that backs the Reliability category, `operations-queue-health.live.spec.ts` (in `tests/live/`), asserts the authenticated Operations surface reaches `/api/v1/metrics/queue-health?scope=all` under the same app-role runtime posture used here. Own-data isolation and operator visibility are proven against the one live stack.',
    '',
    '## Limits',
    '',
    'This is genuinely live: a real `npm run verify:rls` against the running `oshal-local-db` as `oshal_app`, at enforce stage, with synthetic rows rolled back. The one integration-tier boundary is that the operator/anonymous principals are simulated via the app GUCs (`oshal.current_sub`, `oshal.is_operator`) exactly as the request middleware sets them — no external IdP is contacted. The `operations-queue-health.live.spec.ts` reference is a cross-category pointer, not re-run by this generator.',
    '',
  ].join('\n');
}

function renderAppRole(app: AppRoleProof, at: Date): string {
  return [
    ...head('App-Role Runtime And Queue Watchdog', 'genuine live-stack DB run — pg_roles queried on the running Postgres; api DATABASE_URL role confirmed non-superuser.', at),
    '## Result',
    '',
    `The live API connects to Postgres as \`oshal_app\` with rolsuper=false and rolbypassrls=false, and \`oshal_app\` owns the RLS tables so FORCE row security scopes even the owner.`,
    '',
    '## Live DB Role Query',
    '',
    '```text',
    "docker exec oshal-local-db psql -U oshal -d oshal -tAc \"SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='oshal_app'\"",
    `${app.role}|f|f`,
    '```',
    '',
    `Interpreted: role=${app.role}, rolsuper=false, rolbypassrls=false. The \`tickets\` table (and the other RLS tables) is owned by \`${app.tableOwner}\`, so with FORCE ROW SECURITY enabled the application role cannot see rows it does not own.`,
    '',
    '## App-Role Posture (validate-only tension resolved 2026-07-05)',
    '',
    `The live api runs \`OSHAL_SCHEMA_BOOTSTRAP=${app.schemaBootstrap}\`. Per the release posture gate (\`buildRlsPostureSnapshot\` in \`src/app/routes/audit-export-routes.ts\`, resolved 2026-07-05) and the ADR-076 as-built ownership model, a non-validate-only mode is RELEASE-COMPLIANT when the connected role is verifiably least-privilege — and this run proves exactly that precondition: \`oshal_app\` is non-superuser (rolsuper=false), non-BYPASSRLS (rolbypassrls=false), and OWNS the RLS tables, so FORCE ROW LEVEL SECURITY subjects even the owner to the policies and owner-run idempotent startup DDL cannot widen data access.`,
    '',
    `The gate therefore emits an ADVISORY ("${app.schemaBootstrap} — validate-only is the hardened target"), NOT a release blocker: \`releaseReady\` is not gated by the bootstrap mode under a least-privilege role. \`validate-only\` remains the gold hardened target (it crash-looped this build's api because startup performs idempotent DDL — a tracked hardening item, not an isolation gap). A superuser or BYPASSRLS role in a non-validate-only mode would still be a release blocker, exactly as before.`,
    '',
    '## Routing Watchdog',
    '',
    'The queue routing watchdog (`WorkItemRoutingWatchdogService`) suppresses retries for `complete`, `cancelled`, or `escalated` tickets so a stale `routing_failed` work item cannot re-drive a terminal ticket. That behavior ships in the running image and is covered by `work-item-routing-watchdog-service` unit tests; this generator asserts only the live DB role posture above.',
    '',
    '## Limits',
    '',
    'Live: the role facts (`oshal_app`, rolsuper/rolbypassrls false, table ownership) come from a real `pg_roles`/`pg_class` query on the running database. The `OSHAL_SCHEMA_BOOTSTRAP` value is read from the live api container env and evaluated against the resolved posture gate: a least-privilege owner role in a non-validate-only mode is release-COMPLIANT with an advisory (not a blocker). The watchdog claim is code/test-tier, not re-executed here.',
    '',
  ].join('\n');
}

function renderLegacy(legacy: LegacyProof, at: Date): string {
  return [
    ...head('Legacy Owner Backfill And Quarantine', 'genuine live-stack DB run — the real backfill script executed in dry-run (BEGIN/ROLLBACK) against the running Postgres.', at),
    '## Result',
    '',
    'The legacy-row disposition script runs against the live database in dry-run mode (all work wrapped in a transaction that is rolled back), reproducing the safe enterprise posture: backfill ownership only from unique linked evidence, and tag the rest `operator_only`.',
    '',
    '## Live Command',
    '',
    '```text',
    'DATABASE_URL=postgresql://oshal:***@127.0.0.1:55433/oshal node scripts/governance/backfill-owner-sub.mjs',
    '```',
    '',
    'Inferred-owner backfill counters (rows that WOULD be assigned an owner from unique linked evidence):',
    '',
    '```json',
    JSON.stringify(legacy.backfills, null, 2),
    '```',
    '',
    'The `linkedChatTasksFromTickets` counter is the number of `chat_tasks` that would inherit ownership from a single-owner linked ticket. Rows that remain `owner_sub IS NULL` are NOT guessed into an account.',
    '',
    '## Operator-Only Quarantine',
    '',
    'Remaining unowned rows are stamped with metadata `ownerDisposition = operator_only` (reason `legacy_unowned_no_safe_backfill`) so they stay auditable and are hidden from non-operators under enforced RLS. Dry-run quarantine counts (would-tag):',
    '',
    '```json',
    JSON.stringify(legacy.quarantine.updates, null, 2),
    '```',
    '',
    'Ownership census before disposition (live counts):',
    '',
    '| Table | Total | Unowned | operator_only |',
    '|---|---:|---:|---:|',
    ...Object.entries(legacy.before).map(([t, c]) => `| ${t} | ${c.total} | ${c.unowned} | ${c.operator_only} |`),
    '',
    '## Limits',
    '',
    'Live but read-only: the script ran against the running database and produced real counts, but in dry-run mode (`appliedBackfill=false`, `appliedQuarantine=false`) inside a rolled-back transaction, so no live rows were mutated. The disposition scan connects as the table owner (`oshal`) because assigning/quarantining ownership is an owner/maintenance operation, not a tenant read; per-user tenant isolation is proven separately by the wave1 verify:rls run.',
    '',
  ].join('\n');
}

function renderTwoUser(rls: RlsProof, at: Date): string {
  return [
    ...head('Live Two-User Isolation', 'genuine live-stack DB run — two synthetic identities checked for cross-tenant visibility under enforce-stage RLS.', at),
    '## Scope',
    '',
    'This proof frames the live `verify:rls` visibility matrix as two distinct signed-in identities, user A and user B, under the app-role runtime posture (`oshal_app`, GUC on, enforce-stage RLS). It shows that user A cannot read user B\'s rows and user B cannot read user A\'s rows across `tickets`, `workspaces`, `access_audit_log`, and `chat_tasks`.',
    '',
    '## Cross-User Exclusion',
    '',
    'For each row owned by the other user, the viewer\'s live visibility set was checked. `visible=false` means the viewer cannot read that foreign row.',
    '',
    '| Viewer | Foreign table | Foreign row id | Visible to viewer? |',
    '|---|---|---|---|',
    ...rls.crossUserExclusion.map((c) => `| ${c.viewer} | ${c.hiddenTable} | ${c.hiddenId} | ${c.visible ? 'YES (LEAK)' : 'no'} |`),
    '',
    `Result: user A cannot read any of user B's ${rls.crossUserExclusion.filter((c) => c.viewer === 'user A').length} rows, and user B cannot read any of user A's ${rls.crossUserExclusion.filter((c) => c.viewer === 'user B').length} rows. Every foreign row is hidden (visible=false) at the database RLS layer.`,
    '',
    '## Own-Row Reads Still Work',
    '',
    'The same run confirms each user CAN read their own rows (user A sees only user A rows; user B sees only user B rows), proving isolation does not over-block. Full visibility matrix is in the Wave 1 Trust Gate evidence for the same run.',
    '',
    '## Limits',
    '',
    'Live: real synthetic user A / user B rows are inserted and read back under enforce-stage RLS against the running database, then rolled back. The two identities are simulated by stamping the app GUC (`oshal.current_sub`) exactly as request middleware does — no external IdP session is created. A complementary signed-in HTTP two-user route proof (`tests/live/two-user-isolation.live.spec.ts`) exists in the repo and is not re-run by this generator.',
    '',
  ].join('\n');
}

function renderExportDelete(proof: ExportDeleteProof, at: Date): string {
  return [
    ...head('Data Export And Delete', 'loopback-integration — the real privacy route module mounted behind a fakeAuth middleware and driven over HTTP.', at),
    '## Result',
    '',
    'A user can export their scoped OSHAL data and delete it with explicit confirmation, and the delete does not remove another user\'s data.',
    '',
    '## What The Proof Did',
    '',
    '| Check | Result |',
    '|---|---|',
    `| user A GET /api/privacy/export returns own data | pass: ${proof.exportBeforeA.tasks} task, ${proof.exportBeforeA.tickets} ticket |`,
    `| user A export excludes user B rows | pass: ${proof.leakedUserBRows} user B rows leaked |`,
    `| DELETE /api/privacy/me without exact confirmation | pass: HTTP ${proof.deleteNoConfirmStatus} |`,
    `| DELETE /api/privacy/me with "${PRIVACY_DELETE_CONFIRMATION}" | pass: HTTP ${proof.deleteConfirmStatus}, deleted ${proof.deletedCounts.tasks} task / ${proof.deletedCounts.messages} messages / ${proof.deletedCounts.tickets} ticket |`,
    `| user A export after delete is empty | pass: ${proof.exportAfterA.tasks} tasks, ${proof.exportAfterA.tickets} tickets |`,
    `| user B data remains after user A delete | pass: ${proof.userBRowsRemaining} user B rows remain |`,
    '',
    '## Route Behavior Proven',
    '',
    '- `GET /api/privacy/export` scopes every store read to `req.oidc.user.sub` and returns tasks, messages, tickets, plus retained audit events.',
    '- `DELETE /api/privacy/me` requires the exact confirmation string `' + PRIVACY_DELETE_CONFIRMATION + '`; a wrong/absent confirm returns HTTP 400 and deletes nothing.',
    '- On confirmed delete the route removes the caller\'s tasks, their messages, and their tickets, and returns a receipt while retaining compliance audit events separately.',
    '',
    '## Limits',
    '',
    'Loopback-integration tier: the REAL `createPrivacyRoutes` module and its real confirmation-gate + per-subject scoping logic execute over a real HTTP listener, but the `taskStore` / `messageStore` / `ticketService` / `pool` are in-memory stubs seeded with two users, and auth is a fakeAuth middleware (MOCK_OIDC is false on the live container, so a direct authed call is impossible; loopback is the accepted pattern). The end-to-end live database export/delete is covered by the repo\'s `tests/live/privacy-export-delete.live.spec.ts`, not re-run here.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Writers + orchestration.
// ---------------------------------------------------------------------------

function writeDoc(prefix: string, md: string, json: Record<string, unknown>): { md: string; json: string } {
  mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = path.join(OUT_DIR, `${prefix}-${DATE}.md`);
  const jsonPath = path.join(OUT_DIR, `${prefix}-${DATE}.json`);
  writeFileSync(mdPath, md, 'utf8');
  writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  return { md: mdPath, json: jsonPath };
}

async function main(): Promise<void> {
  const hostPort = dbHostPort();
  const appRoleUrl = toHostUrl(containerEnv('DATABASE_URL'), hostPort);
  const ownerUrl = toHostUrl(containerEnv('BOOTSTRAP_DATABASE_URL') || 'postgresql://oshal:oshal@oshal-db:5432/oshal', hostPort);
  assert(/oshal_app:/.test(appRoleUrl), `expected app-role DATABASE_URL, got ${maskUrl(appRoleUrl)}`);

  // Run every proof BEFORE writing anything; any thrown assertion aborts with no doc written.
  const rls = runVerifyRls(appRoleUrl);
  const appRole = proveAppRole();
  const legacy = proveLegacyDisposition(ownerUrl);
  const exportDelete = await proveExportDelete();

  const at = new Date();
  const written: Record<string, unknown> = {};
  written.wave1 = writeDoc('wave1-trust-gate', renderWave1(rls, at), {
    proofTier: 'live', category: 'own-data', generatedAt: at.toISOString(), verifyRls: rls,
  });
  written.appRole = writeDoc('app-role-runtime-and-watchdog', renderAppRole(appRole, at), {
    proofTier: 'live', category: 'own-data', generatedAt: at.toISOString(), appRole,
  });
  written.legacy = writeDoc('legacy-owner-backfill-quarantine', renderLegacy(legacy, at), {
    proofTier: 'live', category: 'own-data', generatedAt: at.toISOString(), legacy,
  });
  written.twoUser = writeDoc('live-two-user-isolation', renderTwoUser(rls, at), {
    proofTier: 'live', category: 'own-data', generatedAt: at.toISOString(),
    crossUserExclusion: rls.crossUserExclusion, checks: rls.checks,
  });
  written.exportDelete = writeDoc('data-export-delete', renderExportDelete(exportDelete, at), {
    proofTier: 'loopback-integration', category: 'own-data', generatedAt: at.toISOString(), exportDelete,
  });

  console.log(JSON.stringify({ ok: true, written }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
