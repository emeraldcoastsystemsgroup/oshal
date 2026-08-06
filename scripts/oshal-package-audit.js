#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: implement the checkout-independent package-audit profile, safe catalog-record loader, staged install assessment, and native-installer CLI.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_AUDIT_PROFILE_VERSION = 1;
const PACKAGE_AUDIT_MODE_COMPATIBLE = 'compatible';
const PACKAGE_AUDIT_MODE_ENFORCE = 'enforce';
const UNAUDITED_SOURCE_SHA = '0000000000000000000000000000000000000000';
const PACKAGE_AUDIT_CONTROLS = Object.freeze([
  'manifest',
  'authz',
  'rls',
  'dependencies',
  'installLifecycle',
  'surface',
]);
const RECORD_FIELDS = Object.freeze([
  'profileVersion', 'app', 'version', 'sourceSha', 'status', 'auditedAt', 'controls', 'evidence',
]);
const RECORD_STATUSES = new Set(['pending', 'passed', 'failed']);
const CONTROL_STATUSES = new Set(['pending', 'passed', 'failed']);
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;

/**
 * @description Resolve the staged package-audit posture, rejecting unknown values so a typo
 * cannot silently weaken an enforce deployment.
 * @param {unknown} value - Explicit mode or the OSHAL_PACKAGE_AUDIT_MODE environment value.
 * @returns {'compatible' | 'enforce'} The normalized audit mode.
 */
function resolvePackageAuditMode(value = process.env.OSHAL_PACKAGE_AUDIT_MODE) {
  const normalized = String(value ?? '').trim().toLowerCase() || PACKAGE_AUDIT_MODE_COMPATIBLE;
  if (normalized !== PACKAGE_AUDIT_MODE_COMPATIBLE && normalized !== PACKAGE_AUDIT_MODE_ENFORCE) {
    throw new Error('OSHAL_PACKAGE_AUDIT_MODE must be compatible or enforce');
  }
  return normalized;
}

/** @description Return whether a value is a strict UTC ISO-8601 audit timestamp. */
function isAuditTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

/** @description Report exact-key drift so profile changes require a new profile version. */
function exactKeyProblems(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object`];
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const problems = [];
  const missing = wanted.filter((key) => !actual.includes(key));
  const added = actual.filter((key) => !wanted.includes(key));
  if (missing.length) problems.push(`${label} is missing ${missing.join(', ')}`);
  if (added.length) problems.push(`${label} has unsupported field(s) ${added.join(', ')}`);
  return problems;
}

/** @description Validate one content-addressed evidence descriptor without executing it. */
function evidenceProblems(item, index) {
  const label = `evidence[${index}]`;
  const problems = exactKeyProblems(item, ['name', 'sha256'], label);
  if (!item || typeof item !== 'object' || Array.isArray(item)) return problems;
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160) {
    problems.push(`${label}.name must be a non-empty string of at most 160 characters`);
  }
  if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
    problems.push(`${label}.sha256 must be a lowercase 64-character SHA-256 digest`);
  }
  return problems;
}

/**
 * @description Validate an immutable profile-v1 record independently of rollout policy.
 * @param {unknown} record - Parsed audit record.
 * @returns {string[]} Unique structural and semantic profile problems.
 */
function packageAuditRecordProblems(record) {
  const problems = exactKeyProblems(record, RECORD_FIELDS, 'audit record');
  if (!record || typeof record !== 'object' || Array.isArray(record)) return problems;
  if (record.profileVersion !== PACKAGE_AUDIT_PROFILE_VERSION) problems.push('profileVersion must equal 1');
  if (typeof record.app !== 'string' || !SLUG.test(record.app)) problems.push('app must be a lowercase slug');
  if (typeof record.version !== 'string' || !SEMVER.test(record.version)) problems.push('version must be a semantic version');
  if (typeof record.sourceSha !== 'string' || !SHA1.test(record.sourceSha)) {
    problems.push('sourceSha must be a lowercase 40-character Git SHA');
  }
  if (!RECORD_STATUSES.has(record.status)) problems.push('status must be pending, passed, or failed');
  problems.push(...controlProblems(record));
  problems.push(...recordEvidenceProblems(record));
  problems.push(...recordStatusProblems(record));
  return [...new Set(problems)];
}

/** @description Validate the exact six-control map and all control values. */
function controlProblems(record) {
  const problems = exactKeyProblems(record.controls, PACKAGE_AUDIT_CONTROLS, 'controls');
  if (!record.controls || typeof record.controls !== 'object' || Array.isArray(record.controls)) return problems;
  for (const control of PACKAGE_AUDIT_CONTROLS) {
    if (!CONTROL_STATUSES.has(record.controls[control])) {
      problems.push(`controls.${control} must be pending, passed, or failed`);
    }
  }
  return problems;
}

/** @description Validate evidence shape, digest format, uniqueness, and passed-record presence. */
function recordEvidenceProblems(record) {
  if (!Array.isArray(record.evidence)) return ['evidence must be an array'];
  const problems = [];
  record.evidence.forEach((item, index) => problems.push(...evidenceProblems(item, index)));
  const names = record.evidence.map((item) => item?.name).filter((name) => typeof name === 'string');
  if (new Set(names).size !== names.length) problems.push('evidence names must be unique');
  if (record.status === 'passed' && record.evidence.length === 0) {
    problems.push('passed audit requires at least one content-addressed evidence item');
  }
  return problems;
}

/** @description Validate timestamp, sentinel, and status/control coherence. */
function recordStatusProblems(record) {
  const problems = [];
  if (record.status === 'pending') {
    if (record.auditedAt !== null) problems.push('pending audit auditedAt must be null');
    if (record.sourceSha !== UNAUDITED_SOURCE_SHA) problems.push(`pending audit sourceSha must use the unaudited sentinel ${UNAUDITED_SOURCE_SHA}`);
  } else {
    if (!isAuditTimestamp(record.auditedAt)) problems.push(`${record.status} audit auditedAt must be a strict UTC timestamp`);
    if (record.sourceSha === UNAUDITED_SOURCE_SHA) problems.push(`${record.status} audit must bind a real sourceSha`);
  }
  if (record.status === 'passed') {
    for (const control of PACKAGE_AUDIT_CONTROLS) {
      if (record.controls?.[control] !== 'passed') problems.push(`passed audit requires controls.${control}=passed`);
    }
  }
  if (record.status === 'failed' && !PACKAGE_AUDIT_CONTROLS.some((name) => record.controls?.[name] === 'failed')) {
    problems.push('failed audit requires at least one failed control');
  }
  return problems;
}

/**
 * @description Validate the marketplace pointer and its exact app/version/source-SHA binding.
 * @param {unknown} entry - Marketplace entry.
 * @param {unknown} record - Parsed audit record.
 * @returns {string[]} Unique binding problems.
 */
function packageAuditBindingProblems(entry, record) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['catalog entry must be an object'];
  if (!entry.audit || typeof entry.audit !== 'object' || Array.isArray(entry.audit)) {
    return ['catalog audit must be an object with record and sourceSha'];
  }
  const expectedRecord = typeof entry.name === 'string' ? `audits/${entry.name}.json` : null;
  const problems = exactKeyProblems(entry.audit, ['record', 'sourceSha'], 'catalog audit');
  if (entry.audit.record !== expectedRecord) problems.push(`catalog audit.record must equal ${expectedRecord}`);
  if (typeof entry.audit.sourceSha !== 'string' || !SHA1.test(entry.audit.sourceSha)) {
    problems.push('catalog audit.sourceSha must be a lowercase 40-character Git SHA');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [...problems, 'audit record is unavailable'];
  if (record.app !== entry.name) problems.push('audit app does not match catalog name');
  if (record.version !== entry.version) problems.push('audit version does not match catalog version');
  if (record.sourceSha !== entry.audit.sourceSha) problems.push('audit sourceSha does not match catalog audit.sourceSha');
  return [...new Set(problems)];
}

/**
 * @description Make the install decision. Structural/profile/binding failures block in both modes;
 * compatible admits only a structurally valid pending/failed rollout without granting a SHA pin.
 * @param {unknown} entry - Marketplace entry.
 * @param {unknown} record - Parsed audit record.
 * @param {unknown} modeValue - Requested rollout mode.
 * @param {string[]} extraStructuralProblems - Safe-loader/canonicalization problems.
 * @returns {{mode:'compatible'|'enforce',allowed:boolean,verified:boolean,sourceSha:string|null,reasons:string[],structuralProblems:string[]}}
 */
function assessPackageAuditForInstall(entry, record, modeValue, extraStructuralProblems = []) {
  const mode = resolvePackageAuditMode(modeValue);
  const structuralProblems = [...new Set([
    ...extraStructuralProblems,
    ...packageAuditRecordProblems(record),
    ...packageAuditBindingProblems(entry, record),
  ])];
  const policyProblems = record?.status === 'passed' ? [] : [`audit status is ${record?.status ?? 'unavailable'}, not passed`];
  const verified = structuralProblems.length === 0 && policyProblems.length === 0;
  return {
    mode,
    allowed: structuralProblems.length === 0 && (mode === PACKAGE_AUDIT_MODE_COMPATIBLE || verified),
    verified,
    sourceSha: verified ? record.sourceSha : null,
    reasons: [...new Set([...structuralProblems, ...policyProblems])],
    structuralProblems,
  };
}

/** @description Read a bounded regular file, rejecting symlinks and non-files before parsing. */
function readRegularFile(filePath, maxBytes, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return fs.readFileSync(filePath, 'utf8');
}

/** @description Resolve the canonical audits/<app>.json path without traversal or symlink indirection. */
function resolveAuditRecordPath(root, entry) {
  const expected = typeof entry?.name === 'string' ? `audits/${entry.name}.json` : null;
  if (entry?.audit?.record !== expected) throw new Error(`catalog audit.record must equal ${expected}`);
  const auditsDir = path.join(root, 'audits');
  const auditsStat = fs.lstatSync(auditsDir);
  if (!auditsStat.isDirectory() || auditsStat.isSymbolicLink()) throw new Error('audits must be a regular directory');
  const filePath = path.resolve(root, entry.audit.record);
  const relative = path.relative(root, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('catalog audit.record escapes the store root');
  }
  return filePath;
}

/**
 * @description Safely load one official catalog entry and its canonical audit record from a store checkout.
 * @param {string} rootValue - Store checkout root.
 * @param {string} app - Package slug.
 * @param {unknown} modeValue - Requested rollout mode.
 * @returns {{entry:object,record:object,recordPath:string,mode:'compatible'|'enforce',allowed:boolean,verified:boolean,sourceSha:string|null,reasons:string[],structuralProblems:string[]}}
 */
function loadPackageAuditAssessment(rootValue, app, modeValue) {
  const mode = resolvePackageAuditMode(modeValue);
  if (!SLUG.test(app)) throw new Error(`invalid package name: ${app}`);
  const root = path.resolve(rootValue);
  const catalogSource = readRegularFile(path.join(root, 'marketplace.json'), MAX_CATALOG_BYTES, 'marketplace.json');
  const catalog = JSON.parse(catalogSource);
  if (!catalog || !Array.isArray(catalog.apps)) throw new Error('marketplace.json apps must be an array');
  const matches = catalog.apps.filter((entry) => entry?.name === app);
  if (matches.length !== 1) throw new Error(`marketplace.json must contain exactly one ${app} entry`);
  const entry = matches[0];
  const recordPath = resolveAuditRecordPath(root, entry);
  const recordSource = readRegularFile(recordPath, MAX_RECORD_BYTES, `${entry.audit.record}`);
  const record = JSON.parse(recordSource);
  // Git may materialize text with CRLF on Windows; canonical JSON is a structural layout rule,
  // not a platform-newline rule, so compare after the one safe newline normalization.
  const normalizedRecordSource = recordSource.replace(/\r\n/g, '\n');
  const canonicalProblems = normalizedRecordSource === `${JSON.stringify(record, null, 2)}\n`
    ? []
    : ['audit record is not canonical two-space JSON'];
  return { entry, record, recordPath, ...assessPackageAuditForInstall(entry, record, mode, canonicalProblems) };
}

/** @description Parse the native-installer CLI without accepting ambiguous positional arguments. */
function parseArgs(argv) {
  const options = { root: '', app: '', mode: undefined, json: false, printSha: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' || arg === '--app' || arg === '--mode') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--print-sha') options.printSha = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.root || !options.app) throw new Error('Usage: oshal-package-audit.js --root <store> --app <name> [--mode compatible|enforce] [--json|--print-sha]');
  options.mode = resolvePackageAuditMode(options.mode);
  return options;
}

/**
 * @description Run the safe assessor for codebase-free installers; exit nonzero on every denied decision.
 * @param {string[]} argv - Command-line arguments.
 * @returns {number} Process exit code.
 */
function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const assessment = loadPackageAuditAssessment(options.root, options.app, options.mode);
  if (options.json) process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
  else if (options.printSha && assessment.sourceSha) process.stdout.write(`${assessment.sourceSha}\n`);
  if (!assessment.allowed) {
    console.error(`Package audit denied ${options.app} in ${assessment.mode} mode:`);
    assessment.reasons.forEach((reason) => console.error(`  - ${reason}`));
    return 1;
  }
  if (!assessment.verified) {
    console.error(`WARNING: ${options.app} is NOT AUDIT-VERIFIED; compatible rollout uses the mutable store ref and grants no audited SHA pin.`);
    assessment.reasons.forEach((reason) => console.error(`  - ${reason}`));
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  PACKAGE_AUDIT_CONTROLS,
  PACKAGE_AUDIT_MODE_COMPATIBLE,
  PACKAGE_AUDIT_MODE_ENFORCE,
  PACKAGE_AUDIT_PROFILE_VERSION,
  UNAUDITED_SOURCE_SHA,
  assessPackageAuditForInstall,
  loadPackageAuditAssessment,
  packageAuditBindingProblems,
  packageAuditRecordProblems,
  resolvePackageAuditMode,
};
