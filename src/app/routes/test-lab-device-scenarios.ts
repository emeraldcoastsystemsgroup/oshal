/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the remote-node binding card (BACKLOG "Node enrolment is the blocker for every remote-node capability"). A node's enrolment succeeds or fails on one fact - did the computer come up BOUND to a person - and a node that installed, connected and heartbeats but bound to nobody looks identical to a working one while receiving no owner-scoped work at all. The live step reads the caller's own device list and checks the surface can say, per computer, who it is bound to, without any owner subject id inside what it renders. Read-only: it registers nothing, adopts nothing and dispatches nothing.
 *
 * @module routes/test-lab-device-scenarios
 */

import type { Scenario, StepResult } from './test-lab-scenarios';

const APP = 'devices';
const LABEL = 'Remote node bindings';

/** The GET /api/remote-clients payload, as far as this step needs to read it. */
interface DeviceListPayload {
  clients?: unknown;
}

/** One listed computer, as far as this step needs to read it. */
interface ListedDevice {
  clientId?: unknown;
  ownerSub?: unknown;
  ownership?: { state?: unknown; owned?: unknown };
}

/**
 * @description Live step: read the computers registered to the caller and check each one reports
 * the viewer-relative binding the cockpit renders. A computer with no binding block is the failure
 * this card exists for — the surface cannot then tell a finished enrolment from an abandoned one.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result; a missing session or an empty fleet degrades, a missing binding fails.
 */
async function bindingsStep(cookie: string): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult =>
    ({ app: APP, label: LABEL, state, detail, ...(status ? { status } : {}) });
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/remote-clients`, {
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) return result('degraded', 'Sign in to read the computers registered to you.', 401);
  if (response.status !== 200) return result('fail', `The device list returned HTTP ${response.status}.`, response.status);

  const payload = (await response.json()) as DeviceListPayload;
  if (!Array.isArray(payload.clients)) return result('fail', 'The device list reports no computers array.');
  const devices = payload.clients as ListedDevice[];
  if (!devices.length) return result('degraded', 'No computers are registered to you yet, so there is no binding to read.');

  const silent = devices.filter((device) => typeof device.ownership?.owned !== 'boolean');
  if (silent.length) {
    return result('fail', `${silent.length} of ${devices.length} computers do not say who they are bound to, so a finished enrolment cannot be told from an abandoned one.`);
  }
  const leaking = devices.filter((device) => typeof device.ownerSub === 'string'
    && JSON.stringify(device.ownership).includes(device.ownerSub));
  if (leaking.length) return result('fail', `${leaking.length} binding blocks carry an owner subject id.`);

  const bound = devices.filter((device) => device.ownership?.owned === true).length;
  return result('pass', `${bound} of ${devices.length} computers are bound to an account; ${devices.length - bound} unowned. Read-only; nothing was registered or dispatched.`);
}

/** The remote-node binding Test Lab card: one read-only binding readback. */
export const DEVICE_SCENARIOS: Scenario[] = [{
  id: 'device-node-bindings', title: 'Remote nodes — whether each computer finished enrolling', group: 'tool',
  description: 'Reads the computers registered to you and checks the cockpit can say, for each one, who it is bound to. A node that installed and connected but bound to nobody heartbeats exactly like a working one and receives no work dispatched to you; this is the read that tells them apart. Read-only.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/device-ownership-visible.spec.ts' },
    { level: 'unit', path: 'tests/unit/remote-client-device-ownership.spec.ts' },
    { level: 'unit', path: 'tests/unit/device-access-dispatch.spec.ts' },
    { level: 'unit', path: 'tests/unit/node-enrolment-device-binding.spec.ts' },
  ],
  steps: [{ id: 'bindings', app: APP, label: LABEL, run: bindingsStep }],
}];
