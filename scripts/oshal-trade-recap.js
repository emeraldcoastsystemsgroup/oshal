#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Daily Trade Recap — BUILD side. Backs the
 *   registered trade_recap_build tool (swarm-apps/daily-trade-recap.yaml). A thin
 *   wrapper (mirrors scripts/oshal-vids.js style) the vids-operator stage calls: it
 *   shells out to the write-once report generator
 *   packages/oshal-vids-operator/build-daily-report.js, feeding it the recap-data.json
 *   produced earlier by scripts/oshal-trade-data.js (trade_recap_data tool), and
 *   reports the output path as JSON on stdout for a bot to read.
 *
 *   build-daily-report.js is authored in parallel; this wrapper only shells out to
 *   that path. If it is missing, we surface a clear non-zero error (no fabrication).
 *
 *   Usage:  node scripts/oshal-trade-recap.js [{input}]
 *   Optional {input} JSON: { data?, out? } to override the data file / output path.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const VIDS_OP = path.join(ROOT, 'packages', 'oshal-vids-operator');
const BUILD_SCRIPT = path.join(VIDS_OP, 'build-daily-report.js');
const DEFAULT_DATA = path.join(VIDS_OP, 'out', 'recap-data.json');

function parseInput(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function run(input) {
  const dataPath = input.data || DEFAULT_DATA;
  if (!fs.existsSync(BUILD_SCRIPT)) {
    throw new Error(`report generator not found at ${BUILD_SCRIPT} (built in parallel) — run it once it exists`);
  }
  if (!fs.existsSync(dataPath)) {
    throw new Error(`recap data not found at ${dataPath} — run scripts/oshal-trade-data.js first`);
  }
  const args = [BUILD_SCRIPT, dataPath];
  if (input.out) args.push(input.out);
  // Run synchronously, inheriting stderr so the generator's progress is visible; capture stdout.
  const res = cp.spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (res.error) throw new Error(`failed to launch report generator: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`report generator exited ${res.status}`);

  // The generator prints the final path; surface it best-effort from its stdout.
  // Prefer a structured JSON line ({report|output|path}); fall back to a REPORT/REPORT_OK
  // marker, then any *.mp4 token. The generator is authored in parallel, so we stay lenient.
  const stdout = (res.stdout || '').trim();
  let reportPath = null;
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const j = JSON.parse(t);
        reportPath = j.report || j.output || j.path || j.file || null;
        if (reportPath) break;
      } catch { /* not the JSON line */ }
    }
  }
  if (!reportPath) {
    const m = stdout.match(/REPORT(?:_OK|:)?\s+(\S+\.mp4)/i) || stdout.match(/(\S+\.mp4)/i);
    reportPath = m ? m[1] : null;
  }
  return { ok: true, data: dataPath, report: reportPath, output: stdout };
}

(async () => {
  const input = parseInput(process.argv[2]);
  try {
    const out = run(input);
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    process.exitCode = 1;
  }
})();
