#!/usr/bin/env node
/*
 * trade_recap_pipeline tool (in-container CLI). The whole daily recap in ONE call so a
 * workflow bot makes a single deterministic tool invocation:
 *   1) render the video on the remote framework node over A2A (oshal-recap-render-remote.js)
 *   2) email it with the day's numbers + attached preview (oshal-recap-email.js)
 *
 *   Usage:  node oshal-recap-pipeline.js [{input}]
 *   input (optional): { node?: "<clientId|name>", to?: "<email>" }
 *   Prints JSON: { ok, report, reportName, compressedMB, node, emailed, data }
 */
'use strict';
const cp = require('child_process');
const path = require('path');
const HERE = __dirname;

function runNode(script, inputObj) {
  const args = [path.join(HERE, script)];
  if (inputObj) args.push(JSON.stringify(inputObj));
  const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 });
  return { status: r.status, stdout: (r.stdout || '').trim() };
}
function lastJson(s) {
  const lines = String(s).split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { const t = lines[i].trim(); if (t.startsWith('{') && t.endsWith('}')) { try { return JSON.parse(t); } catch {} } }
  return null;
}

(async () => {
  let parsed = {};
  try { parsed = process.argv[2] ? JSON.parse(process.argv[2]) : {}; } catch {}

  // 1) Render on the remote node.
  const rend = runNode('oshal-recap-render-remote.js', parsed.node ? { node: parsed.node } : undefined);
  const r = lastJson(rend.stdout);
  if (rend.status !== 0 || !r || r.ok !== true) {
    process.stdout.write(JSON.stringify({ ok: false, stage: 'render', error: (r && r.error) || rend.stdout.slice(-300) }));
    process.exitCode = 1;
    return;
  }

  // 2) Email it (defaults read the recap-data.json + recap-email.mp4 the render just produced).
  const em = runNode('oshal-recap-email.js', parsed.to ? { to: parsed.to } : undefined);
  const emailed = em.status === 0 && /SEND_OK/.test(em.stdout);

  process.stdout.write(JSON.stringify({
    ok: true,
    report: r.report,
    reportName: r.reportName,
    reportMB: r.reportMB,
    compressedMB: r.compressedMB,
    node: r.node,
    emailed,
    emailResult: em.stdout.slice(-160),
    data: r.data,
  }));
})();
