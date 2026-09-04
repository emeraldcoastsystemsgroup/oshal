/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 — deploy modes. Every posture this resolves already existed as an individual environment switch; what did not exist was anything that read the COMBINATION. A deployer sets a dozen unrelated variables and the dangerous combinations fail OPEN and silently: MOCK_OIDC makes requiresAuth a pass-through, REMOTE_CLIENT_REQUIRE_NODE_TOKEN ships false so the retired swarm-wide shared secret stays live, a stopped Headscale turns an off-LAN join request into a LAN-only code. This module is a pure function over the environment — no I/O, no singletons — so the mode table is testable as a table, which matters because the composition is the thing most likely to be got wrong. Generalizes the one precedent that already did this right: local-auth-routes throws at boot when LOCAL_AUTH and MOCK_OIDC are both set, rather than degrading to open auth. Unset mode resolves to the deployment's CURRENT behaviour and only advises — choosing a default here would silently re-posture every existing box, which is the exact failure the ADR exists to prevent.
 *
 * @module shared/deploy-mode
 */

/** The deployment shapes this project actually runs. */
export type DeployMode = 'demo' | 'home' | 'connected' | 'tenant';

/** How far the controller is meant to be reachable. */
export type NetworkReach = 'loopback' | 'lan' | 'overlay' | 'public';

/** What a mode asserts about the deployment. */
export interface DeployPosture {
  /** How far the controller should be reachable. */
  reach: NetworkReach;
  /** Whether open, unauthenticated access (MOCK_OIDC) is acceptable. */
  openAuthAllowed: boolean;
  /** Whether a real external identity provider is required. */
  requiresIdentityProvider: boolean;
  /** Whether machines other than this one may enrol as nodes. */
  remoteNodesAllowed: boolean;
  /** Whether an enrolled node must present a device-bound token. */
  requiresNodeToken: boolean;
  /** Whether the self-hosted overlay must be running for the mode to be coherent. */
  requiresOverlay: boolean;
  /** Whether more than one tenant's data may share the deployment. */
  multiTenant: boolean;
}

/** An explicit setting that loosens the mode. Legitimate, but never silent. */
export interface DeployDeviation {
  setting: string;
  value: string;
  note: string;
}

/** A combination the mode declares incoherent. Boot must refuse. */
export interface DeployViolation {
  setting: string;
  value: string;
  reason: string;
}

export interface ResolvedDeployment {
  /** The declared mode, or null when OSHAL_DEPLOY_MODE is unset. */
  mode: DeployMode | null;
  /** The mode that best describes what the environment is actually doing. */
  detected: DeployMode;
  posture: DeployPosture;
  deviations: DeployDeviation[];
  violations: DeployViolation[];
  /** True when no mode was declared — behaviour is unchanged and advice is logged. */
  advisory: boolean;
}

export const DEPLOY_MODES: readonly DeployMode[] = ['demo', 'home', 'connected', 'tenant'] as const;

/**
 * What each mode asserts. Read as a table on purpose: the composition is the
 * thing most likely to be got wrong, so it should be reviewable in one place.
 */
const MODE_POSTURE: Record<DeployMode, DeployPosture> = {
  demo: {
    reach: 'loopback',
    openAuthAllowed: true,
    requiresIdentityProvider: false,
    remoteNodesAllowed: false,
    requiresNodeToken: false,
    requiresOverlay: false,
    multiTenant: false,
  },
  home: {
    reach: 'lan',
    openAuthAllowed: false,
    requiresIdentityProvider: false,
    remoteNodesAllowed: true,
    requiresNodeToken: true,
    requiresOverlay: false,
    multiTenant: false,
  },
  connected: {
    reach: 'overlay',
    openAuthAllowed: false,
    requiresIdentityProvider: false,
    remoteNodesAllowed: true,
    requiresNodeToken: true,
    requiresOverlay: true,
    multiTenant: false,
  },
  tenant: {
    reach: 'public',
    openAuthAllowed: false,
    requiresIdentityProvider: true,
    remoteNodesAllowed: true,
    requiresNodeToken: true,
    requiresOverlay: false,
    multiTenant: true,
  },
};

/**
 * @description Read a boolean environment switch the way the rest of the codebase does.
 * @param raw - The raw environment value.
 * @returns True for the accepted truthy spellings.
 */
function flag(raw: string | undefined): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'on' || value === 'yes';
}

/**
 * @description The posture a mode asserts.
 * @param mode - The deployment mode.
 * @returns A copy of the mode's posture.
 */
export function postureFor(mode: DeployMode): DeployPosture {
  return { ...MODE_POSTURE[mode] };
}

/**
 * @description Parse a declared mode. An unrecognized value is a violation rather
 * than a fallback: silently treating `OSHAL_DEPLOY_MODE=prod` as unset would give a
 * deployer the impression they had declared a posture when they had not.
 * @param raw - The raw environment value.
 * @returns The mode, or null when unset, or 'invalid' when unrecognized.
 */
export function parseDeployMode(raw: string | undefined): DeployMode | null | 'invalid' {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  return (DEPLOY_MODES as readonly string[]).includes(value) ? (value as DeployMode) : 'invalid';
}

/**
 * @description Describe what the environment is actually doing, independent of what
 * it declared. Used to advise an undeclared deployment, and to make a declared one's
 * deviations concrete.
 * @param env - The environment to read.
 * @returns The mode that best matches the observed settings.
 */
export function detectMode(env: NodeJS.ProcessEnv): DeployMode {
  if (flag(env.MOCK_OIDC)) return 'demo';
  const hasIdp = Boolean(String(env.OIDC_ISSUER_BASE_URL || '').trim());
  if (hasIdp && !flag(env.LOCAL_AUTH)) return 'tenant';
  if (String(env.HEADSCALE_URL || '').trim()) return 'connected';
  return 'home';
}

/**
 * @description Collect the ways an environment contradicts or loosens its declared mode.
 * Kept separate from resolution so each rule is one readable statement.
 * @param mode - The declared mode.
 * @param posture - That mode's posture.
 * @param env - The environment to check.
 * @returns Violations (boot must refuse) and deviations (legitimate, but logged).
 */
function auditAgainstMode(
  mode: DeployMode,
  posture: DeployPosture,
  env: NodeJS.ProcessEnv,
): { violations: DeployViolation[]; deviations: DeployDeviation[] } {
  const violations: DeployViolation[] = [];
  const deviations: DeployDeviation[] = [];

  if (flag(env.MOCK_OIDC) && !posture.openAuthAllowed) {
    violations.push({
      setting: 'MOCK_OIDC',
      value: 'true',
      reason: `MOCK_OIDC makes every route publicly callable, which ${mode} mode does not permit`,
    });
  }
  if (flag(env.MOCK_OIDC) && flag(env.LOCAL_AUTH)) {
    violations.push({
      setting: 'LOCAL_AUTH',
      value: 'true',
      reason: 'LOCAL_AUTH and MOCK_OIDC are both enabled - pick one auth mode',
    });
  }
  if (posture.requiresIdentityProvider && !String(env.OIDC_ISSUER_BASE_URL || '').trim()) {
    violations.push({
      setting: 'OIDC_ISSUER_BASE_URL',
      value: '(unset)',
      reason: `${mode} mode serves more than one tenant and requires a real identity provider`,
    });
  }
  if (posture.requiresOverlay && !String(env.HEADSCALE_URL || '').trim()) {
    violations.push({
      setting: 'HEADSCALE_URL',
      value: '(unset)',
      reason: `${mode} mode exists to reach machines on other networks, which needs the overlay configured`,
    });
  }
  if (posture.multiTenant && !flag(env.MULTI_TENANT_ENABLED) && env.MULTI_TENANT_ENABLED !== undefined) {
    violations.push({
      setting: 'MULTI_TENANT_ENABLED',
      value: String(env.MULTI_TENANT_ENABLED),
      reason: 'tenant mode requires tenancy enforcement to be enabled',
    });
  }
  // Loosening: permitted, never silent. The shared secret is retired, so leaving
  // node tokens optional in a mode that expects them is a real weakening.
  if (posture.requiresNodeToken && !flag(env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN)) {
    deviations.push({
      setting: 'REMOTE_CLIENT_REQUIRE_NODE_TOKEN',
      value: String(env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN ?? '(unset)'),
      note: 'the retired swarm-wide shared secret still authenticates nodes; set true once every node has re-enrolled',
    });
  }
  if (!posture.remoteNodesAllowed && String(env.HEADSCALE_URL || '').trim()) {
    deviations.push({
      setting: 'HEADSCALE_URL',
      value: 'configured',
      note: `${mode} mode does not expect remote nodes; the overlay is configured anyway`,
    });
  }
  return { violations, deviations };
}

/**
 * @description Resolve a deployment's posture from its environment. Pure: no I/O,
 * no process state, no singleton. An UNSET mode returns the detected posture with
 * `advisory: true` and NO violations — behaviour is unchanged and the caller only
 * advises, because choosing a default here would silently re-posture every existing
 * deployment, which is the failure this whole mechanism exists to prevent.
 * @param env - The environment to resolve, defaulting to the process environment.
 * @returns The declared mode, the detected mode, the posture, deviations and violations.
 */
export function resolveDeployPosture(env: NodeJS.ProcessEnv = process.env): ResolvedDeployment {
  const parsed = parseDeployMode(env.OSHAL_DEPLOY_MODE);
  const detected = detectMode(env);

  if (parsed === 'invalid') {
    return {
      mode: null,
      detected,
      posture: postureFor(detected),
      deviations: [],
      violations: [{
        setting: 'OSHAL_DEPLOY_MODE',
        value: String(env.OSHAL_DEPLOY_MODE),
        reason: `unrecognized deploy mode; expected one of ${DEPLOY_MODES.join(', ')}`,
      }],
      advisory: false,
    };
  }

  if (parsed === null) {
    return {
      mode: null,
      detected,
      posture: postureFor(detected),
      deviations: [],
      violations: [],
      advisory: true,
    };
  }

  const posture = postureFor(parsed);
  const { violations, deviations } = auditAgainstMode(parsed, posture, env);
  return { mode: parsed, detected, posture, deviations, violations, advisory: false };
}

/**
 * @description One line an operator can read at boot to know what they are running,
 * naming the assertions rather than only the mode — a reassuring name is how an
 * incomplete promise gets believed.
 * @param resolved - The resolved deployment.
 * @returns A human-readable summary.
 */
export function describeDeployment(resolved: ResolvedDeployment): string {
  if (resolved.advisory) {
    return `deploy mode not declared - behaviour unchanged; this environment looks like '${resolved.detected}'. `
      + `Set OSHAL_DEPLOY_MODE to have the composition checked at boot.`;
  }
  const { posture } = resolved;
  const asserts = [
    `reach=${posture.reach}`,
    `openAuth=${posture.openAuthAllowed ? 'allowed' : 'refused'}`,
    `idp=${posture.requiresIdentityProvider ? 'required' : 'optional'}`,
    `remoteNodes=${posture.remoteNodesAllowed ? 'allowed' : 'refused'}`,
    `nodeToken=${posture.requiresNodeToken ? 'required' : 'optional'}`,
    `overlay=${posture.requiresOverlay ? 'required' : 'optional'}`,
    `multiTenant=${posture.multiTenant}`,
  ].join(' ');
  return `deploy mode '${resolved.mode}' - ${asserts}`;
}

/**
 * @description The error a boot should throw when the composition is incoherent.
 * Names the mode, every offending setting and why, because a refusal an operator
 * cannot act on just becomes a variable someone deletes.
 * @param resolved - The resolved deployment.
 * @returns The error, or null when the composition is coherent.
 */
export function deployViolationError(resolved: ResolvedDeployment): Error | null {
  if (!resolved.violations.length) return null;
  const detail = resolved.violations
    .map((violation) => `  - ${violation.setting}=${violation.value}: ${violation.reason}`)
    .join('\n');
  return new Error(
    `deploy mode '${resolved.mode ?? String(process.env.OSHAL_DEPLOY_MODE)}' rejects this environment:\n${detail}`,
  );
}
