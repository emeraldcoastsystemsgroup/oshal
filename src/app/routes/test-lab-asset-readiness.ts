/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share fixed-asset readiness between dashboard and profile Lab scenarios.
 */
import { createChildLogger } from '@/shared/logger';
import type { StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-asset-readiness' });

/** Read a code-declared local asset in the caller's session without executing it. */
export async function assetReadiness(cookie: string, route: string, mime: string, label: string): Promise<StepResult> {
  const base = { app: 'cockpit', label };
  const startedAt = Date.now();
  logger.debug({ route }, 'asset readiness entered');
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${route}`, {
      headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) return { ...base, status: response.status,
      state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
      detail: `Cockpit asset returned HTTP ${response.status}. No account, preference or application action was started.` };
    const pass = (response.headers.get('content-type') || '').includes(mime) && (await response.text()).trim().length > 0;
    return { ...base, status: response.status, state: pass ? 'pass' : 'fail', detail: pass
      ? 'Cockpit asset is available. This readiness check does not execute the linked browser or integration suites.'
      : 'The Cockpit response is empty or has an unexpected content type.' };
  } catch (err) {
    logger.error({ err, route }, 'asset readiness failed');
    return { ...base, state: 'degraded', detail: 'Cockpit asset could not be checked. No account or application action was started.' };
  } finally {
    logger.debug({ route, durationMs: Date.now() - startedAt }, 'asset readiness exited');
  }
}
