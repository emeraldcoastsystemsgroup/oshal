#!/usr/bin/env node
/*
 * trade_recap_render tool (in-container CLI). Dispatches the daily trade-recap RENDER to a
 * framework REMOTE NODE over A2A (POST /api/remote-clients/:id/tasks, intent mcp.call-tool,
 * tool shell.exec) instead of running in this GUI-less container. Mirrors scripts/oshal-vids.js
 * (a cli tool that enqueues to the remote-client registry and returns JSON on stdout for a bot).
 *
 * The node's shell.exec has a fixed 120s cap, but the build takes ~3min, so we START the build
 * DETACHED (recap-render-node.ps1 writes a sentinel) and POLL the sentinel until done.
 *
 *   Usage:  node oshal-recap-render-remote.js [{input}]
 *   input (all optional): { node?: "<clientId|name>" }
 *   Prints: { ok, report, reportName, compressed, compressedContainer, reportContainer, data, node }
 */
'use strict';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTH = { [process.env.REMOTE_CLIENT_AUTH_HEADER || 'x-remote-client-key']: process.env.REMOTE_CLIENT_SHARED_SECRET || '' };
const BASE = `http://127.0.0.1:${process.env.PORT || 5000}`;
const REPO_WIN = process.env.OSHAL_RENDER_REPO || 'C:\\Projects\\open-shal-swarm-harness-agent-llm';
const PS1 = `${REPO_WIN}\\scripts\\recap-render-node.ps1`;
const OUT_WIN = `${REPO_WIN}\\packages\\oshal-vids-operator\\out`;
const OUT_CONTAINER = '/run/desktop/mnt/host/c/Projects/open-shal-swarm-harness-agent-llm/packages/oshal-vids-operator/out';

function parseInput(raw) { if (!raw) return {}; try { return JSON.parse(raw); } catch { return {}; } }

async function listClients() {
  const r = await fetch(`${BASE}/api/remote-clients`, { headers: AUTH });
  if (!r.ok) throw new Error(`list remote-clients HTTP ${r.status}`);
  return (await r.json()).clients || [];
}

function pickNode(cs, input) {
  const online = cs.filter((c) => c.status === 'online' && (c.capabilities || []).includes('shell.exec'));
  const want = process.env.OSHAL_RENDER_NODE_ID || input.node;
  if (want) { const n = online.find((c) => c.clientId === want || c.name === want); if (n) return n; }
  return online.find((c) => /parentpc|render/i.test(c.name || '')) || online[0] || null;
}

async function execNode(node, command, maxPolls) {
  const taskId = `render-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const env = {
    taskId, correlationId: taskId, fromAgentId: 'recap-render',
    toAgentId: node.agentId || node.clientId, intent: 'mcp.call-tool',
    input: { name: 'shell.exec', arguments: { command } }, createdAt: new Date().toISOString(),
  };
  const e = await fetch(`${BASE}/api/remote-clients/${node.clientId}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify(env),
  });
  if (e.status !== 201) throw new Error(`enqueue HTTP ${e.status} ${await e.text()}`);
  for (let i = 0; i < (maxPolls || 16); i++) {
    await sleep(2500);
    const r = await fetch(`${BASE}/api/remote-clients/${node.clientId}/tasks/${taskId}/result`, { headers: AUTH });
    if (r.ok) {
      const j = await r.json();
      const o = (j.output && typeof j.output === 'object') ? j.output : {};
      return { status: j.status, stdout: String(o.stdout || ''), stderr: String(o.stderr || ''), exitCode: o.exitCode, error: j.error };
    }
  }
  throw new Error('node exec timed out (no result)');
}

(async () => {
  const input = parseInput(process.argv[2]);
  try {
    const node = pickNode(await listClients(), input);
    if (!node) throw new Error('no online render node advertising shell.exec');

    // 1) Start the detached build on the node (returns immediately).
    const startCmd = `if(Test-Path '${PS1}'){ Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${PS1}'; 'STARTED' } else { 'NO_PS1' }`;
    const s = await execNode(node, startCmd, 8);
    if (/NO_PS1/.test(s.stdout)) throw new Error(`render script missing on node: ${PS1}`);
    if (!/STARTED/.test(s.stdout)) throw new Error(`could not start build on node: ${s.stdout || s.stderr || s.error}`);

    // 2) Poll the sentinel until done/err (up to ~8 min).
    const pollCmd = `$o='${OUT_WIN}'; if(Test-Path "$o\\recap-build.done"){ Get-Content "$o\\recap-build.done" -Raw } elseif(Test-Path "$o\\recap-build.err"){ 'ERR:'+(Get-Content "$o\\recap-build.err" -Raw) } else { 'RUNNING' }`;
    let result = null;
    for (let i = 0; i < 48; i++) {
      await sleep(10000);
      const p = await execNode(node, pollCmd, 8);
      const out = (p.stdout || '').trim();
      if (out.startsWith('{')) { result = JSON.parse(out); break; }
      if (out.startsWith('ERR:')) throw new Error(`node build failed: ${out.slice(4, 500)}`);
    }
    if (!result) throw new Error('node build did not complete within 8 min');

    result.compressedContainer = `${OUT_CONTAINER}/recap-email.mp4`;
    result.reportContainer = `${OUT_CONTAINER}/${result.reportName}`;
    result.node = node.name;
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    process.exitCode = 1;
  }
})();
