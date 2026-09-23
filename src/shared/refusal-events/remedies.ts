/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Start the P3 operator-remediable refusal catalog with the two proven authorization cases. Exact delegation setting names are imported from the enforcing policy and every message is generated from the exported settings map so the check and remedy cannot drift.
 */

import {
  DELEGATION_PUBLIC_KEY_ENV_KEY,
  DELEGATION_SIGNING_ENV_KEYS,
} from '@/shared/security/delegation-http-policy';

/**
 * Exact configuration keys used by remediable refusal messages. A code with an empty list is
 * remedied through the control plane rather than by changing process configuration.
 */
export const REFUSAL_REMEDY_SETTINGS = Object.freeze({
  authorization_permission_denied: Object.freeze([] as string[]),
  authorization_recorded_delegation_required: Object.freeze([
    ...DELEGATION_SIGNING_ENV_KEYS,
    DELEGATION_PUBLIC_KEY_ENV_KEY,
  ]),
});

export type OperatorRemediableRefusalCode = keyof typeof REFUSAL_REMEDY_SETTINGS;

/** One operator action attached to a stable refusal code. */
export interface RefusalRemedy {
  remedy: string;
  settings: readonly string[];
}

/** Format setting names from the canonical array; messages never retype them. */
function settingsList(settings: readonly string[]): string {
  if (settings.length < 2) return settings[0] ?? '';
  return `${settings.slice(0, -1).join(', ')} and ${settings.at(-1)}`;
}

const delegationSettings = REFUSAL_REMEDY_SETTINGS.authorization_recorded_delegation_required;

/**
 * The reviewed operator-remediable subset. Absence is deliberate: identity, tenant, policy and
 * validation denials are not listed merely because an administrator could weaken a gate.
 */
export const OPERATOR_REMEDIABLE_REFUSALS: Readonly<Record<OperatorRemediableRefusalCode, RefusalRemedy>> = Object.freeze({
  authorization_permission_denied: Object.freeze({
    settings: REFUSAL_REMEDY_SETTINGS.authorization_permission_denied,
    remedy: 'Grant the refusing actor the application permission required by this target, then reactivate the scheduled service and retry.',
  }),
  authorization_recorded_delegation_required: Object.freeze({
    settings: delegationSettings,
    remedy: `Set ${settingsList(delegationSettings)} on the controller/bot fleet, restart the affected runtimes, then retry the protected dispatch.`,
  }),
});

/** @description Return the reviewed operator remedy for a stable refusal code, when one exists. */
export function remedyForRefusal(code: string): string | undefined {
  return (OPERATOR_REMEDIABLE_REFUSALS as Readonly<Record<string, RefusalRemedy>>)[code]?.remedy;
}
