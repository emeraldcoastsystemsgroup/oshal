/**
 * Data-Loss-Prevention (DLP) egress redactor.
 *
 * OSHAL acts across a user's real life (bank, email, trading, jobs) and sends context to external
 * LLMs and connectors. DLP is the boundary control that detects sensitive values in OUTBOUND text
 * and either masks or blocks them before they leave the box. This is the content-egress half of the
 * governance layer (the broker/OPA half is the access decision in ../policy).
 *
 * Deterministic + dependency-free: pure regex/heuristic detectors, no model calls. Detectors aim
 * for low false-positives (credit cards are Luhn-validated) and are intentionally conservative —
 * DLP that cries wolf gets turned off. OFF BY DEFAULT (`OSHAL_DLP_MODE` unset => 'off' => passthrough).
 *
 * @module features/governance/dlp/redactor
 */

/** What kind of sensitive value a finding represents. */
export type DlpKind =
  | 'email'
  | 'ssn'
  | 'credit_card'
  | 'aws_access_key'
  | 'private_key'
  | 'jwt'
  | 'bearer_token'
  | 'us_phone';

/** Egress handling mode. */
export type DlpMode = 'off' | 'mask' | 'block';

/** One detected sensitive span. */
export interface DlpFinding {
  kind: DlpKind;
  /** The matched text (kept for masking/length; callers should NOT log this). */
  match: string;
  index: number;
}

export interface DlpResult {
  /** Text after masking (identical to input in 'off' mode or when nothing matched). */
  redacted: string;
  findings: DlpFinding[];
  /** True only in 'block' mode when at least one finding was present. */
  blocked: boolean;
  mode: DlpMode;
}

const TRUTHY = ['mask', 'block'];

/** @description Resolve the egress DLP mode from env. Default 'off' (passthrough). */
export function dlpMode(env: NodeJS.ProcessEnv = process.env): DlpMode {
  const v = (env.OSHAL_DLP_MODE ?? '').toLowerCase().trim();
  return (TRUTHY.includes(v) ? v : 'off') as DlpMode;
}

// --- detectors ---------------------------------------------------------------
// Order matters only for overlapping patterns; we run all and sort by index.
interface Detector {
  kind: DlpKind;
  re: RegExp;
  /** Optional extra validation to cut false positives (e.g. Luhn for cards). */
  valid?: (m: string) => boolean;
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const DETECTORS: Detector[] = [
  { kind: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: 'credit_card', re: /\b(?:\d[ -]*?){13,19}\b/g, valid: luhnValid },
  { kind: 'us_phone', re: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g },
];

/**
 * @description Scan text for sensitive values. Returns findings sorted by position. Pure; does not
 * mutate input. Overlapping matches are de-duplicated by keeping the earliest-starting, longest one.
 */
export function scanText(text: string): DlpFinding[] {
  if (!text) return [];
  const raw: DlpFinding[] = [];
  for (const det of DETECTORS) {
    det.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = det.re.exec(text)) !== null) {
      const match = m[0];
      if (det.valid && !det.valid(match)) continue;
      raw.push({ kind: det.kind, match, index: m.index });
      if (m.index === det.re.lastIndex) det.re.lastIndex++; // guard zero-width
    }
  }
  raw.sort((a, b) => a.index - b.index || b.match.length - a.match.length);
  // Drop findings fully contained within an earlier finding's span (e.g. an email inside a token).
  const kept: DlpFinding[] = [];
  let coveredUntil = -1;
  for (const f of raw) {
    if (f.index < coveredUntil) continue;
    kept.push(f);
    coveredUntil = f.index + f.match.length;
  }
  return kept;
}

/** @description Mask a finding's value as a typed placeholder, preserving a hint of length. */
function maskToken(kind: DlpKind): string {
  return `[REDACTED:${kind}]`;
}

/**
 * @description Apply egress DLP to text. In 'off' mode returns the text unchanged. In 'mask' mode
 * replaces every finding with a typed placeholder. In 'block' mode, if any finding exists, returns
 * `blocked:true` and a fully-masked body (so a caller can refuse the egress and still log safely).
 *
 * @param text The outbound text.
 * @param env Environment (injectable for tests).
 */
export function redactEgress(text: string, env: NodeJS.ProcessEnv = process.env): DlpResult {
  const mode = dlpMode(env);
  if (mode === 'off' || !text) {
    return { redacted: text, findings: [], blocked: false, mode };
  }
  const findings = scanText(text);
  if (findings.length === 0) {
    return { redacted: text, findings, blocked: false, mode };
  }
  // Build masked text by replacing spans from right to left (so indices stay valid).
  let redacted = text;
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i];
    redacted = redacted.slice(0, f.index) + maskToken(f.kind) + redacted.slice(f.index + f.match.length);
  }
  return { redacted, findings, blocked: mode === 'block', mode };
}
