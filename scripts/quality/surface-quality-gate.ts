/**
 * Product-quality gate for rendered app surfaces — the "stop false greens" layer.
 *
 * The competitive proof harness can call a surface "green" when a route returns 200 and the
 * page renders. That let broken-but-rendering screens (raw JSON envelopes, missing shared
 * stylesheet, console errors, blank bodies, leaked error stacks) pass as done. This module is
 * a PURE evaluator over what a headless capture already has (final HTML + console errors +
 * HTTP status), so a live validator can fail those screens instead of passing them.
 *
 * It is deliberately dependency-free and side-effect-free: given the captured inputs it returns
 * a verdict, so it is trivially unit-testable and can be wired into
 * scripts/validate-app-surfaces-docker.mjs (or any Playwright capture) without a browser.
 */

export interface SurfaceQualityInput {
  /** Surface URL/label, for reporting. */
  url: string;
  /** Final rendered HTML (documentElement.outerHTML or response body). */
  html: string;
  /** Console errors captured during load (page.on('console', ... type === 'error')). */
  consoleErrors?: string[];
  /** HTTP status of the top-level navigation, if known. */
  status?: number;
}

export type SurfaceQualitySeverity = 'fail' | 'warn';

export interface SurfaceQualityFinding {
  rule: string;
  severity: SurfaceQualitySeverity;
  detail: string;
}

export interface SurfaceQualityResult {
  url: string;
  passed: boolean;
  findings: SurfaceQualityFinding[];
}

/** Strip scripts/styles/tags to the human-visible text, whitespace-collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeJsonEnvelope(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  // Cheap structural check first, then confirm it actually parses as JSON.
  if (!/["}]\s*$/.test(t)) return false;
  try {
    const parsed = JSON.parse(t);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

const ERROR_STACK_PATTERNS: RegExp[] = [
  /\bat\s+[\w$.<>[\] ]+\s+\([^)]*:\d+:\d+\)/, // JS stack frame: at fn (file.js:12:5)
  /\bat\s+[^\s]+:\d+:\d+/, // anonymous frame: at file.js:12:5
  /Traceback \(most recent call last\)/, // python
  /(TypeError|ReferenceError|SyntaxError|RangeError):\s/, // thrown error banner
  /Cannot read propert(y|ies) of (undefined|null)/,
];

const SHARED_CSS_MARKERS = ['surface-glass.css', '/shared/ui/css/', 'design-system', 'ecsg', 'cockpit-theme'];

/**
 * Evaluate one captured surface. `passed` is true when there are zero `fail` findings
 * (warnings do not fail the gate).
 */
export function evaluateSurfaceQuality(input: SurfaceQualityInput): SurfaceQualityResult {
  const findings: SurfaceQualityFinding[] = [];
  const html = input.html ?? '';
  const text = visibleText(html);

  if (typeof input.status === 'number' && input.status >= 400) {
    findings.push({ rule: 'http-error', severity: 'fail', detail: `HTTP ${input.status}` });
  }

  if (looksLikeJsonEnvelope(html) || looksLikeJsonEnvelope(text)) {
    findings.push({ rule: 'raw-json-envelope', severity: 'fail', detail: 'raw JSON is shown to the user instead of a UI' });
  }

  // Test against the visible text, not raw html, so a stack-trace string literal inside a
  // <script> (not shown to the user) does not trip the gate.
  const stackHit = ERROR_STACK_PATTERNS.find((re) => re.test(text));
  if (stackHit) {
    findings.push({ rule: 'error-stack', severity: 'fail', detail: `leaked error/stack trace (${stackHit.source.slice(0, 40)})` });
  }

  const consoleErrors = input.consoleErrors ?? [];
  if (consoleErrors.length > 0) {
    findings.push({ rule: 'console-errors', severity: 'fail', detail: `${consoleErrors.length} console error(s): ${consoleErrors[0]}` });
  }

  const hasStylesheetLink = /<link[^>]+rel=["']?stylesheet/i.test(html);
  const hasInlineStyle = /<style[\s>]/i.test(html);
  const hasBodyContent = text.length >= 20;

  if (hasBodyContent && !hasStylesheetLink && !hasInlineStyle) {
    findings.push({ rule: 'unstyled', severity: 'fail', detail: 'no stylesheet loaded (broken CSS/MIME or unstyled surface)' });
  }

  if (!hasBodyContent && findings.length === 0) {
    findings.push({ rule: 'blank-surface', severity: 'fail', detail: 'blank/empty surface (no visible content)' });
  }

  // Warn (does not fail): a surface that loads CSS but not the shared theme drifts from the
  // cockpit look and usually skips the theme bridge.
  if (hasStylesheetLink) {
    const usesShared = SHARED_CSS_MARKERS.some((marker) => html.toLowerCase().includes(marker.toLowerCase()));
    if (!usesShared) {
      findings.push({ rule: 'missing-shared-css', severity: 'warn', detail: 'no shared glass/theme stylesheet referenced' });
    }
  }

  return {
    url: input.url,
    passed: !findings.some((finding) => finding.severity === 'fail'),
    findings,
  };
}

/** Summarize a batch of surface verdicts (for a validator's rollup). */
export function summarizeSurfaceQuality(results: SurfaceQualityResult[]): {
  total: number;
  passed: number;
  failed: number;
  warned: number;
  failingUrls: string[];
} {
  const failed = results.filter((r) => !r.passed);
  const warned = results.filter((r) => r.passed && r.findings.some((f) => f.severity === 'warn'));
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: failed.length,
    warned: warned.length,
    failingUrls: failed.map((r) => r.url),
  };
}
