/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add a per-user enablement OVERRIDE layer on top of the deployment-global marketplace state (BACKLOG.md:2718): optional pool + enableProviderForUser / disableProviderForUser / isEnabledForUser / enabledProviderSetForUser / userEnablementRows, delegating to user-enablement-store. NON-BREAKING — a connector is usable for a user when deployment-enabled AND NOT explicitly user-disabled; absence of a per-user row = allowed, so existing credentialed connectors never regress. Deployment routes/state untouched.
 *
 * @module marketplace
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import { actionProfilesForSpec, type ConnectorActionProfile } from './action-safety';
import { auditSpec, type ConnectorAudit } from './catalog-audit';
import { loadConnectorSpec, type ConnectorSpec } from './spec';
import {
  readConnectorUserEnablement,
  readConnectorUserDisabledProviders,
  setConnectorUserEnablement,
} from './user-enablement-store';

export type ConnectorInstallState = 'available' | 'enabled' | 'disabled' | 'removed' | 'blocked';
export type ConnectorRiskLevel = 'low' | 'medium' | 'high';
export type ConnectorOnboardingMode = 'user-key' | 'oauth-app' | 'basic-auth' | 'no-auth';

export interface ConnectorMarketplaceState {
  version: 1;
  enabledProviders: string[];
  disabledProviders: string[];
  removedProviders: string[];
  updatedAt: string;
}

interface ConnectorMarketplaceDiskCache {
  version: 2;
  signature: string;
  generatedAt: string;
  entries: ConnectorMarketplaceEntry[];
}

export interface ConnectorMarketplaceEntry {
  id: string;
  label: string;
  category: string;
  description?: string;
  tags: string[];
  icon?: string;
  iconTitle?: string;
  iconSource?: string;
  iconVerified?: boolean;
  iconUrl?: string;
  website?: string;
  authType: ConnectorSpec['auth']['type'];
  credProvider: string;
  onboarding: {
    mode: ConnectorOnboardingMode;
    label: string;
    description: string;
    credentialScope: 'per-user' | 'operator' | 'none';
    setupLevel: 'self-serve' | 'operator-assisted' | 'none';
  };
  source: {
    type: 'local-spec';
    path: string;
  };
  installState: ConnectorInstallState;
  enabled: boolean;
  riskLevel: ConnectorRiskLevel;
  scopes: string[];
  resourceCount: number;
  toolCount: number;
  readCount: number;
  writeCount: number;
  destructiveCount: number;
  actions: ConnectorActionProfile[];
  audit: {
    pass: boolean;
    errors: number;
    warnings: number;
    issues: ConnectorAudit['issues'];
  };
}

export interface ConnectorMarketplaceSummary {
  generatedAt: string;
  totals: {
    entries: number;
    enabled: number;
    available: number;
    disabled: number;
    removed: number;
    blocked: number;
    highRisk: number;
    writeCapable: number;
    actionCount: number;
  };
  entries: ConnectorMarketplaceEntry[];
}

export interface ConnectorMarketplaceOptions {
  specDir?: string;
  specDirs?: string[];
  statePath?: string;
  cachePath?: string;
  defaultEnabledProviders?: Iterable<string>;
  defaultEnableAll?: boolean;
  /**
   * Postgres pool backing the per-user enablement override layer
   * (enableProviderForUser / isEnabledForUser / …). Optional: the deployment-global
   * catalog + state are file-based and work without it. When absent, the per-user read
   * methods degrade to the deployment gate (default-allow) and the write methods throw.
   */
  pool?: Pool | null;
}

const DEFAULT_SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');
const DEFAULT_IMPORTED_SPEC_DIR = path.join(process.cwd(), 'output/connectors/imported-openapi');
const DEFAULT_STATE_PATH = path.join(process.cwd(), 'output', 'connector-marketplace-state.json');
const DEFAULT_CACHE_PATH = path.join(process.cwd(), 'output', 'connectors', 'marketplace-catalog-cache.json');
const DEFAULT_CACHE_TTL_MS = 30_000;
const MARKETPLACE_CACHE_VERSION = 2;

const CATEGORY_BY_PROVIDER: Record<string, string> = {
  airtable: 'Productivity',
  asana: 'Project management',
  bitbucket: 'Developer tools',
  buttondown: 'Marketing',
  calendly: 'Scheduling',
  clickup: 'Project management',
  coinbase: 'Finance',
  datadog: 'Operations',
  'defender-cloud': 'Security',
  discord: 'Communications',
  dropbox: 'Files',
  dynatrace: 'Operations',
  'elastic-security': 'Security',
  figma: 'Design',
  fitbit: 'Health',
  github: 'Developer tools',
  gitlab: 'Developer tools',
  gmail: 'Email',
  'google-calendar': 'Scheduling',
  'google-drive': 'Files',
  gumroad: 'Commerce',
  hubspot: 'CRM',
  intercom: 'Support',
  jira: 'Project management',
  monzo: 'Finance',
  newrelic: 'Operations',
  notion: 'Knowledge',
  openai: 'AI',
  oura: 'Health',
  outlook: 'Email',
  pagerduty: 'Operations',
  pinterest: 'Social',
  postmark: 'Email',
  raindrop: 'Knowledge',
  sentinel: 'Security',
  servicenow: 'Operations',
  sendgrid: 'Email',
  sentry: 'Operations',
  shippo: 'Commerce',
  slack: 'Communications',
  spotify: 'Media',
  stripe: 'Payments',
  strava: 'Health',
  tenable: 'Security',
  tmdb: 'Media',
  todoist: 'Productivity',
  twitter: 'Social',
  unsplash: 'Media',
  vercel: 'Developer tools',
  virustotal: 'Security',
  wakatime: 'Developer tools',
  whoop: 'Health',
  youtube: 'Media',
  zoom: 'Communications',
};

const SIMPLE_ICON_BY_PROVIDER: Record<string, string> = {
  airtable: 'airtable',
  asana: 'asana',
  bitbucket: 'bitbucket',
  buttondown: 'buttondown',
  calendly: 'calendly',
  clickup: 'clickup',
  coinbase: 'coinbase',
  datadog: 'datadog',
  discord: 'discord',
  dropbox: 'dropbox',
  dynatrace: 'dynatrace',
  'elastic-security': 'elastic',
  figma: 'figma',
  fitbit: 'fitbit',
  github: 'github',
  gitlab: 'gitlab',
  gmail: 'gmail',
  'google-calendar': 'googlecalendar',
  'google-drive': 'googledrive',
  gumroad: 'gumroad',
  hubspot: 'hubspot',
  intercom: 'intercom',
  jira: 'jira',
  monzo: 'monzo',
  netlify: 'netlify',
  newrelic: 'newrelic',
  notion: 'notion',
  openai: 'openai',
  pagerduty: 'pagerduty',
  pinterest: 'pinterest',
  postmark: 'postmark',
  sendgrid: 'sendgrid',
  sentry: 'sentry',
  servicenow: 'servicenow',
  slack: 'slack',
  spotify: 'spotify',
  stripe: 'stripe',
  strava: 'strava',
  tmdb: 'themoviedatabase',
  todoist: 'todoist',
  twitter: 'x',
  unsplash: 'unsplash',
  vercel: 'vercel',
  virustotal: 'virustotal',
  wakatime: 'wakatime',
  youtube: 'youtube',
  zoom: 'zoom',
};

const FAVICON_DOMAIN_BY_PROVIDER: Record<string, string> = {
  'defender-cloud': 'azure.microsoft.com',
  outlook: 'outlook.office.com',
  sentinel: 'azure.microsoft.com',
  oura: 'ouraring.com',
  raindrop: 'raindrop.io',
  shippo: 'goshippo.com',
  tenable: 'tenable.com',
  whoop: 'whoop.com',
};

export class ConnectorMarketplaceService {
  private readonly specDirs: string[];
  private readonly statePath: string;
  private readonly cachePath: string;
  private readonly defaultEnabledProviders: Set<string>;
  private readonly defaultEnableAll: boolean;
  private readonly cacheTtlMs: number;
  private readonly pool: Pool | null;
  private cache: { expiresAt: number; signature: string; entries: ConnectorMarketplaceEntry[] } | null = null;

  constructor(options: ConnectorMarketplaceOptions = {}) {
    this.specDirs = resolveSpecDirs(options);
    this.statePath = options.statePath ?? process.env.CONNECTOR_MARKETPLACE_STATE_PATH ?? DEFAULT_STATE_PATH;
    this.cachePath = options.cachePath ?? process.env.CONNECTOR_MARKETPLACE_CACHE_PATH ?? DEFAULT_CACHE_PATH;
    this.pool = options.pool ?? null;
    this.defaultEnabledProviders = new Set([
      ...parseCsv(process.env.CONNECTOR_ENABLED_PROVIDERS),
      ...(options.defaultEnabledProviders ? Array.from(options.defaultEnabledProviders) : []),
    ]);
    this.defaultEnableAll = options.defaultEnableAll ?? process.env.CONNECTOR_MARKETPLACE_DEFAULT_ENABLED === 'all';
    this.cacheTtlMs = positiveInt(process.env.CONNECTOR_MARKETPLACE_CACHE_TTL_MS) ?? DEFAULT_CACHE_TTL_MS;
  }

  list(): ConnectorMarketplaceSummary {
    const entries = this.loadEntriesCached();
    return {
      generatedAt: new Date().toISOString(),
      totals: {
        entries: entries.length,
        enabled: entries.filter((entry) => entry.installState === 'enabled').length,
        available: entries.filter((entry) => entry.installState === 'available').length,
        disabled: entries.filter((entry) => entry.installState === 'disabled').length,
        removed: entries.filter((entry) => entry.installState === 'removed').length,
        blocked: entries.filter((entry) => entry.installState === 'blocked').length,
        highRisk: entries.filter((entry) => entry.riskLevel === 'high').length,
        writeCapable: entries.filter((entry) => entry.writeCount > 0).length,
        actionCount: entries.reduce((sum, entry) => sum + entry.actions.length, 0),
      },
      entries,
    };
  }

  get(provider: string): ConnectorMarketplaceEntry | null {
    return this.list().entries.find((entry) => entry.id === provider) ?? null;
  }

  enableProvider(provider: string): ConnectorMarketplaceEntry {
    const entry = this.get(provider);
    if (!entry) {
      throw new Error(`Connector '${provider}' is not in the local marketplace catalog.`);
    }
    if (!entry.audit.pass) {
      throw new Error(`Connector '${provider}' failed the audit gate and cannot be enabled.`);
    }
    const state = this.readState();
    const enabled = new Set(state.enabledProviders);
    const disabled = new Set(state.disabledProviders);
    const removed = new Set(state.removedProviders);
    enabled.add(provider);
    disabled.delete(provider);
    removed.delete(provider);
    this.writeState({ enabledProviders: enabled, disabledProviders: disabled, removedProviders: removed });
    return this.get(provider) ?? entry;
  }

  disableProvider(provider: string): ConnectorMarketplaceEntry {
    const entry = this.get(provider);
    if (!entry) {
      throw new Error(`Connector '${provider}' is not in the local marketplace catalog.`);
    }
    const state = this.readState();
    const enabled = new Set(state.enabledProviders);
    const disabled = new Set(state.disabledProviders);
    const removed = new Set(state.removedProviders);
    enabled.delete(provider);
    disabled.add(provider);
    removed.delete(provider);
    this.writeState({ enabledProviders: enabled, disabledProviders: disabled, removedProviders: removed });
    return this.get(provider) ?? entry;
  }

  removeProvider(provider: string): ConnectorMarketplaceEntry {
    const entry = this.get(provider);
    if (!entry) {
      throw new Error(`Connector '${provider}' is not in the local marketplace catalog.`);
    }
    const state = this.readState();
    const enabled = new Set(state.enabledProviders);
    const disabled = new Set(state.disabledProviders);
    const removed = new Set(state.removedProviders);
    enabled.delete(provider);
    disabled.delete(provider);
    removed.add(provider);
    this.writeState({ enabledProviders: enabled, disabledProviders: disabled, removedProviders: removed });
    return this.get(provider) ?? { ...entry, installState: 'removed', enabled: false };
  }

  refreshProviderAudit(provider: string): ConnectorMarketplaceEntry {
    this.cache = null;
    const entry = this.get(provider);
    if (!entry) {
      throw new Error(`Connector '${provider}' is not in the local marketplace catalog.`);
    }
    if (!entry.audit.pass) {
      const state = this.readState();
      const enabled = new Set(state.enabledProviders);
      if (enabled.delete(provider)) {
        this.writeState({
          enabledProviders: enabled,
          disabledProviders: new Set(state.disabledProviders),
          removedProviders: new Set(state.removedProviders),
        });
      }
    }
    return this.get(provider) ?? entry;
  }

  isProviderEnabled(provider: string): boolean {
    return this.get(provider)?.enabled === true;
  }

  enabledProviderSet(): Set<string> {
    if (this.defaultEnableAll) {
      return new Set(this.list().entries.filter((entry) => entry.enabled).map((entry) => entry.id));
    }
    const state = this.readState();
    const enabled = new Set([...state.enabledProviders, ...this.defaultEnabledProviders]);
    for (const provider of state.disabledProviders) enabled.delete(provider);
    for (const provider of state.removedProviders) enabled.delete(provider);
    return enabled;
  }

  /**
   * @description Record an explicit per-user opt-in for a connector (an `enabled=true` override).
   * This is a surfacing/opt-in marker — usability still requires the connector to be
   * deployment-enabled. Requires a pool (throws if the service was built without one).
   * @param userSub - the authenticated caller's OIDC sub (owner of the override)
   * @param provider - connector provider slug
   * @returns resolves when the override is persisted
   */
  async enableProviderForUser(userSub: string, provider: string): Promise<void> {
    await setConnectorUserEnablement(this.requirePool(), userSub, provider, true);
  }

  /**
   * @description Block a connector for one caller only (an `enabled=false` override). The
   * deployment state and every other user are unaffected. Requires a pool.
   * @param userSub - the authenticated caller's OIDC sub
   * @param provider - connector provider slug
   * @returns resolves when the override is persisted
   */
  async disableProviderForUser(userSub: string, provider: string): Promise<void> {
    await setConnectorUserEnablement(this.requirePool(), userSub, provider, false);
  }

  /**
   * @description Whether a connector is usable for one caller. NON-BREAKING semantics:
   * deployment-enabled AND NOT explicitly user-disabled. Absence of a per-user row = allowed,
   * so existing users who never toggled keep working. The deployment gate wins for everyone —
   * a deployment-disabled connector is off regardless of any per-user row. Fail-open on the
   * per-user read (a store error defaults to allow), and pool-less services fall back to the
   * deployment gate only.
   * @param userSub - the caller's OIDC sub
   * @param provider - connector provider slug
   * @returns true when the caller may use the connector
   */
  async isEnabledForUser(userSub: string, provider: string): Promise<boolean> {
    if (!this.enabledProviderSet().has(provider)) return false;
    if (!this.pool || !userSub) return true;
    const disabled = await readConnectorUserDisabledProviders(this.pool, userSub);
    return !disabled.has(provider);
  }

  /**
   * @description The effective set of connectors usable for one caller: the deployment-enabled
   * set MINUS the caller's explicitly-disabled providers. Pool-less / no-sub falls back to the
   * deployment set (default-allow).
   * @param userSub - the caller's OIDC sub
   * @returns the caller's usable provider ids
   */
  async enabledProviderSetForUser(userSub: string): Promise<Set<string>> {
    const deployment = this.enabledProviderSet();
    if (!this.pool || !userSub) return deployment;
    const disabled = await readConnectorUserDisabledProviders(this.pool, userSub);
    return new Set([...deployment].filter((provider) => !disabled.has(provider)));
  }

  /**
   * @description The caller's explicit per-user overrides (only providers they have toggled),
   * for the my-enablement surface. Empty for a pool-less service or a user with no overrides.
   * @param userSub - the caller's OIDC sub
   * @returns provider → explicit enabled flag
   */
  async userEnablementRows(userSub: string): Promise<Array<{ provider: string; enabled: boolean }>> {
    if (!this.pool || !userSub) return [];
    const overrides = await readConnectorUserEnablement(this.pool, userSub);
    return Array.from(overrides, ([provider, enabled]) => ({ provider, enabled }));
  }

  /**
   * @description Assert a pool is present for a per-user WRITE, with a clear error otherwise.
   * @returns the backing pool
   */
  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('Per-user connector enablement requires a database pool; this marketplace service was built without one.');
    }
    return this.pool;
  }

  private loadEntriesCached(): ConnectorMarketplaceEntry[] {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.entries;
    const files = this.specFiles();
    const signature = this.cacheSignature(files);
    const cached = this.readDiskCache(signature);
    if (cached) {
      this.cache = { entries: cached, signature, expiresAt: now + this.cacheTtlMs };
      return cached;
    }
    const entries = this.loadEntries(files);
    this.writeDiskCache(signature, entries);
    this.cache = { entries, signature, expiresAt: now + this.cacheTtlMs };
    return entries;
  }

  private loadEntries(files = this.specFiles()): ConnectorMarketplaceEntry[] {
    const state = this.readState();
    const enabled = new Set([...state.enabledProviders, ...this.defaultEnabledProviders]);
    const disabled = new Set(state.disabledProviders);
    const removed = new Set(state.removedProviders);
    const byId = new Map<string, ConnectorMarketplaceEntry>();
    for (const file of files) {
      const entry = this.entryFromFile(file, enabled, disabled, removed);
      if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
    return Array.from(byId.values()).sort((left, right) => left.label.localeCompare(right.label));
  }

  private cacheSignature(files: string[]): string {
    const state = this.readState();
    const fileParts = files.map((file) => {
      try {
        const stat = statSync(file);
        return `${path.relative(process.cwd(), file).replace(/\\/g, '/')}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
      } catch {
        return `${path.relative(process.cwd(), file).replace(/\\/g, '/')}:missing`;
      }
    });
    return JSON.stringify({
      version: 1,
      entrySchemaVersion: MARKETPLACE_CACHE_VERSION,
      specDirs: this.specDirs,
      state: {
        enabledProviders: state.enabledProviders,
        disabledProviders: state.disabledProviders,
        removedProviders: state.removedProviders,
        updatedAt: state.updatedAt,
      },
      defaultEnabledProviders: Array.from(this.defaultEnabledProviders).sort(),
      defaultEnableAll: this.defaultEnableAll,
      files: fileParts,
    });
  }

  private readDiskCache(signature: string): ConnectorMarketplaceEntry[] | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<ConnectorMarketplaceDiskCache>;
      if (parsed.version !== MARKETPLACE_CACHE_VERSION || parsed.signature !== signature || !Array.isArray(parsed.entries)) return null;
      return parsed.entries;
    } catch {
      return null;
    }
  }

  private writeDiskCache(signature: string, entries: ConnectorMarketplaceEntry[]): void {
    try {
      mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const payload: ConnectorMarketplaceDiskCache = {
        version: MARKETPLACE_CACHE_VERSION,
        signature,
        generatedAt: new Date().toISOString(),
        entries,
      };
      writeFileSync(this.cachePath, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch {
      // Disk cache is a performance optimization only; the live catalog remains authoritative.
    }
  }

  private entryFromFile(
    file: string,
    enabled: Set<string>,
    disabled: Set<string>,
    removed: Set<string>,
  ): ConnectorMarketplaceEntry | null {
    const sourcePath = file;
    let spec: ConnectorSpec;
    try {
      spec = loadConnectorSpec(sourcePath);
    } catch {
      return null;
    }
    const audit = auditSpec(spec, sourcePath);
    const actions = actionProfilesForSpec(spec);
    const providerEnabled = !disabled.has(spec.provider) && (enabled.has(spec.provider) || this.defaultEnableAll);
    const writeCount = actions.filter((action) => action.actionType === 'write').length;
    const destructiveCount = actions.filter((action) => action.actionType === 'destructive').length;
    const readCount = actions.filter((action) => action.actionType === 'read').length;
    const curatedIcon = SIMPLE_ICON_BY_PROVIDER[spec.provider];
    const curatedFaviconDomain = FAVICON_DOMAIN_BY_PROVIDER[spec.provider];
    const installState: ConnectorInstallState = !audit.pass
      ? 'blocked'
      : removed.has(spec.provider)
        ? 'removed'
      : providerEnabled
        ? 'enabled'
        : disabled.has(spec.provider)
          ? 'disabled'
          : 'available';
    return {
      id: spec.provider,
      label: spec.displayName || toTitle(spec.provider),
      category: CATEGORY_BY_PROVIDER[spec.provider] ?? inferCategory(spec),
      description: spec.metadata?.description,
      tags: tagsFor(spec, actions),
      icon: spec.metadata?.icon || curatedIcon,
      iconTitle: spec.metadata?.iconTitle,
      iconSource: spec.metadata?.iconSource || (curatedIcon ? 'simple-icons-curated' : curatedFaviconDomain ? 'favicon-curated' : undefined),
      iconVerified: spec.metadata?.iconVerified ?? Boolean(curatedIcon),
      iconUrl: spec.metadata?.iconUrl || (curatedFaviconDomain ? `https://icons.duckduckgo.com/ip3/${curatedFaviconDomain}.ico` : undefined),
      website: spec.metadata?.website,
      authType: spec.auth.type,
      credProvider: spec.credProvider || spec.provider,
      onboarding: onboardingFor(spec),
      source: {
        type: 'local-spec',
        path: path.relative(process.cwd(), sourcePath).replace(/\\/g, '/'),
      },
      installState,
      enabled: installState === 'enabled',
      riskLevel: riskLevel(spec, writeCount + destructiveCount),
      scopes: scopesFor(spec),
      resourceCount: spec.resources.length,
      toolCount: spec.resources.filter((resource) => Boolean(resource.tool)).length,
      readCount,
      writeCount,
      destructiveCount,
      actions,
      audit: {
        pass: audit.pass,
        errors: audit.issues.filter((issue) => issue.level === 'error').length,
        warnings: audit.issues.filter((issue) => issue.level === 'warn').length,
        issues: audit.issues,
      },
    };
  }

  private specFiles(): string[] {
    const files: string[] = [];
    for (const dir of this.specDirs) {
      try {
        for (const file of readdirSync(dir)) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) files.push(path.join(dir, file));
        }
      } catch {
        // Generated import dirs may not exist until the operator runs the bulk importer.
      }
    }
    return files.sort((left, right) => left.localeCompare(right));
  }

  private readState(): ConnectorMarketplaceState {
    if (!existsSync(this.statePath)) {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<ConnectorMarketplaceState>;
      return {
        version: 1,
        enabledProviders: uniqueStrings(parsed.enabledProviders),
        disabledProviders: uniqueStrings(parsed.disabledProviders),
        removedProviders: uniqueStrings(parsed.removedProviders),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      };
    } catch {
      return emptyState();
    }
  }

  private writeState(next: {
    enabledProviders: Set<string>;
    disabledProviders: Set<string>;
    removedProviders: Set<string>;
  }): void {
    this.cache = null;
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    const state: ConnectorMarketplaceState = {
      version: 1,
      enabledProviders: Array.from(next.enabledProviders).sort(),
      disabledProviders: Array.from(next.disabledProviders).sort(),
      removedProviders: Array.from(next.removedProviders).sort(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

function emptyState(): ConnectorMarketplaceState {
  return {
    version: 1,
    enabledProviders: [],
    disabledProviders: [],
    removedProviders: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))).sort()
    : [];
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveSpecDirs(options: ConnectorMarketplaceOptions): string[] {
  const explicitSpecDirs = Boolean(options.specDir || options.specDirs?.length);
  const configured = [
    options.specDir ?? DEFAULT_SPEC_DIR,
    ...(options.specDirs ?? []),
    ...parsePathList(process.env.CONNECTOR_SPEC_DIRS),
  ];
  if (!explicitSpecDirs && existsSync(DEFAULT_IMPORTED_SPEC_DIR)) configured.push(DEFAULT_IMPORTED_SPEC_DIR);
  return Array.from(new Set(configured.map((dir) => path.resolve(dir))));
}

function parsePathList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[;,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferCategory(spec: ConnectorSpec): string {
  const text = `${spec.provider} ${(spec.displayName ?? '')}`.toLowerCase();
  if (/mail|email|postmark|sendgrid/.test(text)) return 'Email';
  if (/pay|stripe|coin|bank|finance|monzo/.test(text)) return 'Finance';
  if (/git|dev|sentry|pager|wakatime|vercel|netlify/.test(text)) return 'Developer tools';
  if (/calendar|zoom|slack|discord|social|twitter/.test(text)) return 'Communications';
  return 'General';
}

function riskLevel(spec: ConnectorSpec, writeCount: number): ConnectorRiskLevel {
  if (writeCount > 0) {
    return 'high';
  }
  if (spec.auth.type === 'oauth2' || spec.auth.type === 'basic') {
    return 'medium';
  }
  return 'low';
}

function scopesFor(spec: ConnectorSpec): string[] {
  const authScopes = spec.auth.type === 'oauth2' && Array.isArray(spec.auth.scopes) ? spec.auth.scopes : [];
  const methods = Array.from(new Set(spec.resources.map((resource) => resource.method))).sort();
  return Array.from(new Set([
    `auth:${spec.auth.type}`,
    ...authScopes,
    ...methods.map((method) => `method:${method.toLowerCase()}`),
  ]));
}

function onboardingFor(spec: ConnectorSpec): ConnectorMarketplaceEntry['onboarding'] {
  switch (spec.auth.type) {
    case 'apiKeyHeader':
    case 'apiKeyQuery':
      return {
        mode: 'user-key',
        label: 'User-owned API key',
        description: 'Enable the definition, then each signed-in user stores their own key through the brokered connection store.',
        credentialScope: 'per-user',
        setupLevel: 'self-serve',
      };
    case 'oauth2':
      return {
        mode: 'oauth-app',
        label: 'OAuth app + user consent',
        description: 'Operator registers the provider app once; users connect their own account through the OAuth callback.',
        credentialScope: 'per-user',
        setupLevel: 'operator-assisted',
      };
    case 'basic':
      return {
        mode: 'basic-auth',
        label: 'User-owned username/password',
        description: 'Each user stores a brokered username/password secret; runtime resolves it only for that caller.',
        credentialScope: 'per-user',
        setupLevel: 'self-serve',
      };
    case 'none':
    default:
      return {
        mode: 'no-auth',
        label: 'No credential required',
        description: 'This connector can run without a stored user credential.',
        credentialScope: 'none',
        setupLevel: 'none',
      };
  }
}

function tagsFor(spec: ConnectorSpec, actions: ConnectorActionProfile[]): string[] {
  return Array.from(new Set([
    spec.provider,
    inferCategory(spec).toLowerCase(),
    spec.auth.type,
    `onboarding:${onboardingFor(spec).mode}`,
    `setup:${onboardingFor(spec).setupLevel}`,
    ...(spec.metadata?.tags ?? []),
    ...actions.map((action) => `action:${action.actionType}`),
    ...actions.map((action) => action.method.toLowerCase()),
  ].map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))).sort();
}

function toTitle(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
