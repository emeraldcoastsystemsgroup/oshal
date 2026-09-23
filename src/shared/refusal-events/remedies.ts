/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Start the P3 operator-remediable refusal catalog with the two proven authorization cases. Exact delegation setting names are imported from the enforcing policy and every message is generated from the exported settings map so the check and remedy cannot drift.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Complete the source-reviewed operator-remediable catalog, using the shared setting/control constants enforced by each path. Remove the unsafe global permission-denied advice because that code also represents resource-scope denials; the schedule emitter now supplies its evidence-bound remedy itself.
 * 3   | maintainer@emeraldcoastsystemsgroup.com   | Keep ordinary app-admin and minimum-tier policy denials out of the global catalog: an operator may review them in Access, but a caller's denial alone is not evidence that granting privilege is safe.
 * 4   | maintainer@emeraldcoastsystemsgroup.com   | Remove aliased or dependency-injection-only infrastructure advice, preserve existing encryption keys, and state secret/key deployment topology explicitly.
 */

import {
  DELEGATION_PUBLIC_KEY_ENV_KEY,
  DELEGATION_SIGNING_ENV_KEYS,
} from '@/shared/security/delegation-http-policy';
import { PLATFORM_SETTING_KEYS } from '@/shared/platform-settings';

/** Exact configuration keys used by remediable refusal messages. */
export const REFUSAL_REMEDY_SETTINGS = Object.freeze({
  authorization_recorded_delegation_required: Object.freeze([
    ...DELEGATION_SIGNING_ENV_KEYS,
    DELEGATION_PUBLIC_KEY_ENV_KEY,
  ]),
  database_pool_unavailable: Object.freeze([PLATFORM_SETTING_KEYS.databaseUrl]),
  encrypted_secret_storage_required: Object.freeze([PLATFORM_SETTING_KEYS.encryptionKey]),
  graph_engine_unavailable: Object.freeze([PLATFORM_SETTING_KEYS.graphUrl]),
  guest_unavailable: PLATFORM_SETTING_KEYS.guestSigningSecrets,
  intake_unavailable: Object.freeze([PLATFORM_SETTING_KEYS.serviceSecret]),
  live_codex_auth_path_required: Object.freeze([PLATFORM_SETTING_KEYS.codexAuthSourcePath]),
  vision_unavailable: Object.freeze([
    PLATFORM_SETTING_KEYS.openRouterApiKey,
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
const databaseSettings = REFUSAL_REMEDY_SETTINGS.database_pool_unavailable;
const encryptionSettings = REFUSAL_REMEDY_SETTINGS.encrypted_secret_storage_required;
const guestSettings = REFUSAL_REMEDY_SETTINGS.guest_unavailable;
const visionSettings = REFUSAL_REMEDY_SETTINGS.vision_unavailable;

/**
 * The reviewed operator-remediable subset. Absence is deliberate: identity, tenant, policy and
 * validation denials are not listed merely because an administrator could weaken a gate.
 */
export const OPERATOR_REMEDIABLE_REFUSALS: Readonly<Record<OperatorRemediableRefusalCode, RefusalRemedy>> = Object.freeze({
  authorization_recorded_delegation_required: Object.freeze({
    settings: delegationSettings,
    remedy: `On the controller, set ${settingsList(DELEGATION_SIGNING_ENV_KEYS)}. On every bot node, set the matching ${DELEGATION_PUBLIC_KEY_ENV_KEY}. Restart the affected runtimes, then retry the protected dispatch.`,
  }),
  database_pool_unavailable: Object.freeze({
    settings: databaseSettings,
    remedy: `Set ${settingsList(databaseSettings)} to a reachable PostgreSQL DSN or restore that database, restart the affected runtime, then retry.`,
  }),
  encrypted_secret_storage_required: Object.freeze({
    settings: encryptionSettings,
    remedy: `Restore the deployment's existing ${settingsList(encryptionSettings)} (or set and retain a stable value on a fresh deployment), restart the API, then retry.`,
  }),
  graph_engine_unavailable: Object.freeze({
    settings: REFUSAL_REMEDY_SETTINGS.graph_engine_unavailable,
    remedy: `Set ${PLATFORM_SETTING_KEYS.graphUrl} to a reachable ArangoDB endpoint, restart the API, then retry the graph operation.`,
  }),
  guest_unavailable: Object.freeze({
    settings: guestSettings,
    remedy: `Set one of ${settingsList(guestSettings)} to a stable signing secret, restart the API, then start the guest session again.`,
  }),
  intake_unavailable: Object.freeze({
    settings: REFUSAL_REMEDY_SETTINGS.intake_unavailable,
    remedy: `Set ${PLATFORM_SETTING_KEYS.serviceSecret} on the controller API, restart the API, then retry the intake from the remote node.`,
  }),
  live_codex_auth_path_required: Object.freeze({
    settings: REFUSAL_REMEDY_SETTINGS.live_codex_auth_path_required,
    remedy: `Set ${PLATFORM_SETTING_KEYS.codexAuthSourcePath} to the controller-owned Codex auth.json target, ensure it is mounted writable, restart the API, then retry promotion.`,
  }),
  vision_unavailable: Object.freeze({
    settings: visionSettings,
    remedy: `Set ${PLATFORM_SETTING_KEYS.openRouterApiKey} on the controller API, restart the API, then retry image understanding.`,
  }),
});

/** @description Return the reviewed operator remedy for a stable refusal code, when one exists. */
export function remedyForRefusal(code: string): string | undefined {
  return (OPERATOR_REMEDIABLE_REFUSALS as Readonly<Record<string, RefusalRemedy>>)[code]?.remedy;
}
