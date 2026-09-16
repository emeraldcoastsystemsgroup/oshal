/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the Notifications routing table's per-channel credential tier. The live step reads GET /api/notify/prefs with the initiating user's cookie and checks that every sendable channel reports the account that would carry it for that user (their own account, the deployment's service, or unavailable). Read-only: it never saves a preference or sends anything.
 */

import { NOTIFY_CHANNELS } from '@/features/notifications';
import type { Scenario, StepResult } from './test-lab-scenarios';

const APP = 'notifications';
const LABEL = 'Per-channel account tier';
const TIERS = new Set(['own', 'deployment', 'unavailable']);

/**
 * @description Live step: read the caller's own notification routing and check every sendable
 * channel carries a known account tier.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result; a missing session degrades, a missing or unknown tier fails.
 */
async function tierStep(cookie: string): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: APP, label: LABEL, state, detail, ...(status ? { status } : {}) });
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/notify/prefs`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) });
  if (response.status === 401) return result('degraded', 'Sign in to read your own notification routing.', 401);
  if (response.status !== 200) return result('fail', `Notification prefs returned HTTP ${response.status}.`, response.status);
  const tiers = ((await response.json()) as { tiers?: Record<string, unknown> }).tiers;
  if (!tiers || typeof tiers !== 'object') return result('fail', 'The prefs route reports no per-channel account tier.');
  const sendable = NOTIFY_CHANNELS.filter((channel) => channel !== 'none');
  const unknown = sendable.filter((channel) => !TIERS.has(String(tiers[channel])));
  if (unknown.length) return result('fail', `No known account tier for: ${unknown.join(', ')}.`);
  return result('pass', `${sendable.map((channel) => `${channel}: ${tiers[channel]}`).join(' · ')}. Read-only; nothing was saved or sent.`);
}

export const NOTIFICATION_SCENARIOS: Scenario[] = [{
  id: 'notification-channel-tiers', title: 'Notifications — whose account sends each channel', group: 'tool',
  description: 'Reads your own notification routing and checks each channel option can say which account would carry it for you: your own connected account, the deployment\'s service, or none yet. Read-only.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/notify-channel-tier.spec.ts' },
    { level: 'integration', path: 'tests/unit/notify-prefs-routes.spec.ts' },
    { level: 'unit', path: 'tests/unit/notify-surface-tier-copy.spec.ts' },
    { level: 'unit', path: 'tests/unit/notify-user-senders.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-notification-registration.spec.ts' },
  ],
  steps: [{ id: 'tiers', app: APP, label: LABEL, run: tierStep }],
}];
