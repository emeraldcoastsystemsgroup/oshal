#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: implement the checkout-independent package-audit profile, safe catalog-record loader, staged install assessment, and native-installer CLI.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Evidence contract (backlog #33, mirrors the store validator): a passed or failed record names exactly the seven evidence documents (six controls plus goldenPath) and a pending one names none; the loader re-hashes every document from audits/evidence/<app>/<sourceSha>/<name>.json and checks it agrees with the record, so a changed digest or a changed evidence byte is refused in every mode instead of being trusted. Adds sourceCurrencyProblems: the installer compares the package tree at the catalog ref with the tree at sourceSha, because a source change after an audit used to install the older audited commit silently. Profile version stays 1.
 */

'use strict';

const crypto = require('crypto');
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
/** The seven evidence documents an attestation carries: one per control plus the golden path. */
const PACKAGE_AUDIT_EVIDENCE_NAMES = Object.freeze([...PACKAGE_AUDIT_CONTROLS, 'goldenPath']);
const RECORD_FIELDS = Object.freeze([
  'profileVersion', 'app', 'version', 'sourceSha', 'status', 'auditedAt', 'controls', 'evidence',
]);
const EVIDENCE_DOCUMENT_FIELDS = Object.freeze([
  'profileVersion', 'app', 'version', 'sourceSha', 'sourcePath', 'packageTree', 'control', 'result', 'checks',
]);
const EVIDENCE_RESULTS = new Set(['passed', 'failed']);
const MAX_EVIDENCE_BYTES = 1024 * 1024;
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

/** @description Validate evidence shape, digest format, uniqueness, and the exact seven-document set. */
function recordEvidenceProblems(record) {
  if (!Array.isArray(record.evidence)) return ['evidence must be an array'];
  const problems = [];
  record.evidence.forEach((item, index) => problems.push(...evidenceProblems(item, index)));
  const names = record.evidence.map((item) => item?.name).filter((name) => typeof name === 'string');
  if (new Set(names).size !== names.length) problems.push('evidence names must be unique');
  if (record.status === 'pending' && record.evidence.length) problems.push('pending audit evidence must be empty');
  if (record.status === 'passed' || record.status === 'failed') {
    const missing = PACKAGE_AUDIT_EVIDENCE_NAMES.filter((name) => !names.includes(name));
    const extra = names.filter((name) => !PACKAGE_AUDIT_EVIDENCE_NAMES.includes(name));
    if (missing.length) problems.push(`${record.status} audit evidence is missing ${missing.join(', ')}`);
    if (extra.length) problems.push(`${record.status} audit evidence names unsupported item(s) ${extra.join(', ')}`);
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

/**
 * @description Serialize a value as canonical audit JSON (keys sorted at every depth, two-space
 * indentation, one trailing newline) - the exact bytes the store's audit runner writes.
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} Canonical text.
 */
function canonicalAuditJson(value) {
  const sortDeep = (item) => {
    if (Array.isArray(item)) return item.map(sortDeep);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sortDeep(item[key])]));
  };
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

/**
 * @description SHA-256 of evidence text after folding CRLF to LF; canonical JSON holds no carriage
 * return, so the fold only undoes a Windows checkout's line-ending conversion.
 * @param {string} text - Evidence file text.
 * @returns {string} Lowercase hex digest.
 */
function auditEvidenceDigest(text) {
  return crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * @description Repository-relative directory holding one attestation's evidence documents.
 * @param {string} app - Package slug.
 * @param {string} sourceSha - Audited commit.
 * @returns {string} POSIX directory path.
 */
function auditEvidenceDirectory(app, sourceSha) {
  return `audits/evidence/${app}/${sourceSha}`;
}

/** @description The record's control statuses must be exactly what the evidence says. */
function evidenceAgreementProblems(document, name, record) {
  if (!EVIDENCE_RESULTS.has(document.result)) return [];
  if (name === 'goldenPath') {
    return document.result !== 'passed' && record.controls?.authz === 'passed'
      ? ['controls.authz=passed requires a passed goldenPath evidence document'] : [];
  }
  return record.controls?.[name] === document.result
    ? [] : [`controls.${name}=${record.controls?.[name]} disagrees with evidence ${name} (${document.result})`];
}

/** @description Check one parsed evidence document against its record and catalog entry. */
function evidenceDocumentProblems(document, name, record, entry) {
  const label = `evidence ${name}`;
  const problems = exactKeyProblems(document, EVIDENCE_DOCUMENT_FIELDS, label);
  if (!document || typeof document !== 'object' || Array.isArray(document)) return problems;
  if (document.profileVersion !== PACKAGE_AUDIT_PROFILE_VERSION) problems.push(`${label} profileVersion must equal 1`);
  for (const key of ['app', 'version', 'sourceSha']) {
    if (document[key] !== record[key]) problems.push(`${label} ${key} does not match the audit record`);
  }
  if (document.sourcePath !== entry?.source?.path) problems.push(`${label} sourcePath does not match catalog source.path`);
  if (typeof document.packageTree !== 'string' || !SHA1.test(document.packageTree)) problems.push(`${label} packageTree must be a Git tree id`);
  if (document.control !== name) problems.push(`${label} control must equal ${name}`);
  if (!EVIDENCE_RESULTS.has(document.result)) problems.push(`${label} result must be passed or failed`);
  const checks = Array.isArray(document.checks) ? document.checks : [];
  if (!checks.length || checks.some((check) => typeof check?.name !== 'string' || !EVIDENCE_RESULTS.has(check?.result))) {
    problems.push(`${label} checks must be a non-empty list of named passed/failed checks`);
  } else if (document.result !== (checks.every((check) => check.result === 'passed') ? 'passed' : 'failed')) {
    problems.push(`${label} result disagrees with its checks`);
  }
  return [...problems, ...evidenceAgreementProblems(document, name, record)];
}

/** @description Reject a symlinked or non-directory component on the fixed evidence path. */
function assertEvidenceDirectories(root, app, sourceSha) {
  let current = root;
  for (const part of ['audits', 'evidence', app, sourceSha]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path.relative(root, current)} must be a regular directory`);
  }
}

/** @description Read, re-hash and parse one named evidence document; returns problems or the document. */
function readEvidenceDocument(root, record, item) {
  const relative = `${auditEvidenceDirectory(record.app, record.sourceSha)}/${item.name}.json`;
  let text;
  try {
    text = readRegularFile(path.join(root, ...relative.split('/')), MAX_EVIDENCE_BYTES, relative);
  } catch (error) {
    return { problems: [`evidence ${item.name}: ${error.code === 'ENOENT' ? `${relative} is missing` : error.message}`] };
  }
  if (auditEvidenceDigest(text) !== item.sha256) {
    return { problems: [`evidence ${item.name} bytes do not match the recorded sha256; re-audit required`] };
  }
  let document;
  try { document = JSON.parse(text); } catch (error) {
    return { problems: [`evidence ${item.name} is not JSON: ${error.message}`] };
  }
  const canonical = text.replace(/\r\n/g, '\n') === canonicalAuditJson(document);
  return { document, problems: canonical ? [] : [`evidence ${item.name} is not canonical audit JSON`] };
}

/**
 * @description Re-hash and read every evidence document a passed/failed record names. A missing,
 * changed, non-canonical or contradicting document is a structural problem: the attestation no
 * longer proves what it claims, so no mode may trust it.
 * @param {string} root - Store checkout root (the evidence directory is sparse-checked-out).
 * @param {object} entry - Catalog entry.
 * @param {object} record - Parsed audit record.
 * @returns {{problems: string[], packageTrees: string[]}} Problems plus the trees the evidence describes.
 */
function packageAuditEvidenceProblems(root, entry, record) {
  if (!record || (record.status !== 'passed' && record.status !== 'failed') || !Array.isArray(record.evidence)) {
    return { problems: [], packageTrees: [] };
  }
  if (!SLUG.test(String(record.app)) || !SHA1.test(String(record.sourceSha))) {
    return { problems: ['evidence cannot be located without a valid app and sourceSha'], packageTrees: [] };
  }
  try {
    assertEvidenceDirectories(root, record.app, record.sourceSha);
  } catch (error) {
    const directory = auditEvidenceDirectory(record.app, record.sourceSha);
    return { problems: [`evidence directory ${directory} is unavailable: ${error.code === 'ENOENT' ? 'missing' : error.message}`], packageTrees: [] };
  }
  const problems = [];
  const trees = new Set();
  for (const item of record.evidence) {
    if (!PACKAGE_AUDIT_EVIDENCE_NAMES.includes(item?.name)) continue;
    const read = readEvidenceDocument(root, record, item);
    problems.push(...read.problems);
    if (!read.document) continue;
    problems.push(...evidenceDocumentProblems(read.document, item.name, record, entry));
    trees.add(read.document.packageTree);
  }
  return { problems: [...new Set(problems)], packageTrees: [...trees] };
}

/**
 * @description Decide whether an audited attestation still describes the source a catalog ref would
 * install. The package tree at the catalog ref must be the tree at sourceSha, and the evidence must
 * describe exactly that tree; otherwise the source (or its version) changed without a re-audit.
 * @param {{sourceSha:string, sourcePath:string, catalogTree:string|null, auditedTree:string|null, evidenceTrees:string[], fetchError?:string}} input
 *   Tree ids read from Git by the installer, plus the trees the evidence documents name.
 * @returns {string[]} Currency problems; empty when the attestation is current.
 */
function sourceCurrencyProblems(input) {
  const { sourceSha, sourcePath, catalogTree, auditedTree, evidenceTrees = [], fetchError } = input;
  if (fetchError || !auditedTree) {
    return [`audited source ${sourceSha} (${sourcePath}) cannot be read from this store${fetchError ? `: ${fetchError}` : ''}; re-audit against this store required`];
  }
  const problems = [];
  if (!catalogTree || catalogTree !== auditedTree) {
    problems.push(`package source ${sourcePath} changed since the audit (catalog tree ${catalogTree || 'missing'}, audited tree ${auditedTree}); re-audit required`);
  }
  if (evidenceTrees.length !== 1 || evidenceTrees[0] !== auditedTree) {
    problems.push('evidence does not describe the audited source tree; re-audit required');
  }
  return problems;
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
  const evidence = packageAuditEvidenceProblems(root, entry, record);
  return {
    entry, record, recordPath, evidenceTrees: evidence.packageTrees,
    ...assessPackageAuditForInstall(entry, record, mode, [...canonicalProblems, ...evidence.problems]),
  };
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
  PACKAGE_AUDIT_EVIDENCE_NAMES,
  PACKAGE_AUDIT_MODE_COMPATIBLE,
  PACKAGE_AUDIT_MODE_ENFORCE,
  PACKAGE_AUDIT_PROFILE_VERSION,
  UNAUDITED_SOURCE_SHA,
  assessPackageAuditForInstall,
  auditEvidenceDigest,
  auditEvidenceDirectory,
  canonicalAuditJson,
  loadPackageAuditAssessment,
  packageAuditBindingProblems,
  packageAuditRecordProblems,
  resolvePackageAuditMode,
  sourceCurrencyProblems,
};
