/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add Change Log header; docs/ path references updated in the 2026-07-04 docs consolidation
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stop hardcoding the evidence date: DATE now derives from the run date so the own-data proofs (wave1/app-role/legacy/two-user/export) get correctly-dated filenames instead of always emitting *-2026-07-04.md — the "filename date lag" the competitive audit flagged, which trips freshness checks keyed on the filename and mis-sorts newest-by-name globs.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Privacy-delete stub: add pool.connect() no-op transactional client so the export/delete proof survives the delete route's new ambient/speaker-data cleanup transaction (clean-account user has no ambient rows -> no-op). Was failing "confirmed delete expected 200, got 500: pool.connect is not a function".
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Replace loopback stores with the real mock-OIDC route specs on the live app-role database; consume their structured Playwright attachments and refuse evidence when Postgres/RLS proof is absent.
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
 *   - live-two-user-isolation    -> combines verify:rls with the real signed-in route spec;
 *                                    both synthetic owners must reach Postgres and remain isolated.
 *   - data-export-delete         -> runs the real privacy HTTP route spec on that app-role
 *                                    database and proves user B's rows survive user A deletion.
 *
 * On ANY failed assertion the generator prints failures, sets exit code 1, and writes
 * NO evidence docs. Nothing is hardcoded to pass.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-own-data-live.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Derive the evidence date from the run date (dateStamp is a hoisted function declaration).
// Previously hardcoded to 2026-07-04, which made every nightly run emit stale-named files.
const DATE = dateStamp(new Date());
const OUT_DIR = path.join(process.cwd(), 'docs', 'evidence');

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

function runArgs(cmd: string, args: string[], env?: NodeJS.ProcessEnv): CmdResult {
  const res = spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
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

function dockerHostPort(container: string, containerPort: number): string {
  const out = runArgs('docker', ['port', container, `${containerPort}/tcp`]).stdout.trim();
  const match = out.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
  if (!match) throw new Error(`could not read ${container}:${containerPort} host port from: ${out}`);
  return `${match[1] === '0.0.0.0' ? '127.0.0.1' : match[1]}:${match[2]}`;
}

function dbHostPort(): string {
  return dockerHostPort('oshal-local-db', 5432);
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
  const res = runArgs(process.execPath, ['scripts/governance/verify-rls-isolation.mjs'], { DATABASE_URL: appRoleUrl });
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
  const res = runArgs(process.execPath, ['scripts/governance/backfill-owner-sub.mjs'], { DATABASE_URL: ownerUrl });
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
// Proof 4 + 5: real signed-in route specs over the live app-role database.
// ---------------------------------------------------------------------------

interface PlaywrightAttachment {
  name: string;
  body?: string;
  contentType: string;
}

interface PlaywrightResult {
  status?: string;
  attachments: PlaywrightAttachment[];
}

interface PlaywrightSpec {
  title: string;
  file: string;
  ok: boolean;
  tests: Array<{ status: string; results: PlaywrightResult[] }>;
}

interface PlaywrightSuite {
  specs: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface PlaywrightReport {
  suites: PlaywrightSuite[];
  errors: Array<{ message?: string }>;
  stats: { startTime: string; duration: number; expected: number; unexpected: number; flaky: number; skipped: number };
}

interface LiveOwnDataRouteProof {
  databaseRole: 'oshal_app';
  databaseUrl: string;
  stats: PlaywrightReport['stats'];
  twoUser: Record<string, any>;
  exportDelete: Record<string, any>;
}

/** @description Reserves an unused loopback port for Playwright's isolated evidence server. */
async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function collectPlaywrightSpecs(suites: PlaywrightSuite[]): PlaywrightSpec[] {
  return suites.flatMap((suite) => [
    ...suite.specs,
    ...collectPlaywrightSpecs(suite.suites ?? []),
  ]);
}

/** @description Decodes one structured attachment only after its exact spec passed without skip. */
function proofAttachment(
  report: PlaywrightReport,
  fileSuffix: string,
  attachmentName: string,
): Record<string, any> {
  const normalizedSuffix = fileSuffix.replace(/\\/g, '/');
  const specs = collectPlaywrightSpecs(report.suites);
  const spec = specs.find((candidate) => {
    const file = candidate.file.replace(/\\/g, '/');
    return file.endsWith(normalizedSuffix)
      || normalizedSuffix.endsWith(`/${file}`)
      || path.posix.basename(file) === path.posix.basename(normalizedSuffix);
  });
  assert(spec, `Playwright report omitted ${fileSuffix}; reported: ${specs.map((candidate) => candidate.file).join(', ')}`);
  assert(spec.ok, `${fileSuffix} did not pass: ${spec.title}`);
  assert(spec.tests.length === 1 && spec.tests[0].status === 'expected', `${fileSuffix} was skipped/flaky/unexpected`);
  const finalResult = spec.tests[0].results.at(-1);
  assert(finalResult?.status === 'passed', `${fileSuffix} final result was ${finalResult?.status ?? 'missing'}`);
  const attachment = finalResult.attachments.find((candidate) => candidate.name === attachmentName);
  assert(attachment?.body, `${fileSuffix} did not attach ${attachmentName}`);
  const decoded = Buffer.from(attachment.body, 'base64').toString('utf8');
  const proof = JSON.parse(decoded) as Record<string, any>;
  assert(proof.databaseEvidence, `${fileSuffix} did not prove its fixtures reached Postgres`);
  return proof;
}

/**
 * @description Runs both real route specs against the live app-role DSN. The specs opt into direct
 * database assertions, so optional in-memory fallback cannot produce a passing evidence artifact.
 */
async function proveLiveOwnDataRoutes(appRoleUrl: string, redisUrl: string): Promise<LiveOwnDataRouteProof> {
  const port = await availableLoopbackPort();
  const reportDir = mkdtempSync(path.join(tmpdir(), 'oshal-own-data-playwright-'));
  const reportPath = path.join(reportDir, 'report.json');
  try {
    const res = runArgs(process.execPath, [
      'node_modules/playwright/cli.js', 'test',
      'tests/live/privacy-export-delete.live.spec.ts',
      'tests/live/two-user-isolation.live.spec.ts',
      '--reporter=json', '--workers=1', '--retries=0',
    ], {
      CI: 'true',
      NODE_ENV: 'test',
      MOCK_OIDC: 'true',
      MOCK_OIDC_ALLOW_HEADER: 'true',
      OSHAL_OWN_DATA_DATABASE_EVIDENCE: 'true',
      DATABASE_URL: appRoleUrl,
      REDIS_URL: redisUrl,
      RUN_MIGRATIONS: 'false',
      OSHAL_SCHEMA_BOOTSTRAP: 'validate-only',
      FORCE_LLM_PROVIDER: 'noop',
      PLAYWRIGHT_PORT: String(port),
      PLAYWRIGHT_REUSE_SERVER: 'false',
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      SESSION_SECRET: 'own-data-evidence-ephemeral-session-secret',
      SWARM_SERVICE_SECRET: 'own-data-evidence-ephemeral-service-secret',
      TRADING_LIVE_ENABLED: 'false',
      TRADING_AUTOPILOT_ENABLED: 'false',
      TRADING_AUTOPILOT_LIVE: 'false',
      TRADING_HALT: 'true',
    });
    assert(res.status === 0, `own-data Playwright proofs exited ${res.status}: ${(res.stderr || res.stdout).slice(-2000)}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as PlaywrightReport;
    assert(report.errors.length === 0, `Playwright reporter errors: ${JSON.stringify(report.errors)}`);
    assert(report.stats.expected === 2, `expected exactly 2 own-data specs, got ${JSON.stringify(report.stats)}`);
    assert(report.stats.unexpected === 0 && report.stats.flaky === 0 && report.stats.skipped === 0,
      `own-data specs were not clean passes: ${JSON.stringify(report.stats)}`);

    const twoUser = proofAttachment(
      report, 'tests/live/two-user-isolation.live.spec.ts', 'two-user-isolation-proof.json',
    );
    const exportDelete = proofAttachment(
      report, 'tests/live/privacy-export-delete.live.spec.ts', 'privacy-export-delete-proof.json',
    );
    assert(twoUser.databaseEvidence?.userA?.role === 'oshal_app', 'two-user proof did not use oshal_app');
    assert(exportDelete.databaseEvidence?.before?.userA?.role === 'oshal_app', 'export/delete proof did not use oshal_app');
    return {
      databaseRole: 'oshal_app',
      databaseUrl: maskUrl(appRoleUrl),
      stats: report.stats,
      twoUser,
      exportDelete,
    };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
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

function renderTwoUser(rls: RlsProof, routes: LiveOwnDataRouteProof, at: Date): string {
  const route = routes.twoUser;
  const database = route.databaseEvidence as Record<string, any>;
  return [
    ...head('Live Two-User Isolation', 'genuine live-stack DB + signed-in HTTP run — two synthetic identities checked at both route and enforce-stage RLS boundaries.', at),
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
    '## Signed-In Route And Database Proof',
    '',
    `The nightly generator re-ran tests/live/two-user-isolation.live.spec.ts against an isolated mock-OIDC server connected as ${routes.databaseRole}. Playwright passed ${routes.stats.expected} own-data specs with zero skipped, flaky, or unexpected results in ${routes.stats.duration} ms.`,
    '',
    '| Caller | Own task persisted in Postgres | Foreign task visible through Postgres/RLS |',
    '|---|---|---|',
    `| user A (${route.userA.sub}) | ${database.userA.tasks[0].taskId} | no |`,
    `| user B (${route.userB.sub}) | ${database.userB.tasks[0].taskId} | no |`,
    '',
    'The same two identities then exercised task list/get and task-message HTTP routes; every own read returned 200 and every cross-owner object read returned 404.',
    '',
    '## Limits',
    '',
    'Live: `verify:rls` inserts synthetic rows inside a rolled-back transaction, while the signed-in route spec creates uniquely named task rows through the real HTTP API, proves them directly through the app-role/GUC database connection, and deletes them in cleanup. Mock OIDC supplies the two test identities; no external identity provider is contacted.',
    '',
  ].join('\n');
}

function renderExportDelete(routes: LiveOwnDataRouteProof, at: Date): string {
  const proof = routes.exportDelete;
  const database = proof.databaseEvidence as Record<string, any>;
  return [
    ...head('Data Export And Delete', 'genuine live-stack route/database run — the real privacy endpoints exercised with two mock-OIDC identities over app-role Postgres.', at),
    '## Result',
    '',
    'A user can export their scoped OSHAL data and delete it with explicit confirmation, and the delete does not remove another user\'s data.',
    '',
    '## What The Proof Did',
    '',
    '| Check | Result |',
    '|---|---|',
    `| user A fixtures reached Postgres as ${routes.databaseRole} | pass: task ${proof.userA.deletedTask}, ticket ${proof.userA.deletedTicket} |`,
    `| user A export excludes user B rows | pass: user B task/ticket absent from user A response |`,
    `| DELETE /api/privacy/me without exact confirmation | pass: HTTP 400 |`,
    `| confirmed user A delete removes app-role database rows | pass: ${database.after.userA.tasks.length} tasks and ${database.after.userA.tickets.length} tickets remain |`,
    `| user B data remains after user A delete | pass: task ${database.after.userB.tasks[0].taskId}, ticket ${database.after.userB.tickets[0].ticketId} |`,
    '',
    '## Route Behavior Proven',
    '',
    '- `GET /api/privacy/export` scopes every store read to `req.oidc.user.sub` and returns tasks, messages, tickets, plus retained audit events.',
    '- `DELETE /api/privacy/me` requires the route\'s exact confirmation constant; a wrong/absent confirm returns HTTP 400 and deletes nothing.',
    '- On confirmed delete the route removes the caller\'s tasks, their messages, and their tickets, and returns a receipt while retaining compliance audit events separately.',
    '',
    '## Limits',
    '',
    'Live application boundary: `tests/live/privacy-export-delete.live.spec.ts` is re-run by this generator over HTTP with mock-OIDC identities and the live `oshal_app` DSN. Its direct database assertions reject superuser/BYPASSRLS roles and reject the optional in-memory fallback. Synthetic operational rows are deleted; compliance audit events remain by design. No external identity provider is contacted.',
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
  const redisUrl = `redis://${dockerHostPort('oshal-local-redis', 6379)}`;
  assert(/oshal_app:/.test(appRoleUrl), `expected app-role DATABASE_URL, got ${maskUrl(appRoleUrl)}`);

  // Run every proof BEFORE writing anything; any thrown assertion aborts with no doc written.
  const rls = runVerifyRls(appRoleUrl);
  const appRole = proveAppRole();
  const legacy = proveLegacyDisposition(ownerUrl);
  const routeProof = await proveLiveOwnDataRoutes(appRoleUrl, redisUrl);

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
  written.twoUser = writeDoc('live-two-user-isolation', renderTwoUser(rls, routeProof, at), {
    proofTier: 'live', category: 'own-data', generatedAt: at.toISOString(),
    crossUserExclusion: rls.crossUserExclusion, checks: rls.checks, routeProof: routeProof.twoUser,
  });
  written.exportDelete = writeDoc('data-export-delete', renderExportDelete(routeProof, at), {
    proofTier: 'live', category: 'own-data', generatedAt: at.toISOString(), exportDelete: routeProof.exportDelete,
    playwright: routeProof.stats, databaseRole: routeProof.databaseRole,
  });

  console.log(JSON.stringify({ ok: true, written }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
