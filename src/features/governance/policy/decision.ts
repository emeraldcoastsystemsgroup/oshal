/**
 * Policy decision point (PDP) for the data-access broker — the OPA-shaped "valve" between the
 * reasoning layer and a user's personal data (ADR-056). Every brokered data pull / connector action
 * should be checked here BEFORE the deterministic broker executes it. Today this ships a local,
 * deterministic evaluator that encodes OSHAL's ownership rules; the {@link PolicyEvaluator} interface
 * is the seam where a real OPA sidecar (HTTP bundle eval) drops in later with no caller changes.
 *
 * Decision model:
 *   - Operators bypass ownership (consistent with authz.canAccessResource / RBAC admin).
 *   - A caller may act on resources they own (subjectSub === ownerSub).
 *   - `sensitive` data classes additionally require ownership or operator — never granted to a
 *     non-owner even if some coarse role would otherwise allow it.
 *   - Unknown/҂missing identity → deny (fail closed) when enforcement is on.
 *   - Enforcement is OFF by default (`OSHAL_POLICY_ENFORCE`): evaluate() returns allow with a
 *     'enforcement-off' reason, so merging changes nothing until opted in.
 *
 * Pure + deterministic: no IO, no env writes. Obligations (e.g. 'redact-egress', 'audit') are
 * returned for the caller to honor, decoupling the decision from its side effects.
 *
 * @module features/governance/policy/decision
 */

/** Sensitivity of the data/resource being acted on. */
export type DataClass = 'public' | 'internal' | 'sensitive';

/** The question posed to the PDP. */
export interface PolicyInput {
  /** OIDC sub of the caller, or null when unauthenticated/system. */
  subjectSub: string | null;
  /** Whether the caller is an operator/admin. */
  isOperator: boolean;
  /** Verb, e.g. 'data.read', 'data.write', 'connector.invoke'. */
  action: string;
  /** Resource class, e.g. 'vault', 'ticket', 'connector'. */
  resourceType: string;
  /** Owner of the target resource, when known. */
  ownerSub?: string | null;
  /** Data sensitivity; defaults to 'internal' when unknown. */
  dataClass?: DataClass;
}

/** The PDP's answer. */
export interface PolicyDecision {
  allow: boolean;
  /** Short machine-ish reason, useful for audit + debugging. */
  reason: string;
  /** Actions the caller must perform when allowed (e.g. 'audit', 'redact-egress'). */
  obligations: string[];
}

/** The pluggable decision interface — local default today, OPA sidecar tomorrow. */
export interface PolicyEvaluator {
  evaluate(input: PolicyInput): PolicyDecision;
}

/** @description Is broker policy enforcement on? Default OFF → permissive. */
export function policyEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OSHAL_POLICY_ENFORCE ?? 'false').toLowerCase().trim() === 'true';
}

function decision(allow: boolean, reason: string, obligations: string[] = []): PolicyDecision {
  return { allow, reason, obligations };
}

/**
 * The default in-process policy. Mirrors the deterministic rules used elsewhere in the codebase so
 * the broker's decisions are consistent with RLS + RBAC + canAccessResource.
 */
export class LocalPolicyEvaluator implements PolicyEvaluator {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  evaluate(input: PolicyInput): PolicyDecision {
    // Always audit a brokered decision; that obligation holds regardless of enforcement.
    const baseObligations = ['audit'];

    if (!policyEnforced(this.env)) {
      return decision(true, 'enforcement-off', baseObligations);
    }

    const dataClass: DataClass = input.dataClass ?? 'internal';
    // Egress-bearing reads of sensitive data must be redacted by the caller.
    const obligations = dataClass === 'sensitive' ? [...baseObligations, 'redact-egress'] : baseObligations;

    // Operators bypass ownership (but still carry obligations).
    if (input.isOperator) {
      return decision(true, 'operator-bypass', obligations);
    }

    // Fail closed on no identity.
    if (!input.subjectSub) {
      return decision(false, 'no-identity', baseObligations);
    }

    const owns = !!input.ownerSub && input.ownerSub === input.subjectSub;

    // Sensitive data: owner-only (operators handled above).
    if (dataClass === 'sensitive') {
      return owns
        ? decision(true, 'owner-sensitive', obligations)
        : decision(false, 'sensitive-requires-owner', baseObligations);
    }

    // Owned resource → allow.
    if (owns) {
      return decision(true, 'owner', obligations);
    }

    // Unowned (legacy/system) resource → allow internal/public reads but never writes.
    if (input.ownerSub == null) {
      const isWrite = /\.(write|delete|update|invoke)$/.test(input.action);
      return isWrite
        ? decision(false, 'unowned-write-denied', baseObligations)
        : decision(true, 'unowned-read', obligations);
    }

    // Someone else's resource → deny.
    return decision(false, 'not-owner', baseObligations);
  }
}

/** Convenience singleton over process.env. */
export const defaultPolicyEvaluator = new LocalPolicyEvaluator();

/** @description Evaluate with the default local policy. */
export function evaluatePolicy(input: PolicyInput, env: NodeJS.ProcessEnv = process.env): PolicyDecision {
  return new LocalPolicyEvaluator(env).evaluate(input);
}
