#!/usr/bin/env node
/**
 * One-time scheduler activation for an already-proven owner-private Schwab Futures collector.
 * Runs inside the API container and prints no owner identifier, token or market-data row.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Activate bounded owner capture through the shared Redis schedule service after explicit live collector proof.
 */
'use strict';
require('/app/node_modules/tsconfig-paths').register({ baseUrl: '/app/dist', paths: { '@/*': ['*'] } });
const { Pool } = require('/app/node_modules/pg');
const { RedisScheduleStore, ScheduleService } = require('/app/dist/features/scheduling');
const { isOperatorIdentity } = require('/app/dist/shared/middleware/authz');
const { schwabFuturesCaptureTaskType, SCHWAB_FUTURES_CAPTURE_CRON } = require('/app/dist/app/trading-futures-schwab-capture');

async function main() {
  const email = (process.env.OSHAL_PROBE_USER_EMAIL || '').trim().toLowerCase();
  if (!email) throw new Error('operator_email_required');
  const mode = process.argv[2] || '--status';
  if (!['--status','--canary','--hourly'].includes(mode)) throw new Error('invalid_mode');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
  const store = new RedisScheduleStore();
  try {
    const client = await pool.connect();
    let ownerSub;
    try {
      await client.query("SELECT set_config('oshal.is_operator','on',false)");
      const matching = (await client.query("SELECT DISTINCT user_sub FROM oshal_connections WHERE provider='schwab' AND lower(user_email)=$1", [email])).rows;
      if (matching.length !== 1) throw new Error(matching.length ? 'ambiguous_schwab_connection' : 'no_matching_schwab_connection');
      ownerSub = String(matching[0].user_sub);
      if (!isOperatorIdentity(ownerSub)) throw new Error('connected_owner_not_operator');
      const bars = (await client.query('SELECT COUNT(*)::int AS n FROM oshal_trading_futures_schwab_bars WHERE owner_sub=$1', [ownerSub])).rows[0]?.n;
      if (!Number.isInteger(bars) || bars < 2) throw new Error('live_capture_not_proven');
    } finally { client.release(); }
    const service = new ScheduleService(store, async () => { throw new Error('This utility does not dispatch'); },
      { ensureSchedulingEnabled: async () => {} });
    const taskType = schwabFuturesCaptureTaskType(ownerSub);
    const existing = (await service.listSchedules({ ownerSub, scope: 'mine' })).filter(item => item.ownerSub === ownerSub && item.taskType === taskType);
    if (existing.length && mode === '--status') {
      process.stdout.write(JSON.stringify({ enabled: existing.some(item => item.status === 'active'), alreadyPresent: true,
        schedules: existing.map(item => ({ status: item.status, cron: item.cron, nextRunAt: item.nextRunAt,
          lastRunAt: item.lastRunAt, executionCount: item.executionCount })) }) + '\n');
      return;
    }
    if (!existing.length && mode === '--status') throw new Error('schedule_not_present');
    const cron = mode === '--canary' ? '* * * * *' : SCHWAB_FUTURES_CAPTURE_CRON;
    const schedule = await service.createSchedule({ taskType, schedule: cron,
      timezone: 'Etc/UTC', ownerSub, queue: 'intelligent-trades',
      taskData: { prompt: 'Owner-approved read-only Schwab Futures bar capture', userSub: ownerSub, roots: ['ES','CL'], mode: 'paper' } });
    process.stdout.write(JSON.stringify({ enabled: schedule.status === 'active', cron: schedule.cron, nextRunAt: schedule.nextRunAt }) + '\n');
  } finally { await store.close(); await pool.end(); }
}
main().catch(error => {
  const known = ['operator_email_required','invalid_mode','no_matching_schwab_connection','ambiguous_schwab_connection','connected_owner_not_operator','live_capture_not_proven','schedule_not_present'];
  process.stderr.write(`schedule_failed:${known.includes(error.message) ? error.message : 'scheduler_or_storage_error'}\n`);
  process.exitCode = 1;
});
