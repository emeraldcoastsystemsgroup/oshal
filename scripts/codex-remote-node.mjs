#!/usr/bin/env node
/**
 * Small operator helper for OSHAL Node remote control.
 *
 * Uses the remote-client queue to call gated system tools on an online node:
 * screen.capture, desktop.control, app.open, and shell.exec.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';
const base = String(args.url || process.env.CONTROL_PLANE_URL || 'http://localhost:35457').replace(/\/+$/, '');
const authHeader = String(args.header || process.env.AUTH_HEADER || 'x-remote-client-key').toLowerCase();
const secret = args.secret || process.env.SHARED_SECRET || process.env.REMOTE_CLIENT_SHARED_SECRET || await readEnvSecret();
const api = `${base}/api/remote-clients`;
const headers = { 'content-type': 'application/json', [authHeader]: secret, authorization: `Bearer ${secret}` };

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
  case 'rightclick':
    await callDesktop('rightclick', { x: num(args.x, 300), y: num(args.y, 300) });
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
    die(`Unknown command "${command}". Run: node scripts/codex-remote-node.mjs help`);
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
  const chunkSize = Math.max(2000, Math.min(num(args.chunkSize, 14000), 24000));
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
  // A pull is hundreds of chunk round-trips and ONE chunk exceeding the global 30s result window
  // kills the whole transfer (2026-07-28: every nightly video pull died this way while the node
  // was healthy). Default each chunk to a patient window; --timeoutMs still overrides.
  if (args.timeoutMs == null) args.timeoutMs = 120_000;
  const remotePath = String(remote);
  const out = resolve(String(local));
  const chunkSize = Math.max(2000, Math.min(num(args.chunkSize, 14000), 18000));
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
    if ((i + 1) % 10 === 0 || i + 1 === chunks) console.error(`pulled ${i + 1}/${chunks} chunks`);
  }
  await mkdir(dirname(out), { recursive: true });
  const data = Buffer.from(b64, 'base64');
  await writeFile(out, data);
  console.log(JSON.stringify({ ok: true, remote: remotePath, local: out, bytes: data.length }, null, 2));
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
  const res = await robustFetch(`${api}/${encodeURIComponent(clientId)}/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`enqueue ${name} failed HTTP ${res.status}: ${await res.text()}`);
  const result = await awaitResult(clientId, taskId, name, num(args.timeoutMs, 30_000));
  if (result.status !== 'completed') die(`${name} failed: ${result.error || JSON.stringify(result)}`);
  if (!opts.quiet) console.log(JSON.stringify({ ok: true, clientId, taskId, output: result.output, text: result.text }, null, 2));
  return result;
}

async function awaitResult(clientId, taskId, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await robustFetch(`${api}/${encodeURIComponent(clientId)}/tasks/${encodeURIComponent(taskId)}/result`, { headers }, 4);
    if (res.status === 200) return res.json();
    if (res.status !== 404) die(`poll ${name} failed HTTP ${res.status}: ${await res.text()}`);
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
  const res = await robustFetch(`${api}/`, { headers }, 4);
  if (res.status === 401) die('401 Unauthorized: shared secret does not match control plane');
  if (!res.ok) die(`list clients failed HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).clients || [];
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

async function robustFetch(url, options, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      last = err;
      await sleep(350 * (i + 1));
    }
  }
  throw last;
}

function die(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  node scripts/codex-remote-node.mjs list [--url=http://localhost:35457]
  node scripts/codex-remote-node.mjs capture [--out=artifacts/shot.png] [--maxWidth=1280]
  node scripts/codex-remote-node.mjs move --x=300 --y=300
  node scripts/codex-remote-node.mjs click --x=300 --y=300
  node scripts/codex-remote-node.mjs doubleclick --x=300 --y=300
  node scripts/codex-remote-node.mjs rightclick --x=300 --y=300
  node scripts/codex-remote-node.mjs type --text="hello"
  node scripts/codex-remote-node.mjs type --textFile=message.txt
  node scripts/codex-remote-node.mjs open --app=notepad
  node scripts/codex-remote-node.mjs shell --cmd="Get-Date"
  node scripts/codex-remote-node.mjs shell --cmdFile=remote.ps1
  node scripts/codex-remote-node.mjs push --local=packet.zip --remote="C:\\Users\\me\\Documents\\packet.zip"
  node scripts/codex-remote-node.mjs pull --remote="C:\\Users\\me\\Desktop\\shot.png" --local=artifacts\\shot.png

Options:
  --client=<clientId>          Target a specific node; otherwise first online controllable node.
  --timeoutMs=30000            Result poll timeout.
  --secret=<secret>            Usually omitted; reads REMOTE_CLIENT_SHARED_SECRET from .env.
`);
}
