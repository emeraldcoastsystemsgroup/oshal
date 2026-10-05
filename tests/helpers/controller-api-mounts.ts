/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Controller /api mount extraction and auth-posture classification, moved verbatim out of tests/unit/server-route-auth-inventory.spec.ts so the anonymous-route inventory and the signed-in (operator) route ratchet read the same mount table. Behaviour unchanged: string-aware comment stripping and the balanced-paren walk come from the shared security module; the classifier stays test-side so the runtime scanner and the CI guards remain independent checks.
 */

import {
  balancedCallArgs,
  isLimiterOnlyMiddleware,
  stripRouteSourceComments,
  type RegistrarSource,
} from '@/features/security';

/**
 * @description Parse the mount's leading path argument(s): a string literal or an array of
 * string literals. Non-literal first args (e.g. the commented-out express.static mount) yield [].
 * @param args - The mount's full argument text.
 * @returns Every literal path the mount claims.
 */
export function mountPaths(args: string): string[] {
  const lead = args.trimStart();
  const single = lead.match(/^(['"`])([^'"`]*)\1/);
  if (single) return [single[2]];
  if (lead.startsWith('[')) {
    const arr = lead.slice(0, lead.indexOf(']') + 1);
    return [...arr.matchAll(/(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
  }
  return [];
}

/** One extracted mount from a controller registrar. */
export interface Mount {
  file: string;
  method: string;
  paths: string[];
  args: string;
  line: number;
  mode: 'delegated-or-oidc' | 'service-or-oidc' | 'operator' | 'oidc' | 'limiter-only' | 'unguarded';
}

/**
 * @description Classify a mount's auth posture from its argument text (the manifest-route-auth
 * classifyMount idiom, widened): serviceSecretOr → service-or-oidc; requiresOperator → operator;
 * any requiresAuth (direct middleware OR passed into the route factory, which applies it
 * per-route — the /api/notify / claude-code-auth-routes pattern) → oidc; else unguarded.
 * @param args - The mount's full argument text.
 * @returns The posture.
 */
export function classifyMount(args: string): Mount['mode'] {
  if (isLimiterOnlyMiddleware(middlewareArgs(args))) return 'limiter-only';
  if (args.includes('delegatedUserRouteAuth')) return 'delegated-or-oidc';
  if (args.includes('serviceSecretOr')) return 'service-or-oidc';
  if (args.includes('requiresOperator')) return 'operator';
  if (args.includes('requiresAuth')) return 'oidc';
  return 'unguarded';
}

/** @description Return the registration text after its string/array path argument. */
export function middlewareArgs(args: string): string {
  const lead = args.trimStart();
  const single = lead.match(/^(['"`])([^'"`]*)\1/);
  if (single) return lead.slice(single[0].length).replace(/^\s*,/, '');
  if (!lead.startsWith('[')) return '';
  const close = lead.indexOf(']');
  if (close === -1) return '';
  return lead.slice(close + 1).replace(/^\s*,/, '');
}

/**
 * @description Extract every app.<method>(…) mount whose path starts with /api/ from one
 * controller registrar.
 * @param registrar - The registrar's repository-relative path and raw source.
 * @returns The classified /api mount inventory for that file.
 */
export function extractApiMounts(registrar: RegistrarSource): Mount[] {
  const stripped = stripRouteSourceComments(registrar.text);
  const mounts: Mount[] = [];
  const starts = /\bapp\.(use|get|post|put|patch|delete|all)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = starts.exec(stripped)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const args = balancedCallArgs(stripped, openIdx);
    if (args === null) continue;
    const paths = mountPaths(args).filter((p) => p.startsWith('/api/'));
    if (!paths.length) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    mounts.push({ file: registrar.file, method: m[1], paths, args, line, mode: classifyMount(args) });
  }
  return mounts;
}
