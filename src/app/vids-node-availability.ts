/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Is the render node free? One fail-closed gate over every signal that says otherwise — an in-flight render, the nightly recap agent, a held lease, a missing signed-in browser, and the memory/stray-Chrome pressure that turned a 20-minute build into two hours on 2026-07-28.
 */
/**
 * @description The render node's availability gate.
 *
 * The node is ONE machine driving ONE signed-in Chrome, and more than one thing wants it: the
 * nightly trade recap, a video-series render, and now the joke-shorts pump. Two of them at once does
 * not mean "slower" — it means both fail, because they re-open each other's Google Vids tabs, and
 * every retry is a paid generation.
 *
 * So nothing here asks "is the node up?". It asks "is the node FREE?", and it answers no unless it
 * can prove otherwise:
 *
 *   - A remote task is already claimed on it, or a render is already in flight (Postgres).
 *   - We are inside the blackout window the recap owns (the recap does not announce itself).
 *   - The recap's agent is alive on the node — its pid, or a log it wrote seconds ago.
 *   - Someone holds the node lease.
 *   - The signed-in Vids browser is not running, so a render would open a login page and click into it.
 *   - Free memory or stray-Chrome count is in the range that made the 2026-07-28 build crawl.
 *
 * FAIL-CLOSED is the whole design. A probe that times out, a node that cannot be reached, an
 * unreadable answer — all of them mean "not available". The cost of a false "free" is a wasted paid
 * render and a corrupted recap; the cost of a false "busy" is that the pump tries again later.
 *
 * @module app/vids-node-availability
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';

const logger = createChildLogger({ module: 'vids-node-availability' });

/** The vids-operator agent — the identity a probe/lease task is sent as. */
export const VIDS_OPERATOR_AGENT_ID = 'b00e0000-0000-0000-0000-000000000001';

/** Where the vids-operator package lives ON THE RENDER NODE (also the recap agent's working dir). */
export const nodePkgDir = (): string => (process.env.VIDS_NODE_PKG_DIR || 'C:\\oshal-vidsop').replace(/\\+$/, '');

/** The node-side binary that runs it. */
export const nodeExe = (): string => process.env.VIDS_NODE_EXE || 'C:\\Program Files\\nodejs\\node.exe';

/** @description What the node itself reported. Every field is optional: an absent field is never read as "fine". */
export interface NodeProbe {
  /** The recap agent is running (its pid is alive, or it wrote its log seconds ago). */
  recapActive?: boolean;
  /** Who holds the node lease, when one is held and unexpired. */
  leaseOwner?: string | null;
  /** When that lease expires (ISO). */
  leaseExpiresAt?: string | null;
  /** chrome.exe processes in total — the stray-tab count that ate 14.5GB on 2026-07-28. */
  chromeTotal?: number;
  /** chrome.exe processes running the signed-in Vids profile. Zero means a render cannot log in. */
  chromeDebug?: number;
  /** Available memory, MB (Windows' "Available", which includes standby — not "free"). */
  availableMb?: number;
  /**
   * Commit charge as a percent of the commit limit. THE signal from 2026-07-28, when the node sat at
   * 31.5GB of a 31.8GB limit (99%) and a 20-minute build took two hours — free physical memory alone
   * reads low on a healthy Windows box and would have failed that call either way.
   */
  commitPct?: number;
}

/** @description The gate's verdict. */
export interface NodeAvailability {
  /** True only when every signal says the node is free. */
  available: boolean;
  /** Which check decided it — `free` when available. */
  check: 'no-worker' | 'worker-busy' | 'render-in-flight' | 'blackout' | 'probe-failed'
  | 'recap-running' | 'leased' | 'no-browser' | 'low-memory' | 'chrome-storm' | 'free';
  /** One human-readable line, safe to show an operator or write to a ledger. */
  reason: string;
  /** The node's clientId when one was found. */
  clientId?: string;
  /** What the node reported, when the probe ran. */
  probe?: NodeProbe;
}

/** @description Tuning knobs. Defaults are the proven ones; every one is overridable by env. */
export interface AvailabilityOptions {
  /** Skip the node-side probe (registry + Postgres + blackout only). Default false — the probe is the honest part. */
  skipProbe?: boolean;
  /** How long to wait for the probe task. Default VIDS_NODE_PROBE_TIMEOUT_MS or 120s. */
  probeTimeoutMs?: number;
  /** Treat the recap as active when its log was written within this many minutes. Default 10. */
  recapIdleMinutes?: number;
  /** Refuse below this many AVAILABLE MB. Default VIDS_NODE_MIN_FREE_MB or 512. */
  minFreeMb?: number;
  /** Refuse at or above this commit-charge percent. Default VIDS_NODE_MAX_COMMIT_PCT or 92. */
  maxCommitPct?: number;
  /** Refuse above this many chrome.exe processes. Default VIDS_NODE_MAX_CHROME or 40. */
  maxChrome?: number;
  /** A lease held by this owner does not block us (the pump re-entering its own lease). */
  selfLeaseOwner?: string;
}

/** @description One blackout window, minutes-from-midnight in the configured zone. */
interface Window { fromMin: number; toMin: number }

/** Parse "16:45-19:45,22:00-06:00" into windows. Unparseable entries are dropped, not guessed at. */
function parseWindows(spec: string): Window[] {
  const out: Window[] = [];
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) { logger.warn({ part }, 'unparseable blackout window — ignored'); continue; }
    const fromMin = Number(m[1]) * 60 + Number(m[2]);
    const toMin = Number(m[3]) * 60 + Number(m[4]);
    if (fromMin > 1439 || toMin > 1439) { logger.warn({ part }, 'out-of-range blackout window — ignored'); continue; }
    out.push({ fromMin, toMin });
  }
  return out;
}

/**
 * @description True while `now` falls inside any window, in the given zone. Windows that wrap
 * midnight (22:00-06:00) are handled — a naive `from <= x && x < to` would silently never fire.
 * @param {Date} now the instant to test
 * @param {string} spec comma-separated HH:MM-HH:MM windows
 * @param {string} timeZone IANA zone the windows are written in
 * @returns {boolean} whether the instant is blacked out
 */
export function isInBlackout(now: Date, spec: string, timeZone: string): boolean {
  const windows = parseWindows(spec);
  if (!windows.length) return false;
  // Read the wall clock in the node's own zone — the operator writes "16:45" meaning Central. A zone
  // Intl rejects, or a clock we cannot read, means we do not know whether the recap owns the node
  // right now: answer "blacked out" rather than letting a second chain onto it.
  let hour = NaN;
  let minute = NaN;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
    minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  } catch (err) {
    logger.warn({ timeZone, err: (err as Error).message }, 'unreadable blackout time zone — treating as blacked out');
    return true;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true; // unreadable clock: fail closed
  const at = hour * 60 + minute;
  return windows.some((w) => (w.fromMin <= w.toMin
    ? at >= w.fromMin && at < w.toMin
    : at >= w.fromMin || at < w.toMin));
}

/** @description A node that can run a shell command, as the registry describes it. */
interface WorkerRecord {
  clientId: string;
  agentId?: string;
  status?: string;
  healthy?: boolean;
  capabilities?: unknown;
  activeTaskId?: string | null;
  taskQueueDepth?: number;
}

/**
 * @description Find the render node: the one pinned by VIDS_RENDER_CLIENT_ID, or the first online
 * client that can run a shell command.
 * @returns {WorkerRecord | null} the node, or null when none is connected
 */
export function findRenderNode(): WorkerRecord | null {
  let clients: WorkerRecord[] = [];
  try { clients = remoteClientRegistry.listClients() as WorkerRecord[]; } catch { return null; }
  const shellCapable = clients.filter((c) => {
    const caps = Array.isArray(c.capabilities) ? (c.capabilities as string[]) : [];
    return caps.includes('shell.exec');
  });
  const pinned = (process.env.VIDS_RENDER_CLIENT_ID || '').trim();
  if (pinned) return shellCapable.find((c) => c.clientId === pinned) ?? null;
  return shellCapable.find((c) => (c.status ?? 'online') === 'online' && (c.healthy ?? true)) ?? null;
}

/**
 * @description Run one PowerShell command on the node and wait for it. Used for the probe and the
 * lease — both need an answer NOW, unlike a render, which is dispatched and reconciled later.
 * @param {string} clientId the node
 * @param {string} command the PowerShell to run (pure ASCII — CP1252 smart quotes break the parser)
 * @param {number} timeoutMs how long to wait before giving up
 * @returns {Promise<{ok: boolean, stdout: string, error?: string}>} the result; never throws
 */
export async function runNodeShell(
  clientId: string,
  command: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  const taskId = randomUUID();
  try {
    remoteClientRegistry.enqueueTask(clientId, {
      taskId,
      correlationId: taskId,
      fromAgentId: VIDS_OPERATOR_AGENT_ID,
      toAgentId: clientId,
      intent: 'mcp.call-tool' as const,
      input: { name: 'shell.exec', arguments: { command } },
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    return { ok: false, stdout: '', error: `enqueue failed: ${(err as Error).message}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = remoteClientRegistry.getCompletedResult(clientId, taskId) as
      { status?: string; output?: { stdout?: string }; error?: string } | null;
    if (result) {
      const stdout = String(result.output?.stdout ?? '');
      if (result.status && result.status !== 'completed' && result.status !== 'succeeded') {
        return { ok: false, stdout, error: result.error || `task ${result.status}` };
      }
      return { ok: true, stdout };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 2000); });
  }
  return { ok: false, stdout: '', error: `no answer from the node in ${Math.round(timeoutMs / 1000)}s` };
}

/** The probe. One PowerShell block, one JSON line out. ASCII only, and every read is guarded. */
function probeCommand(recapIdleMinutes: number): string {
  const pkg = nodePkgDir();
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    `$pkg = '${pkg}'`,
    '$data = if ($env:VIDS_DATA_DIR) { $env:VIDS_DATA_DIR } else { Join-Path $env:USERPROFILE \'.oshal-vids\' }',
    '$out = Join-Path $pkg \'out\'',
    // The nightly recap, detected by the markers run-daily-recap.ps1 ACTUALLY writes on the node:
    // out\build.pid (the launched agent) and out\build.log (what it is writing right now). The older
    // claude-run.pid / claude-run.log in the package root are checked too, but they are stale on this
    // node — trusting them alone reported "idle" while the recap was mid-build (verified 2026-07-29).
    '$recap = $false',
    'foreach ($pf in @((Join-Path $out \'build.pid\'), (Join-Path $pkg \'claude-run.pid\'))) {',
    '  if (-not $recap -and (Test-Path $pf)) {',
    '    $rp = (Get-Content $pf -Raw).Trim()',
    '    if ($rp -match \'^\\d+$\' -and (Get-Process -Id ([int]$rp) -ErrorAction SilentlyContinue)) { $recap = $true }',
    '  }',
    '}',
    'foreach ($lf in @((Join-Path $out \'build.log\'), (Join-Path $pkg \'claude-run.log\'))) {',
    '  if (-not $recap -and (Test-Path $lf)) {',
    `    if ((Get-Item $lf).LastWriteTime -gt (Get-Date).AddMinutes(-${recapIdleMinutes})) { $recap = $true }`,
    '  }',
    '}',
    // A `claude` process on the node is the recap's agent by construction — nothing else runs one.
    'if (-not $recap -and @(Get-Process claude -ErrorAction SilentlyContinue).Count -gt 0) { $recap = $true }',
    // The lease, when one is held.
    '$leaseOwner = $null; $leaseExp = $null',
    '$leaseFile = Join-Path $data \'node.lock\'',
    'if (Test-Path $leaseFile) {',
    '  $l = (Get-Content $leaseFile -Raw) | ConvertFrom-Json',
    '  if ($l -and $l.expiresAt -and ([datetime]$l.expiresAt) -gt (Get-Date).ToUniversalTime()) {',
    '    $leaseOwner = [string]$l.owner; $leaseExp = [string]$l.expiresAt',
    '  }',
    '}',
    // Chrome census + memory headroom.
    '$all = @(Get-Process chrome -ErrorAction SilentlyContinue)',
    '$dbg = @(Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -like \'*oshal-video-chrome*\' })',
    '$m = Get-CimInstance Win32_PerfRawData_PerfOS_Memory',
    '$avail = [int]$m.AvailableMBytes',
    '$commit = if ($m.CommitLimit -gt 0) { [int](100 * $m.CommittedBytes / $m.CommitLimit) } else { 0 }',
    'Write-Output (\'NODE_STATUS \' + (@{ recapActive = $recap; leaseOwner = $leaseOwner; leaseExpiresAt = $leaseExp;'
      + ' chromeTotal = $all.Count; chromeDebug = $dbg.Count; availableMb = $avail; commitPct = $commit } | ConvertTo-Json -Compress))',
  ].join('; ');
}

/** Pull the NODE_STATUS line out of the probe's stdout. Anything else is a failed probe, not a default. */
function parseProbe(stdout: string): NodeProbe | null {
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('NODE_STATUS'));
  if (!line) return null;
  try {
    const raw = JSON.parse(line.slice('NODE_STATUS'.length).trim()) as Record<string, unknown>;
    return {
      recapActive: Boolean(raw.recapActive),
      leaseOwner: (raw.leaseOwner as string | null) ?? null,
      leaseExpiresAt: (raw.leaseExpiresAt as string | null) ?? null,
      chromeTotal: Number(raw.chromeTotal ?? NaN),
      chromeDebug: Number(raw.chromeDebug ?? NaN),
      availableMb: Number(raw.availableMb ?? NaN),
      commitPct: Number(raw.commitPct ?? NaN),
    };
  } catch { return null; }
}

/**
 * @description Is the render node free right now? Checks cheapest-first and stops at the first
 * signal that says no. Every failure mode answers "not available" — never "probably fine".
 * @param {Pool} pool database pool (for the in-flight render check)
 * @param {AvailabilityOptions} [opts] tuning
 * @returns {Promise<NodeAvailability>} the verdict
 */
export async function checkVidsNodeAvailability(
  pool: Pool,
  opts: AvailabilityOptions = {},
): Promise<NodeAvailability> {
  const node = findRenderNode();
  if (!node) {
    return { available: false, check: 'no-worker', reason: 'no render node is connected (no online client advertising shell.exec)' };
  }
  const clientId = node.clientId;

  // 1. The node is already running something for someone else.
  if (node.activeTaskId) {
    return { available: false, check: 'worker-busy', clientId, reason: `the node is running task ${node.activeTaskId}` };
  }
  if ((node.taskQueueDepth ?? 0) > 0) {
    return { available: false, check: 'worker-busy', clientId, reason: `${node.taskQueueDepth} task(s) already queued on the node` };
  }

  // 2. A render is in flight anywhere — one Chrome, one chain, regardless of which series owns it.
  const inFlight = await pool.query(
    `SELECT e.episode_id, e.title FROM video_episodes e WHERE e.status = 'rendering' LIMIT 1`,
  );
  if (inFlight.rows.length) {
    const t = String((inFlight.rows[0] as { title?: string }).title ?? 'an episode');
    return { available: false, check: 'render-in-flight', clientId, reason: `"${t}" is still rendering on the node` };
  }

  // 3. The window the nightly recap owns. It does not announce itself, so we stay out by the clock
  //    as well as by the probe below.
  // `||`, not `??`: compose passes an unset variable through as an EMPTY STRING, and `??` would
  // accept that as "the operator configured no window" — silently deleting the recap's protection.
  const spec = process.env.VIDS_NODE_BLACKOUT || '16:45-19:45';
  const zone = process.env.VIDS_NODE_BLACKOUT_TZ || 'America/Chicago';
  if (isInBlackout(new Date(), spec, zone)) {
    return { available: false, check: 'blackout', clientId, reason: `inside the reserved window ${spec} ${zone} (the nightly recap owns the node)` };
  }

  if (opts.skipProbe) return { available: true, check: 'free', clientId, reason: 'registry and schedule are clear (node probe skipped)' };

  // 4. Ask the node itself.
  const timeoutMs = opts.probeTimeoutMs ?? Number(process.env.VIDS_NODE_PROBE_TIMEOUT_MS || 120_000);
  const recapIdleMinutes = opts.recapIdleMinutes ?? Number(process.env.VIDS_NODE_RECAP_IDLE_MIN || 10);
  const shell = await runNodeShell(clientId, probeCommand(recapIdleMinutes), timeoutMs);
  if (!shell.ok) {
    return { available: false, check: 'probe-failed', clientId, reason: `could not probe the node: ${shell.error}` };
  }
  const probe = parseProbe(shell.stdout);
  if (!probe) {
    return { available: false, check: 'probe-failed', clientId, reason: 'the node answered without a NODE_STATUS line' };
  }

  if (probe.recapActive) {
    return { available: false, check: 'recap-running', clientId, probe, reason: 'the nightly recap agent is running on the node' };
  }
  if (probe.leaseOwner && probe.leaseOwner !== opts.selfLeaseOwner) {
    return {
      available: false, check: 'leased', clientId, probe,
      reason: `the node is leased by ${probe.leaseOwner} until ${probe.leaseExpiresAt ?? 'unknown'}`,
    };
  }
  if (!(probe.chromeDebug && probe.chromeDebug > 0)) {
    return {
      available: false, check: 'no-browser', clientId, probe,
      reason: 'the signed-in Vids browser is not running on the node — start chrome.exe with --remote-debugging-port=9222 --user-data-dir=<the oshal-video-chrome profile>',
    };
  }
  // Memory. Commit percent is the signal that actually caught 2026-07-28; available-MB is the
  // secondary floor for a genuinely starved box. Free-physical was deliberately dropped: on a healthy
  // Windows machine it reads low all the time, so gating on it refuses forever.
  const maxCommitPct = opts.maxCommitPct ?? Number(process.env.VIDS_NODE_MAX_COMMIT_PCT || 92);
  if (Number.isFinite(probe.commitPct) && (probe.commitPct as number) >= maxCommitPct) {
    return {
      available: false, check: 'low-memory', clientId, probe,
      reason: `the node's commit charge is at ${probe.commitPct}% (limit ${maxCommitPct}%) — prune chrome.exe processes without oshal-video-chrome in their command line`,
    };
  }
  const minFreeMb = opts.minFreeMb ?? Number(process.env.VIDS_NODE_MIN_FREE_MB || 512);
  if (Number.isFinite(probe.availableMb) && (probe.availableMb as number) < minFreeMb) {
    return {
      available: false, check: 'low-memory', clientId, probe,
      reason: `only ${probe.availableMb}MB available on the node (need ${minFreeMb}MB)`,
    };
  }
  const maxChrome = opts.maxChrome ?? Number(process.env.VIDS_NODE_MAX_CHROME || 40);
  if (Number.isFinite(probe.chromeTotal) && (probe.chromeTotal as number) > maxChrome) {
    return {
      available: false, check: 'chrome-storm', clientId, probe,
      reason: `${probe.chromeTotal} chrome.exe processes on the node (limit ${maxChrome}) — stray tabs are what made the 2026-07-28 build crawl`,
    };
  }

  logger.info({ clientId, probe }, 'render node is free');
  return { available: true, check: 'free', clientId, probe, reason: 'the render node is idle' };
}

/**
 * @description Take the node lease so anything else that checks sees it as busy. Refuses when a
 * DIFFERENT owner holds an unexpired lease — the lease is advisory between cooperating callers, not
 * a substitute for the availability gate.
 * @param {string} clientId the node
 * @param {string} owner who is taking it (e.g. `joke-pump:<runId>`)
 * @param {number} ttlMinutes how long the lease should outlive a crash
 * @returns {Promise<{ok: boolean, error?: string}>} whether the lease is ours
 */
export async function acquireVidsNodeLease(
  clientId: string,
  owner: string,
  ttlMinutes: number,
): Promise<{ ok: boolean; error?: string }> {
  const safeOwner = owner.replace(/[^A-Za-z0-9:_-]/g, '');
  const command = [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$data = if ($env:VIDS_DATA_DIR) { $env:VIDS_DATA_DIR } else { Join-Path $env:USERPROFILE \'.oshal-vids\' }',
    'New-Item -ItemType Directory -Force -Path $data | Out-Null',
    '$leaseFile = Join-Path $data \'node.lock\'',
    `$me = '${safeOwner}'`,
    '$held = $null',
    'if (Test-Path $leaseFile) {',
    '  $l = (Get-Content $leaseFile -Raw) | ConvertFrom-Json',
    '  if ($l -and $l.expiresAt -and ([datetime]$l.expiresAt) -gt (Get-Date).ToUniversalTime() -and $l.owner -ne $me) { $held = [string]$l.owner }',
    '}',
    'if ($held) { Write-Output ("LEASE_HELD " + $held) } else {',
    `  $exp = (Get-Date).ToUniversalTime().AddMinutes(${Math.max(1, Math.round(ttlMinutes))}).ToString('o')`,
    '  @{ owner = $me; expiresAt = $exp } | ConvertTo-Json -Compress | Set-Content -Path $leaseFile -Encoding utf8',
    '  Write-Output ("LEASE_OK " + $exp)',
    '}',
  ].join('; ');

  const r = await runNodeShell(clientId, command, Number(process.env.VIDS_NODE_PROBE_TIMEOUT_MS || 120_000));
  if (!r.ok) return { ok: false, error: r.error };
  if (r.stdout.includes('LEASE_OK')) return { ok: true };
  const held = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('LEASE_HELD'));
  return { ok: false, error: held ? held.replace('LEASE_HELD', 'lease held by').trim() : 'lease was neither taken nor refused' };
}

/**
 * @description Release the node lease, but only if it is still ours. A release that clears someone
 * else's lease is worse than a leaked one.
 * @param {string} clientId the node
 * @param {string} owner the owner that took it
 * @returns {Promise<{ok: boolean, error?: string}>} whether it was released
 */
export async function releaseVidsNodeLease(clientId: string, owner: string): Promise<{ ok: boolean; error?: string }> {
  const safeOwner = owner.replace(/[^A-Za-z0-9:_-]/g, '');
  const command = [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$data = if ($env:VIDS_DATA_DIR) { $env:VIDS_DATA_DIR } else { Join-Path $env:USERPROFILE \'.oshal-vids\' }',
    '$leaseFile = Join-Path $data \'node.lock\'',
    `$me = '${safeOwner}'`,
    'if (Test-Path $leaseFile) {',
    '  $l = (Get-Content $leaseFile -Raw) | ConvertFrom-Json',
    '  if ($l -and $l.owner -eq $me) { Remove-Item $leaseFile -Force; Write-Output \'LEASE_RELEASED\' }',
    '  else { Write-Output \'LEASE_NOT_MINE\' }',
    '} else { Write-Output \'LEASE_ABSENT\' }',
  ].join('; ');

  const r = await runNodeShell(clientId, command, Number(process.env.VIDS_NODE_PROBE_TIMEOUT_MS || 120_000));
  if (!r.ok) return { ok: false, error: r.error };
  if (r.stdout.includes('LEASE_RELEASED') || r.stdout.includes('LEASE_ABSENT')) return { ok: true };
  return { ok: false, error: 'the lease on the node belongs to someone else — left in place' };
}
