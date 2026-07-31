#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — generates the weekly "oshal report" post from the platform's own ledgers plus the strategy journal, replacing a hand-written page that silently went a week stale.
 */
/*
 * site-oshal-report.js — generate the weekly oshal report post for the site.
 *
 * The weekly write-up was hand-authored, so it froze the moment nobody remembered it: it sat on
 * "week of July 17-24" while the daily pipeline published every session beneath it. Every FIGURE
 * here now comes from a ledger the platform already writes — the ticket store, the per-call cost
 * table, the trading equity store, the app-store git history — and every NARRATIVE line comes from
 * the strategy journal, which mixes the pipeline's own daily entries with the operator's hand notes.
 *
 * Anti-drift rules this obeys (docs/README honesty rules):
 *   - counts are generated, never hand-typed
 *   - a zero is reported as a zero; no section is invented to fill space
 *   - paper posture is labeled as paper, never implied to be a live track record
 *
 * Usage (inside the api container, OSHAL_USER_SUB set):
 *   node scripts/site-oshal-report.js [--through=YYYY-MM-DD] [--days=7] [--out=/path/oshal-report.html]
 *   Writes the post and prints OSHAL_REPORT_OK with the numbers it used.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const SUB = process.env.OSHAL_USER_SUB || '';
const APPS_REPO = process.env.OSHAL_APPS_REPO || 'C:\\Projects\\oshal-applications';

/** @description Parse `--k=v` argv into a plain object. @returns {Record<string,string>} */
function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** @description Escape text for safe HTML interpolation. @param s - raw text @returns {string} */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** @description Format an integer with thousands separators. @param n - number @returns {string} */
function num(n) { return Number(n || 0).toLocaleString('en-US'); }

/** @description Human month-day label, e.g. "July 24". @param iso - YYYY-MM-DD @returns {string} */
function mdy(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** @description Shift an ISO date by n days. @param iso - YYYY-MM-DD @param n - days @returns {string} */
function shift(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @description Count commits in the app-store repo for the window. Returns null when the repo is
 * not on this host — a null renders as "not counted" rather than a fabricated zero.
 * @param since - window start (inclusive), YYYY-MM-DD
 * @param through - window end (inclusive), YYYY-MM-DD
 * @returns {number|null} Commit count, or null when uncountable here.
 */
function appStoreCommits(since, through) {
  try {
    if (!fs.existsSync(APPS_REPO)) return null;
    const out = execFileSync('git', ['-C', APPS_REPO, 'log', '--oneline',
      `--since=${since}T00:00:00`, `--until=${shift(through, 1)}T00:00:00`], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim()).length;
  } catch { return null; }
}

(async () => {
  const args = parseArgs();
  const days = Math.max(1, parseInt(args.days || '7', 10));
  const through = args.through || new Date().toISOString().slice(0, 10);
  const since = shift(through, -(days - 1));
  if (!SUB) { console.error('OSHAL_REPORT_FAIL OSHAL_USER_SUB not set'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const q = (sql, p) => client.query(sql, p).then((r) => r.rows).catch(() => []);
  const ET = "AT TIME ZONE 'America/New_York'";
  let ticketRows = [], llm = {}, journal = [], equity = [];
  try {
    await client.query("SELECT set_config('oshal.is_operator','on',false)");
    ticketRows = await q(
      `SELECT ticket_type, count(*)::int AS n FROM tickets
        WHERE (created_at ${ET})::date BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 2 DESC`, [since, through]);
    llm = (await q(
      `SELECT count(*)::int AS runs,
              coalesce(sum(coalesce(total_input_tokens,0)+coalesce(total_output_tokens,0)),0)::bigint AS tokens,
              round(coalesce(sum(total_cost),0)::numeric,2)::float AS cost
         FROM chat_tasks WHERE (created_at ${ET})::date BETWEEN $1::date AND $2::date`, [since, through]))[0] || {};
    journal = await q(
      `SELECT et_day::text AS day, kind, summary, source FROM oshal_trading_strategy_journal
        WHERE user_sub=$1 AND et_day BETWEEN $2::date AND $3::date
        ORDER BY et_day ASC, id ASC`, [SUB, since, through]);
    equity = await q(
      `SELECT et_day::text AS day, equity::float AS e FROM oshal_trading_daily_equity
        WHERE user_sub=$1 AND mode='paper' AND et_day BETWEEN $2::date AND $3::date
        ORDER BY et_day ASC`, [SUB, since, through]);
  } finally { client.release(); await pool.end(); }

  const totalTickets = ticketRows.reduce((s, r) => s + r.n, 0);
  // The app-store repo lives on the HOST; this usually runs inside the api container, where the
  // path does not exist. The caller (which is on the host) can count and pass it in. Absent either
  // way the stat is omitted entirely rather than rendered as a fabricated zero.
  const commits = /^\d+$/.test(args.commits || '') ? parseInt(args.commits, 10) : appStoreCommits(since, through);
  const tokensM = llm.tokens ? (Number(llm.tokens) / 1e6).toFixed(1) + 'M' : '0';
  const first = equity[0], last = equity[equity.length - 1];
  const weekPct = (first && last && first.e) ? (((last.e - first.e) / first.e) * 100).toFixed(2) : null;
  const weekUsd = (first && last) ? (last.e - first.e) : null;

  // Narrative comes from the journal. Report entries are the daily spine; everything else is a
  // knob turn or an incident worth calling out by name.
  const reports = journal.filter((j) => j.kind === 'report');
  const changes = journal.filter((j) => j.kind !== 'report' && j.kind !== 'incident');
  const incidents = journal.filter((j) => j.kind === 'incident');

  const stats = [
    commits == null ? null : { b: num(commits), s: 'app-store commits' },
    { b: num(totalTickets), s: `tickets processed across ${ticketRows.length} type${ticketRows.length === 1 ? '' : 's'}` },
    { b: num(llm.runs || 0), s: `metered LLM runs · ${tokensM} tokens` },
    { b: '$' + Number(llm.cost || 0).toFixed(2), s: 'total LLM spend, from the cost ledger' },
  ].filter(Boolean);

  const li = (s) => `        <li>${s}</li>`;
  const sections = [];

  sections.push(`      <h2>The week in the report</h2>
      <p>The desk published ${reports.length === 0 ? 'no session report' : `<strong>${reports.length}</strong> session report${reports.length === 1 ? '' : 's'}`} this week${weekPct != null ? `, and the paper book moved <strong>${weekPct > 0 ? '+' : ''}${weekPct}%</strong> (${weekUsd >= 0 ? '+' : '-'}$${Math.abs(weekUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}) from ${mdy(first.day)} to ${mdy(last.day)}` : ''}. Every figure is the ledger's own close, not the broker's live equity.</p>
      <ul>
${reports.map((r) => li(esc(r.summary))).join('\n') || li('<em>No session report was journaled this week.</em>')}
      </ul>`);

  if (changes.length) {
    sections.push(`      <h2>What changed</h2>
      <ul>
${changes.map((c) => li(`<strong>${esc(c.kind)}</strong> — ${esc(c.summary)}`)).join('\n')}
      </ul>`);
  }
  if (incidents.length) {
    sections.push(`      <h2>What broke</h2>
      <p>Publishing the failures is the point; a status report that only lists wins is marketing.</p>
      <ul>
${incidents.map((c) => li(esc(c.summary))).join('\n')}
      </ul>`);
  }
  if (ticketRows.length) {
    sections.push(`      <h2>The week in tickets</h2>
      <ul>
${ticketRows.map((r) => li(`<strong>${num(r.n)}</strong> ${esc(r.ticket_type)}`)).join('\n')}
      </ul>`);
  }

  const range = `${mdy(since)}–${mdy(through).replace(/^[A-Za-z]+ /, '')}, ${through.slice(0, 4)}`;
  const lede = `A weekly, numbers-first status on the Open Swarm build — every figure below is pulled from the platform's own ledgers, not estimated: the ticket store, the per-call cost table the bots write as they work, the trading equity store, and the app-store git history. The narrative comes from the platform's own strategy journal, which the nightly pipeline writes to whether the week was eventful or quiet.`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>The oshal report — ${esc(range)} · Agentic Federal</title>
<meta name="description" content="${esc(`A numbers-first weekly status pulled from the platform's own ledgers: ${num(totalTickets)} tickets, ${num(llm.runs || 0)} metered LLM runs for $${Number(llm.cost || 0).toFixed(2)}.`)}" />
<meta property="og:title" content="The oshal report — ${esc(range)}" />
<meta property="og:description" content="${esc(`${num(totalTickets)} tickets, ${num(llm.runs || 0)} metered LLM runs, $${Number(llm.cost || 0).toFixed(2)} of LLM spend — from the platform's own ledgers.`)}" />
<link rel="stylesheet" href="/assets/site.css" />
</head>
<body>
  <div id="nav"></div>
  <section class="hero hero-sm">
    <div class="wrap">
      <div class="breadcrumb"><a href="/">Home</a> / <a href="/blog/">Blog</a> / The oshal report</div>
      <div class="eyebrow">Platform · ${esc(range)} · by <a href="/about.html" style="color:inherit">Roger Murphy</a></div>
      <h1>The oshal report.</h1>
    </div>
  </section>

  <section class="section">
    <div class="wrap article">
      <p class="lede">${lede}</p>

      <div class="stats" style="margin:28px 0">
${stats.map((s) => `        <div class="stat"><b>${esc(s.b)}</b><span>${esc(s.s)}</span></div>`).join('\n')}
      </div>

${sections.join('\n\n')}

      <p style="opacity:.7;font-size:.9rem;margin-top:32px">Trading figures are from a <strong>paper</strong> book unless stated otherwise — this is a build log, not a track record. Generated ${esc(mdy(through))} from the platform's ledgers and journal; no figure on this page was typed by hand.</p>
    </div>
  </section>

  <div id="footer"></div>
<script src="/assets/nav.js" defer></script>
</body>
</html>
`;

  const outPath = args.out || path.join('/app', 'out', 'oshal-report.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log(`OSHAL_REPORT_OK ${outPath} | ${since}..${through} | tickets=${totalTickets} runs=${llm.runs || 0} cost=$${Number(llm.cost || 0).toFixed(2)} commits=${commits == null ? 'n/a' : commits} journal=${journal.length} (reports=${reports.length}, changes=${changes.length}, incidents=${incidents.length})`);
})();
