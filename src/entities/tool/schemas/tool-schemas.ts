/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool validation schemas
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Zod v4 compatibility: refactored all .default() to .optional().default(); fixed Change Log author/timestamp
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added PresentronIntegrationConfigSchema and RAGIngestionConfigSchema for new tool types
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fixed Zod v3 compatibility - removed .optional() before .default() (default already handles optionality)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added unified tool runtime/auth config validation schema for per-agent tool configuration updates
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added oauth2.accessToken to persisted tool auth schema so PAT-based repo tool setup round-trips through validation
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Removed the orphaned PresentronIntegrationConfigSchema: the Presentron HTTP sidecar it validated was retired (zero remaining consumers). RAGIngestionConfigSchema is unaffected.
 */

import { z } from 'zod';
import { ToolType, AuthMode, InstallMethod, ToolAuthType } from '@/shared/types/tool';

/**
 * @description Zod schema for install specification validation
 */
export const InstallSpecSchema = z.object({
  method: z.nativeEnum(InstallMethod),
  package: z.string().optional(),
  args: z.array(z.string()).optional(),
  verifyCommand: z.string().optional(),
  cleanupCommand: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  script: z.string().optional(),
});

/**
 * @description Zod schema for optional tool UI configuration.
 * When present, the tool gets a sidebar icon in the Cockpit and renders
 * a view when clicked (iframe or built-in component).
 */
export const ToolUiConfigSchema = z.object({
  sidebarIcon: z.string().min(1),          // codicon class e.g. 'codicon codicon-type-hierarchy'
  sidebarLabel: z.string().min(1).max(30), // e.g. 'Graph Viewer'
  sidebarSection: z.enum(['top', 'bottom']).default('top'),
  route: z.string().min(1),                // cockpit view id e.g. 'tool-graph-query'
  iframeUrl: z.string().optional(),        // external URL to embed in an iframe
  component: z.string().optional(),        // built-in component name (future)
}).optional();

/**
 * @description Zod schema for creating a new tool
 */
export const CreateToolSchema = z.object({
  name: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  type: z.nativeEnum(ToolType),
  category: z.string().min(1).max(100),
  version: z.string().default('1.0.0'),
  installSpec: InstallSpecSchema.default({ method: InstallMethod.NONE }),
  skills: z.array(z.string()).default([]),
  selectorFragment: z.string().default(''),
  routingTags: z.array(z.string()).default([]),
  authGroup: z.string().default(''),
  defaultAuthMode: z.nativeEnum(AuthMode).default(AuthMode.AUTO),
  description: z.string().min(1),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).optional(),
  usageInstructions: z.string().optional(),
  examples: z.array(z.unknown()).default([]),
  requiresApproval: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(30000),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  registeredBy: z.string().min(1),
  // ui: ToolUiConfigSchema, // TODO: Enable after DB migration adds ui column
});

/**
 * @description Zod schema for updating a tool
 */
export const UpdateToolSchema = CreateToolSchema.partial();

/**
 * @description Zod schema for tool filters
 */
export const ToolFiltersSchema = z.object({
  type: z.nativeEnum(ToolType).optional(),
  category: z.string().optional(),
  authGroup: z.string().optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

/**
 * @description Zod schema for setting agent tool auth mode
 */
export const SetAgentToolAuthModeSchema = z.object({
  authMode: z.nativeEnum(AuthMode),
});

/**
 * @description Zod schema for bulk setting auth mode for tool group
 */
export const SetGroupAuthModeSchema = z.object({
  groupName: z.string().min(1),
  authMode: z.nativeEnum(AuthMode),
});

/**
 * @description Zod schema for unified tool auth configuration.
 */
export const ToolAuthConfigSchema = z.object({
  type: z.nativeEnum(ToolAuthType).default(ToolAuthType.NONE),
  enabled: z.boolean().default(false),
  apiKey: z.string().optional(),
  bearerToken: z.string().optional(),
  basic: z.object({
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional(),
  oauth2: z.object({
    flow: z.enum(['authorization_code', 'client_credentials', 'device_code', 'pkce']).optional(),
    authorizeUrl: z.string().optional(),
    tokenUrl: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    accessToken: z.string().optional(),
    redirectUri: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    audience: z.string().optional(),
  }).optional(),
  certificate: z.object({
    certPem: z.string().optional(),
    keyPem: z.string().optional(),
    caPem: z.string().optional(),
    passphrase: z.string().optional(),
  }).optional(),
  vault: z.object({
    address: z.string().optional(),
    namespace: z.string().optional(),
    mount: z.string().optional(),
    secretPath: z.string().optional(),
    roleId: z.string().optional(),
    secretId: z.string().optional(),
  }).optional(),
  aws: z.object({
    profile: z.string().optional(),
    region: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional(),
  }).optional(),
  gcp: z.object({
    projectId: z.string().optional(),
    serviceAccountJson: z.string().optional(),
  }).optional(),
  azure: z.object({
    tenantId: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    subscriptionId: z.string().optional(),
  }).optional(),
  kubeconfig: z.object({
    path: z.string().optional(),
    context: z.string().optional(),
    namespace: z.string().optional(),
  }).optional(),
});

/**
 * @description Zod schema for full tool runtime configuration payload.
 */
export const ToolRuntimeConfigSchema = z.object({
  auth: ToolAuthConfigSchema.default({ type: ToolAuthType.NONE, enabled: false }),
  env: z.record(z.string()).optional(),
  endpoint: z.object({
    url: z.string().optional(),
    baseUrl: z.string().optional(),
    region: z.string().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * @description Zod schema for setting agent tool configuration.
 */
export const SetAgentToolConfigSchema = z.object({
  toolConfig: ToolRuntimeConfigSchema,
});

/**
 * @description Type inference helpers
 */
export type CreateToolInput = z.infer<typeof CreateToolSchema>;
/**
 * @description Inferred TypeScript type for the partial payload accepted when updating an existing tool.
 */
export type UpdateToolInput = z.infer<typeof UpdateToolSchema>;
/**
 * @description Inferred TypeScript type for the criteria used to filter and paginate tool queries.
 */
export type ToolFilters = z.infer<typeof ToolFiltersSchema>;
/**
 * @description Inferred TypeScript type for the payload that sets a single agent tool's auth mode.
 */
export type SetAgentToolAuthModeInput = z.infer<typeof SetAgentToolAuthModeSchema>;
/**
 * @description Inferred TypeScript type for the payload that bulk-sets the auth mode for a named tool group.
 */
export type SetGroupAuthModeInput = z.infer<typeof SetGroupAuthModeSchema>;
/**
 * @description Inferred TypeScript type for the payload that sets an agent's full tool runtime configuration.
 */
export type SetAgentToolConfigInput = z.infer<typeof SetAgentToolConfigSchema>;

/**
 * @description Zod schema for RAG ingestion integration config
 */
export const RAGIngestionConfigSchema = z.object({
  endpoint: z.string().url(),
  supportedFormats: z.array(z.string()),
  maxFileSizeMB: z.number().int().positive(),
});
