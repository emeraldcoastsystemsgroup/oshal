/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial workflow-studio tool integration for AI agent tool-use
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'workflow-studio-integration' });

/**
 * @description Configuration controlling where the integration service sends its
 * Workflow Studio API requests, so it can target the in-process Express routes.
 */
export interface WorkflowStudioIntegrationConfig {
  /** Base URL for the workflow studio API (default: same-process via APP_URL) */
  baseUrl: string;
}

/**
 * @description Integration service that translates AI tool calls into Workflow Studio API requests.
 * Runs against the same-process Express routes at /api/workflow-studio/*.
 */
export class WorkflowStudioIntegrationService {
  private readonly baseUrl: string;

  constructor(config: WorkflowStudioIntegrationConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  /**
   * @description Dispatch a workflow-studio tool action to the appropriate API endpoint.
   */
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = input.action as string;
    if (!action) {
      return { success: false, error: 'Missing required field: action' };
    }

    try {
      switch (action) {
        case 'getCatalog':
          return this.get('/catalog');

        case 'listDefinitions':
          return this.get('/definitions');

        case 'getDefinition':
          return this.get(`/definitions/${this.requireString(input, 'definitionId')}`);

        case 'createDefinition':
          return this.post('/definitions', {
            name: input.name,
            description: input.description,
          });

        case 'saveDefinition':
          return this.put(`/definitions/${this.requireString(input, 'definitionId')}`, {
            nodes: input.nodes,
            edges: input.edges,
            name: input.name,
            description: input.description,
            metadata: input.metadata,
          });

        case 'validateDefinition':
          return this.post(`/definitions/${this.requireString(input, 'definitionId')}/validate`, {});

        case 'compileDefinition':
          return this.post(`/definitions/${this.requireString(input, 'definitionId')}/compile`, {});

        case 'duplicateDefinition':
          return this.post(`/definitions/${this.requireString(input, 'definitionId')}/duplicate`, {
            name: input.name,
            description: input.description,
          });

        case 'listVersions':
          return this.get(`/definitions/${this.requireString(input, 'definitionId')}/versions`);

        case 'getVersion':
          return this.get(
            `/definitions/${this.requireString(input, 'definitionId')}/versions/${this.requireField(input, 'version')}`,
          );

        case 'forkVersion':
          return this.post(
            `/definitions/${this.requireString(input, 'definitionId')}/versions/${this.requireField(input, 'version')}/fork`,
            { name: input.name, description: input.description },
          );

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ action, error: message }, 'Workflow studio tool execution failed');
      return { success: false, error: message };
    }
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    logger.debug({ url }, 'GET workflow-studio');
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GET ${path} returned ${response.status}: ${body}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    logger.debug({ url }, 'POST workflow-studio');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`POST ${path} returned ${response.status}: ${text}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  private async put(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    logger.debug({ url }, 'PUT workflow-studio');
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PUT ${path} returned ${response.status}: ${text}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  private requireString(input: Record<string, unknown>, field: string): string {
    const value = input[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing required string field: ${field}`);
    }
    return value;
  }

  private requireField(input: Record<string, unknown>, field: string): unknown {
    const value = input[field];
    if (value === undefined || value === null) {
      throw new Error(`Missing required field: ${field}`);
    }
    return value;
  }
}
