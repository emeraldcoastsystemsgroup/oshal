#!/usr/bin/env node
/**
 * Read-only, operator-scoped Schwab Futures capability diagnostic for the API container.
 * It resolves the existing connector in-process and prints only statuses/counts/coverage.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Check actual ES/CL dated-contract quote and minute/daily history availability without disclosing credentials or market-data rows.
 */
'use strict';
const { Pool } = require('/app/node_modules/pg');
const { getValidAccessToken } = require('/app/dist/app/routes/connectors-routes.js');
const { activeContractAt } = require('/app/dist/features/trading/services/futures-contract.js');

const base = (process.env.SCHWAB_MARKETDATA_BASE_URL || 'https://api.schwabapi.com/marketdata/v1').replace(/\/+$/, '');
const ownerEmail = (process.env.OSHAL_PROBE_USER_EMAIL || '').trim().toLowerCase();
const timeoutMs = 8_000;

async function read(token, path) {
  try {
    const response = await fetch(base + path, { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { state: 'http_error', status: response.status };
    const body = await response.json();
    return { state: 'ok', body };
  } catch { return { state: 'network_or_format_error' }; }
}

function bars(result) {
  if (result.state !== 'ok') return result;
  const rows = result.body?.candles;
  if (!Array.isArray(rows)) return { state: 'no_candles_array' };
  const valid = rows.filter(row => row && Number.isFinite(Number(row.datetime)) &&
    ['open','high','low','close','volume'].every(key => Number.isFinite(Number(row[key]))) &&
    Number(row.open) > 0 && Number(row.close) > 0 && Number(row.volume) >= 0);
  return { state: valid.length === rows.length && valid.length ? 'bars' : rows.length ? 'invalid_bars' : 'empty',
    count: rows.length, valid: valid.length, volumeBars: valid.filter(row => Number(row.volume) > 0).length,
    first: valid.length ? new Date(Math.min(...valid.map(row => Number(row.datetime)))).toISOString() : null,
    last: valid.length ? new Date(Math.max(...valid.map(row => Number(row.datetime)))).toISOString() : null };
}

async function main() {
  if (!ownerEmail) throw new Error('operator_email_required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('oshal.is_operator','on',false)");
    const matching = (await client.query("SELECT DISTINCT user_sub FROM oshal_connections WHERE provider='schwab' AND lower(user_email)=$1", [ownerEmail])).rows;
    if (matching.length !== 1) throw new Error(matching.length ? 'ambiguous_schwab_connection' : 'no_matching_schwab_connection');
    const token = await getValidAccessToken(client, String(matching[0].user_sub), 'schwab');
    if (!token) throw new Error('schwab_connector_unavailable_for_operator');
    const result = [];
    for (const root of ['ES', 'CL']) {
      const dated = activeContractAt(root, new Date())?.symbol;
      if (!dated) throw new Error('dated_contract_unavailable');
      const perSymbol = [];
      for (const symbol of [`/${root}`, `/${dated}`]) {
        const qs = new URLSearchParams({ symbol, periodType: 'day', frequencyType: 'minute', frequency: '30',
          startDate: String(Date.now() - 5 * 86_400_000), endDate: String(Date.now()), needExtendedHoursData: 'true' });
        const quote = await read(token, `/quotes?symbols=${encodeURIComponent(symbol)}&fields=quote&indicative=false`);
        const quoteRow = quote.state === 'ok' ? quote.body?.[symbol]?.quote : null;
        const history = bars(await read(token, `/pricehistory?${qs}`));
        perSymbol.push({ symbol, quote: quote.state === 'ok' ? { state: quoteRow ? 'present' : 'empty' } : quote,
          minute: history });
      }
      result.push({ root, perSymbol });
    }
    process.stdout.write(JSON.stringify({ source: 'schwab', readOnly: true, checkedAt: new Date().toISOString(), result }) + '\n');
  } finally { client.release(); await pool.end(); }
}
main().catch(error => {
  const known = ['operator_email_required','no_matching_schwab_connection','ambiguous_schwab_connection','schwab_connector_unavailable_for_operator','dated_contract_unavailable'];
  process.stderr.write(`probe_failed:${known.includes(error.message) ? error.message : 'connector_or_provider_error'}\n`);
  process.exitCode = 1;
});
