/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ToolVerificationService
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added ChromaDB-backed healthcheck fallback for RAG tool verification when no external ingestion endpoint is configured
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Presentron verification fallback to deployable service endpoint
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the ToolType.PRESENTRON sidecar healthcheck branch + the PresentronIntegrationService import: the Presentron HTTP sidecar (presentron:8080) was retired. A presentron-typed tool now falls through to its verifyCommand / skipped path like any other tool — the presentron tool renders in-repo, there is no external sidecar to probe.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Disable execution of persisted free-form verifyCommand strings; only immutable server-owned verifier implementations may perform process/network checks.
 */

import { Pool } from 'pg';
import { logger } from '@/shared/logger';
import {
  VerificationResult,
  VerificationStatus,
  VerificationSummary,
  Tool,
  ToolType,
} from '@/shared/types/tool';
import { RagService } from '@/features/rag';
import { RAGIngestionIntegrationService } from '@/features/tool-integrations';

/**
 * @description Service for verifying tool installations with immutable server-owned checks and
 * recording results in the database. Persisted free-form shell commands are never executable.
 */
export class ToolVerificationService {
  private readonly logger = logger.child({ service: 'ToolVerificationService' });

  constructor(private readonly pool: Pool) {}

  /**
   * @description Verify a single tool by executing its verify command
   * 
   * @param toolId - UUID of the tool to verify
   * @param verifiedBy - User ID or 'system' for automated checks
   * @returns VerificationResult with command execution details
   */
  async verifyTool(
    toolId: string,
    verifiedBy: string = 'system'
  ): Promise<VerificationResult> {
    this.logger.info({ toolId, verifiedBy }, 'Starting tool verification');
    const startTime = Date.now();

    try {
      const tool = await this.fetchTool(toolId);
      if (!tool) {
        throw new Error(`Tool not found: ${toolId}`);
      }

      // Custom healthcheck for the rag tool type. (The Presentron sidecar healthcheck was
      // retired with the sidecar itself — a presentron-typed tool renders in-repo now and
      // falls through to the generic verifyCommand / skipped path below.)
      if (tool.type === ToolType.RAG) {
        const configuredEndpoint = process.env.RAG_INGESTION_ENDPOINT?.trim();
        const healthy = configuredEndpoint
          ? await new RAGIngestionIntegrationService({
            endpoint: configuredEndpoint,
            supportedFormats: ['pdf', 'txt', 'md'],
            maxFileSizeMB: 50,
          }).healthcheck()
          : await new RagService().healthCheck();
        const durationMs = Date.now() - startTime;
        const status = healthy ? VerificationStatus.PASSED : VerificationStatus.FAILED;
        const result = await this.recordVerificationResult({
          toolId: tool.toolId,
          toolName: tool.name,
          verifyCommand: configuredEndpoint ? 'rag-ingestion.healthcheck' : 'rag.chromadb.healthcheck',
          status,
          exitCode: healthy ? 0 : 1,
          stdout: healthy ? 'RAG ingestion healthy' : 'RAG ingestion unhealthy',
          stderr: null,
          durationMs,
          verifiedBy,
          errorMessage: healthy ? null : 'RAG ingestion healthcheck failed',
        });
        await this.updateToolVerificationStatus(tool.toolId, status, result.verifiedAt);
        this.logger.info({ toolId, status, durationMs }, 'RAG ingestion tool verification completed');
        return result;
      }

      const legacyVerifyCommand = tool.installSpec.verifyCommand;
      if (!legacyVerifyCommand) {
        return await this.recordSkippedVerification(tool, verifiedBy);
      }

      // `install_spec` is mutable catalog data. Treating its verifyCommand as a program made a
      // catalog write equivalent to remote shell execution from both HTTP and scheduler paths.
      // Legacy rows remain visible for migration but are explicitly non-executable.
      this.logger.warn(
        { toolId: tool.toolId, toolName: tool.name },
        'Skipped legacy free-form verification command',
      );
      return await this.recordSkippedVerification(
        tool,
        verifiedBy,
        'Legacy free-form verify commands are disabled; configure a reviewed verifier implementation',
      );
    } catch (error) {
      this.logger.error({ toolId, err: error }, 'Tool verification failed');
      return await this.recordErrorVerification(
        toolId,
        verifiedBy,
        error,
        startTime
      );
    }
  }

  /**
   * @description Verify all enabled tools in the registry
   * 
   * @param verifiedBy - User ID or 'system' for automated checks
   * @returns VerificationSummary with aggregate results
   */
  async verifyAllTools(
    verifiedBy: string = 'system'
  ): Promise<VerificationSummary> {
    this.logger.info({ verifiedBy }, 'Starting verification of all tools');
    const startedAt = new Date();
    const tools = await this.fetchAllEnabledTools();

    const results = await Promise.allSettled(
      tools.map(tool => this.verifyTool(tool.toolId, verifiedBy))
    );

    const summary = this.buildSummary(results, startedAt);
    this.logger.info(summary, 'All tools verification completed');
    
    return summary;
  }

  /**
   * @description Get the latest verification result for a specific tool
   * 
   * @param toolId - UUID of the tool
   * @returns Latest VerificationResult or null if never verified
   */
  async getLatestVerificationResult(
    toolId: string
  ): Promise<VerificationResult | null> {
    const query = `
      SELECT id, tool_id, tool_name, verify_command, status, exit_code,
             stdout, stderr, duration_ms, verified_at, verified_by, error_message
      FROM tool_verification_results
      WHERE tool_id = $1
      ORDER BY verified_at DESC
      LIMIT 1
    `;

    const result = await this.pool.query(query, [toolId]);
    return result.rows.length > 0 ? this.mapRowToResult(result.rows[0]) : null;
  }

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ToolVerificationService
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added presentron/rag healthcheck logic for tool verification
 */
  async getVerificationHistory(
    toolId: string,
    limit: number = 10
  ): Promise<VerificationResult[]> {
    const query = `
      SELECT id, tool_id, tool_name, verify_command, status, exit_code,
             stdout, stderr, duration_ms, verified_at, verified_by, error_message
      FROM tool_verification_results
      WHERE tool_id = $1
      ORDER BY verified_at DESC
      LIMIT $2
    `;

    const result = await this.pool.query(query, [toolId, limit]);
    return result.rows.map(row => this.mapRowToResult(row));
  }

  /**
   * @description Get all verification results across all tools
   * 
   * @returns Array of latest VerificationResults per tool
   */
  async getAllVerificationResults(): Promise<VerificationResult[]> {
    const query = `
      SELECT DISTINCT ON (tool_id)
        id, tool_id, tool_name, verify_command, status, exit_code,
        stdout, stderr, duration_ms, verified_at, verified_by, error_message
      FROM tool_verification_results
      ORDER BY tool_id, verified_at DESC
    `;

    const result = await this.pool.query(query);
    return result.rows.map(row => this.mapRowToResult(row));
  }

  /**
   * @description Fetch tool metadata from database
   */
  private async fetchTool(toolId: string): Promise<Tool | null> {
    const query = `
      SELECT tool_id, name, display_name, type, category, version,
             install_spec, skills, selector_fragment, routing_tags,
             auth_group, default_auth_mode, description, input_schema,
             output_schema, usage_instructions, examples, requires_approval,
             timeout_ms, tags, enabled, registered_by, registered_at,
             created_at, updated_at
      FROM tools
      WHERE tool_id = $1
    `;

    const result = await this.pool.query(query, [toolId]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      toolId: row.tool_id,
      name: row.name,
      displayName: row.display_name,
      type: row.type,
      category: row.category,
      version: row.version,
      installSpec: row.install_spec,
      skills: row.skills,
      selectorFragment: row.selector_fragment,
      routingTags: row.routing_tags,
      authGroup: row.auth_group,
      defaultAuthMode: row.default_auth_mode,
      description: row.description,
      inputSchema: row.input_schema,
      outputSchema: row.output_schema,
      usageInstructions: row.usage_instructions,
      examples: row.examples,
      requiresApproval: row.requires_approval,
      timeoutMs: row.timeout_ms,
      tags: row.tags,
      enabled: row.enabled,
      registeredBy: row.registered_by,
      registeredAt: row.registered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * @description Fetch all enabled tools from database
   */
  private async fetchAllEnabledTools(): Promise<Tool[]> {
    const query = `
      SELECT tool_id, name, display_name, type, category, version,
             install_spec, skills, selector_fragment, routing_tags,
             auth_group, default_auth_mode, description, input_schema,
             output_schema, usage_instructions, examples, requires_approval,
             timeout_ms, tags, enabled, registered_by, registered_at,
             created_at, updated_at
      FROM tools
      WHERE enabled = true
      ORDER BY name
    `;

    const result = await this.pool.query(query);
    return result.rows.map(row => ({
      toolId: row.tool_id,
      name: row.name,
      displayName: row.display_name,
      type: row.type,
      category: row.category,
      version: row.version,
      installSpec: row.install_spec,
      skills: row.skills,
      selectorFragment: row.selector_fragment,
      routingTags: row.routing_tags,
      authGroup: row.auth_group,
      defaultAuthMode: row.default_auth_mode,
      description: row.description,
      inputSchema: row.input_schema,
      outputSchema: row.output_schema,
      usageInstructions: row.usage_instructions,
      examples: row.examples,
      requiresApproval: row.requires_approval,
      timeoutMs: row.timeout_ms,
      tags: row.tags,
      enabled: row.enabled,
      registeredBy: row.registered_by,
      registeredAt: row.registered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * @description Record skipped verification (no verify command)
   */
  private async recordSkippedVerification(
    tool: Tool,
    verifiedBy: string,
    reason = 'No reviewed verifier configured',
  ): Promise<VerificationResult> {
    return await this.recordVerificationResult({
      toolId: tool.toolId,
      toolName: tool.name,
      verifyCommand: null,
      status: VerificationStatus.SKIPPED,
      exitCode: null,
      stdout: null,
      stderr: null,
      durationMs: null,
      verifiedBy,
      errorMessage: reason,
    });
  }

  /**
   * @description Record error verification (exception during verification)
   */
  private async recordErrorVerification(
    toolId: string,
    verifiedBy: string,
    error: any,
    startTime: number
  ): Promise<VerificationResult> {
    const durationMs = Date.now() - startTime;

    return await this.recordVerificationResult({
      toolId,
      toolName: 'unknown',
      verifyCommand: null,
      status: VerificationStatus.ERROR,
      exitCode: null,
      stdout: null,
      stderr: null,
      durationMs,
      verifiedBy,
      errorMessage: error.message,
    });
  }

  /**
   * @description Insert verification result into database
   */
  private async recordVerificationResult(
    data: Omit<VerificationResult, 'id' | 'verifiedAt'>
  ): Promise<VerificationResult> {
    const query = `
      INSERT INTO tool_verification_results (
        tool_id, tool_name, verify_command, status, exit_code,
        stdout, stderr, duration_ms, verified_by, error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, tool_id, tool_name, verify_command, status, exit_code,
                stdout, stderr, duration_ms, verified_at, verified_by, error_message
    `;

    const values = [
      data.toolId,
      data.toolName,
      data.verifyCommand,
      data.status,
      data.exitCode,
      data.stdout,
      data.stderr,
      data.durationMs,
      data.verifiedBy,
      data.errorMessage,
    ];

    const result = await this.pool.query(query, values);
    return this.mapRowToResult(result.rows[0]);
  }

  /**
   * @description Update tool table with latest verification status
   */
  private async updateToolVerificationStatus(
    toolId: string,
    status: VerificationStatus,
    verifiedAt: Date
  ): Promise<void> {
    const query = `
      UPDATE tools
      SET last_verified_at = $1,
          last_verification_status = $2
      WHERE tool_id = $3
    `;

    await this.pool.query(query, [verifiedAt, status, toolId]);
  }

  /**
   * @description Map database row to VerificationResult
   */
  private mapRowToResult(row: any): VerificationResult {
    return {
      id: row.id,
      toolId: row.tool_id,
      toolName: row.tool_name,
      verifyCommand: row.verify_command,
      status: row.status,
      exitCode: row.exit_code,
      stdout: row.stdout,
      stderr: row.stderr,
      durationMs: row.duration_ms,
      verifiedAt: row.verified_at,
      verifiedBy: row.verified_by,
      errorMessage: row.error_message,
    };
  }

  /**
   * @description Build summary from verification results
   */
  private buildSummary(
    results: PromiseSettledResult<VerificationResult>[],
    startedAt: Date
  ): VerificationSummary {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    const summary: VerificationSummary = {
      total: results.length,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      pending: 0,
      startedAt,
      completedAt,
      durationMs,
    };

    results.forEach(result => {
      if (result.status === 'fulfilled') {
        const status = result.value.status;
        if (status === VerificationStatus.PASSED) summary.passed++;
        else if (status === VerificationStatus.FAILED) summary.failed++;
        else if (status === VerificationStatus.ERROR) summary.errors++;
        else if (status === VerificationStatus.SKIPPED) summary.skipped++;
        else if (status === VerificationStatus.PENDING) summary.pending++;
      } else {
        summary.errors++;
      }
    });

    return summary;
  }
}
