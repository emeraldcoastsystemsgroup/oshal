import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import { AuthMode, InstallMethod, ToolType } from '@/shared/types/tool';
import type { CreateToolInput } from '@/entities/tool';
import { createChildLogger } from '@/shared/logger';
import { hasExplicitWriteConfirmation, confirmationRequiredPayload } from '@/shared/security/explicit-write-confirmation';
import type { DynamicToolExecutorRegistry, ToolExecutorDescriptor, ToolRegistryService } from '@/features/tool-registry';
import { getValidAccessToken } from '@/app/routes/connectors-routes';
import { invokeSpecResource } from './spec-routes';
import { loadConnectorSpec, type BuildSpecOptions, type ConnectorSpec, type SpecResource } from './spec';
import {
  buildConnectorActionPreview,
  describeConnectorAction,
  isConnectorActionDryRun,
  requiresConnectorConfirmation,
  supportsConnectorDryRun,
} from './action-safety';

const logger = createChildLogger({ module: 'connector-spec-tools' });
const DEFAULT_SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');
const DEFAULT_IMPORTED_SPEC_DIR = path.join(process.cwd(), 'output/connectors/imported-openapi');

type AccessTokenResolver = (pool: unknown, userSub: string, provider: string) => Promise<string | null>;

export interface ConnectorProviderGate {
  isProviderEnabled(provider: string): boolean;
  enabledProviderSet?(): Set<string>;
}

export interface ConnectorSpecToolServiceDeps {
  pool: Pool | unknown;
  specDir?: string;
  specDirs?: string[];
  getAccessToken?: AccessTokenResolver;
  providerGate?: ConnectorProviderGate;
}

export interface ConnectorSpecToolRegistration {
  tool: CreateToolInput;
  descriptor: ToolExecutorDescriptor;
}

const CONNECTOR_CAPABILITY_GROUPS: Record<string, string[]> = {
  github: ['devops', 'coding', 'source-control'],
  gitlab: ['devops', 'coding', 'source-control'],
  bitbucket: ['devops', 'coding', 'source-control'],
  jira: ['devops', 'project-management', 'planning'],
  sentry: ['devops', 'monitoring', 'incident-response'],
  dynatrace: ['devops', 'monitoring', 'observability', 'incident-response'],
  datadog: ['devops', 'monitoring', 'observability', 'incident-response'],
  newrelic: ['devops', 'monitoring', 'observability', 'incident-response'],
  servicenow: ['devops', 'itsm', 'incident-response', 'change-management'],
  sentinel: ['secops', 'siem', 'security', 'incident-response'],
  'elastic-security': ['secops', 'siem', 'security', 'endpoint', 'incident-response'],
  tenable: ['secops', 'vulnerability-management', 'security'],
  'defender-cloud': ['secops', 'cspm', 'cloud-posture', 'security'],
  virustotal: ['secops', 'threat-intel', 'security'],
  pagerduty: ['devops', 'incident-response', 'on-call'],
  slack: ['communications', 'collaboration'],
  gmail: ['communications', 'email', 'google-workspace'],
  outlook: ['communications', 'email', 'microsoft-365'],
  'google-calendar': ['calendar', 'scheduling', 'google-workspace'],
  'google-drive': ['files', 'storage-management', 'google-workspace'],
  spotify: ['music', 'playlist-building', 'media'],
  tmdb: ['movies', 'media', 'title-search'],
  stripe: ['finance', 'payments'],
  monzo: ['finance', 'financial-aggregation'],
  openai: ['llm', 'ai'],
  figma: ['design', 'product'],
  notion: ['documentation', 'knowledge-management'],
  todoist: ['productivity', 'task-management'],
  clickup: ['project-management', 'planning'],
  asana: ['project-management', 'planning'],
};

/**
 * @description Registers ADR-065 connector spec resources as ADR-067 scoped runtime tools.
 */
export class ConnectorSpecToolService {
  private readonly pool: Pool | unknown;
  private readonly specDirs: string[];
  private readonly getAccessToken: AccessTokenResolver;
  private readonly providerGate?: ConnectorProviderGate;
  private readonly specs = new Map<string, ConnectorSpec>();
  private readonly tools = new Map<string, { spec: ConnectorSpec; resource: SpecResource }>();

  constructor(deps: ConnectorSpecToolServiceDeps) {
    this.pool = deps.pool;
    this.specDirs = resolveSpecDirs(deps.specDir, deps.specDirs);
    this.getAccessToken = deps.getAccessToken ?? getValidAccessToken;
    this.providerGate = deps.providerGate;
  }

  /**
   * @description Loads specs, upserts tool rows, and registers in-memory connector executors.
   */
  async registerConnectorSpecTools(
    toolRegistryService: ToolRegistryService,
    executorRegistry: DynamicToolExecutorRegistry,
  ): Promise<ConnectorSpecToolRegistration[]> {
    const registrations = this.discoverRegistrations();
    for (const registration of registrations) {
      await toolRegistryService.registerOrUpdateTool(registration.tool);
      executorRegistry.register(registration.descriptor);
    }
    logger.info({ count: registrations.length }, 'Connector spec tools registered');
    return registrations;
  }

  /**
   * @description Enables one provider's spec tools after a marketplace install/enable action.
   */
  async registerConnectorProvider(
    provider: string,
    toolRegistryService: ToolRegistryService,
    executorRegistry: DynamicToolExecutorRegistry,
  ): Promise<ConnectorSpecToolRegistration[]> {
    const registrations = this.discoverRegistrations(new Set([provider]));
    for (const registration of registrations) {
      await toolRegistryService.registerOrUpdateTool(registration.tool);
      executorRegistry.register(registration.descriptor);
    }
    logger.info({ provider, count: registrations.length }, 'Connector provider tools registered');
    return registrations;
  }

  /**
   * @description Disables one provider's connector tools and removes in-memory executors.
   */
  async deregisterConnectorProvider(
    provider: string,
    toolRegistryService: ToolRegistryService,
    executorRegistry: DynamicToolExecutorRegistry,
  ): Promise<string[]> {
    const spec = this.loadSpec(provider);
    const toolNames = spec.resources.map((resource) => resource.tool).filter((tool): tool is string => Boolean(tool));
    for (const toolName of toolNames) {
      executorRegistry.deregister(toolName);
      const existing = await toolRegistryService.getToolByName(toolName);
      if (existing) {
        await toolRegistryService.updateTool(existing.toolId, { enabled: false });
      }
      this.tools.delete(toolName);
    }
    this.specs.delete(provider);
    logger.info({ provider, count: toolNames.length }, 'Connector provider tools deregistered');
    return toolNames;
  }

  /**
   * @description Executes one connector spec tool with the caller's own brokered credentials.
   */
  async executeTool(
    descriptor: ToolExecutorDescriptor,
    inputs: Record<string, unknown>,
    userSub?: string,
  ): Promise<string> {
    const provider = descriptor.connectorProvider;
    const resourceName = descriptor.connectorResource;
    if (!provider || !resourceName) {
      throw new Error(`Connector tool "${descriptor.toolName}" is missing provider/resource metadata.`);
    }
    const spec = this.specs.get(provider) ?? this.loadSpec(provider);
    const resource = spec.resources.find((item) => item.name === resourceName);
    if (!resource) {
      throw new Error(`${provider}: unknown resource '${resourceName}'`);
    }
    if (isConnectorActionDryRun(inputs) && supportsConnectorDryRun(resource)) {
      return JSON.stringify(buildConnectorActionPreview(spec, resource, inputs), null, 2);
    }
    if (requiresConnectorConfirmation(resource) && !hasExplicitWriteConfirmation(inputs)) {
      return JSON.stringify({
        ...confirmationRequiredPayload('connector-action', `${provider}.${resourceName}`),
        action: describeConnectorAction(spec, resource),
      }, null, 2);
    }
    const creds = await resolveConnectorSpecCreds(spec, this.pool, userSub, this.getAccessToken);
    const result = await invokeSpecResource(spec, creds, resourceName, inputs);
    if (!result.body.ok) {
      throw new Error(`${provider}.${resourceName} failed (${result.status}): ${result.body.error ?? result.body.code ?? 'connector error'}`);
    }
    return JSON.stringify(result.body.data ?? null, null, 2);
  }

  private discoverRegistrations(providerFilter?: Set<string>): ConnectorSpecToolRegistration[] {
    if (!providerFilter) {
      this.specs.clear();
      this.tools.clear();
    }
    const enabledProviderFilter = providerFilter ?? this.providerGate?.enabledProviderSet?.();
    if (!providerFilter && this.providerGate && enabledProviderFilter && enabledProviderFilter.size === 0) {
      logger.info('No connector providers enabled; connector spec tools skipped');
      return [];
    }
    const registrations: ConnectorSpecToolRegistration[] = [];
    for (const spec of loadConnectorSpecs(this.specDirs, enabledProviderFilter)) {
      if (enabledProviderFilter && !enabledProviderFilter.has(spec.provider)) {
        continue;
      }
      if (this.providerGate && !this.providerGate.isProviderEnabled(spec.provider)) {
        continue;
      }
      this.specs.set(spec.provider, spec);
      for (const resource of spec.resources.filter((item) => item.tool)) {
        this.tools.set(resource.tool!, { spec, resource });
        registrations.push({
          tool: buildConnectorToolInput(spec, resource),
          descriptor: {
            toolName: resource.tool!,
            executorType: 'connector',
            connectorProvider: spec.provider,
            connectorResource: resource.name,
            runtimeRegistered: true,
            registeredAt: new Date().toISOString(),
          },
        });
      }
    }
    return registrations;
  }

  private loadSpec(provider: string): ConnectorSpec {
    for (const dir of this.specDirs) {
      const filePath = path.join(dir, `${provider}.yaml`);
      try {
        const spec = loadConnectorSpec(filePath);
        this.specs.set(spec.provider, spec);
        return spec;
      } catch {
        // Try the next configured spec directory.
      }
    }
    throw new Error(`Connector spec '${provider}' not found in configured spec dirs.`);
  }
}

export async function resolveConnectorSpecCreds(
  spec: ConnectorSpec,
  pool: unknown,
  userSub: string | undefined,
  getAccessToken: AccessTokenResolver = getValidAccessToken,
): Promise<BuildSpecOptions> {
  const credProvider = spec.credProvider || spec.provider;
  const brokerToken = userSub ? await getAccessToken(pool, userSub, credProvider) : null;
  const envToken = envKey(spec.provider, 'TOKEN') || envKey(spec.provider, 'KEY');
  switch (spec.auth.type) {
    case 'oauth2':
      return { token: async () => brokerToken || envToken || null };
    case 'apiKeyHeader':
    case 'apiKeyQuery':
      return { apiKeyValue: brokerToken || envToken || (spec.provider === 'tmdb' ? process.env.TMDB_API_KEY || '' : '') };
    case 'basic': {
      const colon = brokerToken ? brokerToken.indexOf(':') : -1;
      if (colon > 0) {
        return { username: brokerToken!.slice(0, colon), password: brokerToken!.slice(colon + 1) };
      }
      return { username: envKey(spec.provider, 'USER'), password: envKey(spec.provider, 'PASS') };
    }
    default:
      return {};
  }
}

export function loadConnectorSpecs(specDir: string | string[] = DEFAULT_SPEC_DIR, providerFilter?: Set<string>): ConnectorSpec[] {
  const specDirs = Array.isArray(specDir) ? specDir : [specDir];
  const files: string[] = [];
  for (const dir of specDirs) {
    try {
      for (const file of readdirSync(dir).filter((item) => item.endsWith('.yaml') || item.endsWith('.yml'))) {
        const provider = path.basename(file, path.extname(file));
        if (providerFilter && !providerFilter.has(provider)) continue;
        files.push(path.join(dir, file));
      }
    } catch (error) {
      logger.warn({ err: error, specDir: dir }, 'Connector spec dir not readable; no connector tools registered from this dir');
    }
  }

  const specs: ConnectorSpec[] = [];
  for (const file of files) {
    try {
      specs.push(loadConnectorSpec(file));
    } catch (error) {
      logger.warn({ err: error, file }, 'Connector spec not loadable; skipping tool registration');
    }
  }
  return specs;
}

function resolveSpecDirs(specDir?: string, specDirs?: string[]): string[] {
  const explicitSpecDirs = Boolean(specDir || specDirs?.length);
  const dirs = [
    specDir ?? DEFAULT_SPEC_DIR,
    ...(specDirs ?? []),
    ...parsePathList(process.env.CONNECTOR_SPEC_DIRS),
  ];
  if (!explicitSpecDirs && existsSync(DEFAULT_IMPORTED_SPEC_DIR)) dirs.push(DEFAULT_IMPORTED_SPEC_DIR);
  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

function parsePathList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[;,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildConnectorToolInput(spec: ConnectorSpec, resource: SpecResource): CreateToolInput {
  const action = describeConnectorAction(spec, resource);
  const placeholders = action.inputs;
  const properties: Record<string, unknown> = Object.fromEntries(placeholders.map((name) => [name, { type: 'string' }]));
  if (action.supportsDryRun) {
    properties.dryRun = { type: 'boolean', description: 'Preview the connector action without sending a provider request.' };
  }
  if (action.requiresConfirmation) {
    properties.confirm = { type: 'boolean', const: true, description: 'Required for a real mutating connector action.' };
  }
  const capabilityGroup = CONNECTOR_CAPABILITY_GROUPS[spec.provider] ?? [];
  const displayName = spec.displayName ?? spec.provider;
  return {
    name: resource.tool!,
    displayName: `${displayName}: ${resource.name}`,
    type: ToolType.API,
    category: 'connector',
    version: spec.version ?? '1.0.0',
    installSpec: { method: InstallMethod.NONE },
    skills: Array.from(new Set(['connector', spec.provider, ...capabilityGroup])),
    selectorFragment: `${displayName} connector resource ${resource.name}`,
    routingTags: Array.from(new Set([spec.provider, 'connector', ...capabilityGroup])),
    authGroup: `connector:${spec.credProvider || spec.provider}`,
    defaultAuthMode: AuthMode.ASK,
    description: `Call the ${displayName} connector resource "${resource.name}" (${resource.method} ${resource.path}) as a ${action.actionType} action using the signed-in user's configured connection.`,
    inputSchema: { type: 'object', properties, required: placeholders },
    examples: [],
    requiresApproval: action.requiresConfirmation,
    timeoutMs: 120000,
    usageInstructions: action.requiresConfirmation
      ? 'Use dryRun: true to preview. A real provider write requires confirm: true from the user/action boundary.'
      : undefined,
    tags: Array.from(new Set([
      'connector-spec',
      'adr-065',
      'adr-067',
      spec.provider,
      resource.method.toLowerCase(),
      `action:${action.actionType}`,
      ...(spec.metadata?.tags ?? []),
    ])),
    enabled: true,
    registeredBy: 'connector-spec-tools',
  };
}

const envKey = (provider: string, suffix: string): string => (
  process.env[`CONNECTOR_${provider.toUpperCase().replace(/-/g, '_')}_${suffix}`] || ''
);
