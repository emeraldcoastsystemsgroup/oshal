/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added persistent runtime tool registration service for framework-owned executable tools
 */

import type { Pool } from 'pg';
import type { Tool } from '@/shared/types/tool';
import type { CreateToolInput } from '@/entities/tool';
import { createChildLogger } from '@/shared/logger';
import { DynamicToolExecutorRegistry, type ToolExecutorDescriptor } from './dynamic-tool-executor-registry';
import { ToolRegistryService } from './tool-registry-service';
import { assertSafeCliCommandTemplate, validateCliCommandTemplate } from './cli-command-validator';

const logger = createChildLogger({ module: 'runtime-tool-registration-service' });

export interface RuntimeToolRegistrationResult {
  tool: Tool;
  executor: ToolExecutorDescriptor;
  created: boolean;
}

/**
 * @description Coordinates persistent registry rows with the in-memory executor map.
 *
 * Tool metadata lives in `tools`; executable strategy lives in
 * `runtime_tool_executors`; execution reads from DynamicToolExecutorRegistry.
 */
export class RuntimeToolRegistrationService {
  constructor(
    private readonly pool: Pool,
    private readonly toolRegistryService: ToolRegistryService,
    private readonly executorRegistry: DynamicToolExecutorRegistry,
  ) {}

  async registerRuntimeTool(
    toolInput: CreateToolInput,
    descriptorInput: Omit<ToolExecutorDescriptor, 'runtimeRegistered' | 'registeredAt'> & {
      runtimeRegistered?: boolean;
      registeredAt?: string;
    },
  ): Promise<RuntimeToolRegistrationResult> {
    const toolName = descriptorInput.toolName || toolInput.name;
    if (toolName !== toolInput.name) {
      throw new Error(`Runtime descriptor toolName '${toolName}' must match tool name '${toolInput.name}'`);
    }

    const descriptor = this.normalizeDescriptor({
      ...descriptorInput,
      toolName,
      runtimeRegistered: true,
      registeredAt: descriptorInput.registeredAt ?? new Date().toISOString(),
    });

    // Fail-closed write path: a cli template with shell metacharacters in its
    // static segments is never persisted or made executable. Throws here so the
    // manifest loader / API route surfaces the rejection per-tool.
    if (descriptor.executorType === 'cli') {
      assertSafeCliCommandTemplate(descriptor.cliCommand, toolName);
    }

    const taggedToolInput: CreateToolInput = {
      ...toolInput,
      tags: Array.from(new Set([...(toolInput.tags ?? []), 'runtime-registered'])),
      enabled: true,
    };

    const { tool, created } = await this.toolRegistryService.registerOrUpdateTool(taggedToolInput);
    const persisted = await this.persistDescriptor(descriptor, taggedToolInput.registeredBy);
    this.executorRegistry.register(persisted);
    logger.info({ toolName: tool.name, executorType: persisted.executorType, created }, 'Runtime tool registered');
    return { tool, executor: persisted, created };
  }

  async restoreRuntimeExecutors(): Promise<ToolExecutorDescriptor[]> {
    let descriptors: ToolExecutorDescriptor[] = [];
    try {
      descriptors = await this.listRuntimeExecutors();
    } catch (error) {
      logger.warn({ err: error }, 'Runtime tool executor restore skipped');
      return [];
    }
    const safe: ToolExecutorDescriptor[] = [];
    for (const descriptor of descriptors) {
      // Fail-closed restore path: a previously-persisted (possibly poisoned) cli
      // template is re-validated. An invalid one is skipped + logged rather than
      // registered — and skipping a single bad row must not abort restoring the
      // rest, so this never throws.
      if (descriptor.executorType === 'cli') {
        const result = validateCliCommandTemplate(descriptor.cliCommand ?? '');
        if (!result.ok) {
          logger.warn(
            { toolName: descriptor.toolName, reason: result.reason },
            'Skipped restoring cli tool executor — unsafe command template',
          );
          continue;
        }
      }
      this.executorRegistry.register(descriptor);
      safe.push(descriptor);
    }
    logger.info(
      { count: safe.length, skipped: descriptors.length - safe.length },
      'Runtime tool executors restored',
    );
    return safe;
  }

  async listRuntimeExecutors(): Promise<ToolExecutorDescriptor[]> {
    const { rows } = await this.pool.query(
      `SELECT
         tool_name,
         executor_type,
         cli_command,
         api_endpoint,
         mcp_server_name,
         builtin_key,
         runtime_registered,
         registered_at
       FROM runtime_tool_executors
       ORDER BY tool_name ASC`,
    );
    return rows.map((row) => this.rowToDescriptor(row));
  }

  async deregisterRuntimeTool(toolName: string, disableTool = true): Promise<{ removed: boolean; disabled: boolean }> {
    const deleteResult = await this.pool.query(
      'DELETE FROM runtime_tool_executors WHERE tool_name = $1',
      [toolName],
    );
    const removed = (deleteResult.rowCount ?? 0) > 0;
    const memoryRemoved = this.executorRegistry.deregister(toolName);
    let disabled = false;

    if (disableTool) {
      const tool = await this.toolRegistryService.getToolByName(toolName);
      if (tool && (tool.tags ?? []).includes('runtime-registered')) {
        await this.toolRegistryService.updateTool(tool.toolId, { enabled: false });
        disabled = true;
      }
    }

    logger.info({ toolName, removed, memoryRemoved, disabled }, 'Runtime tool deregistered');
    return { removed: removed || memoryRemoved, disabled };
  }

  private async persistDescriptor(
    descriptor: ToolExecutorDescriptor,
    registeredBy: string,
  ): Promise<ToolExecutorDescriptor> {
    const { rows } = await this.pool.query(
      `INSERT INTO runtime_tool_executors (
         tool_name,
         executor_type,
         cli_command,
         api_endpoint,
         mcp_server_name,
         builtin_key,
         runtime_registered,
         registered_by,
         registered_at
       ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
       ON CONFLICT (tool_name)
       DO UPDATE SET
         executor_type = EXCLUDED.executor_type,
         cli_command = EXCLUDED.cli_command,
         api_endpoint = EXCLUDED.api_endpoint,
         mcp_server_name = EXCLUDED.mcp_server_name,
         builtin_key = EXCLUDED.builtin_key,
         runtime_registered = true,
         registered_by = EXCLUDED.registered_by,
         registered_at = EXCLUDED.registered_at,
         updated_at = NOW()
       RETURNING
         tool_name,
         executor_type,
         cli_command,
         api_endpoint,
         mcp_server_name,
         builtin_key,
         runtime_registered,
         registered_at`,
      [
        descriptor.toolName,
        descriptor.executorType,
        descriptor.cliCommand ?? null,
        descriptor.apiEndpoint ?? null,
        descriptor.mcpServerName ?? null,
        descriptor.builtinKey ?? null,
        registeredBy,
        descriptor.registeredAt,
      ],
    );
    return this.rowToDescriptor(rows[0]);
  }

  private normalizeDescriptor(descriptor: ToolExecutorDescriptor): ToolExecutorDescriptor {
    switch (descriptor.executorType) {
      case 'cli':
        if (!descriptor.cliCommand) throw new Error('cli executor requires cliCommand');
        break;
      case 'api':
        if (!descriptor.apiEndpoint) throw new Error('api executor requires apiEndpoint');
        break;
      case 'connector':
        if (!descriptor.connectorProvider || !descriptor.connectorResource) {
          throw new Error('connector executor requires connectorProvider and connectorResource');
        }
        break;
      case 'mcp':
        if (!descriptor.mcpServerName) throw new Error('mcp executor requires mcpServerName');
        break;
      case 'builtin':
        if (!descriptor.builtinKey) throw new Error('builtin executor requires builtinKey');
        break;
      default:
        throw new Error(`Unsupported executor type '${String((descriptor as any).executorType)}'`);
    }
    return descriptor;
  }

  private rowToDescriptor(row: Record<string, any>): ToolExecutorDescriptor {
    const registeredAt = row.registered_at instanceof Date
      ? row.registered_at.toISOString()
      : String(row.registered_at);
    return this.normalizeDescriptor({
      toolName: String(row.tool_name),
      executorType: row.executor_type,
      cliCommand: row.cli_command ?? undefined,
      apiEndpoint: row.api_endpoint ?? undefined,
      mcpServerName: row.mcp_server_name ?? undefined,
      builtinKey: row.builtin_key ?? undefined,
      runtimeRegistered: Boolean(row.runtime_registered),
      registeredAt,
    });
  }
}
