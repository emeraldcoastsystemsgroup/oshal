/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Recheck current authority and sealed source throughout isolated package test execution.
 */
import type { AppSmokeResult } from './app-smoke-verifier';
import type { PackageTestSnapshot } from './package-test-snapshot';
import { PackageTestSandbox } from './package-test-sandbox';

export interface InstalledAppTestResult extends AppSmokeResult {
  output?: string;
  executionRevision?: string;
  image?: string;
  cancelled?: boolean;
  timedOut?: boolean;
  cleanupVerified?: boolean;
}
export interface PackageTestExecution {
  name: string; path: string; suiteFiles: string[]; timeoutMs: number; maxMemoryMb?: number;
  snapshot: PackageTestSnapshot; snapshotNow: () => PackageTestSnapshot;
  current: () => Promise<boolean>; signal?: AbortSignal; executionId?: string; image?: string; sandbox: PackageTestSandbox;
}

/** @description Bound policy reads so a failed provider cannot hold cancellation or result publication open. */
async function currentAuthority(options: PackageTestExecution): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([options.current(), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}

/** @description Keep one in-flight authority probe and cancel promptly on revocation or failure. */
function watchAuthority(options: PackageTestExecution, controller: AbortController) {
  let denied = false, checking: Promise<void> | undefined;
  const verify = async (): Promise<void> => {
    if (!await currentAuthority(options)) denied = true;
    if (denied) controller.abort();
  };
  const timer = setInterval(() => { if (!checking) checking = verify().finally(() => { checking = undefined; }); }, 1000);
  timer.unref();
  return { denied: () => denied, stop: async () => { clearInterval(timer); await checking; } };
}

/** @description Run immutable bytes and publish output only while source and caller remain current. */
export async function executePackageTest(options: PackageTestExecution): Promise<InstalledAppTestResult> {
  const started = Date.now(), controller = new AbortController();
  const base = { name: options.name, path: options.path, executionRevision: options.snapshot.revision };
  const refused = (error: string): InstalledAppTestResult => ({ ...base, status: 'pending', error, durationMs: Date.now() - started });
  const abort = () => controller.abort();
  if (options.signal?.aborted) return { ...refused('Test cancelled before execution.'), cancelled: true, cleanupVerified: true };
  options.signal?.addEventListener('abort', abort, { once: true });
  const watch = watchAuthority(options, controller);
  try {
    if (!await currentAuthority(options)) return { ...refused('Current test execution authority is unavailable.'), cleanupVerified: true };
    const result = await options.sandbox.run({ files: options.snapshot.files, suiteFiles: options.suiteFiles,
      timeoutMs: options.timeoutMs, maxMemoryMb: options.maxMemoryMb, signal: controller.signal, image: options.image, executionId: options.executionId });
    const cleanup = { cleanupVerified: result.cleanupVerified, cancelled: result.cancelled, timedOut: result.timedOut };
    await watch.stop();
    if (watch.denied() || !await currentAuthority(options)) return { ...refused('Application or execution authority changed during the test.'), ...cleanup };
    if (options.snapshotNow().revision !== options.snapshot.revision) return { ...refused('Package source changed during the test. Refresh the catalog.'), ...cleanup };
    if (options.signal?.aborted || result.cancelled) return { ...refused('Test cancelled.'), cancelled: true, cleanupVerified: result.cleanupVerified };
    const passed = result.exitCode === 0 && !result.timedOut && result.cleanupVerified;
    return { ...base, status: passed ? 'passed' : 'failed', durationMs: Date.now() - started,
      output: result.output, image: result.image, timedOut: result.timedOut, cleanupVerified: result.cleanupVerified,
      ...(!passed ? { error: result.timedOut ? 'Test exceeded its time limit.' : !result.cleanupVerified ? 'Test cleanup could not be verified.' : 'Package test assertions failed.' } : {}) };
  } catch (error) {
    return { ...refused('The isolated runner or current package source is unavailable.'),
      cleanupVerified: (error as { cleanupVerified?: boolean })?.cleanupVerified === true };
  } finally { await watch.stop(); options.signal?.removeEventListener('abort', abort); }
}
