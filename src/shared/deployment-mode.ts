/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127: ONE definition of "this deployment is a demo". Three call sites need it — the controller's key-lending lane, brain resolution, and the bot node's SEC-05 preflight — and the node cannot import a controller route, so without a shared home the predicate would exist in three copies that can drift apart. It gates real credentials; drift here is a security defect, not a style one.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The environment is a parameter (default process.env) and deploymentOperatorSubs lists the configured operators: world classify decides its accountable owner from these same two facts, and a second private parse of DEMO_MODE / OSHAL_OPERATOR_SUBS is exactly the copy this module exists to prevent.
 */

/**
 * @description True when this deployment runs as a demo (ADR-127): it may lend its own hosted keys
 * and, for its operator, its mounted CLI logins to a turn.
 *
 * Reads `DEMO_MODE` and NOTHING else. In particular it never reads `MOCK_OIDC`, unlike
 * `shouldSeedDemoData` — mock auth is a local-testing convenience, and a convenience flag must not
 * be able to unlock a real subscription or a metered vendor key.
 * @param env - Environment to read (default: this process's).
 * @returns true when DEMO_MODE is explicitly truthy (`1` / `true` / `yes` / `on`, case-insensitive)
 */
export function demoModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env.DEMO_MODE || '').trim().toLowerCase());
}

/**
 * @description The deployment's configured operator subjects, in configuration order. Exact and
 * case-sensitive on each OIDC subject — only the delimiters are trim-tolerant.
 * @param env - Environment to read (default: this process's).
 * @returns The subjects listed in OSHAL_OPERATOR_SUBS (empty when none).
 */
export function deploymentOperatorSubs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OSHAL_OPERATOR_SUBS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * @description True when this exact subject is a configured operator of the deployment. Exact and
 * case-sensitive on the OIDC subject — only the delimiters are trim-tolerant — so a case or
 * whitespace variant never inherits operator privilege.
 * @param userSub - the subject to test
 * @param env - Environment to read (default: this process's).
 * @returns true when the subject is listed in OSHAL_OPERATOR_SUBS
 */
export function isDeploymentOperatorSub(userSub: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof userSub !== 'string' || !userSub.trim()) return false;
  return deploymentOperatorSubs(env).includes(userSub);
}
