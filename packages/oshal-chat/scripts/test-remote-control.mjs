#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | End-to-end smoke test for system control of a connected OSHAL Node: acts as a "bot", enqueues screen.capture + desktop.control tasks over the remote-client HTTP API, polls the result endpoint, and saves the screenshot to disk. Proves a bot can SEE and DRIVE the remote machine before you hand it to a real one.
 */

// Zero-dep. Node 18+ (uses global fetch + crypto.randomUUID).
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ── Config (env or --flags) ──────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);

const BASE = (args.url || process.env.CONTROL_PLANE_URL || 'http://localhost:35457').replace(/\/+$/, '');
const SECRET = args.secret || process.env.SHARED_SECRET || process.env.REMOTE_CLIENT_SHARED_SECRET || '';
const AUTH_HEADER = (args.header || process.env.AUTH_HEADER || 'x-remote-client-key').toLowerCase();
let CLIENT_ID = args.client || process.env.CLIENT_ID || '';
const X = Number(args.x ?? 300);
const Y = Number(args.y ?? 300);
const DO_CLICK = Boolean(args.click); // default: MOVE only (safe — won't click anything)
const OUT = resolve(String(args.out || 'remote-screenshot.png'));

const api = `${BASE}/api/remote-clients`;
const headers = { 'content-type': 'application/json', [AUTH_HEADER]: SECRET, authorization: `Bearer ${SECRET}` };

function die(msg) { console.error(`\nFAIL: ${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SECRET) die('No shared secret. Pass --secret=… or set SHARED_SECRET (must match the control plane).');

// ── Helpers ──────────────────────────────────────────────────────────────────
async function listClients() {
  const res = await fetch(`${api}/`, { headers });
  if (res.status === 401) die('401 Unauthorized — the shared secret does not match the control plane.');
  if (!res.ok) die(`Could not list clients (HTTP ${res.status}). Is the control plane reachable at ${BASE}?`);
  return (await res.json()).clients || [];
}

/** Enqueue one mcp.call-tool task and return its taskId. */
async function enqueue(toolName, toolArgs) {
  const taskId = randomUUID();
  const body = {
    taskId,
    correlationId: randomUUID(),
    fromAgentId: 'remote-control-test',
    toAgentId: CLIENT_ID,
    intent: 'mcp.call-tool',
    input: { name: toolName, arguments: toolArgs },
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
  const res = await fetch(`${api}/${encodeURIComponent(CLIENT_ID)}/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) die(`Enqueue of ${toolName} failed (HTTP ${res.status}): ${await res.text()}`);
  return taskId;
}

/** Poll the result endpoint until the node completes the task (or timeout). */
async function awaitResult(toolName, taskId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${api}/${encodeURIComponent(CLIENT_ID)}/tasks/${encodeURIComponent(taskId)}/result`, { headers });
    if (res.status === 200) return res.json();
    if (res.status !== 404) die(`Result poll for ${toolName} errored (HTTP ${res.status}): ${await res.text()}`);
    await sleep(750);
  }
  die(`Timed out waiting for ${toolName}. Is the node connected, the worker enabled, and "Allow this machine to be controlled" ON?`);
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.log(`Control plane : ${BASE}`);
const clients = await listClients();
if (!CLIENT_ID) {
  const online = clients.find((c) => c.status === 'online') || clients[0];
  if (!online) die('No remote clients are registered. Launch the OSHAL Node and click Connect first.');
  CLIENT_ID = online.clientId;
  console.log(`Auto-selected : ${CLIENT_ID} (${online.name}, ${online.status})`);
} else {
  const c = clients.find((x) => x.clientId === CLIENT_ID);
  console.log(`Target client : ${CLIENT_ID}${c ? ` (${c.name}, ${c.status})` : ' (not in registry yet)'}`);
}

// 1) Screenshot — proves the bot can SEE the machine.
console.log('\n[1/2] screen.capture ...');
const shotTask = await enqueue('screen.capture', { maxWidth: 1280 });
const shot = await awaitResult('screen.capture', shotTask);
if (shot.status !== 'completed') die(`screen.capture failed: ${shot.error || 'unknown'}`);
const dataUrl = shot.output?.dataUrl;
if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) die('screen.capture returned no image (is system control ON?).');
const png = Buffer.from(dataUrl.split(',')[1], 'base64');
await writeFile(OUT, png);
console.log(`      ok — ${shot.output.width}x${shot.output.height}, saved ${png.length} bytes -> ${OUT}`);

// 2) Cursor — proves the bot can DRIVE the machine.
console.log(`\n[2/2] desktop.control ${DO_CLICK ? 'move+click' : 'move'} -> (${X}, ${Y}) ...`);
const moveTask = await enqueue('desktop.control', { kind: 'move', x: X, y: Y });
const move = await awaitResult('desktop.control', moveTask);
if (move.status !== 'completed') die(`mouse move failed: ${move.error || 'unknown'}`);
console.log(`      ok — moved (${move.output?.via})`);
if (DO_CLICK) {
  const clickTask = await enqueue('desktop.control', { kind: 'click', x: X, y: Y });
  const click = await awaitResult('desktop.control', clickTask);
  if (click.status !== 'completed') die(`click failed: ${click.error || 'unknown'}`);
  console.log(`      ok — clicked (${click.output?.via})`);
}

console.log('\nPASS — the swarm can screenshot and drive this node. Open the saved PNG to confirm the view.');
console.log('Note for the bot author: screen.capture is downscaled; scale click coords back to true resolution (realX = imgX * realW / image.width).');
