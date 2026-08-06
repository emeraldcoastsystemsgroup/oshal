/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial strict-CSP builder, opt-in and returning `false` (no CSP at all) by default.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | DEFAULT POSTURE FLIP: cspFromEnv now returns the strict directive set in REPORT-ONLY mode by default instead of `false`, so every response actually carries a policy and the violation collector starts learning the real allowlist without an env act. Report-only is non-blocking by construction, so no surface can break; enforcement still requires OSHAL_STRICT_CSP=on, and OSHAL_CSP=off is the kill switch that restores "no header at all". Added cspMode (the three-way posture, one place), buildStrictCsp hardening (frame-src/worker-src/manifest-src/media-src + upgrade-insecure-requests, and object-src/base-uri/form-action pinned), and shouldLogCspReport — a bounded dedupe so report-only on a cockpit full of inline scripts cannot flood the log with the same violation. Guard: tests/unit/web-hardening-csp-body.spec.ts asserts the POLICY (directives + which header), not a string.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile inline guidance with the default report-only posture: operators observe the default (or pin it explicitly) before enforcement; cspFromEnv is the full three-mode wrapper, not an off-by-default opt-in wrapper.
 */

/**
 * Strict Content-Security-Policy builder.
 *
 * POSTURE, and why it changed. This module used to return `false` — no CSP header on any
 * response — because the cockpit still uses inline `<script>` and inline `style=`, and a naive
 * strict policy would break the surface. The cost of that caution was a control nobody could
 * observe: no header shipped, no violation was ever reported, and the "migrate off inline
 * scripts" plan below had no data to work from.
 *
 * The default is now the strict directive set in **report-only** mode. A report-only policy is
 * non-blocking by definition — the browser renders everything and merely POSTs what WOULD have
 * been refused — so this cannot break a surface, while making the policy real, provable, and
 * self-documenting through the violation collector. Enforcement stays an explicit operator act
 * (`OSHAL_STRICT_CSP=on`), and `OSHAL_CSP=off` restores the previous "no header" behaviour for
 * anyone who needs it.
 *
 * MIGRATION PATH off inline scripts (incremental, safe to do over several PRs):
 *  1. Observe the DEFAULT report-only mode first (optionally pin it with
 *     OSHAL_CSP_REPORT_ONLY=on during rollout). The browser does NOT block anything;
 *     it only reports violations to report-uri. Watch the reports to learn exactly
 *     which inline scripts/styles still exist.
 *  2. Move each inline <script>...</script> into an external .js file served from
 *     'self', OR stamp it with the per-request nonce (see nonce support below)
 *     so it is allowed under 'script-src'. Repeat until report-only is clean.
 *  3. For inline style="" attributes, move them to classes/stylesheets, or keep
 *     'unsafe-inline' on style-src ONLY (styles cannot exfiltrate data the way
 *     scripts can; this is a common, pragmatic compromise).
 *  4. Flip OSHAL_STRICT_CSP=on to enforce. Leave report-uri wired so regressions
 *     are still reported even while enforcing.
 *
 * Nonce support: when a nonce is supplied, script-src includes 'nonce-<value>'
 * instead of 'unsafe-inline', so inline scripts that carry a matching
 * <script nonce="..."> attribute run while un-nonced inline scripts are blocked.
 * Generate a fresh nonce per request in middleware and stamp it on the markup;
 * this file only builds the directive object.
 *
 * @module features/security/hardening/strict-csp
 */

/** Read a boolean-ish env flag. Defaults OFF so behavior never changes silently. */
function envOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[name] ?? 'off').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

/** Read a boolean-ish env flag meaning "switched off". */
function envOff(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  return v === 'off' || v === 'false' || v === '0' || v === 'no' || v === 'disabled';
}

/** The three CSP postures, in increasing strictness. */
export type CspMode = 'disabled' | 'report-only' | 'enforce';

/**
 * @description Resolves the CSP posture from the environment, in ONE place so the header
 * selection and every guard read the same rule:
 *   - `OSHAL_CSP=off`        -> 'disabled'    (kill switch: no header at all, the old default)
 *   - `OSHAL_STRICT_CSP=on`  -> 'enforce'     (blocking Content-Security-Policy)
 *   - anything else          -> 'report-only' (the DEFAULT: non-blocking, reports collected)
 *
 * `OSHAL_CSP_REPORT_ONLY=on` is still honoured as an explicit way to pin report-only even with
 * the enforce flag set, so a staged rollout can keep both variables in .env while flipping one.
 *
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns The active posture.
 */
export function cspMode(env: NodeJS.ProcessEnv = process.env): CspMode {
  if (envOff('OSHAL_CSP', env)) return 'disabled';
  if (envOn('OSHAL_CSP_REPORT_ONLY', env)) return 'report-only';
  return envOn('OSHAL_STRICT_CSP', env) ? 'enforce' : 'report-only';
}

/** Options for {@link buildStrictCsp}. */
export interface StrictCspOptions {
  /**
   * Per-request nonce. When set, inline scripts are allowed only via
   * 'nonce-<value>' (not blanket 'unsafe-inline'). Omit during the report-only
   * phase if you have not stamped nonces on the markup yet.
   */
  nonce?: string;
  /**
   * Keep 'unsafe-inline' on style-src. Styles cannot exfiltrate data the way
   * scripts can, so this is a common pragmatic compromise while inline style
   * attributes are still being migrated. Defaults true.
   */
  allowInlineStyles?: boolean;
  /**
   * Extra hosts to allow for connect-src (APIs, websockets/SSE the cockpit
   * talks to). 'self' is always included.
   */
  connectSrc?: string[];
  /** Extra hosts to allow for img-src (e.g. avatar/CDN hosts). */
  imgSrc?: string[];
  /** report-uri target for violation reports. Wire this in both phases. */
  reportUri?: string;
}

/**
 * Build a helmet contentSecurityPolicy directive object.
 *
 * The returned shape is what you pass as
 *   helmet({ contentSecurityPolicy: { directives: <this> } })
 * Use {@link cspFromEnv} for the full three-mode wrapper: report-only by default,
 * explicit enforcement, and an explicit no-header kill switch.
 */
export function buildStrictCsp(opts: StrictCspOptions = {}): Record<string, string[]> {
  const { nonce, allowInlineStyles = true, connectSrc = [], imgSrc = [], reportUri } = opts;

  const scriptSrc = ["'self'"];
  if (nonce) {
    scriptSrc.push(`'nonce-${nonce}'`);
    // strict-dynamic lets a nonced loader script pull in further scripts it
    // trusts, without each needing its own nonce. Safe to include only when a
    // nonce is present.
    scriptSrc.push("'strict-dynamic'");
  }

  const styleSrc = ["'self'"];
  if (allowInlineStyles) styleSrc.push("'unsafe-inline'");
  else if (nonce) styleSrc.push(`'nonce-${nonce}'`);

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    'style-src': styleSrc,
    'img-src': ["'self'", 'data:', 'blob:', ...imgSrc],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...connectSrc],
    // Framing: 'self' both ways — nobody else may frame us (clickjacking), and we frame only
    // our own surfaces (the cockpit embeds its own tool pages).
    'frame-ancestors': ["'self'"],
    'frame-src': ["'self'"],
    // Plugins/embeds have no legitimate use here and are a classic script-execution bypass.
    'object-src': ["'none'"],
    // Workers are same-origin plus blob: — the PWA service worker and any generated worker.
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'media-src': ["'self'", 'data:', 'blob:'],
    // <base href> rewriting would redirect every relative script/fetch to an attacker origin.
    'base-uri': ["'self'"],
    // Form posts cannot be redirected off-origin (credential exfiltration).
    'form-action': ["'self'"],
    // Any http:// subresource that slips into markup is fetched over https instead of failing
    // open — matters behind the cloudflared tunnel, where the origin hop is plain http.
    'upgrade-insecure-requests': [],
  };

  if (reportUri) directives['report-uri'] = [reportUri];

  return directives;
}

/** Result of {@link cspFromEnv}: a value ready to hand to helmet's option. */
export type CspHelmetValue =
  | false
  | { directives: Record<string, string[]>; reportOnly?: boolean; useDefaults?: boolean };

/**
 * @description Env-driven CSP selector — the value handed to helmet's
 * `contentSecurityPolicy` option. Posture comes from {@link cspMode}:
 *
 *  - 'disabled'    (OSHAL_CSP=off)        -> `false`: no CSP header at all.
 *  - 'report-only' (the DEFAULT)          -> the strict directive set on the NON-BLOCKING
 *                                            `Content-Security-Policy-Report-Only` header.
 *  - 'enforce'     (OSHAL_STRICT_CSP=on)  -> the same directives on the BLOCKING header.
 *
 * Pass a per-request nonce (from middleware) so inline scripts you have stamped can run.
 * Without a nonce, inline scripts are reported (report-only) or blocked (enforce) — which is
 * exactly the signal the migration path below needs.
 *
 * @param opts - Nonce / extra origins / report-uri overrides.
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns The helmet option value.
 * @example
 *   app.use(helmet({ contentSecurityPolicy: cspFromEnv() }));
 */
export function cspFromEnv(
  opts: StrictCspOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): CspHelmetValue {
  const mode = cspMode(env);
  if (mode === 'disabled') return false;

  return {
    directives: buildStrictCsp({
      ...opts,
      reportUri: opts.reportUri ?? env.OSHAL_CSP_REPORT_URI ?? DEFAULT_CSP_REPORT_URI,
    }),
    reportOnly: mode === 'report-only',
    // We supply a full directive set; do not merge helmet's defaults on top.
    useDefaults: false,
  };
}

/** Where violation reports go when the deployment names no other collector. */
export const DEFAULT_CSP_REPORT_URI = '/api/security/csp-report';

/** Bounded set of already-logged violation signatures (see {@link shouldLogCspReport}). */
const seenCspReports = new Set<string>();
/** Cap on distinct signatures held. Small: the whole point is a handful of real findings. */
const CSP_REPORT_SIGNATURE_CAP = 200;

/**
 * @description Whether a violation report is NEW enough to log. Report-only on a surface full
 * of inline scripts means every page load reports the same handful of violations from every
 * browser — logging each one buries real faults (the exact failure mode the education-serve-file
 * incident was: one orphaned client, 188 ERROR lines in 24h). Signature is
 * `directive|blockedUri|documentUri`, so each DISTINCT finding is logged once per process and
 * repeats are dropped. The set is capped and stops admitting new signatures past the cap rather
 * than growing without bound.
 * @param signature - The violation signature, built by the collector.
 * @returns True the first time a signature is seen; false thereafter.
 */
export function shouldLogCspReport(signature: string): boolean {
  const key = String(signature ?? '').slice(0, 500);
  if (seenCspReports.has(key)) return false;
  if (seenCspReports.size >= CSP_REPORT_SIGNATURE_CAP) return false;
  seenCspReports.add(key);
  return true;
}

/** Test-only: clears the dedupe memory so specs do not leak state into one another. */
export function resetCspReportDedupe(): void {
  seenCspReports.clear();
}
