/**
 * Enrich generated OpenAPI connector specs with marketplace-ready icons.
 *
 * The bulk importer intentionally creates safe, disabled connector drafts. This
 * second pass makes the catalog feel real without hand-maintaining hundreds of
 * logos: verified Simple Icons slugs when available, provider favicons when not,
 * and an initials fallback when neither can be resolved.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { ConnectorSpec } from '../../src/app/connectors/runtime/spec';

const SIMPLE_ICONS_CATALOG_URL = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/_data/simple-icons.json';

interface CliOptions {
  catalogUrl: string;
  dryRun: boolean;
  limit: number | null;
  reportPath: string;
  specDir: string;
}

interface SimpleIconRecord {
  title: string;
  slug: string;
  terms: string[];
}

interface SimpleIconIndex {
  bySlug: Map<string, SimpleIconRecord>;
  byTerm: Map<string, SimpleIconRecord>;
}

interface IconReportEntry {
  provider: string;
  source: 'simple-icons' | 'favicon-fallback' | 'initials-fallback' | 'failed';
  icon?: string;
  iconTitle?: string;
  iconUrl?: string;
  changed: boolean;
  error?: string;
}

interface IconReport {
  generatedAt: string;
  specDir: string;
  catalogUrl: string;
  dryRun: boolean;
  totals: {
    specs: number;
    simpleIcons: number;
    faviconFallbacks: number;
    initialsFallbacks: number;
    changed: number;
    failed: number;
  };
  entries: IconReportEntry[];
}

const GENERIC_PROVIDER_WORDS = new Set([
  'api',
  'apis',
  'app',
  'apps',
  'cloud',
  'com',
  'connect',
  'developer',
  'developers',
  'dev',
  'docs',
  'events',
  'gateway',
  'global',
  'io',
  'local',
  'net',
  'openapi',
  'org',
  'portal',
  'public',
  'rest',
  'service',
  'services',
  'swagger',
  'v1',
  'v2',
  'v3',
]);

const CURATED_ICON_BY_TERM: Record<string, string> = {
  '1password': '1password',
  activemq: 'apacheactivemq',
  adobesign: 'adobeacrobatreader',
  amazonaws: 'amazonaws',
  apollo: 'apollographql',
  aws: 'amazonaws',
  azure: 'microsoftazure',
  bitbucket: 'bitbucket',
  box: 'box',
  cloudflare: 'cloudflare',
  confluence: 'confluence',
  dockerhub: 'docker',
  facebook: 'facebook',
  github: 'github',
  gitlab: 'gitlab',
  googleapis: 'google',
  kubernetes: 'kubernetes',
  linkedin: 'linkedin',
  microsoftgraph: 'microsoft',
  microsoftonline: 'microsoft',
  mongodb: 'mongodb',
  mysql: 'mysql',
  okta: 'okta',
  openshift: 'redhatopenshift',
  paypal: 'paypal',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  rabbitmq: 'rabbitmq',
  redhat: 'redhat',
  salesforce: 'salesforce',
  sendgrid: 'sendgrid',
  shopify: 'shopify',
  stackexchange: 'stackexchange',
  twilio: 'twilio',
  twitter: 'x',
  wordpress: 'wordpress',
  youtube: 'youtube',
};

const CURATED_FAVICON_DOMAIN_BY_TERM: Record<string, string> = {
  activecampaign: 'activecampaign.com',
  chargebee: 'chargebee.com',
  docusign: 'docusign.com',
  freshdesk: 'freshdesk.com',
  gorgias: 'gorgias.com',
  healthchecks: 'healthchecks.io',
  liveagent: 'liveagent.com',
  loggly: 'loggly.com',
  logzio: 'logz.io',
  nocodb: 'nocodb.com',
  pipedrive: 'pipedrive.com',
  plivo: 'plivo.com',
  qdrant: 'qdrant.tech',
  reamaze: 'reamaze.com',
  servicenow: 'servicenow.com',
  teamwork: 'teamwork.com',
  workable: 'workable.com',
};

void main().catch((error) => {
  console.error(`ERROR enrich-openapi-icons crashed: ${(error as Error).message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const index = await loadSimpleIcons(options.catalogUrl);
  const files = specFiles(options.specDir).slice(0, options.limit ?? undefined);
  const report: IconReport = {
    generatedAt: new Date().toISOString(),
    specDir: path.resolve(options.specDir),
    catalogUrl: options.catalogUrl,
    dryRun: options.dryRun,
    totals: { specs: files.length, simpleIcons: 0, faviconFallbacks: 0, initialsFallbacks: 0, changed: 0, failed: 0 },
    entries: [],
  };

  for (const file of files) {
    const entry = enrichFile(file, index, options);
    report.entries.push(entry);
    if (entry.source === 'simple-icons') report.totals.simpleIcons += 1;
    if (entry.source === 'favicon-fallback') report.totals.faviconFallbacks += 1;
    if (entry.source === 'initials-fallback') report.totals.initialsFallbacks += 1;
    if (entry.source === 'failed') report.totals.failed += 1;
    if (entry.changed) report.totals.changed += 1;
  }

  mkdirSync(path.dirname(path.resolve(options.reportPath)), { recursive: true });
  writeFileSync(path.resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Connector icon enrichment: ${report.totals.simpleIcons} verified Simple Icons, ${report.totals.faviconFallbacks} favicon fallbacks, ${report.totals.initialsFallbacks} initials fallbacks, ${report.totals.failed} failed`);
  console.log(`Changed: ${report.totals.changed}/${report.totals.specs}`);
  console.log(`Report: ${path.relative(process.cwd(), path.resolve(options.reportPath)).replace(/\\/g, '/')}`);
  if (report.totals.failed > 0) process.exitCode = 1;
}

function enrichFile(file: string, index: SimpleIconIndex, options: CliOptions): IconReportEntry {
  try {
    const original = readFileSync(file, 'utf8');
    const spec = yaml.load(original) as ConnectorSpec;
    if (!spec || typeof spec !== 'object' || !spec.provider) {
      throw new Error('not a connector spec');
    }
    spec.metadata = spec.metadata || {};
    const before = JSON.stringify(spec.metadata);
    const match = resolveSimpleIcon(spec, index);
    if (match) {
      spec.metadata.icon = match.slug;
      spec.metadata.iconTitle = match.title;
      spec.metadata.iconSource = 'simple-icons';
      spec.metadata.iconVerified = true;
      delete spec.metadata.iconUrl;
    } else {
      delete spec.metadata.icon;
      delete spec.metadata.iconTitle;
      spec.metadata.iconVerified = false;
      const faviconDomain = domainForFavicon(spec);
      if (faviconDomain) {
        spec.metadata.iconSource = 'favicon-fallback';
        spec.metadata.iconUrl = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(faviconDomain)}.ico`;
      } else {
        spec.metadata.iconSource = 'initials-fallback';
        delete spec.metadata.iconUrl;
      }
    }

    const changed = before !== JSON.stringify(spec.metadata);
    if (changed && !options.dryRun) {
      const output = yaml.dump(spec, { lineWidth: 120, noRefs: true, sortKeys: false });
      writeFileSync(file, output, 'utf8');
    }

    return {
      provider: spec.provider,
      source: match ? 'simple-icons' : spec.metadata.iconSource === 'favicon-fallback' ? 'favicon-fallback' : 'initials-fallback',
      icon: spec.metadata.icon,
      iconTitle: spec.metadata.iconTitle,
      iconUrl: spec.metadata.iconUrl,
      changed,
    };
  } catch (error) {
    return {
      provider: path.basename(file, path.extname(file)),
      source: 'failed',
      changed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadSimpleIcons(catalogUrl: string): Promise<SimpleIconIndex> {
  const raw = await readText(catalogUrl);
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  const records = parsed
    .filter((item) => typeof item.title === 'string')
    .map((item): SimpleIconRecord => {
      const title = String(item.title);
      const aliasTerms = collectAliasStrings(item.aliases);
      const slug = simpleIconSlug(title);
      return {
        title,
        slug,
        terms: uniqueStrings([title, slug, ...aliasTerms]),
      };
    });
  const bySlug = new Map<string, SimpleIconRecord>();
  const byTerm = new Map<string, SimpleIconRecord>();
  for (const record of records) {
    bySlug.set(record.slug, record);
    for (const term of record.terms) {
      byTerm.set(simpleIconSlug(term), record);
      byTerm.set(normalizeProviderTerm(term), record);
    }
  }
  return { bySlug, byTerm };
}

function resolveSimpleIcon(spec: ConnectorSpec, index: SimpleIconIndex): SimpleIconRecord | null {
  const candidates = iconCandidates(spec);
  for (const candidate of candidates) {
    const normalized = normalizeProviderTerm(candidate);
    const curated = CURATED_ICON_BY_TERM[normalized];
    if (curated && index.bySlug.has(curated)) return index.bySlug.get(curated) ?? null;
    const slug = simpleIconSlug(candidate);
    if (index.bySlug.has(slug)) return index.bySlug.get(slug) ?? null;
    if (index.byTerm.has(slug)) return index.byTerm.get(slug) ?? null;
    if (index.byTerm.has(normalized)) return index.byTerm.get(normalized) ?? null;
  }
  return null;
}

function iconCandidates(spec: ConnectorSpec): string[] {
  const values: string[] = [];
  push(values, spec.metadata?.icon);
  push(values, spec.displayName);
  push(values, spec.provider);
  push(values, domainBrand(spec.metadata?.website));
  push(values, domainBrand(spec.baseUrl));
  push(values, apiGuruProvider(spec.metadata?.sourceUrl));
  for (const term of providerTerms(spec.provider)) push(values, term);
  return uniqueStrings(values);
}

function providerTerms(provider: string): string[] {
  const cleaned = provider
    .replace(/-dot-/g, '-')
    .replace(/^googleapis-/, 'google-')
    .replace(/-(com|io|ai|dev|org|net|local|api|apis)(-|$).*/i, '')
    .replace(/-(com|io|ai|dev|org|net)$/i, '');
  const tokens = cleaned.split(/[-_.]+/g).filter((token) => token && !GENERIC_PROVIDER_WORDS.has(token));
  const terms: string[] = [cleaned, tokens.join('')];
  for (let length = Math.min(4, tokens.length); length >= 1; length -= 1) {
    terms.push(tokens.slice(0, length).join(' '));
    terms.push(tokens.slice(0, length).join(''));
  }
  return terms;
}

function domainForFavicon(spec: ConnectorSpec): string | null {
  return normalizedHost(spec.metadata?.website)
    || normalizedHost(spec.baseUrl)
    || normalizedHost(spec.metadata?.sourceUrl)
    || curatedFaviconDomain(spec);
}

function curatedFaviconDomain(spec: ConnectorSpec): string | null {
  for (const candidate of iconCandidates(spec)) {
    const domain = CURATED_FAVICON_DOMAIN_BY_TERM[normalizeProviderTerm(candidate)];
    if (domain) return domain;
  }
  return null;
}

function domainBrand(source: string | undefined): string | null {
  const host = normalizedHost(source);
  if (!host) return null;
  if (host.endsWith('.appspot.com')) {
    return host.split('.')[0]?.replace(/^\d+-dot-/, '').replace(/-dot-/g, '-') || null;
  }
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] ?? null;
  return parts[parts.length - 2] || null;
}

function normalizedHost(source: string | undefined): string | null {
  if (!source) return null;
  try {
    const host = new URL(source).hostname.toLowerCase();
    if (!host || host === 'api.apis.guru') return null;
    const stripped = host
      .replace(/^(www\d?|api|apis|developer|developers|docs|support|portal|gateway|app|apps|cloud)\./, '')
      .replace(/^api-/, '');
    return stripped || host;
  } catch {
    return null;
  }
}

function apiGuruProvider(source: string | undefined): string | null {
  if (!source || !source.includes('/specs/')) return null;
  const match = source.match(/\/specs\/([^/]+)/);
  return match ? match[1].replace(/\./g, '-') : null;
}

async function readText(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${source}`);
    return response.text();
  }
  return readFileSync(path.resolve(source), 'utf8');
}

function specFiles(specDir: string): string[] {
  const dir = path.resolve(specDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .map((file) => path.join(dir, file))
    .sort((left, right) => left.localeCompare(right));
}

function collectAliasStrings(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectAliasStrings(item));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap((item) => collectAliasStrings(item));
  return [];
}

function normalizeProviderTerm(value: string): string {
  return simpleIconSlug(value)
    .replace(/^the/, '')
    .replace(/(api|apis|app|apps|cloud|connect|developer|developers|dev|docs|events|gateway|openapi|public|rest|service|services|swagger)$/g, '');
}

function simpleIconSlug(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/@/g, 'at')
    .replace(/\./g, 'dot')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase();
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean)));
}

function push(values: string[], value: string | undefined | null): void {
  if (value && String(value).trim()) values.push(String(value).trim());
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    catalogUrl: SIMPLE_ICONS_CATALOG_URL,
    dryRun: false,
    limit: null,
    reportPath: path.join('output', 'connectors', 'icon-enrichment-report.json'),
    specDir: path.join('output', 'connectors', 'imported-openapi'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--catalog') {
      options.catalogUrl = requireValue(arg, next);
      index += 1;
    } else if (arg === '--spec-dir') {
      options.specDir = requireValue(arg, next);
      index += 1;
    } else if (arg === '--report') {
      options.reportPath = requireValue(arg, next);
      index += 1;
    } else if (arg === '--limit') {
      options.limit = Number.parseInt(requireValue(arg, next), 10);
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('--limit must be a positive integer.');
  }
  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp(): void {
  console.log([
    'Usage: ts-node -r tsconfig-paths/register --transpile-only scripts/connectors/enrich-openapi-icons.ts [options]',
    '',
    'Options:',
    `  --catalog <url|file>  Simple Icons JSON catalog. Default: ${SIMPLE_ICONS_CATALOG_URL}`,
    '  --spec-dir <dir>      Generated connector spec directory. Default: output/connectors/imported-openapi',
    '  --report <file>       JSON report path. Default: output/connectors/icon-enrichment-report.json',
    '  --limit <n>           Enrich only the first n specs.',
    '  --dry-run             Build report without writing specs.',
  ].join('\n'));
}
