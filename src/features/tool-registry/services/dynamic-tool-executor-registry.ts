/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Track B S6: Dynamic tool executor registry — replaces hardcoded switch with runtime-extendable descriptor map
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: publish immutable executor descriptors so request-start identity checks cannot be bypassed by in-place mutation.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'dynamic-tool-executor-registry' });

/**
 * @description Execution strategy type for a registered tool.
 * - `builtin` — handled by a named handler in ToolExecutorService
 * - `cli` — run a shell command with templated args
 * - `api` — HTTP call to a configured endpoint
 * - `mcp` — delegate to a running MCP server (Cline runtime only)
 */
export type ToolExecutorType = 'builtin' | 'cli' | 'api' | 'connector' | 'mcp';

/**
 * @description Descriptor that controls how a registered tool is executed.
 */
export interface ToolExecutorDescriptor {
  toolName: string;
  executorType: ToolExecutorType;
  /** For `cli`: command template with {input.*} placeholders */
  cliCommand?: string;
  /** For `api`: base endpoint for the tool's HTTP integration */
  apiEndpoint?: string;
  /** For `connector`: provider slug from swarm-apps/connectors/<provider>.yaml */
  connectorProvider?: string;
  /** For `connector`: spec resource name to invoke */
  connectorResource?: string;
  /** For `mcp`: server name in the active MCP runtime config */
  mcpServerName?: string;
  /** For `builtin`: internal handler key used in ToolExecutorService switch */
  builtinKey?: string;
  /** Whether this descriptor was registered at runtime vs. seeded at startup */
  runtimeRegistered: boolean;
  registeredAt: string;
}

/**
 * @description In-memory registry mapping tool names to executor descriptors.
 *
 * Decouples tool execution strategy from the ToolExecutorService switch statement.
 * External code (CLI tools, MCP integrations, tests) can register descriptors at
 * startup or runtime. The executor consults this registry before falling through
 * to its hardcoded builtin dispatch.
 *
 * NOTE: The map is process-scoped, but runtime descriptors can be restored from
 * `runtime_tool_executors` by RuntimeToolRegistrationService during bootstrap.
 */
export class DynamicToolExecutorRegistry {
  private readonly registry = new Map<string, ToolExecutorDescriptor>();

  /**
   * @description Register a tool executor descriptor.
   * Overwrites any existing descriptor for the same tool name.
   *
   * @param descriptor - Execution descriptor for the tool
   */
  register(descriptor: ToolExecutorDescriptor): void {
    const immutableDescriptor = Object.freeze({ ...descriptor });
    this.registry.set(immutableDescriptor.toolName, immutableDescriptor);
    logger.info(
      {
        toolName: immutableDescriptor.toolName,
        executorType: immutableDescriptor.executorType,
        runtimeRegistered: immutableDescriptor.runtimeRegistered,
      },
      'Tool executor descriptor registered',
    );
  }

  /**
   * @description Resolve the executor descriptor for a tool.
   * @param toolName - Tool name as used in LLM tool calls
   * @returns Descriptor or undefined if not registered
   */
  resolve(toolName: string): ToolExecutorDescriptor | undefined {
    return this.registry.get(toolName);
  }

  /**
   * @description List all registered descriptors.
   * @returns Array of all descriptors in registration order
   */
  listAll(): ToolExecutorDescriptor[] {
    return Array.from(this.registry.values());
  }

  /**
   * @description Remove a runtime-registered descriptor.
   * Builtin descriptors (runtimeRegistered=false) are not removed.
   *
   * @param toolName - Tool name to deregister
   * @returns True if removed, false if not found or is a builtin
   */
  deregister(toolName: string): boolean {
    const existing = this.registry.get(toolName);
    if (!existing || !existing.runtimeRegistered) return false;
    this.registry.delete(toolName);
    logger.info({ toolName }, 'Runtime tool executor descriptor deregistered');
    return true;
  }

  /**
   * @description Seed the registry with descriptors for all builtin tools
   * handled by ToolExecutorService. Called once at startup.
   */
  seedBuiltinDescriptors(): void {
    const builtins: Array<[string, string]> = [
      ['list_directory', 'list_directory'],
      ['read_file', 'read_file'],
      ['search_files', 'search_files'],
      ['write_to_file', 'write_to_file'],
      ['replace_in_file', 'replace_in_file'],
      ['execute_command', 'execute_command'],
      ['ask_followup_question', 'ask_followup_question'],
      ['presentron', 'presentron'],
      ['rag-ingestion', 'rag-ingestion'],
      ['rag-query', 'rag-query'],
      ['gogcli', 'gogcli'],
      ['finance-import', 'finance-import'],
      ['finance-report', 'finance-report'],
      ['analyze-spending', 'analyze-spending'],
      ['check-budget', 'check-budget'],
      ['workflow-studio', 'workflow-studio'],
    ];

    for (const [toolName, builtinKey] of builtins) {
      this.register({
        toolName,
        executorType: 'builtin',
        builtinKey,
        runtimeRegistered: false,
        registeredAt: new Date().toISOString(),
      });
    }

    logger.info({ count: builtins.length }, 'Builtin tool executor descriptors seeded');
  }
}
