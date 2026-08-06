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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Default pulls to one worker and treat result-poll HTTP 429 as backpressure. Eight concurrent workers gained no throughput because the edge client serialises shell.exec, but multiplied result polling enough to trip the control-plane rate limit and abort the completed 2026-08-03 recap before publish. Respect Retry-After and use a slower poll cadence so a long transfer waits instead of failing.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Make command failures throw to the top-level boundary instead of calling process.exit from deep async helpers. This guarantees pullFile cleanup runs after poll timeouts, HTTP failures, short chunks, and staging errors.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Enforce one AbortSignal-backed deadline across enqueue, response-body reads, retries, and result polling; split pull orchestration into bounded helpers; and surface cleanup failure without replacing the primary transfer error. A peer that accepted a socket but never sent headers previously defeated --timeoutMs and could pin the nightly transfer forever.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Drain every explicitly concurrent chunk worker before removing the shared remote scratch file. Promise.all rejected on the first short chunk while sibling reads were still active, allowing cleanup to race and manufacture secondary failures.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

class RequestDeadlineError extends Error {
  constructor() {
    super('request deadline elapsed');
    this.name = 'RequestDeadlineError';
  }
}

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
try {
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
} catch (error) {
  console.error(`FAIL: ${errorDetails(error)}`);
  process.exitCode = 1;
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
  const { remotePath, out, chunkSize } = resolvePullOptions();
  const marker = `${remotePath}.pull-${Date.now().toString(36)}.b64`;
  let transferError;
  try {
    const b64Length = await stageRemotePull(remotePath, marker);
    const parts = await readRemotePullChunks(marker, b64Length, chunkSize);
    const data = Buffer.from(parts.join(''), 'base64');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data);
    console.log(JSON.stringify({ ok: true, remote: remotePath, local: out, bytes: data.length, chunks: parts.length }, null, 2));
  } catch (error) {
    transferError = error;
    throw error;
  } finally {
    await finalizeRemotePull(marker, transferError);
  }
}

function resolvePullOptions() {
  const remote = args.remote || args.from || args._[1];
  const local = args.local || args.to || args._[2];
  if (!remote || !local) die('pull requires --remote=<path> and --local=<path>');
  // A pull is hundreds of chunk round-trips and ONE chunk exceeding the global 30s result window
  // kills the whole transfer (2026-07-28: every nightly video pull died this way while the node
  // was healthy). Default each chunk to a patient window; --timeoutMs still overrides.
  if (args.timeoutMs == null) args.timeoutMs = 120_000;
  // The node's shell.exec truncates stdout at 20000 chars — measured 2026-07-30, and the reason
  // the original clamp was 18000. Sit just under it: bigger chunks are silently cut, which the
  // integrity check below now turns into a hard failure instead of a corrupt file.
  const chunkSize = Math.max(2000, Math.min(num(args.chunkSize, 19000), 19500));
  return { remotePath: String(remote), out: resolve(String(local)), chunkSize };
}

async function stageRemotePull(remotePath, marker) {
  // Encode once: re-encoding for every range made transfer cost quadratic. Base64 is ASCII, so a
  // byte offset in the scratch file is the same offset in the encoded string.
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
  return b64Length;
}

async function readRemotePullChunks(marker, b64Length, chunkSize) {
  const chunks = Math.ceil(b64Length / chunkSize);
  const parts = new Array(chunks);
  // The edge client serialises shell.exec per client. More workers therefore add no throughput,
  // while every queued call starts its own result poller and can trip the control-plane rate limit.
  const concurrency = Math.max(1, Math.min(num(args.concurrency, 1), 16));
  let issued = 0;
  let completed = 0;
  let stopped = false;
  const worker = async () => {
    for (let i = issued++; i < chunks && !stopped; i = issued++) {
      try {
        parts[i] = await fetchRemotePullChunk(marker, i, chunks, b64Length, chunkSize);
        completed += 1;
        if (completed % 25 === 0 || completed === chunks) console.error(`pulled ${completed}/${chunks} chunks`);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  // Wait for already-issued siblings before pullFile's finally block removes their shared marker.
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, chunks) }, worker));
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return parts;
}

async function fetchRemotePullChunk(marker, index, chunks, b64Length, chunkSize) {
  const offset = index * chunkSize;
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
  if (got.length !== take) {
    throw new Error(`pull chunk ${index + 1}/${chunks} returned ${got.length} chars, expected ${take} — aborted rather than write a corrupt file`);
  }
  return got;
}

async function finalizeRemotePull(marker, transferError) {
  // One cleanup attempt runs after every fallible stage. If transfer already failed, report the
  // cleanup stack separately and preserve the primary error; on success, orphaning is a failure.
  // Cleanup gets its own short cap because the nightly transfer timeout is ten minutes.
  try {
    const command = `$marker=${psQuote(marker)}; if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force -ErrorAction Stop }`;
    const cleanupTimeoutMs = Math.max(100, Math.min(num(args.cleanupTimeoutMs, 15_000), 30_000));
    await callTool('shell.exec', { command }, { quiet: true, timeoutMs: cleanupTimeoutMs });
  } catch (cleanupError) {
    if (!transferError) throw new Error(`remote pull cleanup failed: ${errorDetails(cleanupError)}`);
    console.error(`ERROR: remote pull cleanup also failed: ${errorDetails(cleanupError)}`);
  }
}

async function callDesktop(kind, more) {
  if (kind === 'type') more.text = String(await argOrFile('text', 'textFile') || more.text || '');
  await callTool('desktop.control', { kind, ...more });
}

async function callTool(name, toolArgs, opts = {}) {
  if (name === 'app.open' && !toolArgs.app) die('open requires --app=<name> or an app argument');
  if (name === 'shell.exec' && !toolArgs.command) die('shell requires --cmd=<command> or command text');
  if (name === 'desktop.control' && toolArgs.kind === 'type' && !toolArgs.text) die('type requires --text=<text> or text arguments');

  // One deadline covers client discovery, acceptance, response-body consumption, and polling.
  const deadline = Date.now() + Math.max(1, num(opts.timeoutMs ?? args.timeoutMs, 30_000));
  const clientId = args.client || await pickClient(deadline);
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
  // A peer that accepts a TCP socket but never sends headers must not defeat --timeoutMs.
  const { response: res, body: responseBody } = await robustFetch(`${api}/${encodeURIComponent(clientId)}/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, 3, deadline);
  if (!res.ok) die(`enqueue ${name} failed HTTP ${res.status}: ${responseBody}`);
  const result = await awaitResult(clientId, taskId, name, deadline);
  if (result.status !== 'completed') die(`${name} failed: ${result.error || JSON.stringify(result)}`);
  if (!opts.quiet) console.log(JSON.stringify({ ok: true, clientId, taskId, output: result.output, text: result.text }, null, 2));
  return result;
}

async function awaitResult(clientId, taskId, name, deadline) {
  while (Date.now() < deadline) {
    let fetched;
    try {
      fetched = await robustFetch(`${api}/${encodeURIComponent(clientId)}/tasks/${encodeURIComponent(taskId)}/result`, { headers }, 4, deadline);
    } catch (error) {
      if (error instanceof RequestDeadlineError) break;
      throw error;
    }
    const { response: res, body } = fetched;
    if (res.status === 200) return parseJsonBody(body, `result for ${name}`);
    if (res.status === 429) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs === 0) break;
      await sleep(Math.min(retryAfterDelayMs(res.headers.get('retry-after')), remainingMs));
      continue;
    }
    if (res.status !== 404) die(`poll ${name} failed HTTP ${res.status}: ${body}`);
    // The edge node normally completes shell.exec in about 2.5s. Polling sooner mostly returns a
    // 404 and consumes two rate-limit slots per chunk without making the transfer finish sooner.
    await sleep(Math.min(2_500, Math.max(1, deadline - Date.now())));
  }
  die(`timed out waiting for ${name}`);
}

function retryAfterDelayMs(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(String(value || ''));
  if (Number.isFinite(at)) return Math.max(1, at - Date.now());
  return 2_000;
}

async function pickClient(deadline) {
  const clients = await listClients(deadline);
  const online = clients.filter((c) => c.status === 'online');
  const controllable = online.find((c) => (c.capabilities || []).includes('screen.capture') && (c.capabilities || []).includes('desktop.control'));
  const chosen = controllable || online[0] || clients[0];
  if (!chosen) die('No remote clients registered');
  return chosen.clientId;
}

async function listClients(deadline = Date.now() + Math.max(1, num(args.timeoutMs, 30_000))) {
  const { response: res, body } = await robustFetch(`${api}/`, { headers }, 4, deadline);
  if (res.status === 401) die('401 Unauthorized: shared secret does not match control plane');
  if (!res.ok) die(`list clients failed HTTP ${res.status}: ${body}`);
  return parseJsonBody(body, 'remote client list').clients || [];
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
  if (!existsSync('.env')) return '';
  const text = await readFile('.env', 'utf8');
  const line = text.split(/\r?\n/).find((l) => /^\s*REMOTE_CLIENT_SHARED_SECRET\s*=/.test(l));
  return line ? line.replace(/^\s*REMOTE_CLIENT_SHARED_SECRET\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '') : '';
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

async function robustFetch(url, options, attempts, deadline) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new RequestDeadlineError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      // Consume the body before cancelling the timer: fetch resolves at headers, but a peer can
      // still stall the body forever unless the same deadline remains attached to the stream.
      const body = await response.text();
      if (Date.now() >= deadline) throw new RequestDeadlineError();
      return { response, body };
    } catch (err) {
      last = err;
      if (Date.now() >= deadline || err?.name === 'AbortError') throw new RequestDeadlineError();
      if (i < attempts - 1) await sleep(Math.min(350 * (i + 1), Math.max(1, deadline - Date.now())));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

function parseJsonBody(body, context) {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`invalid JSON in ${context}: ${errorDetails(error)}`);
  }
}

function errorDetails(error) {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}

function die(message) {
  throw new Error(String(message));
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
  --cleanupTimeoutMs=15000     Pull scratch cleanup budget (hard-capped at 30000ms).
  --secret=<secret>            Usually omitted; reads REMOTE_CLIENT_SHARED_SECRET from .env.
`);
}
