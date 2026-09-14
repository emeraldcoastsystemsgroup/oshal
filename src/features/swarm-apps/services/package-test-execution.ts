/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Recheck current authority and sealed source throughout isolated package test execution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Carry the catalog-chosen container profile so browser recipes run under the Chromium profile.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Refuse a silent pass: a zero-exit run must report its TAP summary and at least one executed test, so an empty or early-exiting suite can never read as passed.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Read the TAP plan and its points as well as the `node --test` summary, so a vitest run whose reporter emits no summary is still counted from what it actually reported.
 */
import type { AppSmokeResult } from './app-smoke-verifier';
import type { PackageTestSnapshot } from './package-test-snapshot';
import { PackageTestSandbox } from './package-test-sandbox';
import type { PackageTestSandboxProfile } from './package-test-sandbox-launcher';

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
  /** Closed container profile derived from the declared runner kind; browser recipes get Chromium, nothing else. */
  profile?: PackageTestSandboxProfile;
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

/** @description Read the `node --test` TAP summary the fixed launcher produces for the Node and browser profiles.
 * `node --test` exits 0 for a file that registers no tests, and a suite that calls `process.exit(0)`
 * exits 0 with no summary at all; both would otherwise be published as a pass.
 * @param output Bounded runner output. @returns Executed/passed/failed counts, or null when no summary was reported. */
function tapSummaryCounts(output: string): { tests: number; pass: number; fail: number } | null {
  const last = (key: string): number | undefined => {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : undefined;
  };
  const tests = last('tests'), pass = last('pass'), fail = last('fail');
  if (tests === undefined || pass === undefined || fail === undefined) return null;
  return { tests, pass, fail };
}

/** @description Count a plain TAP 13 stream from its declared plan and its actual points. Vitest's TAP reporters
 * emit a plan and one point per test but no `# tests` summary, so without this a green vitest run would be read
 * as having reported nothing. A truncated stream still fails: fewer points than the plan is not a pass.
 * @param output Bounded runner output. @returns Executed/passed/failed counts, or null when no plan was reported. */
function tapPlanCounts(output: string): { tests: number; pass: number; fail: number } | null {
  const plan = [...output.matchAll(/^1\.\.(\d+)$/gm)].pop();
  if (!plan) return null;
  const points = [...output.matchAll(/^(not ok|ok) \d+(?![0-9])/gm)];
  const fail = points.filter(point => point[1] === 'not ok').length;
  const planned = Number(plan[1]);
  return { tests: planned, pass: points.length - fail, fail: fail + Math.max(0, planned - points.length) };
}

/** @description Read whatever test summary the runner actually reported, whichever reporter produced it.
 * @param output Bounded runner output. @returns Executed/passed/failed counts, or null when nothing was reported. */
export function reportedTestCounts(output: string): { tests: number; pass: number; fail: number } | null {
  return tapSummaryCounts(output) ?? tapPlanCounts(output);
}

/** @description Explain a zero-exit run that proved nothing, or undefined when the run really did assert something. */
function silentPass(output: string): string | undefined {
  const counts = reportedTestCounts(output);
  if (!counts) return 'The runner reported no test summary; the suite exited before completing.';
  if (counts.tests === 0) return 'The suite registered no tests, so it asserted nothing.';
  if (counts.pass === 0 && counts.fail === 0) return 'The suite executed no test points, so it asserted nothing.';
  return undefined;
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
    const result = await options.sandbox.run({ files: options.snapshot.files, suiteFiles: options.suiteFiles, profile: options.profile,
      timeoutMs: options.timeoutMs, maxMemoryMb: options.maxMemoryMb, signal: controller.signal, image: options.image, executionId: options.executionId });
    const cleanup = { cleanupVerified: result.cleanupVerified, cancelled: result.cancelled, timedOut: result.timedOut };
    await watch.stop();
    if (watch.denied() || !await currentAuthority(options)) return { ...refused('Application or execution authority changed during the test.'), ...cleanup };
    if (options.snapshotNow().revision !== options.snapshot.revision) return { ...refused('Package source changed during the test. Refresh the catalog.'), ...cleanup };
    if (options.signal?.aborted || result.cancelled) return { ...refused('Test cancelled.'), cancelled: true, cleanupVerified: result.cleanupVerified };
    if (result.exitCode === null && !result.timedOut) return { ...refused('The isolated runner is unavailable.'), ...cleanup };
    const clean = result.exitCode === 0 && !result.timedOut && result.cleanupVerified;
    const empty = clean ? silentPass(result.output) : undefined;
    const passed = clean && !empty;
    return { ...base, status: passed ? 'passed' : 'failed', durationMs: Date.now() - started,
      output: result.output, image: result.image, timedOut: result.timedOut, cleanupVerified: result.cleanupVerified,
      ...(!passed ? { error: result.timedOut ? 'Test exceeded its time limit.' : !result.cleanupVerified ? 'Test cleanup could not be verified.'
        : empty ?? 'Package test assertions failed.' } : {}) };
  } catch (error) {
    return { ...refused('The isolated runner or current package source is unavailable.'),
      cleanupVerified: (error as { cleanupVerified?: boolean })?.cleanupVerified === true };
  } finally { await watch.stop(); options.signal?.removeEventListener('abort', abort); }
}
