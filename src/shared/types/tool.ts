/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of Layer 1 tool types
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added ApprovalRequest, ApprovalDecision, ApprovalStatus types
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added VerificationStatus, VerificationResult, VerificationSummary types for Sprint 4
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added ToolType values for presentron/rag and integration config types
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Attached hydrated tool metadata to AgentTool so merged switch-framework results are strongly typed
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added unified tool auth/runtime configuration types for dynamic per-tool credentials and OAuth workflows
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Removed the orphaned PresentronIntegrationConfig interface: its only consumers (the Presentron HTTP sidecar client + its route) were retired. ToolType.PRESENTRON stays — it's the live in-repo-rendered presentron tool.
 */

/**
 * @description Tool type enumeration - categorizes tools by execution method
 */
export enum ToolType {
  MCP = 'mcp',
  API = 'api',
  CLI = 'cli',
  PRESENTRON = 'presentron',
  RAG = 'rag',
}

/**
 * @description Authorization mode for tool execution
 * - auto: Execute immediately without approval
 * - ask: Require human approval before execution
 * - off: Tool not available/installed for this agent
 */
export enum AuthMode {
  AUTO = 'auto',
  ASK = 'ask',
  OFF = 'off',
}

/**
 * @description Unified authentication types for tool runtime configuration.
 * This allows one standard object shape across API, CLI, and MCP-backed tools.
 */
export enum ToolAuthType {
  NONE = 'none',
  API_KEY = 'api_key',
  BEARER = 'bearer',
  BASIC = 'basic',
  OAUTH2 = 'oauth2',
  CERTIFICATE = 'certificate',
  VAULT = 'vault',
  AWS = 'aws',
  GCP = 'gcp',
  AZURE = 'azure',
  KUBECONFIG = 'kubeconfig',
}

/**
 * @description Unified per-tool auth configuration object persisted in agent_tools.tool_config.
 */
export interface ToolAuthConfig {
  type: ToolAuthType;
  enabled: boolean;
  apiKey?: string;
  bearerToken?: string;
  basic?: {
    username?: string;
    password?: string;
  };
  oauth2?: {
    flow?: 'authorization_code' | 'client_credentials' | 'device_code' | 'pkce';
    authorizeUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    scopes?: string[];
    audience?: string;
  };
  certificate?: {
    certPem?: string;
    keyPem?: string;
    caPem?: string;
    passphrase?: string;
  };
  vault?: {
    address?: string;
    namespace?: string;
    mount?: string;
    secretPath?: string;
    roleId?: string;
    secretId?: string;
  };
  aws?: {
    profile?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  gcp?: {
    projectId?: string;
    serviceAccountJson?: string;
  };
  azure?: {
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    subscriptionId?: string;
  };
  kubeconfig?: {
    path?: string;
    context?: string;
    namespace?: string;
  };
}

/**
 * @description Unified runtime configuration for a tool assignment.
 */
export interface ToolRuntimeConfig {
  auth: ToolAuthConfig;
  env?: Record<string, string>;
  endpoint?: {
    url?: string;
    baseUrl?: string;
    region?: string;
  };
  metadata?: Record<string, unknown>;
}

/**
 * @description Install method for conditional tool installation
 */
export enum InstallMethod {
  APT = 'apt',
  NPM = 'npm',
  BINARY = 'binary',
  PIP = 'pip',
  SCRIPT = 'script',
  NONE = 'none',
}

/**
 * @description Install specification for tool installation
 */
export interface InstallSpec {
  /** Installation method */
  method: InstallMethod;
  
  /** Package name or binary URL */
  package?: string;
  
  /** Additional install arguments */
  args?: string[];
  
  /** Verification command to confirm installation */
  verifyCommand?: string;
  
  /** Cleanup command for uninstallation */
  cleanupCommand?: string;
  
  /** Tool dependencies (other tool IDs that must be installed first) */
  dependencies?: string[];
  
  /** Environment variables required for installation */
  env?: Record<string, string>;
  
  /** Custom installation script */
  script?: string;
}

/**
 * @description Tool metadata and configuration
 */
export interface Tool {
  toolId: string;
  name: string;
  displayName: string;
  type: ToolType;
  category: string;
  version: string;
  
  /** Install specification for conditional installation */
  installSpec: InstallSpec;
  
  /** Skills that this tool provides to agents */
  skills: string[];
  
  /** Selector fragment to append to agent selector */
  selectorFragment: string;
  
  /** Routing tags for agent selection */
  routingTags: string[];
  
  /** Authorization group (tools sharing authorization state) */
  authGroup: string;
  
  /** Default authorization mode for new agent assignments */
  defaultAuthMode: AuthMode;
  
  /** Tool description */
  description: string;
  
  /** Input schema (JSON Schema) */
  inputSchema: Record<string, unknown>;
  
  /** Output schema (JSON Schema) */
  outputSchema?: Record<string, unknown>;
  
  /** Usage instructions */
  usageInstructions?: string;
  
  /** Example usages */
  examples: unknown[];
  
  /** Whether tool requires approval (legacy field) */
  requiresApproval: boolean;
  
  /** Execution timeout in milliseconds */
  timeoutMs: number;
  
  /** Tool tags for filtering */
  tags: string[];
  
  /** Whether tool is enabled globally */
  enabled: boolean;
  
  /** Who registered this tool */
  registeredBy: string;
  
  /** When tool was registered */
  registeredAt: Date;
  
  /** Creation timestamp */
  createdAt: Date;
  
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * @description Agent-tool assignment with authorization mode
 */
export interface AgentTool {
  agentId: string;
  toolId: string;
  authMode: AuthMode;
  installed: boolean;
  installedAt?: Date;
  installVerified: boolean;
  toolConfig: ToolRuntimeConfig | Record<string, unknown>;
  tool: Tool;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @description Composed selector for an agent
 */
export interface ComposedSelector {
  agentId: string;
  
  /** Base capabilities from persona */
  baseCapabilities: string[];
  
  /** Capabilities from enabled tools */
  toolCapabilities: string[];
  
  /** Combined capabilities (base + tool) */
  capabilities: string[];
  
  /** Base selector descriptor from persona */
  baseSelectorDescriptor: string;
  
  /** Tool selector fragments concatenated */
  toolSelectorFragments: string;
  
  /** Combined selector descriptor */
  selectorDescriptor: string;
  
  /** Base routing keywords from persona */
  baseRoutingKeywords: string[];
  
  /** Routing tags from enabled tools */
  toolRoutingTags: string[];
  
  /** Combined routing keywords (base + tool) */
  routingKeywords: string[];
  
  /** When selector was last computed */
  lastComputedAt?: Date;
}

/**
 * @description Authorization group metadata
 */
export interface AuthGroup {
  groupName: string;
  toolIds: string[];
  toolCount: number;
}

/**
 * @description Tool installation result
 */
export interface InstallResult {
  success: boolean;
  toolId: string;
  agentId: string;
  installMethod?: InstallMethod;
  durationMs?: number;
  error?: string;
  verificationOutput?: string;
}

/**
 * @description Tool installation log entry
 */
export interface ToolInstallLog {
  installId: string;
  agentId: string;
  toolId: string;
  action: 'install' | 'uninstall' | 'verify' | 'cleanup';
  status: 'pending' | 'success' | 'failed' | 'skipped';
  installMethod?: string;
  durationMs?: number;
  errorMessage?: string;
  verificationOutput?: string;
  triggeredBy?: string;
  createdAt: Date;
}

/**
 * @description Status of a tool approval request
 */
export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DENIED = 'denied',
  TIMEOUT = 'timeout',
  ERROR = 'error',
}

/**
 * @description Tool approval request — created when a tool with auth_mode='ask'
 * is invoked. The request is sent to the user via SSE and awaits a decision.
 */
export interface ApprovalRequest {
  /** Unique request identifier */
  requestId: string;

  /** Task context in which the tool was invoked */
  taskId: string;

  /** Agent requesting tool execution */
  agentId: string;

  /** Tool being requested */
  toolId: string;

  /** Tool name (denormalized for display) */
  toolName: string;

  /** Tool input arguments */
  toolInput: Record<string, unknown>;

  /** Current request status */
  status: ApprovalStatus;

  /** When the request was created */
  requestedAt: Date;

  /** When the request was resolved (approved/denied/timeout) */
  resolvedAt?: Date;

  /** Who resolved the request (userId or 'system' for timeout) */
  resolvedBy?: string;

  /** Timeout in milliseconds before auto-deny */
  timeoutMs: number;

  /** Additional context (tool description, display name, etc.) */
  context: Record<string, unknown>;
}

/**
 * @description Decision made by the user on an approval request
 */
export interface ApprovalDecision {
  /** The approval request ID being resolved */
  requestId: string;

  /** Whether the tool execution is approved */
  approved: boolean;

  /** Who made the decision */
  decidedBy: string;

  /** Optional reason for the decision */
  reason?: string;
}

/**
 * @description Status of a tool verification check
 */
export enum VerificationStatus {
  PASSED = 'passed',
  FAILED = 'failed',
  ERROR = 'error',
  SKIPPED = 'skipped',
  PENDING = 'pending',
}

/**
 * @description Result of a single tool verification check
 */
export interface VerificationResult {
  /** Unique result identifier */
  id: string;

  /** Tool being verified */
  toolId: string;

  /** Tool name (denormalized) */
  toolName: string;

  /** Command that was executed */
  verifyCommand: string | null;

  /** Verification outcome */
  status: VerificationStatus;

  /** Process exit code (0 = success) */
  exitCode: number | null;

  /** Standard output from verify command */
  stdout: string | null;

  /** Standard error from verify command */
  stderr: string | null;

  /** Execution duration in milliseconds */
  durationMs: number | null;

  /** When verification was performed */
  verifiedAt: Date;

  /** Who triggered verification (system or userId) */
  verifiedBy: string;

  /** Error message if status is 'error' */
  errorMessage: string | null;
}

/**
 * @description Summary of verification results across all tools
 */
export interface VerificationSummary {
  /** Total number of tools checked */
  total: number;

  /** Number of tools that passed verification */
  passed: number;

  /** Number of tools that failed verification */
  failed: number;

  /** Number of tools with errors during verification */
  errors: number;

  /** Number of tools skipped (no verify command) */
  skipped: number;

  /** Number of tools pending verification */
  pending: number;

  /** When the verification run started */
  startedAt: Date;

  /** When the verification run completed */
  completedAt: Date | null;

  /** Total duration of the verification run */
  durationMs: number | null;
}

/**
 * @description Result of an authorization check on a tool execution request
 */
export interface AuthorizationResult {
  /** Whether the tool is authorized to execute */
  authorized: boolean;

  /** The auth mode that was applied */
  authMode: AuthMode;

  /** If not authorized, the reason */
  reason?: string;

  /** If auth_mode is 'ask', the approval request that was created */
  approvalRequest?: ApprovalRequest;
}

/**
 * @description Configuration for RAG ingestion tool integration
 * @property endpoint - The RAG ingestion API endpoint URL
 * @property supportedFormats - Array of supported file formats
 * @property maxFileSizeMB - Maximum file size in MB
 */
export interface RAGIngestionConfig {
  endpoint: string;
  supportedFormats: string[];
  maxFileSizeMB: number;
}
