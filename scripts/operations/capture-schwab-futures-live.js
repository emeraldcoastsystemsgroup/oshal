#!/usr/bin/env node
/**
 * One-shot, operator-scoped ES/CL Futures bar capture inside the API container.
 * Prints counts/coverage only; the connector token and OHLCV rows stay private.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve the exact connected owner and run one private, replay-safe Schwab capture without displaying credentials or bars.
 */
'use strict';
require('/app/node_modules/tsconfig-paths').register({ baseUrl: '/app/dist', paths: { '@/*': ['*'] } });
const { Pool } = require('/app/node_modules/pg');
const { getValidAccessToken } = require('/app/dist/app/routes/connectors-routes.js');
const { captureSchwabFuturesBars, listSchwabFuturesCoverage } = require('/app/dist/app/trading-futures-schwab-capture.js');

async function main() {
  const email = (process.env.OSHAL_PROBE_USER_EMAIL || '').trim().toLowerCase();
  if (!email) throw new Error('operator_email_required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('oshal.is_operator','on',false)");
    const matching = (await client.query("SELECT DISTINCT user_sub FROM oshal_connections WHERE provider='schwab' AND lower(user_email)=$1", [email])).rows;
    if (matching.length !== 1) throw new Error(matching.length ? 'ambiguous_schwab_connection' : 'no_matching_schwab_connection');
    const ownerSub = String(matching[0].user_sub);
    const token = await getValidAccessToken(client, ownerSub, 'schwab');
    if (!token) throw new Error('schwab_connector_unavailable_for_operator');
    await client.query("SELECT set_config('oshal.current_sub',$1,false),set_config('oshal.is_operator','off',false)", [ownerSub]);
    // All capture and coverage queries use this exact owner-stamped connection. The collector
    // manages its own transaction; release remains with the outer finally block.
    const bound = { query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }) };
    const receipt = await captureSchwabFuturesBars(bound, ownerSub, token);
    const coverage = await listSchwabFuturesCoverage(bound, ownerSub);
    process.stdout.write(JSON.stringify({ source: receipt.source, ownerScoped: true, timeframe: receipt.timeframe,
      completedAt: receipt.completedAt, series: receipt.series, coverage }) + '\n');
  } finally { client.release(); await pool.end(); }
}
main().catch(error => {
  const known = ['operator_email_required', 'no_matching_schwab_connection', 'ambiguous_schwab_connection', 'schwab_connector_unavailable_for_operator'];
  process.stderr.write(`capture_failed:${known.includes(error.message) ? error.message : 'connector_provider_or_storage_error'}\n`);
  process.exitCode = 1;
});
