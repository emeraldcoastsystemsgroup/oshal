/**
 * Bulk-import OpenAPI catalogs into ADR-067 connector specs.
 *
 * Default source is APIs.guru's list.json, but the script also accepts a local
 * JSON/YAML manifest:
 *   [{ "provider": "acme", "url": "./openapi.yaml", "displayName": "Acme" }]
 *
 * The importer writes draft connector.yaml files plus a JSON report that records
 * every imported/skipped provider. It never enables connectors and never handles
 * credentials; marketplace/audit gates still control runtime exposure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { auditSpec, specFromOpenApi } from '../../src/app/connectors/runtime';

const DEFAULT_APIS_GURU_INDEX = 'https://api.apis.guru/v2/list.json';

interface CatalogItem {
  provider: string;
  url: string;
  displayName?: string;
  version?: string;
  sourceCatalog: string;
}

interface CliOptions {
  authTypes: Set<string> | null;
  concurrency: number;
  dryRun: boolean;
  force: boolean;
  index: string;
  limit: number;
  maxOperations: number;
  outDir: string;
  providerPattern?: RegExp;
  reportPath: string;
  targetImports: number | null;
}

interface ImportReport {
  generatedAt: string;
  index: string;
  outDir: string;
  dryRun: boolean;
  totals: {
    candidates: number;
    imported: number;
    skipped: number;
    failed: number;
    unprocessed: number;
  };
  imported: Array<{ provider: string; output: string; resources: number; tools: number; authType: string; warnings: string[] }>;
  skipped: Array<{ provider: string; reason: string; url?: string }>;
  failed: Array<{ provider: string; error: string; url?: string }>;
}

void main().catch((error) => {
  console.error(`ERROR import-openapi-catalog crashed: ${(error as Error).message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const usedProviders = new Set<string>();
  const candidates = (await loadCatalog(options.index))
    .filter((item) => !options.providerPattern || options.providerPattern.test(item.provider) || options.providerPattern.test(item.displayName || ''))
    .slice(0, options.limit)
    .map((item) => ({ ...item, provider: uniqueProviderSlug(item.provider, usedProviders) }));

  const report: ImportReport = {
    generatedAt: new Date().toISOString(),
    index: options.index,
    outDir: options.outDir,
    dryRun: options.dryRun,
    totals: { candidates: candidates.length, imported: 0, skipped: 0, failed: 0, unprocessed: 0 },
    imported: [],
    skipped: [],
    failed: [],
  };
  let cursor = 0;
  const nextCandidate = (): CatalogItem | null => {
    if (options.targetImports !== null && report.imported.length >= options.targetImports) return null;
    const item = candidates[cursor];
    cursor += 1;
    return item ?? null;
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = nextCandidate();
      if (!item) return;
      await importCandidate(item, options, report);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, candidates.length) }, () => worker()));

  report.totals.imported = report.imported.length;
  report.totals.skipped = report.skipped.length;
  report.totals.failed = report.failed.length;
  report.totals.unprocessed = Math.max(
    0,
    report.totals.candidates - report.totals.imported - report.totals.skipped - report.totals.failed,
  );

  if (!options.dryRun || options.reportPath) {
    mkdirSync(path.dirname(path.resolve(options.reportPath)), { recursive: true });
    writeFileSync(path.resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(`OpenAPI catalog import: ${report.totals.imported} imported, ${report.totals.skipped} skipped, ${report.totals.failed} failed, ${report.totals.unprocessed} unprocessed`);
  console.log(`Report: ${path.relative(process.cwd(), path.resolve(options.reportPath)).replace(/\\/g, '/')}`);
  if (report.failed.length > 0) {
    process.exitCode = 1;
  }
}

async function importCandidate(item: CatalogItem, options: CliOptions, report: ImportReport): Promise<void> {
  const provider = item.provider;
  try {
    const outPath = path.resolve(options.outDir, `${provider}.yaml`);
    if (existsSync(outPath) && !options.force) {
      report.skipped.push({ provider, reason: 'output exists; pass --force to overwrite', url: item.url });
      return;
    }

    const doc = await loadDocument(item.url);
    const { spec, warnings } = specFromOpenApi(provider, doc, {
      displayName: item.displayName,
      icon: iconSlugFromProvider(provider),
      sourceCatalog: item.sourceCatalog,
      sourceUrl: item.url,
    });
    if (options.authTypes && !options.authTypes.has(spec.auth.type)) {
      report.skipped.push({ provider, reason: `auth ${spec.auth.type} not selected`, url: item.url });
      return;
    }
    if (spec.resources.length > options.maxOperations) {
      report.skipped.push({ provider, reason: `operation count ${spec.resources.length} exceeds --max-operations ${options.maxOperations}`, url: item.url });
      return;
    }
    const audit = auditSpec(spec, outPath);
    if (!audit.pass) {
      report.skipped.push({ provider, reason: `audit failed: ${audit.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join('; ')}`, url: item.url });
      return;
    }
    if (options.targetImports !== null && report.imported.length >= options.targetImports) {
      report.skipped.push({ provider, reason: `target import count ${options.targetImports} reached before write`, url: item.url });
      return;
    }

    const output = yaml.dump(spec, { lineWidth: 120, noRefs: true, sortKeys: false });
    if (!options.dryRun) {
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, output, 'utf8');
    }
    report.imported.push({
      provider,
      output: path.relative(process.cwd(), outPath).replace(/\\/g, '/'),
      resources: spec.resources.length,
      tools: spec.resources.filter((resource) => resource.tool).length,
      authType: spec.auth.type,
      warnings,
    });
  } catch (error) {
    report.failed.push({ provider, error: error instanceof Error ? error.message : String(error), url: item.url });
  }
}

async function loadCatalog(index: string): Promise<CatalogItem[]> {
  const raw = await loadDocument(index);
  if (Array.isArray(raw)) {
    return raw
      .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
      .filter((item): item is Record<string, unknown> => Boolean(item?.provider && item?.url))
      .map((item) => ({
        provider: slugify(String(item.provider)),
        url: String(item.url),
        displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
        version: typeof item.version === 'string' ? item.version : undefined,
        sourceCatalog: typeof item.sourceCatalog === 'string' ? item.sourceCatalog : 'manifest',
      }));
  }

  const entries = raw && typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>) : [];
  const candidates: CatalogItem[] = [];
  for (const [apiId, value] of entries) {
    const api = value as { preferred?: string; versions?: Record<string, { swaggerUrl?: string; swaggerYamlUrl?: string; info?: { title?: string } }> };
    const versions = api.versions || {};
    const versionKeys = Object.keys(versions).sort();
    const version = api.preferred && versions[api.preferred]
      ? api.preferred
      : versionKeys[versionKeys.length - 1];
    if (!version) continue;
    const selected = versions[version];
    const url = selected.swaggerUrl || selected.swaggerYamlUrl;
    if (!url) continue;
    candidates.push({
      provider: slugify(apiId),
      url,
      displayName: selected.info?.title,
      version,
      sourceCatalog: 'apis-guru',
    });
  }
  return candidates.sort((left, right) => left.provider.localeCompare(right.provider));
}

async function loadDocument(source: string): Promise<any> {
  const text = await readText(source);
  return yaml.load(text) as unknown;
}

async function readText(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${source}`);
    return response.text();
  }
  const filePath = path.resolve(source);
  return readFileSync(filePath, 'utf8');
}

function uniqueProviderSlug(provider: string, used: Set<string>): string {
  const base = slugify(provider);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function iconSlugFromProvider(provider: string): string {
  return provider
    .replace(/-(com|io|ai|dev|org|net|local|api|apis|events|connect|public|cloud)(-|$).*/i, '')
    .replace(/-(com|io|ai|dev|org|net)$/i, '')
    .replace(/^googleapis-/, 'google')
    || provider;
}

function slugify(value: string): string {
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/\.(json|ya?ml)$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    authTypes: null,
    concurrency: 8,
    dryRun: false,
    force: false,
    index: DEFAULT_APIS_GURU_INDEX,
    limit: 1000,
    maxOperations: 120,
    outDir: path.join('output', 'connectors', 'imported-openapi'),
    reportPath: path.join('output', 'connectors', 'openapi-catalog-import-report.json'),
    targetImports: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--index') {
      options.index = requireValue(arg, next);
      index += 1;
    } else if (arg === '--out-dir') {
      options.outDir = requireValue(arg, next);
      index += 1;
    } else if (arg === '--report') {
      options.reportPath = requireValue(arg, next);
      index += 1;
    } else if (arg === '--limit') {
      options.limit = Number.parseInt(requireValue(arg, next), 10);
      index += 1;
    } else if (arg === '--max-operations') {
      options.maxOperations = Number.parseInt(requireValue(arg, next), 10);
      index += 1;
    } else if (arg === '--concurrency') {
      options.concurrency = Number.parseInt(requireValue(arg, next), 10);
      index += 1;
    } else if (arg === '--target-imports') {
      options.targetImports = Number.parseInt(requireValue(arg, next), 10);
      index += 1;
    } else if (arg === '--provider-filter') {
      options.providerPattern = new RegExp(requireValue(arg, next), 'i');
      index += 1;
    } else if (arg === '--auth-types') {
      options.authTypes = new Set(requireValue(arg, next).split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) throw new Error('--limit must be a positive integer.');
  if (!Number.isInteger(options.maxOperations) || options.maxOperations <= 0) throw new Error('--max-operations must be a positive integer.');
  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) throw new Error('--concurrency must be a positive integer.');
  if (options.targetImports !== null && (!Number.isInteger(options.targetImports) || options.targetImports <= 0)) throw new Error('--target-imports must be a positive integer.');
  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log([
    'Usage: ts-node -r tsconfig-paths/register --transpile-only scripts/connectors/import-openapi-catalog.ts [options]',
    '',
    'Options:',
    `  --index <url|file>          Catalog manifest. Default: ${DEFAULT_APIS_GURU_INDEX}`,
    '  --out-dir <dir>             Output directory. Default: output/connectors/imported-openapi',
    '  --report <file>             JSON report path.',
    '  --limit <n>                 Candidate limit. Default: 1000.',
    '  --target-imports <n>        Stop after this many successful imports within the candidate limit.',
    '  --max-operations <n>        Skip very large specs. Default: 120.',
    '  --concurrency <n>           Parallel OpenAPI downloads/imports. Default: 8.',
    '  --provider-filter <regex>   Import only providers matching this regex.',
    '  --auth-types <csv>          Keep only auth types, e.g. apiKeyHeader,apiKeyQuery,basic,oauth2.',
    '  --force                     Overwrite existing generated specs.',
    '  --dry-run                   Do not write connector specs; still writes the report.',
  ].join('\n'));
}
