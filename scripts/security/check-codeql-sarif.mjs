#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Fail SEC-06 on high/critical CodeQL results and require exact, named, expiring exceptions for lower-severity findings.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIGH_SECURITY_SCORE = 7;

/** @description Recursively discover SARIF evidence without accepting an empty analyzer output. */
export function sarifFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const candidate = join(root, name);
    if (statSync(candidate).isDirectory()) out.push(...sarifFiles(candidate));
    else if (/\.sarif(?:\.json)?$/i.test(name)) out.push(candidate);
  }
  return out.sort();
}

/** @description Resolve the CodeQL rule metadata referenced by one SARIF result. */
function ruleFor(run, result) {
  const rules = run?.tool?.driver?.rules ?? [];
  if (Number.isInteger(result.ruleIndex)) return rules[result.ruleIndex];
  return rules.find((rule) => rule.id === result.ruleId);
}

/** @description Convert a SARIF location URI into the stable repository-relative exception key. */
function findingPath(result) {
  return result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? '<no-path>';
}

/** @description Flatten CodeQL SARIF runs into the fields the blocking policy evaluates. */
export function findingsFromSarif(document) {
  const findings = [];
  for (const run of document.runs ?? []) {
    for (const result of run.results ?? []) {
      const rule = ruleFor(run, result);
      const rawScore = result.properties?.['security-severity'] ?? rule?.properties?.['security-severity'];
      findings.push({
        ruleId: result.ruleId ?? rule?.id ?? '<unknown-rule>',
        path: findingPath(result),
        level: result.level ?? 'warning',
        securityScore: Number.isFinite(Number(rawScore)) ? Number(rawScore) : null,
      });
    }
  }
  return findings;
}

/** @description Validate one lower-severity exception as named, reasoned, and not expired. */
function validException(exception, today) {
  if (!exception || typeof exception !== 'object') return false;
  if (![exception.ruleId, exception.path, exception.owner, exception.reason].every((v) => typeof v === 'string' && v.trim())) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires ?? '')) return false;
  const expiry = new Date(`${exception.expires}T23:59:59.999Z`);
  return Number.isFinite(expiry.getTime()) && expiry >= today;
}

/** @description Find an exact, unexpired exception; wildcard paths are intentionally forbidden. */
function exceptionFor(finding, exceptions, today) {
  return exceptions.find(
    (entry) => validException(entry, today) && entry.ruleId === finding.ruleId && entry.path === finding.path,
  );
}

/** @description Apply the no-high-findings and expiring-lower-exception SEC-06 policy. */
export function evaluateFindings(findings, exceptionDocument, today = new Date()) {
  const exceptions = exceptionDocument?.exceptions ?? [];
  const blockers = [];
  for (const finding of findings) {
    const high = finding.level === 'error'
      || (finding.securityScore !== null && finding.securityScore >= HIGH_SECURITY_SCORE);
    if (high) blockers.push({ ...finding, reason: 'high-or-critical' });
    else if (!exceptionFor(finding, exceptions, today)) blockers.push({ ...finding, reason: 'missing-expiring-exception' });
  }
  return blockers;
}

/** @description Run the command-line gate and keep findings free of source snippets or secrets. */
export function main(argv = process.argv.slice(2)) {
  const sarifRoot = resolve(argv[0] ?? 'codeql-results');
  const exceptionPath = resolve(argv[1] ?? 'scripts/security/codeql-exceptions.json');
  const files = sarifFiles(sarifRoot);
  if (files.length === 0) throw new Error(`CodeQL produced no SARIF files under ${sarifRoot}`);
  if (!existsSync(exceptionPath)) throw new Error(`CodeQL exception ledger is missing: ${exceptionPath}`);

  const findings = files.flatMap((file) => findingsFromSarif(JSON.parse(readFileSync(file, 'utf8'))));
  const ledger = JSON.parse(readFileSync(exceptionPath, 'utf8'));
  const blockers = evaluateFindings(findings, ledger);
  if (blockers.length > 0) {
    for (const finding of blockers) {
      console.error(`${finding.reason}: ${finding.ruleId} at ${finding.path}`);
    }
    throw new Error(`${blockers.length} CodeQL finding(s) violate the SEC-06 policy`);
  }
  console.log(`CodeQL policy passed: ${files.length} SARIF file(s), ${findings.length} finding(s)`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
