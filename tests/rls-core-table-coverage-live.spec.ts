/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-124 RLS Phase 2 drift guard. The BACKLOG's residual list had been wrong for a month in BOTH directions — it still named five tables migration 094 closed, and named none of the 114 tables a live inventory found with RLS switched off. Prose cannot hold this: the guard derives the CORE table set from the tree (CREATE TABLE across scripts/migrations + src + any-bot, resolving ${IDENT} template names), intersects it with the live database, and fails unless every core table is either ENABLE+FORCE RLS'd or carries a written justification here. Stale exceptions fail too — an entry whose table has since been walled, dropped, or left the core tree must be deleted, so the list cannot rot into an allowlist nobody reads.
 */

/**
 * ADR-124 — core-table RLS coverage (the drift guard).
 *
 * WHAT GOES RED:
 *   * a NEW core table lands without RLS and without a justification → red
 *   * an EXISTING exception gets walled and the entry is left behind → red
 *   * an exception names a table the database or the core tree no longer has → red
 *   * an exception's stated reason is empty → red
 *
 * WHY IT NEVER SKIPS: a guard that skips in CI is a guard that does not exist
 * (CLAUDE.md "Guard-per-fix"). Without a database URL this FAILS.
 *
 * WHAT "CORE" MEANS: a table whose CREATE TABLE lives in THIS repository.
 * Store-package tables (Rule 0c — dnd_*, gameshow_*, sales_*, lm_*, ps_portraits,
 * career_*, …) create their own schema from the oshal-apps repo and are out of
 * scope by construction; they are excluded because the scan cannot find their DDL
 * here, not by an allowlist that could drift.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const ADMIN_URL =
  process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? '';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Core tables that are deliberately NOT walled, each with the reason. This list is
 * the deliverable of ADR-124's exception review — an enumerated, justified set, not
 * silence. Entries fall into four kinds:
 *
 *   CATALOG    platform-global reference data every user legitimately sees the same
 *              rows of. An owner column would be meaningless.
 *   MACHINERY  scheduler / queue / migration / tool plumbing keyed by a run, unit or
 *              provider. No end user owns a row.
 *   DEFERRED   holds user rows and COULD be walled, but a real reader cannot present
 *              an identity yet. Each carries a done-when in ADR-124; walling first
 *              would be an outage, not a hardening.
 *   PUBLIC     shared data with a deliberate permissive policy (RLS on, FORCE off).
 */
const JUSTIFIED_EXCEPTIONS: Record<string, string> = {
  // ── CATALOG ───────────────────────────────────────────────────────────────
  a2a_agents: 'CATALOG — operator-managed registry of external A2A agents (token_hash/scopes/enabled). Platform config, not user rows.',
  agent_config: 'CATALOG — global per-agent runtime configuration. Every user addresses the same bots.',
  agent_tools: 'CATALOG — agent-to-tool join over two global catalogs. Neither side has an owner.',
  agents: 'CATALOG — the bot registry. Platform-global by design (UUIDs must match compose + Redis heartbeats).',
  persona_layers: 'CATALOG — persona prompt layers loaded at prompt-assembly time. Platform-global.',
  runtime_tool_executors: 'CATALOG — tool executor definitions. Platform-global.',
  tools: 'CATALOG — the Layer-1 tool catalog. Platform-global.',
  oshal_trading_params: 'CATALOG — the single global strategy parameter set. Not per-user (per-user sleeves live in oshal_trading_* owner tables, already walled).',
  oshal_trading_param_recommendations: 'CATALOG — optimizer output against the single global parameter set.',
  oshal_trading_signal_weights: 'CATALOG — global signal weights for the shared model.',
  kalshi_forecast_log: 'CATALOG — market forecast series. Public market data, identical for every caller.',
  kalshi_predictions: 'CATALOG — market prediction series. Public market data.',
  travel_observations: 'CATALOG — anonymous fare observations (route/price/date). Carries no requester at all.',

  // ── MACHINERY ─────────────────────────────────────────────────────────────
  app_migrations: 'MACHINERY — the migration ledger. Walling it would hide schema state from the bootstrap that maintains it.',
  app_package_migrations: 'MACHINERY — store-package migration ledger. Same reason.',
  config_snapshots: 'MACHINERY — global config snapshots for rollback.',
  config_sync_log: 'MACHINERY — config propagation trail between containers.',
  oshal_intake_cursors: 'MACHINERY — per-provider intake cursors (provider, cursor_value). Keyed by provider, never by a person.',
  oshal_queue_dlq: 'MACHINERY — queue dead-letter records. Operator recovery surface.',
  oshal_webhook_deliveries: 'MACHINERY — replay-dedup ledger (delivery_id, seen_at). Two columns, neither an owner.',
  oshal_free_tier_state: 'MACHINERY — per-CONNECTION cooldown state keyed by connection_id, not by a sub.',
  routing_audit_log: 'MACHINERY — dispatcher routing decisions (winner agent, scores, tiers). An operator observability trail over swarm internals.',
  subtask_lifecycle_parents: 'MACHINERY — swarm decomposition state keyed by unit_id. No user owns a work unit.',
  subtask_lifecycle_subtasks: 'MACHINERY — same; keyed by subtask_unit_id.',
  swarm_runs: 'MACHINERY — swarm run records keyed by run_id. Runs belong to the swarm, not a person.',
  swarm_escalations: 'MACHINERY — retry/escalation state keyed by run_id.',
  work_items: 'MACHINERY — swarm decomposition units. Checked for a derivable parent and there is none: work_items.external_id matches ZERO of 298 rows against tickets.external_id, and swarm_run_id resolves only to swarm_runs, which has no owner either.',
  tool_install_log: 'MACHINERY — tool installation trail over the global tool catalog.',
  tool_verification_results: 'MACHINERY — tool verification results over the global tool catalog.',
  eval_runs: 'MACHINERY — operational-intelligence eval harness results, keyed by scenario. Synthetic, not user data.',
  test_lab_golden_runs: 'MACHINERY — test-lab golden-run results, keyed by scenario/batch.',
  oshal_budgets: 'MACHINERY — operator-set spend caps. scope_key can be a sub, but the table IS the operator governance surface and setBudget already enforces tamper-proofing via set_by_operator; RLS would hide an operator cap from the operator.',
  oshal_budget_events: 'MACHINERY — the enforcement trail for the above. Same surface, same reason.',

  // ── PUBLIC ────────────────────────────────────────────────────────────────
  market_bars: 'PUBLIC — OHLCV reference data. RLS is ENABLED with a deliberate permissive market_bars_public policy and deliberately NOT forced; every caller is meant to read the same bars.',

  // ── DEFERRED (done-whens in ADR-124) ──────────────────────────────────────
  human_feedback: 'DEFERRED — reviewer verdicts keyed by ticket_external_id (TEXT), not the tickets uuid, so the derived-owner pattern needs a stable external_id -> tickets mapping first. Empty today.',
  tool_approval_requests: 'DEFERRED — has a task_id and would take the oshal_owns_task policy, but it is the fail-CLOSED tool-approval gate: a scoping mistake hides approval requests from the operator resolving them. Wall it with a live proof of the operator read path, not blind.',
  oshal_trading_daily_equity: 'DEFERRED — read by host CLIs (site-oshal-report.js, oshal-deck-data.js) that open a raw pg Pool on DATABASE_URL. The operator DSN is oshal_app (NOSUPERUSER, NOBYPASSRLS) and no script stamps a GUC, so walling silently empties the daily oshal report.',
  oshal_trading_strategy_journal: 'DEFERRED — same host-CLI readers (oshal-report-journal.js, oshal-strategy-journal.js). Same silent-empty failure.',
  pumpkin_presets: 'DEFERRED — core-migrated (084) but read only by the carved store package over device auth, where no caller sub is established. Walling breaks the projector before it protects anything.',
  pumpkin_settings: 'DEFERRED — same package, same device-auth path.',
  kalshi_orders: 'DEFERRED — carries user_sub NOT NULL, but its writer is the carved store package on a service-or-oidc route; the service arm establishes no sub, so an audited order would be refused and the ADR-094 fail-closed posture would log a phantom failure.',
};

/** Directories scanned for CREATE TABLE. Everything else is store or generated. */
const SCAN_ROOTS = ['scripts/migrations', 'src', 'any-bot'];
const SCAN_EXT = new Set(['.sql', '.ts', '.js', '.mjs']);

/**
 * @description Extracts every table name this repository creates. Handles the literal
 * form (`CREATE TABLE IF NOT EXISTS public.foo`) and the templated form
 * (`CREATE TABLE IF NOT EXISTS ${GOVERNANCE_TABLE}`) by resolving the identifier against
 * a `const IDENT = 'literal'` in the SAME file — three core tables (ticket_governance,
 * oshal_connector_user_enablement, the world-data subjects table) are only created that
 * way, and a scanner that missed them would leave a real hole in this guard.
 * @param file - Absolute path of the file to scan.
 * @returns Lower-cased table names created by that file.
 */
function tablesCreatedBy(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const consts = new Map<string, string>();
  for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*['"`]([a-z_][a-z0-9_]*)['"`]/g)) {
    consts.set(m[1], m[2]);
  }
  const found: string[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(?:\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}|["`]?([a-z_][a-z0-9_]*)["`]?)/gi;
  for (const m of text.matchAll(re)) {
    const resolved = m[1] ? consts.get(m[1]) : m[2]?.toLowerCase();
    if (resolved) found.push(resolved);
  }
  return found;
}

/** Recursively collects scannable files under a repo-relative root. */
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

let coreTables: Set<string>;
let dbTables: Map<string, { enabled: boolean; forced: boolean }>;

test.beforeAll(async () => {
  expect(
    ADMIN_URL,
    'DATABASE_URL (or OSHAL_RLS_ADMIN_DATABASE_URL) is required — this guard compares the tree '
      + 'against the REAL database. Run it under the ci-local e2e gate, which stands up Postgres '
      + 'and applies migrations.',
  ).not.toBe('');

  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), files);
  coreTables = new Set<string>();
  for (const file of files) for (const t of tablesCreatedBy(file)) coreTables.add(t);
  // Sanity: the scan must actually find something. A broken regex would otherwise
  // make this whole guard vacuously green.
  expect(coreTables.size, 'the CREATE TABLE scan found nothing — the scanner is broken, not the schema').toBeGreaterThan(80);

  const pool = new Pool({ connectionString: ADMIN_URL });
  try {
    const rows = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    dbTables = new Map(rows.rows.map((r) => [r.relname, { enabled: r.relrowsecurity, forced: r.relforcerowsecurity }]));
  } finally {
    await pool.end();
  }
  expect(dbTables.size, 'the database reported no public tables — migrations have not run').toBeGreaterThan(50);
});

test.describe('ADR-124 — every core table is walled or justified', () => {
  test('no core table is unwalled without a written justification', () => {
    const unjustified: string[] = [];
    for (const table of coreTables) {
      const state = dbTables.get(table);
      if (!state) continue;                                   // not created on this deployment
      if (state.enabled && state.forced) continue;            // walled
      if (JUSTIFIED_EXCEPTIONS[table]) continue;              // justified
      unjustified.push(table);
    }
    expect(
      unjustified.sort(),
      'These CORE tables have RLS off (or enabled-but-not-forced) and no entry in '
        + 'JUSTIFIED_EXCEPTIONS. Either wall them in a migration (the buildOwnerRlsPolicyStatements '
        + 'shape, or the derived-owner pattern from migration 113) or add an entry here stating WHY '
        + 'they cannot carry an owner. Silence is not an option — ADR-124.',
    ).toEqual([]);
  });

  test('every justified exception is still a real, still-unwalled core table', () => {
    const stale: string[] = [];
    for (const table of Object.keys(JUSTIFIED_EXCEPTIONS)) {
      if (!dbTables.has(table)) { stale.push(`${table} (not in the database)`); continue; }
      if (!coreTables.has(table)) { stale.push(`${table} (no CREATE TABLE in this repo — carved to the store?)`); continue; }
      const state = dbTables.get(table)!;
      if (state.enabled && state.forced) stale.push(`${table} (now walled — delete the exception)`);
    }
    expect(
      stale.sort(),
      'Stale exceptions. An allowlist that outlives its reason is how the BACKLOG residual list '
        + 'drifted for a month. Delete these entries.',
    ).toEqual([]);
  });

  test('every exception states a reason and names its kind', () => {
    const bad = Object.entries(JUSTIFIED_EXCEPTIONS)
      .filter(([, why]) => !/^(CATALOG|MACHINERY|DEFERRED|PUBLIC) — .{30,}/.test(why))
      .map(([t]) => t);
    expect(bad.sort(), 'Each exception must start with CATALOG/MACHINERY/DEFERRED/PUBLIC and give a real reason.').toEqual([]);
  });

  test('the tables migrations 112 and 113 walled are ENABLED and FORCED with their policy', async () => {
    const expected = [
      'channel_link_codes', 'channel_links', 'connector_action_audit', 'linkedin_profile_plans',
      'social_content_drafts', 'user_notification_prefs', 'voice_user_prefs',
      'oshal_trading_rotation_state', 'oshal_cost_events',
      'ticket_status_history', 'ticket_agent_assignments', 'ticket_task_links',
      'ticket_workspace_links', 'task_checkpoints',
    ];
    const notWalled = expected.filter((t) => {
      const s = dbTables.get(t);
      return !s || !s.enabled || !s.forced;
    });
    expect(notWalled, 'migrations 112/113 did not take effect on this database').toEqual([]);

    // A forced table with no policy denies everyone — the failure mode 060's abort caused.
    const pool = new Pool({ connectionString: ADMIN_URL });
    try {
      const rows = await pool.query<{ relname: string; n: string }>(
        `SELECT c.relname, COUNT(p.oid)::text AS n
           FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
           LEFT JOIN pg_policy p ON p.polrelid = c.oid
          WHERE ns.nspname = 'public' AND c.relname = ANY($1::text[])
          GROUP BY c.relname`,
        [expected],
      );
      const policyless = rows.rows.filter((r) => Number(r.n) === 0).map((r) => r.relname);
      expect(policyless, 'FORCE ROW LEVEL SECURITY with zero policies denies every caller, including the owner').toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
