#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const base = String(args.url || process.env.CONTROL_PLANE_URL || 'http://localhost:35457').replace(/\/+$/, '');
const authHeader = String(args.header || process.env.AUTH_HEADER || 'x-remote-client-key').toLowerCase();
const secret = args.secret || process.env.SHARED_SECRET || process.env.REMOTE_CLIENT_SHARED_SECRET || await readEnvSecret();
const clientId = args.client;
const prompt = args.prompt || (args.promptFile ? await readFile(String(args.promptFile), 'utf8') : args._.join(' '));

if (!secret) die('No shared secret. Set REMOTE_CLIENT_SHARED_SECRET in .env or pass --secret=...');
if (!clientId) die('Pass --client=<remote-client-id>');
if (!prompt) die('Pass --prompt=<text> or --promptFile=<path>');

const api = `${base}/api/remote-clients`;
const headers = { 'content-type': 'application/json', [authHeader]: secret, authorization: `Bearer ${secret}` };
const taskId = randomUUID();
const body = {
  taskId,
  correlationId: randomUUID(),
  fromAgentId: 'codex-remote-dispatch',
  toAgentId: clientId,
  intent: 'mcp.call-tool',
  input: {
    name: args.tool || 'codex.exec',
    arguments: {
      prompt,
      sandbox: args.sandbox || 'danger-full-access',
      model: args.model,
    },
  },
  createdAt: new Date().toISOString(),
  status: 'queued',
};

const enqueue = await fetch(`${api}/${encodeURIComponent(clientId)}/tasks`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});
if (!enqueue.ok) die(`enqueue failed HTTP ${enqueue.status}: ${await enqueue.text()}`);
console.log(JSON.stringify({ ok: true, clientId, taskId, tool: body.input.name }, null, 2));

if (args.wait) {
  const timeoutMs = Number(args.timeoutMs || 600000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    const r = await fetch(`${api}/${encodeURIComponent(clientId)}/tasks/${encodeURIComponent(taskId)}/result`, { headers });
    if (r.status === 200) {
      console.log(await r.text());
      process.exit(0);
    }
    if (r.status !== 404) die(`poll failed HTTP ${r.status}: ${await r.text()}`);
  }
  die('timed out waiting for result');
}

async function readEnvSecret() {
  try {
    const text = await readFile('.env', 'utf8');
    const line = text.split(/\r?\n/).find((l) => /^\s*REMOTE_CLIENT_SHARED_SECRET\s*=/.test(l));
    return line ? line.replace(/^\s*REMOTE_CLIENT_SHARED_SECRET\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '') : '';
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
    else out._.push(arg);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(message) {
  console.error(message);
  process.exit(1);
}
