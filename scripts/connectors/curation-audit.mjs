#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Audit the effective connector target set, fail on unreviewed icon fallbacks or declared connector-level risk, and report the deterministic risk derived from executable semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Report effective category, evidence lane, and trusted source-taxonomy provenance so generated-catalog completeness is auditable without a catch-all.
 * -----------------------------------------------------------------------------
 *
 * Connector curation is a gate, not a metadata counter. The target set mirrors the default
 * marketplace: tracked specs, CONNECTOR_SPEC_DIRS, and the generated OpenAPI directory when it
 * exists. A favicon is reviewed only when its domain follows directly from the spec or appears in
 * reviewed-favicon-fallbacks.json. Connector-wide risk is derived; action-level risk remains
 * declared because it controls the per-action confirmation rail.
 *
 * @module scripts/connectors/curation-audit
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { deriveConnectorRiskLevel } from '../../src/app/connectors/runtime/catalog-audit.ts';
import { deriveConnectorCategoryDecision, deriveConnectorDescription } from '../../src/app/connectors/runtime/curation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const reviewRegistryPath = path.join(here, 'reviewed-favicon-fallbacks.json');
const reviewedFallbacks = loadReviewedFallbacks(reviewRegistryPath);

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    const report = buildReport(options.specDirs);
    if (options.reportPath) writeReport(options.reportPath, report);
    if (options.asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printReport(report, options.reportPath);
    if (!report.summary.pass) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`connector-curation-audit: ${(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 2;
  }
}

function buildReport(specDirs) {
  const { rows, duplicates } = loadTargetRows(specDirs);
  const valid = rows.filter((row) => !row.parseError);
  const summary = summarize(rows, valid, duplicates);
  return {
    generatedAt: new Date().toISOString(),
    targetDirs: specDirs.map(relativePath),
    policy: {
      icon: 'simple-icons requires an explicit verified slug; favicon-fallback requires an exact public spec-derived or maintainer-reviewed domain; initials-fallback is allowed only when no public domain exists',
      connectorRisk: 'derived high for any non-GET/explicitly mutating resource or declared action; otherwise medium for OAuth2/basic auth; otherwise low',
      actionRisk: 'actions[].riskLevel remains declared and validated because it controls per-action confirmation',
      category: 'declared category, exact provider rule, reviewed APIs.guru source-taxonomy mapping, then spec signals; unknown values/combinations remain unresolved',
    },
    summary,
    connectors: rows,
  };
}

function loadTargetRows(specDirs) {
  const rows = [];
  const providers = new Set();
  const duplicates = [];
  const files = specDirs.flatMap((dir) => specFiles(dir)).sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    const loaded = loadRow(file);
    if (loaded.parseError) {
      rows.push(loaded);
      continue;
    }
    if (providers.has(loaded.provider)) {
      duplicates.push({ provider: loaded.provider, file: loaded.file });
      continue;
    }
    providers.add(loaded.provider);
    rows.push(loaded);
  }
  return { rows, duplicates };
}

function loadRow(file) {
  let spec;
  try {
    spec = yaml.load(readFileSync(file, 'utf8')) || {};
  } catch (error) {
    return { file: relativePath(file), provider: path.basename(file), parseError: String(error) };
  }
  const metadata = spec.metadata || {};
  const icon = assessIcon(spec, metadata);
  const declaredRiskLocations = connectorRiskDeclarations(spec);
  const category = deriveConnectorCategoryDecision(spec);
  return {
    file: relativePath(file),
    provider: spec.provider || path.basename(file, path.extname(file)),
    icon,
    hasCategory: Boolean(category),
    category: category?.category || null,
    categorySource: category?.source || null,
    categoryEvidence: category?.evidence || null,
    hasDescription: Boolean(deriveConnectorDescription(spec)),
    declaresCategory: Boolean(spec.category || metadata.category),
    declaresDescription: Boolean(spec.description || metadata.description),
    connectorRiskLevel: deriveConnectorRiskLevel(spec),
    declaredRiskLocations,
    setupLane: setupLane(spec.auth?.type),
  };
}

function assessIcon(spec, metadata) {
  const source = String(metadata.iconSource || '');
  if (source === 'simple-icons') return assessSimpleIcon(metadata);
  if (source === 'favicon-fallback' || source === 'favicon-curated' || metadata.iconUrl) {
    return assessFavicon(spec, metadata, source);
  }
  if (source === 'initials-fallback') return assessInitials(spec, metadata);
  return iconFinding('missing-icon', false, 'no reviewed Simple Icons slug or favicon fallback');
}

function assessSimpleIcon(metadata) {
  const slug = String(metadata.icon || '').trim();
  const validSlug = /^[a-z0-9]+$/.test(slug);
  const consistent = metadata.iconVerified === true && validSlug && !metadata.iconUrl;
  if (!consistent) {
    return iconFinding('invalid-icon-metadata', false, 'Simple Icons metadata must have a slug, iconVerified=true, and no iconUrl');
  }
  return { ...iconFinding('verified-simple-icon', true, 'explicitly verified Simple Icons slug'), slug };
}

function assessFavicon(spec, metadata, source) {
  if (source !== 'favicon-fallback' || metadata.iconVerified !== false || metadata.icon || metadata.iconTitle) {
    return iconFinding('unreviewed-favicon-fallback', false, 'favicon metadata must use favicon-fallback, iconVerified=false, and no Simple Icons fields');
  }
  const actualDomain = faviconDomain(metadata.iconUrl);
  const expected = expectedFavicon(spec);
  if (!actualDomain) return iconFinding('unreviewed-favicon-fallback', false, 'favicon URL is missing or not the approved HTTPS DuckDuckGo shape');
  if (!expected || actualDomain !== expected.domain) {
    return { ...iconFinding('unreviewed-favicon-fallback', false, 'favicon domain is not traceable to the spec or review registry'), domain: actualDomain };
  }
  return {
    ...iconFinding('reviewed-favicon-fallback', true, `domain reviewed through ${expected.provenance}`),
    domain: actualDomain,
    provenance: expected.provenance,
  };
}

function assessInitials(spec, metadata) {
  const contradictory = metadata.iconVerified !== false || metadata.icon || metadata.iconTitle || metadata.iconUrl;
  if (contradictory || expectedFavicon(spec)) {
    return iconFinding('invalid-icon-metadata', false, 'initials fallback is allowed only with no icon fields and no public reviewed domain');
  }
  return iconFinding('reviewed-initials-fallback', true, 'no public spec-derived or reviewed favicon domain exists');
}

function expectedFavicon(spec) {
  const reviewed = reviewedFallbacks.get(String(spec.provider || ''));
  if (reviewed) return { domain: reviewed.domain, provenance: 'reviewed-favicon-fallbacks.json' };
  const metadata = spec.metadata || {};
  const declared = metadata.sourceCatalog
    ? normalizedHost(spec.baseUrl) || normalizedHost(metadata.website) || normalizedHost(metadata.sourceUrl)
    : normalizedHost(metadata.website) || normalizedHost(spec.baseUrl) || normalizedHost(metadata.sourceUrl);
  return declared ? { domain: declared, provenance: 'declared connector host' } : null;
}

function iconFinding(status, reviewed, reason) {
  return { status, reviewed, reason };
}

function faviconDomain(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^https:\/\/icons\.duckduckgo\.com\/ip3\/([^/?#]+)\.ico$/);
  if (!match) return null;
  try {
    const domain = decodeURIComponent(match[1]).toLowerCase();
    const parsed = new URL(`https://${domain}`);
    if (parsed.hostname !== domain || parsed.port || parsed.username || parsed.password || !isPublicHostname(domain)) return null;
    return domain;
  } catch {
    return null;
  }
}

function normalizedHost(source) {
  if (!source) return null;
  try {
    const host = new URL(source).hostname.toLowerCase();
    if (!host || host === 'api.apis.guru') return null;
    const stripped = host
      .replace(/^(www\d?|api|apis|developer|developers|docs|support|portal|gateway|app|apps|cloud)\./, '')
      .replace(/^api-/, '');
    if (isPublicHostname(stripped)) return stripped;
    return isPublicHostname(host) ? host : null;
  } catch {
    return null;
  }
}

function isPublicHostname(value) {
  const host = String(value || '').toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || ['example', 'invalid', 'local', 'localhost', 'test'].includes(labels.at(-1) || '')) {
    return false;
  }
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function connectorRiskDeclarations(spec) {
  const locations = [];
  if (Object.prototype.hasOwnProperty.call(spec, 'riskLevel')) locations.push('riskLevel');
  if (spec.metadata && Object.prototype.hasOwnProperty.call(spec.metadata, 'riskLevel')) locations.push('metadata.riskLevel');
  return locations;
}

function summarize(rows, valid, duplicates) {
  const count = (predicate) => valid.filter(predicate).length;
  const iconCount = (status) => count((row) => row.icon.status === status);
  const gates = {
    parseErrors: rows.length - valid.length,
    unreviewedFaviconFallbacks: iconCount('unreviewed-favicon-fallback'),
    invalidOrMissingIcons: iconCount('invalid-icon-metadata') + iconCount('missing-icon'),
    connectorRiskDeclarations: count((row) => row.declaredRiskLocations.length > 0),
  };
  const metadataGaps = {
    missingDeclaredCategories: count((row) => !row.declaresCategory),
    missingDeclaredDescriptions: count((row) => !row.declaresDescription),
  };
  const effectiveMetadataGaps = {
    uncategorized: count((row) => !row.hasCategory),
    undescribed: count((row) => !row.hasDescription),
  };
  const policyReady = count((row) => row.icon.reviewed && row.declaredRiskLocations.length === 0);
  const metadataComplete = count((row) => row.hasCategory && row.hasDescription);
  return {
    pass: Object.values(gates).every((value) => value === 0),
    total: rows.length,
    effectiveConnectors: valid.length,
    shadowedDuplicates: duplicates,
    coverage: coverage(valid),
    categories: groupCount(valid.filter((row) => row.category), (row) => row.category),
    categorySources: groupCount(valid.filter((row) => row.categorySource), (row) => row.categorySource),
    riskLevels: groupCount(valid, (row) => row.connectorRiskLevel),
    policyReady,
    metadataComplete,
    iconRiskBacklog: rows.length - policyReady,
    gates,
    effectiveMetadataGaps,
    metadataGaps,
  };
}

function coverage(valid) {
  const pct = (count) => valid.length ? Math.round((count / valid.length) * 100) : 0;
  const metric = (predicate) => {
    const n = valid.filter(predicate).length;
    return { n, pct: pct(n) };
  };
  return {
    reviewedIcon: metric((row) => row.icon.reviewed),
    verifiedSimpleIcon: metric((row) => row.icon.status === 'verified-simple-icon'),
    reviewedFaviconFallback: metric((row) => row.icon.status === 'reviewed-favicon-fallback'),
    reviewedInitialsFallback: metric((row) => row.icon.status === 'reviewed-initials-fallback'),
    category: metric((row) => row.hasCategory),
    description: metric((row) => row.hasDescription),
    declaredCategory: metric((row) => row.declaresCategory),
    declaredDescription: metric((row) => row.declaresDescription),
    derivedConnectorRisk: metric((row) => Boolean(row.connectorRiskLevel)),
  };
}

function groupCount(values, keyFor) {
  return values.reduce((counts, value) => {
    const key = keyFor(value);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function setupLane(authType) {
  const type = String(authType || 'none').toLowerCase();
  if (type === 'none' || type === '') return 'no-auth';
  if (type.includes('oauth')) return 'needs-operator-oauth-app';
  return 'bring-your-own-key';
}

function loadReviewedFallbacks(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed.reviewedBy !== 'maintainer@emeraldcoastsystemsgroup.com') {
    throw new Error('reviewed favicon registry must identify the project maintainer');
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const result = new Map();
  for (const entry of entries) {
    if (!entry.provider || !validDomain(entry.domain) || !entry.reason || result.has(entry.provider)) {
      throw new Error(`invalid or duplicate reviewed favicon entry for '${entry.provider || '(missing)'}'`);
    }
    result.set(entry.provider, entry);
  }
  return result;
}

function validDomain(value) {
  return typeof value === 'string' && value === value.toLowerCase() && isPublicHostname(value);
}

function specFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/i.test(file))
    .map((file) => path.join(dir, file))
    .sort((left, right) => left.localeCompare(right));
}

function defaultSpecDirs() {
  const dirs = [path.join(root, 'swarm-apps/connectors'), ...parsePathList(process.env.CONNECTOR_SPEC_DIRS)];
  const generated = path.join(root, 'output/connectors/imported-openapi');
  if (existsSync(generated)) dirs.push(generated);
  return uniquePaths(dirs);
}

function parseArgs(args) {
  const options = { asJson: false, help: false, reportPath: null, specDirs: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.asJson = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--report') options.reportPath = path.resolve(requireValue(arg, args[++index]));
    else if (arg === '--spec-dir') options.specDirs.push(path.resolve(requireValue(arg, args[++index])));
    else throw new Error(`unknown argument: ${arg}`);
  }
  options.specDirs = options.specDirs.length ? uniquePaths(options.specDirs) : defaultSpecDirs();
  return options;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePathList(value) {
  return String(value || '').split(/[;,]/g).map((item) => item.trim()).filter(Boolean);
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.map((item) => path.resolve(item))));
}

function relativePath(value) {
  return path.relative(root, value).replace(/\\/g, '/');
}

function writeReport(reportPath, report) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printReport(report, reportPath) {
  const { summary } = report;
  const coverage = summary.coverage;
  console.log(`Connector curation audit - ${summary.effectiveConnectors} effective connectors`);
  console.log(`  reviewed icons:      ${coverage.reviewedIcon.n}/${summary.effectiveConnectors} (${coverage.reviewedIcon.pct}%)`);
  console.log(`    Simple Icons:      ${coverage.verifiedSimpleIcon.n}`);
  console.log(`    favicon fallback:  ${coverage.reviewedFaviconFallback.n}`);
  console.log(`    initials fallback: ${coverage.reviewedInitialsFallback.n}`);
  console.log(`  category:            ${coverage.category.n}/${summary.effectiveConnectors}`);
  console.log(`  category evidence:   ${JSON.stringify(summary.categorySources)}`);
  console.log(`  description:         ${coverage.description.n}/${summary.effectiveConnectors}`);
  console.log(`  derived risk:        ${JSON.stringify(summary.riskLevels)}`);
  console.log(`  icon/risk backlog:   ${summary.iconRiskBacklog}`);
  console.log(`  icon/risk gate:      ${summary.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(summary.gates)}`);
  console.log(`  effective metadata:  ${JSON.stringify(summary.effectiveMetadataGaps)}`);
  console.log(`  declared metadata:   ${JSON.stringify(summary.metadataGaps)} (reported separately; effective marketplace values are derived)`);
  if (reportPath) console.log(`  report:              ${relativePath(reportPath)}`);
}

function printHelp() {
  console.log([
    'Usage: npx tsx scripts/connectors/curation-audit.mjs [options]',
    '',
    'Options:',
    '  --spec-dir <dir>  Audit only this directory; repeat to define the target set.',
    '  --report <file>    Write the complete JSON report to a file.',
    '  --json             Print the complete JSON report to stdout.',
    '  --help             Show this help.',
  ].join('\n'));
}
