#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — CLI for the trading strategy journal (append + list), the honest record every knob turn / incident must reach so the daily report can say what changed. Same table the runtime store (src/app/trading-strategy-journal.ts) self-creates.
 */
/*
 * oshal-strategy-journal.js — append to / read the strategy journal from a shell.
 *
 * The daily recap's "What changed" section reads this journal. Runtime knob turns are captured
 * automatically (applyOverride/revertOverride); code-level changes and incidents are recorded
 * here, by the operator or the pipeline that observed them. Append-only: corrections are new
 * entries, never edits.
 *
 * Usage (inside the api container, OSHAL_USER_SUB set):
 *   node scripts/oshal-strategy-journal.js add --kind=strategy --summary="..." [--day=YYYY-MM-DD] [--source=...]
 *   node scripts/oshal-strategy-journal.js list [--since=YYYY-MM-DD] [--through=YYYY-MM-DD]
 *
 * Kinds: knob-turn | universe | hold-swap | strategy | incident | note
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch {}
const { Pool } = require('pg');

const SUB = process.env.OSHAL_USER_SUB || '';
const KINDS = ['knob-turn', 'universe', 'hold-swap', 'strategy', 'incident', 'note'];

function argOf(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

function etDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const DDL = `CREATE TABLE IF NOT EXISTS oshal_trading_strategy_journal (
  id BIGSERIAL PRIMARY KEY,
  user_sub TEXT NOT NULL,
  et_day DATE NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail JSONB,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

(async () => {
  const cmd = process.argv[2];
  if (!SUB) { console.error('JOURNAL_FAIL OSHAL_USER_SUB not set'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('oshal.is_operator','on',false)");
    await client.query(DDL);
    if (cmd === 'add') {
      const kind = argOf('kind'), summary = argOf('summary');
      if (!KINDS.includes(kind)) { console.error(`JOURNAL_FAIL bad --kind (want ${KINDS.join('|')})`); process.exit(1); }
      if (!summary.trim()) { console.error('JOURNAL_FAIL --summary required'); process.exit(1); }
      const day = argOf('day') || etDay();
      const source = argOf('source') || 'operator-cli';
      await client.query(
        `INSERT INTO oshal_trading_strategy_journal (user_sub, et_day, kind, summary, source)
         VALUES ($1, $2::date, $3, $4, $5)`, [SUB, day, kind, summary.slice(0, 500), source.slice(0, 120)]);
      console.log(`JOURNAL_OK add ${day} [${kind}] ${summary.slice(0, 80)}`);
    } else if (cmd === 'list') {
      const since = argOf('since') || '1970-01-01';
      const through = argOf('through') || etDay();
      const { rows } = await client.query(
        `SELECT et_day::text AS day, kind, summary, source FROM oshal_trading_strategy_journal
          WHERE user_sub=$1 AND et_day >= $2::date AND et_day <= $3::date ORDER BY et_day, id`,
        [SUB, since, through]);
      for (const r of rows) console.log(`${r.day} [${r.kind}] ${r.summary}  (${r.source})`);
      console.log(`JOURNAL_OK list ${rows.length} entries`);
    } else {
      console.error('JOURNAL_FAIL usage: add --kind= --summary= [--day=] [--source=]  |  list [--since=] [--through=]');
      process.exit(1);
    }
  } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error('JOURNAL_FAIL', e.message || e); process.exit(1); });
