/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127: ONE definition of "this deployment is a demo". Three call sites need it — the controller's key-lending lane, brain resolution, and the bot node's SEC-05 preflight — and the node cannot import a controller route, so without a shared home the predicate would exist in three copies that can drift apart. It gates real credentials; drift here is a security defect, not a style one.
 * 2 | Codex                                      | Add an explicit Codex-only demo-user allowlist, separate from operator RBAC. Customer demo users may share the deployment's mounted Codex brain without gaining Security Center, cross-user, other operator privileges, or access to other CLI subscriptions; DEMO_MODE and an exact subject match remain mandatory.
 */

/**
 * @description True when this deployment runs as a demo (ADR-127): it may lend its own hosted keys
 * and, for its operator, its mounted CLI logins to a turn.
 *
 * Reads `DEMO_MODE` and NOTHING else. In particular it never reads `MOCK_OIDC`, unlike
 * `shouldSeedDemoData` — mock auth is a local-testing convenience, and a convenience flag must not
 * be able to unlock a real subscription or a metered vendor key.
 * @returns true when DEMO_MODE is explicitly truthy (`1` / `true` / `yes` / `on`, case-insensitive)
 */
export function demoModeEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env.DEMO_MODE || '').trim().toLowerCase());
}

/**
 * @description True when this exact subject is a configured operator of the deployment. Exact and
 * case-sensitive on the OIDC subject — only the delimiters are trim-tolerant — so a case or
 * whitespace variant never inherits operator privilege.
 * @param userSub - the subject to test
 * @returns true when the subject is listed in OSHAL_OPERATOR_SUBS
 */
export function isDeploymentOperatorSub(userSub: unknown): boolean {
  if (typeof userSub !== 'string' || !userSub.trim()) return false;
  return (process.env.OSHAL_OPERATOR_SUBS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .includes(userSub);
}

/**
 * @description Whether this exact authenticated subject may use the requested mounted CLI provider
 * on a demo box. Operators retain the original ADR-127 lane for every CLI. A deployment may
 * additionally list customer-demo subjects in OSHAL_DEMO_CLI_SUBS; those users are restricted to
 * Codex aliases and gain no operator privilege. DEMO_MODE is still required, so a copied
 * production environment cannot lend the shared subscription accidentally.
 * @param providerName - the resolved CLI provider id
 * @param userSub - the request's canonical authenticated subject
 * @returns true only for an admissible provider and exact subject while DEMO_MODE is enabled
 */
export function isDemoCliProviderAllowed(providerName: unknown, userSub: unknown): boolean {
  if (!demoModeEnabled() || typeof userSub !== 'string' || !userSub.trim()) return false;
  if (isDeploymentOperatorSub(userSub)) return true;
  const provider = typeof providerName === 'string' ? providerName.trim().toLowerCase() : '';
  if (!['codex', 'codex-cli', 'openai-codex'].includes(provider)) return false;
  return (process.env.OSHAL_DEMO_CLI_SUBS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .includes(userSub);
}
