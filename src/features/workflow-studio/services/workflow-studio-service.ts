/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added file-backed workflow-studio service for design-time definitions, validation, and compile previews
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSummary } from '@/entities/agent';
import { createChildLogger } from '@/shared/logger';
import {
  WorkflowDefinitionSchema,
  type CreateWorkflowDefinitionInput,
  type UpdateWorkflowDefinitionInput,
  type WorkflowCompilePreview,
  type WorkflowDefinition,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionVersionSummary,
  type WorkflowStudioCatalog,
  type WorkflowValidationReport,
  buildSeedWorkflowDefinition,
  buildTemplateWorkflowDefinition,
  buildWorkflowDefinitionSummary,
  buildWorkflowStudioCatalog,
  listWorkflowTemplates,
  slugifyWorkflowName,
} from '../schemas/workflow-studio-schemas';
import {
  compileWorkflowDefinition,
  type WorkflowCompilerAgentSummary,
  type WorkflowCompilerContext,
  validateWorkflowDefinition,
} from './workflow-studio-compiler';
import { randomUUID } from 'node:crypto';

const logger = createChildLogger({ module: 'workflow-studio-service' });

interface WorkflowStudioAgentRosterProvider {
  listAgents(): Promise<AgentSummary[]>;
}

/**
 * @description File-backed design-time store for workflow-studio definitions.
 * This service owns authoring persistence only; it does not execute workflows.
 */
export class WorkflowStudioService {
  private initializationPromise?: Promise<void>;
  private readonly historyDir: string;

  constructor(
    private readonly storageDir = path.resolve(process.cwd(), 'output', 'workflow-studio', 'definitions'),
    private readonly agentRosterProvider?: WorkflowStudioAgentRosterProvider,
  ) {
    this.historyDir = path.join(this.storageDir, '.history');
  }

  async getCatalog(): Promise<WorkflowStudioCatalog> {
    await this.ensureInitialized();
    return buildWorkflowStudioCatalog();
  }

  async listDefinitions(): Promise<WorkflowDefinitionSummary[]> {
    const definitions = await this.readAllDefinitions();
    return definitions
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((definition) => buildWorkflowDefinitionSummary(definition));
  }

  async getDefinition(definitionId: string): Promise<WorkflowDefinition | null> {
    await this.ensureInitialized();
    try {
      const raw = await readFile(this.resolveDefinitionPath(definitionId), 'utf8');
      return WorkflowDefinitionSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async listDefinitionVersions(definitionId: string): Promise<WorkflowDefinitionVersionSummary[]> {
    await this.ensureInitialized();
    const versionDir = this.resolveDefinitionHistoryDir(definitionId);

    try {
      const entries = await readdir(versionDir, { withFileTypes: true });
      const versions: WorkflowDefinitionVersionSummary[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }

        try {
          const raw = await readFile(path.join(versionDir, entry.name), 'utf8');
          const definition = WorkflowDefinitionSchema.parse(JSON.parse(raw) as unknown);
          versions.push({
            definitionId: definition.id,
            name: definition.name,
            version: definition.version,
            updatedAt: definition.updatedAt,
            nodeCount: definition.nodes.length,
            edgeCount: definition.edges.length,
          });
        } catch (error) {
          logger.warn({ err: error, definitionId, fileName: entry.name }, 'Skipping unreadable workflow version snapshot');
        }
      }

      return versions.sort((left, right) => right.version - left.version);
    } catch {
      return [];
    }
  }

  async getDefinitionVersion(definitionId: string, version: number): Promise<WorkflowDefinition | null> {
    await this.ensureInitialized();
    try {
      const raw = await readFile(this.resolveDefinitionVersionPath(definitionId, version), 'utf8');
      return WorkflowDefinitionSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async createDefinition(input: CreateWorkflowDefinitionInput = {}): Promise<WorkflowDefinition> {
    await this.ensureInitialized();
    const definition = buildSeedWorkflowDefinition({
      name: input.name?.trim() || this.buildDraftName(),
      description: input.description?.trim(),
    });
    await this.writeDefinition(definition);
    logger.info({ definitionId: definition.id, name: definition.name }, 'Workflow definition created');
    return definition;
  }

  /** @description The built-in template gallery (id/name/description) for the studio picker. */
  listTemplates(): Array<{ id: string; name: string; description: string }> {
    return listWorkflowTemplates();
  }

  /** @description Create a new definition from a built-in template (null when the id is unknown). */
  async createFromTemplate(templateId: string, input: CreateWorkflowDefinitionInput = {}): Promise<WorkflowDefinition | null> {
    await this.ensureInitialized();
    const definition = buildTemplateWorkflowDefinition(templateId, input);
    if (!definition) {
      return null;
    }
    await this.writeDefinition(definition);
    logger.info({ definitionId: definition.id, templateId }, 'Workflow definition created from template');
    return definition;
  }

  async saveDefinition(input: UpdateWorkflowDefinitionInput): Promise<WorkflowDefinition> {
    await this.ensureInitialized();
    const existing = await this.getDefinition(input.id);
    const timestamp = new Date().toISOString();
    const candidate: WorkflowDefinition = {
      id: input.id,
      name: input.name.trim(),
      slug: slugifyWorkflowName(input.name),
      description: input.description?.trim() ?? '',
      runtimeTarget: 'swarm-design-layer',
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      nodes: input.nodes,
      edges: input.edges,
      metadata: {
        notes: input.metadata?.notes,
        seed: input.metadata?.seed ?? false,
        tags: input.metadata?.tags ?? ['workflow-studio'],
      },
    };
    const definition = WorkflowDefinitionSchema.parse(candidate);
    await this.writeDefinition(definition);
    logger.info(
      { definitionId: definition.id, version: definition.version, nodeCount: definition.nodes.length, edgeCount: definition.edges.length },
      'Workflow definition saved',
    );
    return definition;
  }

  async duplicateDefinition(definitionId: string, input: CreateWorkflowDefinitionInput = {}): Promise<WorkflowDefinition | null> {
    const definition = await this.getDefinition(definitionId);
    if (!definition) {
      return null;
    }

    const duplicate = this.createDerivedDefinition(definition, {
      name: input.name?.trim() || `${definition.name} Copy`,
      description: input.description?.trim() ?? definition.description,
      duplicateTags: ['workflow-studio', 'duplicate'],
    });
    await this.writeDefinition(duplicate);
    logger.info({ definitionId: duplicate.id, sourceDefinitionId: definitionId, name: duplicate.name }, 'Workflow definition duplicated');
    return duplicate;
  }

  async forkDefinitionVersion(
    definitionId: string,
    version: number,
    input: CreateWorkflowDefinitionInput = {},
  ): Promise<WorkflowDefinition | null> {
    const snapshot = await this.getDefinitionVersion(definitionId, version);
    if (!snapshot) {
      return null;
    }

    const fork = this.createDerivedDefinition(snapshot, {
      name: input.name?.trim() || `${snapshot.name} v${snapshot.version} Fork`,
      description: input.description?.trim() ?? snapshot.description,
      duplicateTags: ['workflow-studio', 'forked-version'],
    });
    await this.writeDefinition(fork);
    logger.info(
      { definitionId: fork.id, sourceDefinitionId: definitionId, sourceVersion: version, name: fork.name },
      'Workflow definition forked from historical version',
    );
    return fork;
  }

  async validateDefinition(definitionId: string): Promise<WorkflowValidationReport | null> {
    const definition = await this.getDefinition(definitionId);
    if (!definition) {
      return null;
    }
    return validateWorkflowDefinition(definition, await this.buildCompilerContext());
  }

  async compileDefinition(definitionId: string): Promise<WorkflowCompilePreview | null> {
    const definition = await this.getDefinition(definitionId);
    if (!definition) {
      return null;
    }
    return compileWorkflowDefinition(definition, await this.buildCompilerContext());
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initialize();
    }
    await this.initializationPromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await mkdir(this.historyDir, { recursive: true });
    const fileNames = await this.readDefinitionFileNames();
    if (fileNames.length > 0) {
      return;
    }

    const seed = buildSeedWorkflowDefinition();
    await this.writeDefinition(seed);
    logger.info({ definitionId: seed.id, storageDir: this.storageDir }, 'Workflow studio seeded default definition');
  }

  private async readAllDefinitions(): Promise<WorkflowDefinition[]> {
    await this.ensureInitialized();
    const fileNames = await this.readDefinitionFileNames();
    const definitions: WorkflowDefinition[] = [];

    for (const fileName of fileNames) {
      try {
        const raw = await readFile(path.join(this.storageDir, fileName), 'utf8');
        definitions.push(WorkflowDefinitionSchema.parse(JSON.parse(raw) as unknown));
      } catch (error) {
        logger.warn({ err: error, fileName }, 'Skipping unreadable workflow definition file');
      }
    }

    return definitions;
  }

  private async readDefinitionFileNames(): Promise<string[]> {
    const entries = await readdir(this.storageDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  }

  private async writeDefinition(definition: WorkflowDefinition): Promise<void> {
    await mkdir(this.resolveDefinitionHistoryDir(definition.id), { recursive: true });
    await writeFile(
      this.resolveDefinitionPath(definition.id),
      `${JSON.stringify(definition, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      this.resolveDefinitionVersionPath(definition.id, definition.version),
      `${JSON.stringify(definition, null, 2)}\n`,
      'utf8',
    );
  }

  private resolveDefinitionPath(definitionId: string): string {
    return path.join(this.storageDir, `${definitionId}.json`);
  }

  private resolveDefinitionHistoryDir(definitionId: string): string {
    return path.join(this.historyDir, definitionId);
  }

  private resolveDefinitionVersionPath(definitionId: string, version: number): string {
    return path.join(this.resolveDefinitionHistoryDir(definitionId), `v${String(version).padStart(4, '0')}.json`);
  }

  private buildDraftName(): string {
    const now = new Date();
    const label = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
    ].join('');
    return `Workflow Draft ${label}`;
  }

  private async buildCompilerContext(): Promise<WorkflowCompilerContext> {
    if (!this.agentRosterProvider) {
      return {
        agents: [],
        rosterStatus: 'unavailable',
      };
    }

    try {
      const agents = await this.agentRosterProvider.listAgents();
      return {
        agents: agents.map((agent) => mapCompilerAgent(agent)),
        rosterStatus: 'available',
      };
    } catch (error) {
      logger.warn({ err: error }, 'Workflow studio could not load the live agent roster; compile/validation will skip compatibility checks');
      return {
        agents: [],
        rosterStatus: 'unavailable',
      };
    }
  }

  private createDerivedDefinition(
    source: WorkflowDefinition,
    options: {
      description: string;
      duplicateTags: string[];
      name: string;
    },
  ): WorkflowDefinition {
    const now = new Date().toISOString();
    return WorkflowDefinitionSchema.parse({
      ...JSON.parse(JSON.stringify(source)),
      id: randomUUID(),
      name: options.name,
      slug: slugifyWorkflowName(options.name),
      description: options.description,
      version: 1,
      createdAt: now,
      updatedAt: now,
      metadata: {
        notes: source.metadata?.notes,
        seed: false,
        tags: Array.from(new Set([...(source.metadata?.tags ?? []), ...options.duplicateTags])),
      },
    });
  }
}

function mapCompilerAgent(agent: AgentSummary): WorkflowCompilerAgentSummary {
  return {
    agentId: agent.agentId,
    name: agent.name,
    status: agent.status,
    baseCapabilities: agent.baseCapabilities ?? [],
    routingKeywords: agent.routingKeywords ?? [],
  };
}
