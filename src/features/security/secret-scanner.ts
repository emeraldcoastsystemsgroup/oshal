/**
 * Secret scanner (posture) — Security Center (ADR-055).
 *
 * Walks the scan root (default: repo working dir) and flags credentials living in scannable
 * files. The strongest signal is whether the file is GIT-TRACKED: a live-looking key committed
 * to history is the worst case (it is in the [[oshal-committed-secrets]] / [[deals-repo-pii-incident]]
 * class of problem), so tracked hits are escalated and untracked-but-present hits are lower.
 *
 * Never stores the secret VALUE — evidence keeps a redacted preview (first/last few chars) only.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Stop fabricating "committed" when git is unavailable (the in-container scan root has no .git, so EVERY finding was labeled committed/critical — including gitignored config-seed files never in history). Tracked-ness is now three-state (true/false/unknown); unknown de-escalates and says so. Also: recognize *.test.* / *.spec.* as example files, skip AWS doc keys (…EXAMPLE) and bare identifier captures (KEYCLOAK_CLIENT_SECRET, type names) from the generic assignment rule.
 *
 * @module features/security/secret-scanner
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import type { RawFinding, ScannerReport, Severity } from './types';

const logger = createChildLogger({ module: 'security:secret-scanner' });

/** Directories never worth scanning (vendored / build / vcs / large binaries). */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache',
  'playwright-report', 'test-results', 'generated-diagrams', 'trash', '.codex-harness-runs',
  '.codex-tmp', 'output', 'output-local-agent', 'workspace', 'workspace-shared',
]);

/** Only scan files we can reasonably read as text. */
const SCAN_EXT = new Set([
  '.env', '.ts', '.js', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.sh', '.bat', '.ps1',
  '.md', '.txt', '.py', '.tf', '.toml', '.ini', '.cfg', '.conf', '.properties', '.xml',
]);

/** A credential signature. `kind` is the human label; `re` matches the secret. */
interface SecretRule {
  kind: string;
  re: RegExp;
  /** Base severity for a TRACKED hit; untracked drops one level. */
  base: Severity;
}

const RULES: SecretRule[] = [
  { kind: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g, base: 'critical' },
  { kind: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, base: 'critical' },
  { kind: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, base: 'critical' },
  { kind: 'Stripe live key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/g, base: 'critical' },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, base: 'critical' },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, base: 'high' },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, base: 'high' },
  { kind: 'Alpaca key id', re: /\b(?:PK|AK)[A-Z0-9]{16,}\b/g, base: 'high' },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, base: 'medium' },
  // Generic assignment of a long opaque value to a secret-ish key.
  { kind: 'Secret assignment', re: /(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?([A-Za-z0-9/+_=-]{20,})["']?/gi, base: 'high' },
];

/** Filenames/paths whose hits are almost certainly examples — heavily de-escalated. */
function looksLikeExample(rel: string): boolean {
  const l = rel.toLowerCase();
  return /\.(example|sample|template|dist|bak)\b/.test(l)
    || l.includes('.example') || l.endsWith('.md')
    || /\.(test|spec)\.[a-z]+$/.test(l) // co-located test files (redactor.test.ts fixtures are deliberate)
    || l.includes('/test') || l.includes('test/') || l.includes('__mocks__') || l.includes('fixtures');
}

/** Mask a matched value: keep a few edge chars, hide the middle. Never reveal the full secret. */
function redact(v: string): string {
  if (v.length <= 8) return `${v[0] ?? ''}***`;
  return `${v.slice(0, 4)}…${v.slice(-3)} (${v.length} chars)`;
}

function dropOne(sev: Severity): Severity {
  const order: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
  const i = order.indexOf(sev);
  return order[Math.max(0, i - 1)];
}

/**
 * git-tracked file set, rooted at `root`. Returns null when tracking info is UNAVAILABLE
 * (git missing, or the scan root is not a checkout — e.g. the container image, which is
 * built without .git). Callers must treat null as "unknown", never as "tracked": the old
 * assume-tracked fallback stamped every finding "committed (rotate AND scrub)" precisely
 * when there was no evidence for it.
 */
function trackedFiles(root: string): Set<string> | null {
  try {
    // stderr ignored: "not a git repository" is an expected outcome (container scan root), not log-worthy.
    const out = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const set = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\\/g, '/')));
    return set.size ? set : null;
  } catch {
    return null;
  }
}

function* walk(dir: string, root: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.git')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full, root, depth + 1);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      // .env / .env.local etc. have no "extension" by extname — match the basename too.
      if (SCAN_EXT.has(ext) || e.name.toLowerCase().startsWith('.env')) yield full;
    }
  }
}

/**
 * Scan `root` for committed/present credentials.
 * @param root - Directory to walk (defaults to SECURITY_SCAN_ROOT or process.cwd()).
 */
export function scanSecrets(root = process.env.SECURITY_SCAN_ROOT || process.cwd()): ScannerReport {
  const findings: RawFinding[] = [];
  let filesScanned = 0;
  const tracked = trackedFiles(root);
  try {
    for (const file of walk(root, root)) {
      let text: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > 2 * 1024 * 1024) continue; // skip files > 2MB
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      filesScanned++;
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const isExample = looksLikeExample(rel);
      const isTracked: boolean | null = tracked ? tracked.has(rel) : null; // null = unknown (no git checkout at scan root)
      const lines = text.split('\n');
      for (const rule of RULES) {
        for (let i = 0; i < lines.length; i++) {
          rule.re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = rule.re.exec(lines[i])) !== null) {
            const value = m[1] ?? m[0];
            if (!value || value.length < 12) continue;
            // Skip obvious placeholders.
            if (/^(your|example|changeme|xxx+|placeholder|dummy|test[_-]?key|<.*>|\$\{)/i.test(value)) continue;
            // AWS reserves the EXAMPLE suffix for documentation keys (AKIAIOSFODNN7EXAMPLE).
            if (/EXAMPLE$/.test(value)) continue;
            // The generic assignment rule captures identifier NAMES (KEYCLOAK_CLIENT_SECRET,
            // GoogleAccessTokenProvider, facebookAccessToken) — a pure letters/underscore
            // capture is a reference to a secret, not the secret itself.
            if (/^[A-Za-z_]+$/.test(value)) continue;
            let sev = rule.base;
            if (isTracked !== true) sev = dropOne(sev); // only a PROVEN committed hit keeps base severity
            if (isExample) sev = dropOne(dropOne(sev));
            const trackedNote = isTracked === true
              ? ', and the file is git-tracked (committed). If the value is real it is exposed to anyone with repo access and must be rotated AND scrubbed from history.'
              : isTracked === false
                ? ' (file not git-tracked). If the value is real, keep it out of version control and rotate it if it was ever shared.'
                : '. Git-tracked status is UNKNOWN — the scan root is not a git checkout (e.g. running inside the container image), so committed-or-not could not be verified. Check `git ls-files` / `git log` for this path from a real checkout; if the value is real, rotate it.';
            findings.push({
              category: 'secret',
              severity: sev,
              title: `${rule.kind} in ${rel}`,
              detail: isExample
                ? `A ${rule.kind} pattern appears in ${rel} (line ${i + 1}). This looks like an example/test/template file, so it is likely benign — confirm it is not a real value.`
                : `A ${rule.kind} pattern appears in ${rel} (line ${i + 1})${trackedNote}`,
              source: `${rel}:${i + 1}`,
              evidence: { file: rel, line: i + 1, kind: rule.kind, preview: redact(value), committed: isTracked, exampleFile: isExample },
              fingerprint: `secret:${rel}:${i + 1}:${rule.kind}`,
            });
            if (rule.re.lastIndex === m.index) rule.re.lastIndex++; // guard zero-width
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'secret scan failed');
    return { kind: 'posture', available: false, findings, categories: ['secret'], note: `secret scan error: ${(err as Error).message}` };
  }
  return {
    kind: 'posture',
    available: true,
    findings,
    categories: ['secret'],
    note: `scanned ${filesScanned} files under ${root}${tracked ? ` (${tracked.size} git-tracked)` : ' (no git checkout at scan root; tracked-status unknown)'}`,
  };
}
