/**
 * Device access — "may THIS user's work run on THAT person's computer?"
 *
 * A registered leaf node is somebody's actual desktop. Work dispatched to it runs `codex.exec` with
 * `sandbox: danger-full-access` against their real, logged-in browser — so choosing a node is a
 * privilege decision, not a load-balancing decision.
 *
 * The 2026-07-09 device-ownership pass closed this at the HTTP surface (`requireDeviceAccess` in
 * remote-client-routes), but explicitly left "platform dispatchers" on machine trust. Those internal
 * dispatchers pick nodes by LIVENESS ALONE, so on a multi-user swarm any signed-in user's ticket
 * could land on any other user's machine — with their data staged into that workspace. This module is
 * the identity-shaped half of that gate, for the code paths that hold a user sub instead of a Request.
 *
 * Semantics deliberately MIRROR `canAccessResource` (shared/middleware/authz) so a device answers the
 * same way whether it is reached over HTTP or picked by a dispatcher: owner passes, operator passes,
 * an UNOWNED device is fail-closed unless OSHAL_ALLOW_LEGACY_UNOWNED is explicitly set.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: identity-based device
 *   authorization for internal dispatchers (canUseDevice / filterUsableDevices / assertDeviceUsable),
 *   mirroring canAccessResource for callers that have a user sub rather than an Express Request.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | describeDeviceOwnership: the same ownership fact,
 *   shaped for a VIEWER. A node's whole enrolment is judged on whether it came up bound to a person,
 *   and no cockpit surface could say - the device list rendered name, status and heartbeat only, so
 *   an unowned node (enrolment silently incomplete) and a correctly bound one looked identical. The
 *   decision stays on the server beside the gates it mirrors, and the view it returns carries a
 *   label rather than the owner's subject id, so a page can render it without holding a second,
 *   driftable answer to "whose computer is this?".
 *
 * @module features/remote-client/services/device-access
 */

import { createChildLogger } from '@/shared/logger';
import { isOperatorIdentity } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'device-access' });

/** The ownership-bearing subset of a registered device. Structural, so any record shape fits. */
export interface DeviceOwnership {
  clientId?: string;
  ownerSub?: string | null;
}

/**
 * Who is asking for a device.
 *
 * `system: true` is machine trust with NO end user to scope to (schedulers, platform maintenance).
 * It bypasses the check by design — the alternative is breaking every unattributed internal path —
 * so callers must only set it for traffic that genuinely originates inside the platform, never for
 * traffic carrying user-supplied input.
 */
export interface DeviceRequester {
  sub?: string | null;
  email?: string | null;
  system?: boolean;
}

/** True when the deployment still permits the legacy "unowned device = anyone" behaviour. */
function legacyUnownedAllowed(): boolean {
  return (process.env.OSHAL_ALLOW_LEGACY_UNOWNED ?? 'false').toLowerCase() === 'true';
}

/**
 * @description Decides whether the requester's work may execute on the given device. Mirrors
 * `canAccessResource`: the device's owner passes, an operator passes, and an UNOWNED device is
 * operator-only unless OSHAL_ALLOW_LEGACY_UNOWNED opts the deployment into the old behaviour.
 * A requester with no sub and no `system` flag is UNKNOWN and always denied — an unattributed
 * dispatcher must not inherit somebody's desktop by default.
 * @param requester - The identity the work is on behalf of.
 * @param device - The candidate device (only `ownerSub` is read).
 * @returns true when the work may be dispatched to this device.
 */
export function canUseDevice(requester: DeviceRequester, device: DeviceOwnership): boolean {
  if (requester.system === true) return true;
  const sub = requester.sub ? String(requester.sub) : null;
  const ownerSub = device.ownerSub ? String(device.ownerSub) : null;

  // An UNKNOWN requester is denied before any device-side branch is consulted. Ordering is
  // load-bearing: below the unowned branch this returned legacyUnownedAllowed(), so on a deployment
  // with OSHAL_ALLOW_LEGACY_UNOWNED=true and an unbound device — i.e. the live box — an
  // unattributed dispatch was ALLOWED, which is the exact fail-open this module exists to prevent.
  if (!sub) return false;

  if (ownerSub && ownerSub === sub) return true;
  if (isOperatorIdentity(sub, requester.email ?? null)) return true;
  if (!ownerSub) return legacyUnownedAllowed();
  return false;
}

/**
 * @description Narrows a candidate device list to the ones this requester may actually drive. Use
 * this at SELECTION time so a dispatcher can never auto-pick, and a picker UI can never display,
 * somebody else's machine.
 * @param requester - The identity the work is on behalf of.
 * @param devices - All candidate devices.
 * @returns Only the devices the requester is authorized to use.
 */
export function filterUsableDevices<T extends DeviceOwnership>(requester: DeviceRequester, devices: T[]): T[] {
  return devices.filter((device) => canUseDevice(requester, device));
}

/**
 * @description Enforcement backstop for a device already chosen by id (an explicit pin, a ticket
 * field, a request body). Returns an error string to surface, or null when the dispatch may proceed.
 * Logs every denial — a cross-user dispatch attempt is a security event, not a routine miss.
 * @param requester - The identity the work is on behalf of.
 * @param device - The device that was named.
 * @param context - Short label for the dispatch path, for the audit line.
 * @returns null when allowed, else a caller-safe error message.
 */
export function assertDeviceUsable(
  requester: DeviceRequester,
  device: DeviceOwnership,
  context: string,
): string | null {
  if (canUseDevice(requester, device)) return null;
  logger.warn(
    {
      context,
      clientId: device.clientId,
      requesterSub: requester.sub ?? null,
      deviceOwned: Boolean(device.ownerSub),
    },
    'Device dispatch denied: requester is not the owner of this computer',
  );
  return 'That computer is not registered to your account.';
}

/** How a device's binding reads to ONE viewer. Relative to the viewer, never a raw subject id. */
export type DeviceOwnershipState = 'you' | 'another-person' | 'unowned';

/**
 * A viewer-facing description of a device's binding.
 *
 * `owned` is the fact the enrolment flow is judged on — a computer that finished enrolment is bound
 * to a person, one that did not is bound to nobody — and `state` says to whom, without ever carrying
 * the owner's subject id off the server.
 */
export interface DeviceOwnershipView {
  state: DeviceOwnershipState;
  owned: boolean;
  label: string;
  hint: string;
}

const OWNERSHIP_VIEWS: Record<DeviceOwnershipState, { owned: boolean; label: string; hint: string }> = {
  you: {
    owned: true,
    label: 'You',
    hint: 'This computer is bound to your account, so work dispatched to you can run here.',
  },
  'another-person': {
    owned: true,
    label: 'Another person',
    hint: 'Bound to a different account. You can see it because you are an operator.',
  },
  unowned: {
    owned: false,
    label: 'Unowned',
    hint: 'Bound to nobody: enrolment did not complete, so no owner-scoped work is dispatched here.',
  },
};

/**
 * @description Describes a device's binding FROM ONE VIEWER'S SEAT, so a surface can show whether a
 * computer is owned without holding any ownership logic of its own and without ever receiving the
 * owner's subject id. The decision is made here, from the verified caller, for the same reason the
 * gates above are: a page that compared subject ids itself would be a second answer to the question
 * `canUseDevice` already answers, free to drift from it.
 * @param requester - The identity doing the viewing (its `sub` is the only field read).
 * @param device - The device being described (only `ownerSub` is read).
 * @returns The viewer-relative ownership view: state, the owned fact, and text safe to render.
 */
export function describeDeviceOwnership(
  requester: DeviceRequester,
  device: DeviceOwnership,
): DeviceOwnershipView {
  const sub = requester.sub ? String(requester.sub) : null;
  const ownerSub = device.ownerSub ? String(device.ownerSub) : null;
  if (!ownerSub) return { state: 'unowned', ...OWNERSHIP_VIEWS.unowned };
  const state: DeviceOwnershipState = sub !== null && ownerSub === sub ? 'you' : 'another-person';
  return { state, ...OWNERSHIP_VIEWS[state] };
}
