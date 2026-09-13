/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound termination and verify exit of the exact disposable test child tree or process group.
 */
import { spawn, execFile } from 'node:child_process';

/** @description Bound an owned operation while retaining rejection as explicit cleanup failure. */
async function bounded(work, timeoutMs) {
  let timer;
  try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

/** @description Terminate only the PID returned by our live Windows child handle. */
function windowsTree(pid, timeoutMs) {
  return new Promise(resolve => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, error => resolve(error ? 'taskkill failed: ' + error.code : null)));
}

/** @description Send to this launch's private POSIX process group, treating absence as already stopped. */
function groupSignal(pid, signal) {
  try { process.kill(-pid, signal); return null; }
  catch (error) { return error.code === 'ESRCH' ? null : 'process group signal failed: ' + error.code; }
}
function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** @description Verify group disappearance within a fixed deadline, without enumerating or targeting other processes. */
async function groupGone(pid, timeoutMs, exists) {
  const deadline = Date.now() + timeoutMs;
  while (exists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

/** @description Stop the exact owned child; injectable OS ports exercise failures without touching any process. */
export async function stopOwnedChild(child, closed, options = {}) {
  const { platform = process.platform, timeoutMs = 5000, graceMs = 1000,
    killTree = windowsTree, signalGroup = groupSignal, exists = groupExists } = options;
  const result = { pid: child.pid ?? null, exitVerified: false, treeTerminationVerified: false, error: null };
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return { ...result, error: 'Owned child PID is unavailable.' };
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return { ...result, error: 'Child already exited before tree cleanup could be verified.' };
    const killed = await bounded(Promise.resolve().then(() => killTree(child.pid, timeoutMs)).then(error => ({ error })), timeoutMs + 100);
    if (!killed || killed.error) return { ...result, error: killed?.error || 'Owned tree termination timed out.' };
    result.treeTerminationVerified = true;
  } else {
    let error = signalGroup(child.pid, 'SIGTERM');
    await bounded(closed, graceMs);
    if (exists(child.pid)) error ||= signalGroup(child.pid, 'SIGKILL');
    if (error) return { ...result, error };
    result.treeTerminationVerified = await groupGone(child.pid, timeoutMs, exists);
  }
  const exit = await bounded(closed, timeoutMs);
  result.exitVerified = Boolean(exit && !exit.error);
  return { ...result, ...(exit || {}), error: result.exitVerified && result.treeTerminationVerified ? null : 'Owned process exit or tree disappearance was not confirmed.' };
}

/** @description Observe both startup errors and completed stdio, keeping all event listeners owned and removable. */
function observe(child) {
  let done;
  const closed = new Promise(resolve => { done = resolve; });
  const close = (code, signal) => done({ code, signal });
  const error = () => done({ code: null, signal: null, error: 'Test process could not start.' });
  child.once('close', close); child.once('error', error);
  return { closed, detach: () => { child.off('close', close); child.off('error', error); } };
}

/** @description Run one known executable; abort/timeout always produce failure and bounded owned cleanup evidence. */
export async function runOwnedTestProcess(executable, args, options) {
  const { cwd, env, signal, timeoutMs, cleanup = {} } = options;
  if (signal?.aborted) return { code: null, output: '', cancelled: true, timedOut: false, cleanup: null };
  const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const observed = observe(child);
  let output = '', reason = null, stopping, finishStop;
  const stopped = new Promise(resolve => { finishStop = resolve; });
  const collect = bytes => { output = (output + bytes.toString()).slice(-1048576); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const stop = why => {
    if (stopping) return;
    reason = why;
    stopping = stopOwnedChild(child, observed.closed, cleanup).catch(() => ({ pid: child.pid, exitVerified: false, error: 'Owned cleanup failed.' }));
    stopping.then(finishStop);
  };
  const abort = () => stop('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  try {
    const exit = await Promise.race([observed.closed, stopped]);
    const evidence = stopping ? await stopping : { pid: child.pid, exitVerified: !exit.error, error: exit.error || null };
    return { code: exit.code ?? null, signal: exit.signal ?? null, output, timedOut: reason === 'timeout', cancelled: reason === 'cancelled', cleanup: evidence };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); observed.detach();
    child.stdout.off('data', collect); child.stderr.off('data', collect);
    if (stopping) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  }
}
