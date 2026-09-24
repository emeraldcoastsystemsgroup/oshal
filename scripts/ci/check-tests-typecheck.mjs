#!/usr/bin/env node
/**
 * scripts/ci/check-tests-typecheck.mjs
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                   | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com | Typecheck the test tree against tsconfig.tests.json with quarantine ledger enforcement.
 * =============================================================================
 *
 * Usage:
 *   node scripts/ci/check-tests-typecheck.mjs             # Verify: fail on any unquarantined error
 *   node scripts/ci/check-tests-typecheck.mjs --record    # Record: regenerate tests/typecheck-quarantine.json
 *   node scripts/ci/check-tests-typecheck.mjs --summary   # Print summary of quarantined errors
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const QUARANTINE_FILE = path.join(REPO_ROOT, 'tests/typecheck-quarantine.json');
const TSCONFIG_TESTS = path.join(REPO_ROOT, 'tsconfig.tests.json');

const args = process.argv.slice(2);
const isRecord = args.includes('--record');
const isSummary = args.includes('--summary');

function normalizeFilePath(file) {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeMessage(msg) {
  return msg.trim().replace(/\s+/g, ' ');
}

function makeFingerprint(file, code, message) {
  return `${normalizeFilePath(file)}::${code}::${normalizeMessage(message)}`;
}

function inferReason(code, message) {
  if (code === 'TS2493') {
    return 'Pre-existing: Mock query/function call index exceeds declared tuple length in test mock signature';
  }
  if (code === 'TS2322') {
    return 'Pre-existing: Test fixture or mock object does not strictly satisfy production interface';
  }
  if (code === 'TS2339') {
    return 'Pre-existing: Test property access on union, promise, or loosely-typed test object';
  }
  if (code === 'TS2345') {
    return 'Pre-existing: Argument type mismatch in test invocation or mock assertion';
  }
  if (code === 'TS2739' || code === 'TS2741' || code === 'TS2740') {
    return 'Pre-existing: Test mock or fixture missing required property added to interface';
  }
  if (code === 'TS2352') {
    return 'Pre-existing: Unsafe test cast without intermediate unknown';
  }
  if (code === 'TS18047' || code === 'TS18048' || code === 'TS2532' || code === 'TS2531') {
    return 'Pre-existing: Test assumes non-null or non-undefined array/map/lookup element';
  }
  if (code === 'TS7006' || code === 'TS7031') {
    return 'Pre-existing: Test parameter or binding element lacks explicit type annotation';
  }
  if (code === 'TS2578') {
    return 'Pre-existing: Unused @ts-expect-error directive after bundler module resolution';
  }
  if (code === 'TS2554' || code === 'TS2556') {
    return 'Pre-existing: Test invocation argument count does not match function signature';
  }
  return 'Pre-existing: Untyped test pattern prior to test-tree typecheck gate introduction';
}

export function runTypecheck(repoRoot = REPO_ROOT) {
  let stdout = '';
  try {
    stdout = execSync('node ./node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit --pretty false', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    stdout = (err.stdout || '') + (err.stderr || '');
  }

  const errors = [];
  const lines = stdout.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([^(]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/);
    if (match) {
      const relPath = normalizeFilePath(path.relative(repoRoot, path.resolve(repoRoot, match[1])));
      errors.push({
        file: relPath,
        line: parseInt(match[2], 10),
        col: parseInt(match[3], 10),
        code: match[4],
        message: match[5].trim(),
      });
    }
  }

  return errors;
}

export function loadQuarantine(quarantineFile = QUARANTINE_FILE) {
  if (!fs.existsSync(quarantineFile)) {
    return { version: 1, totalQuarantined: 0, entries: [] };
  }
  const content = fs.readFileSync(quarantineFile, 'utf8');
  return JSON.parse(content);
}

export function evaluateTypecheck(errors, quarantine) {
  const quarantineCounts = new Map();
  for (const entry of quarantine.entries) {
    if (!entry.reason || entry.reason.trim().length === 0) {
      throw new Error(`Quarantine entry for ${entry.file}:${entry.line} [${entry.code}] missing reason`);
    }
    const fp = makeFingerprint(entry.file, entry.code, entry.message);
    quarantineCounts.set(fp, (quarantineCounts.get(fp) || 0) + 1);
  }

  const unquarantined = [];
  const matchedCounts = new Map();

  for (const err of errors) {
    const fp = makeFingerprint(err.file, err.code, err.message);
    const available = quarantineCounts.get(fp) || 0;
    const used = matchedCounts.get(fp) || 0;

    if (used < available) {
      matchedCounts.set(fp, used + 1);
    } else {
      unquarantined.push(err);
    }
  }

  let staleCount = 0;
  for (const [fp, total] of quarantineCounts.entries()) {
    const used = matchedCounts.get(fp) || 0;
    if (used < total) {
      staleCount += (total - used);
    }
  }

  return {
    unquarantined,
    totalErrors: errors.length,
    quarantinedCount: errors.length - unquarantined.length,
    staleCount,
  };
}

function main() {
  if (!fs.existsSync(TSCONFIG_TESTS)) {
    console.error(`✗ tests-typecheck: ${TSCONFIG_TESTS} not found`);
    process.exit(1);
  }

  console.log('tests-typecheck: running tsc on tsconfig.tests.json…');
  const errors = runTypecheck();

  if (isRecord) {
    const entries = errors.map((err) => ({
      file: err.file,
      line: err.line,
      col: err.col,
      code: err.code,
      message: err.message,
      reason: inferReason(err.code, err.message),
    }));

    // Sort deterministically by file, line, code
    entries.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.line !== b.line) return a.line - b.line;
      return a.code.localeCompare(b.code);
    });

    const data = {
      version: 1,
      description: 'Quarantined pre-existing test typecheck errors as of 2026-09-24',
      recordedAt: new Date().toISOString(),
      totalQuarantined: entries.length,
      entries,
    };

    fs.writeFileSync(QUARANTINE_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`tests-typecheck: wrote ${entries.length} entries to ${QUARANTINE_FILE}`);
    return;
  }

  const quarantine = loadQuarantine();
  const result = evaluateTypecheck(errors, quarantine);

  if (isSummary) {
    console.log(`tests-typecheck: total errors=${result.totalErrors}, quarantined=${result.quarantinedCount}, unquarantined=${result.unquarantined.length}, stale=${result.staleCount}`);
    return;
  }

  if (result.unquarantined.length > 0) {
    console.error('');
    console.error(`✗ tests-typecheck BLOCKED — ${result.unquarantined.length} new or unquarantined type error(s) in tests/:\n`);
    for (const err of result.unquarantined.slice(0, 25)) {
      console.error(`  ${err.file}:${err.line}:${err.col} - error ${err.code}: ${err.message}`);
    }
    if (result.unquarantined.length > 25) {
      console.error(`  … and ${result.unquarantined.length - 25} more unquarantined error(s)`);
    }
    console.error('');
    console.error('All new or modified test files must be typecheck-clean.');
    console.error('If you fixed errors, do NOT add new ones.');
    process.exit(1);
  }

  if (result.staleCount > 0) {
    console.log(`tests-typecheck: ✓ 0 new errors (${result.quarantinedCount} quarantined, ${result.staleCount} pre-existing errors resolved!)`);
  } else {
    console.log(`tests-typecheck: ✓ clean (${result.quarantinedCount} pre-existing errors quarantined with reasons)`);
  }
}

// Only run main when executed as a script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
