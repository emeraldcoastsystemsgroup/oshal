#!/usr/bin/env node
/**
 * Small operator helper for OSHAL Node remote control.
 *
 * Uses the remote-client queue to call gated system tools on an online node:
 * screen.capture, desktop.control, app.open, and shell.exec.
 *
 * CHANGE LOG  (started 2026-07-30 — this file predates the convention; earlier history is in git)
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Make pullFile linear instead of quadratic. It re-ran ToBase64String(ReadAllBytes(file)) for EVERY chunk and kept ~14KB of the result: a 2.8MB video piece is 278 chunks, so the node read 810MB and base64-encoded 1.08GB to deliver 2.8MB, four times a night. It presents as a node that looks completely idle while a pull grinds for tens of minutes and then dies, which is what the nightly recap hit on 2026-07-30. Now the source is staged to a scratch .b64 file ONCE and chunks are byte-range reads out of it (base64 is ASCII, so byte offset == char offset), with the scratch file removed on both the success and failure paths. Two things measured while fixing it: the node's shell.exec truncates stdout at 20000 chars (hence the sub-20000 clamp, and a hard failure now if a chunk comes back short rather than splicing a corrupt file), and chunk-level concurrency buys nothing because the node serialises shell.exec per client - so the remaining cost is round-trip latency, ~1.5s per 19000-char chunk. The real ceiling is that 20000-char cap in packages/oshal-chat/src/main/system-tools.ts, which needs the edge client rebuilt and reinstalled on the node to lift.
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
  // The node's shell.exec truncates stdout at 20000 chars — measured 2026-07-30, and the reason
  // the original clamp was 18000. Sit just under it: bigger chunks are silently cut, which the
  // integrity check below now turns into a hard failure instead of a corrupt file.
  const chunkSize = Math.max(2000, Math.min(num(args.chunkSize, 19000), 19500));

  // ENCODE ONCE. The previous loop re-ran ToBase64String(ReadAllBytes(file)) for EVERY chunk and
  // then threw all but ~14KB of the result away — quadratic in file size. A 2.8MB video piece is
  // 278 chunks, so the node read 810MB and base64-encoded 1.08GB to deliver 2.8MB, four times a
  // night. It presents as a node that looks completely idle while a pull grinds for 26 minutes and
  // then fails. Encode to a scratch file once, then serve byte ranges out of it: base64 is ASCII,
  // so a byte offset in that file IS a character offset in the string.
  const marker = `${remotePath}.pull-${Date.now().toString(36)}.b64`;
  const initCmd = [
    `$src=${psQuote(remotePath)}`,
    `$b64=${psQuote(marker)}`,
    `[IO.File]::WriteAllText($b64, [Convert]::ToBase64String([IO.File]::ReadAllBytes($src)))`,
    `Write-Output (Get-Item -LiteralPath $b64).Length`,
  ].join('; ');
  const lenResult = await callTool('shell.exec', { command: initCmd }, { quiet: true });
  const b64Length = Number(String(lenResult.output?.stdout || '').trim());
  if (!Number.isFinite(b64Length) || b64Length <= 0) {
    die(`could not stage remote file for pull: ${JSON.stringify(lenResult.output)}`);
  }

  // Always clean the scratch file up, including on a mid-transfer failure — it sits next to the
  // source and is ~1.33x its size; orphaning those fills the node's disk a night at a time.
  const cleanup = async () => {
    try {
      await callTool('shell.exec', { command: `Remove-Item -LiteralPath ${psQuote(marker)} -Force -ErrorAction SilentlyContinue` }, { quiet: true });
    } catch { /* the transfer's own error is the one worth reporting */ }
  };

  const chunks = Math.ceil(b64Length / chunkSize);
  const parts = new Array(chunks);

  // Chunks are independent range reads of an immutable scratch file, so they do not have to go
  // one at a time. Serially, a 3MB piece is 223 round trips at ~1.5s each = 5m39s measured, and
  // four of those overrun the window the recap has. Order is preserved by index, not by arrival.
  const concurrency = Math.max(1, Math.min(num(args.concurrency, 8), 16));
  let issued = 0;
  let completed = 0;

  const fetchChunk = async (i) => {
    const offset = i * chunkSize;
    const take = Math.min(chunkSize, b64Length - offset);
    const cmd = [
      `$fs=[IO.File]::OpenRead(${psQuote(marker)})`,
      `$null=$fs.Seek(${offset},[IO.SeekOrigin]::Begin)`,
      `$buf=New-Object byte[] ${take}`,
      `$tot=0; while($tot -lt ${take}){ $r=$fs.Read($buf,$tot,${take}-$tot); if($r -le 0){break}; $tot+=$r }`,
      `$fs.Close()`,
      `Write-Output ([Text.Encoding]::ASCII.GetString($buf,0,$tot))`,
    ].join('; ');
    const part = await callTool('shell.exec', { command: cmd }, { quiet: true });
    const got = String(part.output?.stdout || '').replace(/\s+/g, '');
    // A short chunk means the range read came back truncated (the node caps stdout). Splicing it
    // in would corrupt every byte after this point and still produce a plausible-looking file.
    if (got.length !== take) {
      throw new Error(`pull chunk ${i + 1}/${chunks} returned ${got.length} chars, expected ${take} — aborted rather than write a corrupt file`);
    }
    parts[i] = got;
    completed += 1;
    if (completed % 25 === 0 || completed === chunks) console.error(`pulled ${completed}/${chunks} chunks`);
  };

  const worker = async () => {
    for (let i = issued++; i < chunks; i = issued++) await fetchChunk(i);
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks) }, worker));
  } catch (err) {
    await cleanup();
    die(String(err?.message || err));
  }
  await cleanup();

  const b64 = parts.join('');
  await mkdir(dirname(out), { recursive: true });
  const data = Buffer.from(b64, 'base64');
  await writeFile(out, data);
  console.log(JSON.stringify({ ok: true, remote: remotePath, local: out, bytes: data.length, chunks }, null, 2));
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
