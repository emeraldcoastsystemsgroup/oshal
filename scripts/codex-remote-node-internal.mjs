#!/usr/bin/env node
/**
 * Fallback remote-node helper that calls the control-plane API from inside the
 * local API container. Use this when the container is healthy but the published
 * host port is hanging during deploy churn.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';
const container = String(args.container || 'oshal-local-api');
const authHeader = String(args.header || process.env.AUTH_HEADER || 'x-remote-client-key').toLowerCase();
const secret = args.secret || process.env.SHARED_SECRET || process.env.REMOTE_CLIENT_SHARED_SECRET || await readEnvSecret();
const api = '/api/remote-clients';

if (command === 'help' || args.help) {
  printHelp();
  process.exit(0);
}
if (!secret) die('No shared secret. Set REMOTE_CLIENT_SHARED_SECRET in .env or pass --secret=...');

switch (command) {
  case 'list':
    await list();
    break;
  case 'capture':
    await capture();
    break;
  case 'move':
    await callDesktop('move', { x: num(args.x, 300), y: num(args.y, 300) });
    break;
  case 'click':
    await callDesktop('click', { x: num(args.x, 300), y: num(args.y, 300) });
    break;
  case 'doubleclick':
    await callDesktop('doubleclick', { x: num(args.x, 300), y: num(args.y, 300) });
    break;
  case 'type':
    await callDesktop('type', { text: String(args.text || args._.slice(1).join(' ') || '') });
    break;
  case 'open':
    await callTool('app.open', { app: String(args.app || args._[1] || '') });
    break;
  case 'shell':
    await callTool('shell.exec', { command: String(await argOrFile('cmd', 'cmdFile') || args._.slice(1).join(' ') || '') });
    break;
  case 'push':
    await pushFile();
    break;
  case 'pull':
    await pullFile();
    break;
  default:
    die(`Unknown command "${command}". Run: node scripts/codex-remote-node-internal.mjs help`);
}

async function list() {
  const clients = await listClients();
  console.log(JSON.stringify(clients.map(publicClient), null, 2));
}

async function capture() {
  const out = resolve(String(args.out || `artifacts/remote-capture-${Date.now()}.png`));
  const maxWidth = num(args.maxWidth, 1280);
  const result = await callTool('screen.capture', { maxWidth }, { quiet: true });
  const dataUrl = result.output?.dataUrl;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    die(`screen.capture returned no image: ${result.error || JSON.stringify(result.output)}`);
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(JSON.stringify({ ok: true, out, width: result.output?.width, height: result.output?.height }, null, 2));
}

async function pushFile() {
  const local = args.local || args.from || args._[1];
  const remote = args.remote || args.to || args._[2];
  if (!local || !remote) die('push requires --local=<path> and --remote=<path>');

  const data = await readFile(resolve(String(local)));
  const b64 = data.toString('base64');
  const remotePath = String(remote);
  const marker = `${remotePath}.b64.${Date.now()}`;
  const chunkSize = Math.max(1800, Math.min(num(args.chunkSize, 3500), 12000));
  const chunks = [];
  for (let i = 0; i < b64.length; i += chunkSize) chunks.push(b64.slice(i, i + chunkSize));

  const init = [
    `$dest=${psQuote(remotePath)}`,
    `$b64=${psQuote(marker)}`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $dest) | Out-Null`,
    `if (Test-Path -LiteralPath $b64) { Remove-Item -LiteralPath $b64 -Force }`,
  ].join('; ');
  await callTool('shell.exec', { command: init }, { quiet: true });

  for (let i = 0; i < chunks.length; i++) {
    const append = `[IO.File]::AppendAllText(${psQuote(marker)}, ${psQuote(chunks[i])}); Write-Output ${psQuote(`${i + 1}/${chunks.length}`)}`;
    await callTool('shell.exec', { command: append }, { quiet: true });
    if ((i + 1) % 10 === 0 || i === chunks.length - 1) console.error(`pushed ${i + 1}/${chunks.length} chunks`);
  }

  const finish = [
    `$dest=${psQuote(remotePath)}`,
    `$b64=${psQuote(marker)}`,
    `[IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String([IO.File]::ReadAllText($b64)))`,
    `Remove-Item -LiteralPath $b64 -Force`,
    `Get-Item -LiteralPath $dest | Select-Object FullName,Length,LastWriteTime | ConvertTo-Json -Compress`,
  ].join('; ');
  const result = await callTool('shell.exec', { command: finish }, { quiet: true });
  console.log(JSON.stringify({ ok: true, local: resolve(String(local)), remote: remotePath, bytes: data.length, result: result.output }, null, 2));
}

async function pullFile() {
  const remote = args.remote || args.from || args._[1];
  const local = args.local || args.to || args._[2];
  if (!remote || !local) die('pull requires --remote=<path> and --local=<path>');
  const remotePath = String(remote);
  const out = resolve(String(local));
  const chunkSize = Math.max(1800, Math.min(num(args.chunkSize, 3500), 12000));
  const lenCmd = `$s=[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(remotePath)})); Write-Output $s.Length`;
  const lenResult = await callTool('shell.exec', { command: lenCmd }, { quiet: true });
  const b64Length = Number(String(lenResult.output?.stdout || '').trim());
  if (!Number.isFinite(b64Length) || b64Length < 0) die(`could not read remote file length: ${JSON.stringify(lenResult.output)}`);
  let b64 = '';
  const chunks = Math.ceil(b64Length / chunkSize);
  for (let offset = 0, i = 0; offset < b64Length; offset += chunkSize, i++) {
    const take = Math.min(chunkSize, b64Length - offset);
    const cmd = `$s=[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(remotePath)})); Write-Output $s.Substring(${offset},${take})`;
    const part = await callTool('shell.exec', { command: cmd }, { quiet: true });
    b64 += String(part.output?.stdout || '').replace(/\s+/g, '');
    if ((i + 1) % 10 === 0 || i + 1 === chunks) console.error(`pulled ${i + 1}/${chunks}`);
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(b64, 'base64'));
  console.log(JSON.stringify({ ok: true, remote: remotePath, local: out, bytes: Buffer.byteLength(b64, 'base64') }, null, 2));
}

async function callDesktop(kind, more) {
  if (kind === 'type') more.text = String(await argOrFile('text', 'textFile') || more.text || '');
  await callTool('desktop.control', { kind, ...more });
}

async function callTool(name, toolArgs, opts = {}) {
  if (name === 'app.open' && !toolArgs.app) die('open requires --app=<name> or an app argument');
  if (name === 'shell.exec' && !toolArgs.command) die('shell requires --cmd=<command> or command text');
  if (name === 'desktop.control' && toolArgs.kind === 'type' && !toolArgs.text) die('type requires --text=<text> or text arguments');

  const clientId = args.client || await pickClient();
  const taskId = randomUUID();
  const body = {
    taskId,
    correlationId: randomUUID(),
    fromAgentId: 'codex-remote-node',
    toAgentId: clientId,
    intent: 'mcp.call-tool',
    input: { name, arguments: toolArgs },
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
  const res = await internalFetch(`${api}/${encodeURIComponent(clientId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`enqueue ${name} failed HTTP ${res.status}: ${res.text}`);
  const result = await awaitResult(clientId, taskId, name, num(args.timeoutMs, 30_000));
  if (result.status !== 'completed') die(`${name} failed: ${result.error || JSON.stringify(result)}`);
  if (!opts.quiet) console.log(JSON.stringify({ ok: true, clientId, taskId, output: result.output, text: result.text }, null, 2));
  return result;
}

async function awaitResult(clientId, taskId, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await internalFetch(`${api}/${encodeURIComponent(clientId)}/tasks/${encodeURIComponent(taskId)}/result`, { method: 'GET' });
    if (res.status === 200) return JSON.parse(res.text);
    if (res.status !== 404) die(`poll ${name} failed HTTP ${res.status}: ${res.text}`);
    await sleep(500);
  }
  die(`timed out waiting for ${name}`);
}

async function pickClient() {
  const clients = await listClients();
  const online = clients.filter((c) => c.status === 'online');
  const controllable = online.find((c) => (c.capabilities || []).includes('screen.capture') && (c.capabilities || []).includes('desktop.control'));
  const chosen = controllable || online[0] || clients[0];
  if (!chosen) die('No remote clients registered');
  return chosen.clientId;
}

async function listClients() {
  const res = await internalFetch(`${api}/`, { method: 'GET' });
  if (res.status === 401) die('401 Unauthorized: shared secret does not match control plane');
  if (!res.ok) die(`list clients failed HTTP ${res.status}: ${res.text}`);
  return JSON.parse(res.text).clients || [];
}

async function internalFetch(path, options = {}) {
  const req = {
    path,
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      [authHeader]: secret,
      authorization: `Bearer ${secret}`,
      ...(options.headers || {}),
    },
    body: options.body || null,
  };
  const code = `
const fs = require('node:fs');
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
fetch('http://127.0.0.1:5000' + req.path, {
  method: req.method,
  headers: req.headers,
  body: req.body
}).then(async (r) => {
  process.stdout.write(JSON.stringify({ status: r.status, ok: r.ok, text: await r.text() }));
}).catch((err) => {
  process.stderr.write(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;
  const proc = spawnSync('docker', ['exec', '-i', container, 'node', '-e', code], {
    input: JSON.stringify(req),
    encoding: 'utf8',
    timeout: num(args.dockerTimeoutMs, 60_000),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) die(`docker exec failed: ${proc.error.message}`);
  if (proc.status !== 0) die(`internal fetch failed (${proc.status}): ${proc.stderr || proc.stdout}`);
  try {
    return JSON.parse(proc.stdout);
  } catch {
    die(`internal fetch returned non-JSON: ${proc.stdout || proc.stderr}`);
  }
}

function publicClient(c) {
  return {
    clientId: c.clientId,
    name: c.name,
    status: c.status,
    platform: c.platform,
    transport: c.transport,
    capabilities: c.capabilities,
    lastSeenAt: c.lastSeenAt,
    activeTaskId: c.activeTaskId || null,
  };
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

async function argOrFile(valueKey, fileKey) {
  if (args[fileKey]) return readFile(resolve(String(args[fileKey])), 'utf8');
  return args[valueKey];
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

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage:
  node scripts/codex-remote-node-internal.mjs list
  node scripts/codex-remote-node-internal.mjs capture --client=<id> --out=artifacts/screen.png
  node scripts/codex-remote-node-internal.mjs click --client=<id> --x=300 --y=300
  node scripts/codex-remote-node-internal.mjs type --client=<id> --text="hello"
  node scripts/codex-remote-node-internal.mjs shell --client=<id> --cmd="Get-Date"
  node scripts/codex-remote-node-internal.mjs push --client=<id> --local=a.pdf --remote=C:\\Temp\\a.pdf
  node scripts/codex-remote-node-internal.mjs pull --client=<id> --remote=C:\\Temp\\a.png --local=artifacts/a.png`);
}

function die(message) {
  console.error(message);
  process.exit(1);
}
