/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the 07-15 event-loop-wedge class (BACKLOG "career-hunter scoring on a bot-node" interim + the 2026-07-19 sweep): NO synchronous child_process (spawnSync/execSync/execFileSync) may be used by modules that load into the api process. A single sync spawn blocks the ENTIRE Node event loop for its whole run — /health dead, all loopback timed out, container Up-but-unhealthy (the 2026-07-15 outage: one career /run/score froze the front end ~76 min). Fixed callers: apply-submit + apply-ingest (60/30/20s spawns), security dependency/trivy scanners (90s/15min execFileSync from POST /scan), trading-strategy-lab-ops buildSha (execSync). Files with a legitimate reason live in the explicit allowlist below, each with the reason in a comment.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Explicit 120s timeout on the full-src/ walk test: the readdirSync/readFileSync sweep of ~1200 files legitimately exceeds vitest's default 5s on a loaded box — it timed out in the first trunk ci-local --head run (2026-07-23), redding the unit gate with no product defect. A gate that reds on a healthy tree trains people to ignore red.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** Trees whose modules load into the api process (src/app/server.ts import graph + features/shared/entities). */
const SCANNED_TREES = ['src'];

/**
 * Files allowed to use sync child_process, each WITH the reason. Adding a file here requires the
 * same justification discipline: it must NOT be reachable from an api-process request path, or its
 * call must be provably bounded to a one-shot sub-50ms probe. Paths are repo-relative, forward-slash.
 */
const ALLOWLIST: Record<string, string> = {
  // Dev-console self-edit runtime: runs on the HOST dev-node process (scripts/dev-node.ts). The
  // containerized api has no .git, builds no manager, and PROXIES /api/dev-console/sessions to the
  // dev-node (see dev-console-routes.ts proxyDevNode). Only a host-checkout dev run of server.ts
  // executes it in-process — superadmin-gated dev tooling, not a request-path on deployments.
  'src/features/dev-console/services/dev-session-engine.ts': 'dev-node/host runtime; production api proxies',
  'src/features/dev-console/services/sandboxed-agent-runner.ts': 'dev-node/host runtime; production api proxies',
  // Secret scanner: ONE bounded `git ls-files` (~100ms, stdio ignored) at scan start; the scanner
  // itself is a deliberately synchronous CPU-bound tree walk (readdirSync/readFileSync) — going
  // async on the exec gains nothing while the walk still holds the loop. Long shell-outs in the
  // security suite (npm audit 90s, trivy 15min) ARE async — see dependency-scanner/trivy-scanner.
  'src/features/security/secret-scanner.ts': 'one bounded ~100ms git ls-files; walk is CPU-bound sync by design',
};

/** import/require of a sync child_process API, or a direct call. Comment mentions without a call
 *  paren (e.g. "was spawnSync —") deliberately do NOT match. */
const SYNC_SPAWN_CALL = /\b(?:spawnSync|execSync|execFileSync)\s*\(/;
const SYNC_SPAWN_IMPORT = /import\s*(?:type\s*)?\{[^}]*\b(?:spawnSync|execSync|execFileSync)\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/;
const SYNC_SPAWN_REQUIRE = /require\(\s*['"](?:node:)?child_process['"]\s*\)/;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) yield full;
  }
}

function rel(p: string): string {
  return path.relative(REPO_ROOT, p).replace(/\\/g, '/');
}

describe('no sync child_process on the api event loop (07-15 wedge-class guard)', () => {
  // 120s: this test walks and reads every source file under src/ (~1200 files). On a loaded box
  // that legitimately exceeds vitest's default 5s testTimeout — it did in the first trunk
  // ci-local --head run (2026-07-23) — and a slow walk is not the defect this guard exists to catch.
  it('src/** has no spawnSync/execSync/execFileSync outside the justified allowlist', { timeout: 120_000 }, () => {
    const offenders: string[] = [];
    for (const tree of SCANNED_TREES) {
      for (const file of walk(path.join(REPO_ROOT, tree))) {
        const relPath = rel(file);
        if (ALLOWLIST[relPath]) continue;
        const src = fs.readFileSync(file, 'utf8');
        const hasCall = SYNC_SPAWN_CALL.test(src);
        const hasImport = SYNC_SPAWN_IMPORT.test(src);
        // require('child_process') alone is fine when only async members are read off it; flag it
        // only together with a sync call so CommonJS callers can't dodge the guard.
        if (hasImport || (hasCall && (SYNC_SPAWN_REQUIRE.test(src) || /child_process/.test(src)))) {
          offenders.push(relPath);
        }
      }
    }
    expect(
      offenders,
      `Sync child_process in api-process module(s): ${offenders.join(', ')}. A sync spawn blocks the WHOLE api event loop `
      + '(the 2026-07-15 ~76-min front-end outage). Use async spawn/execFile + await (see runApplyCli in src/app/apply-submit.ts '
      + 'or defaultRun in src/features/security/trivy-scanner.ts), or add an allowlist entry WITH a justification comment.',
    ).toEqual([]);
  });

  it('every allowlist entry still exists and still uses sync child_process (no stale rows)', () => {
    for (const [relPath, reason] of Object.entries(ALLOWLIST)) {
      const full = path.join(REPO_ROOT, relPath);
      expect(fs.existsSync(full), `allowlisted file missing: ${relPath} (${reason}) — remove the stale entry`).toBe(true);
      const src = fs.readFileSync(full, 'utf8');
      expect(
        SYNC_SPAWN_CALL.test(src) || SYNC_SPAWN_IMPORT.test(src),
        `allowlisted file no longer uses sync child_process: ${relPath} — remove the stale entry`,
      ).toBe(true);
    }
  });

  it('the converted callers stay converted (async spawn present, sync gone)', () => {
    const converted = [
      'src/app/apply-submit.ts',
      'src/app/routes/apply-ingest-routes.ts',
      'src/app/trading-strategy-lab-ops.ts',
      'src/features/security/dependency-scanner.ts',
      'src/features/security/trivy-scanner.ts',
    ];
    for (const relPath of converted) {
      const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      expect(SYNC_SPAWN_IMPORT.test(src), `${relPath} re-imported a sync child_process API`).toBe(false);
      expect(SYNC_SPAWN_CALL.test(src), `${relPath} re-introduced a sync child_process call`).toBe(false);
    }
  });
});
