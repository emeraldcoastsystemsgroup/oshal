/**
 * Strict Content-Security-Policy builder (additive hardening, off by default).
 *
 * GROUND TRUTH: today the app ships with CSP DISABLED in src/app/server.ts:
 *   app.use(helmet({ contentSecurityPolicy: false }));
 * That is intentional, because the cockpit UI still uses inline <script> and
 * inline style attributes, and a naive strict CSP would break the surface.
 *
 * This module does NOT change that default. It provides an opt-in path so an
 * operator can turn on a strict CSP (or a non-blocking report-only CSP) once the
 * inline scripts have been migrated, without anyone editing this file.
 *
 * MIGRATION PATH off inline scripts (incremental, safe to do over several PRs):
 *  1. Turn on REPORT-ONLY mode first (OSHAL_CSP_REPORT_ONLY=on). The browser
 *     does NOT block anything; it only reports violations to report-uri. Watch
 *     the reports to learn exactly which inline scripts/styles still exist.
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
function envOn(name: string): boolean {
  const v = (process.env[name] ?? 'off').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
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
 * Use {@link cspFromEnv} for the full opt-in wrapper that also honours the
 * off-by-default flag and the report-only flag.
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
    'frame-ancestors': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };

  if (reportUri) directives['report-uri'] = [reportUri];

  return directives;
}

/** Result of {@link cspFromEnv}: a value ready to hand to helmet's option. */
export type CspHelmetValue =
  | false
  | { directives: Record<string, string[]>; reportOnly?: boolean; useDefaults?: boolean };

/**
 * Env-driven CSP selector, preserving today's behavior by default.
 *
 *  - OSHAL_STRICT_CSP unset/off  -> returns `false` (helmet CSP disabled; current behavior).
 *  - OSHAL_STRICT_CSP on         -> returns a strict directive set.
 *  - OSHAL_CSP_REPORT_ONLY on    -> returns it in report-only mode (browser does
 *                                   not block, only reports). Use this FIRST.
 *
 * Pass a per-request nonce (from middleware) so inline scripts you have stamped
 * can run. Without a nonce, inline scripts are blocked under strict mode.
 *
 * @example
 *   // in server.ts, replacing helmet({ contentSecurityPolicy: false }):
 *   app.use(helmet({ contentSecurityPolicy: cspFromEnv() }));
 */
export function cspFromEnv(opts: StrictCspOptions = {}): CspHelmetValue {
  if (!envOn('OSHAL_STRICT_CSP')) return false; // unchanged default behavior

  return {
    directives: buildStrictCsp({
      ...opts,
      reportUri: opts.reportUri ?? process.env.OSHAL_CSP_REPORT_URI,
    }),
    reportOnly: envOn('OSHAL_CSP_REPORT_ONLY'),
    // We supply a full directive set; do not merge helmet's defaults on top.
    useDefaults: false,
  };
}
