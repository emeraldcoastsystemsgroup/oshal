/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-profile service for narrow chat-agent persistence and selector refresh
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added optional workspace config sync callback to propagate model/provider changes to runtime globalState.json
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserved seeded routing capabilities and keywords when editing selector descriptor text
 */

import {
  type AgentBulkConfigResult,
  type AgentBulkConfigStatus,
  type AgentBulkProfileTemplate,
  type AgentSummary,
  type AgentProfile,
  type AgentProfileUpdateInput,
} from '@/entities/agent';

interface AgentProfileRepositoryPort {
  getAgentProfile(agentId: string): Promise<AgentProfile | null>;
  listAgents(): Promise<AgentSummary[]>;
  updateAgentProfile(input: {
    agentId: string;
    name: string;
    status: string;
    providerId: string;
    modelId?: string;
    metadata: Record<string, unknown>;
    baseCapabilities: string[];
    baseSelectorDescriptor: string;
    baseRoutingKeywords: string[];
  }): Promise<AgentProfile | null>;
}

interface AgentProfileServiceDeps {
  repository: AgentProfileRepositoryPort;
  recomposeSelector: (agentId: string) => Promise<unknown>;
  syncWorkspaceConfig?: (agentId: string, patch: { providerId?: string; modelId?: string }) => Promise<unknown>;
}

/**
 * @description Service for reading and updating persisted chat-agent personalization.
 * Updates stay scoped to `agentId`, which allows multiple instances of the same bot to remain independent.
 */
export class AgentProfileService {
  constructor(private readonly deps: AgentProfileServiceDeps) {}

  /**
   * @description Returns the persisted profile for one agent.
   * @param agentId - Agent identifier.
   * @returns Normalized agent profile, or null when missing.
   */
  async getAgentProfile(agentId: string): Promise<AgentProfile | null> {
    return this.deps.repository.getAgentProfile(agentId);
  }

  /**
   * @description Returns lightweight summaries for all persisted agents.
   * @returns Agent summaries ordered by repository policy.
   */
  async listAgents(): Promise<AgentSummary[]> {
    return this.deps.repository.listAgents();
  }

  /**
   * @description Returns one bulk-config status row per bot so callers can see
   * which bots are eligible, excluded, or still missing key profile fields.
   */
  async listBulkConfigStatus(): Promise<AgentBulkConfigStatus[]> {
    const agents = await this.deps.repository.listAgents();
    const profiles = await Promise.all(agents.map(async (agent) => (
      this.deps.repository.getAgentProfile(agent.agentId)
    )));

    return profiles
      .filter((profile): profile is AgentProfile => profile !== null)
      .map((profile) => ({
        agentId: profile.agentId,
        name: profile.name,
        status: profile.status,
        providerId: profile.providerId,
        modelId: profile.modelId,
        projectUrlConfigured: profile.projectUrl.trim().length > 0,
        selectorSkillsConfigured: profile.selectorSkillsText.trim().length > 0,
        excludeFromBulkConfig: profile.excludeFromBulkConfig === true,
        updatedAt: profile.updatedAt,
      }));
  }

  /**
   * @description Applies a narrow persisted profile update, then refreshes selector-composition state.
   * @param agentId - Agent identifier.
   * @param input - Partial profile update.
   * @returns Updated normalized profile, or null when the agent row is missing.
   */
  async updateAgentProfile(agentId: string, input: AgentProfileUpdateInput): Promise<AgentProfile | null> {
    const existing = await this.deps.repository.getAgentProfile(agentId);
    if (!existing) {
      return null;
    }

    const merged = mergeAgentProfile(existing, input);
    const updated = await this.deps.repository.updateAgentProfile({
      agentId,
      name: merged.name,
      status: merged.status,
      providerId: merged.providerId,
      modelId: merged.modelId,
      metadata: merged.metadata,
      baseCapabilities: merged.baseCapabilities,
      baseSelectorDescriptor: merged.selectorDescriptor,
      baseRoutingKeywords: merged.routingKeywords,
    });

    if (!updated) {
      return null;
    }

    await this.deps.recomposeSelector(agentId);

    if (this.deps.syncWorkspaceConfig && (merged.providerId || merged.modelId)) {
      await this.deps.syncWorkspaceConfig(agentId, {
        providerId: merged.providerId,
        modelId: merged.modelId,
      }).catch((err: unknown) => {
        // Non-fatal — workspace sync failure should not block profile persistence
      });
    }

    return this.deps.repository.getAgentProfile(agentId);
  }

  /**
   * @description Applies a template profile to every eligible bot, overwriting
   * target fields even when they already have values.
   */
  async configureAllProfiles(
    profile: AgentBulkProfileTemplate,
    includeExcluded = false,
  ): Promise<AgentBulkConfigResult> {
    return this.applyBulkProfileUpdate('all', profile, includeExcluded);
  }

  /**
   * @description Applies a template profile only to unset fields on eligible bots.
   */
  async configureUnsetProfiles(
    profile: AgentBulkProfileTemplate,
    includeExcluded = false,
  ): Promise<AgentBulkConfigResult> {
    return this.applyBulkProfileUpdate('unset', profile, includeExcluded);
  }

  private async applyBulkProfileUpdate(
    mode: 'all' | 'unset',
    template: AgentBulkProfileTemplate,
    includeExcluded: boolean,
  ): Promise<AgentBulkConfigResult> {
    const agents = await this.deps.repository.listAgents();
    const updatedAgents: string[] = [];
    const skippedAgents: Array<{ agentId: string; reason: string }> = [];

    for (const agent of agents) {
      const profile = await this.deps.repository.getAgentProfile(agent.agentId);
      if (!profile) {
        skippedAgents.push({ agentId: agent.agentId, reason: 'profile-missing' });
        continue;
      }

      if (!includeExcluded && profile.excludeFromBulkConfig) {
        skippedAgents.push({ agentId: agent.agentId, reason: 'excluded' });
        continue;
      }

      const update = mode === 'unset'
        ? buildUnsetBulkProfileUpdate(profile, template)
        : { ...template };

      if (Object.keys(update).length === 0) {
        skippedAgents.push({ agentId: agent.agentId, reason: mode === 'unset' ? 'already-configured' : 'no-changes-requested' });
        continue;
      }

      const saved = await this.updateAgentProfile(agent.agentId, update);
      if (!saved) {
        skippedAgents.push({ agentId: agent.agentId, reason: 'update-failed' });
        continue;
      }

      updatedAgents.push(agent.agentId);
    }

    return {
      mode,
      includeExcluded,
      requestedFieldCount: Object.keys(template).length,
      updatedAgents,
      skippedAgents,
    };
  }
}

interface MergedAgentProfileState {
  name: string;
  status: string;
  providerId: string;
  modelId?: string;
  selectorSkillsText: string;
  baseCapabilities: string[];
  selectorDescriptor: string;
  routingKeywords: string[];
  metadata: Record<string, unknown>;
}

/**
 * @description Merges a partial update into the existing persisted profile while preserving unrelated metadata.
 * @param existing - Existing agent profile.
 * @param input - Partial profile update.
 * @returns Selector-aware merged state ready for persistence.
 */
function mergeAgentProfile(existing: AgentProfile, input: AgentProfileUpdateInput): MergedAgentProfileState {
  const selectorSkillsText = pickString(input, 'selectorSkillsText', existing.selectorSkillsText || '');
  const projectUrl = pickString(input, 'projectUrl', existing.projectUrl || '');
  const avatarUrl = pickString(input, 'avatarUrl', existing.avatarUrl || '');
  const themePreference = pickString(input, 'themePreference', existing.themePreference || 'midnight');
  const name = pickRequiredName(input, existing.name);
  const status = pickString(input, 'status', existing.status || 'active');
  const providerId = pickString(input, 'providerId', existing.providerId || process.env.LLM_PROVIDER || 'openai-codex');
  const modelId = pickOptionalString(input, 'modelId', existing.modelId);
  const excludeFromBulkConfig = pickOptionalBoolean(input, 'excludeFromBulkConfig', existing.excludeFromBulkConfig === true);

  return {
    name,
    status,
    providerId,
    modelId,
    selectorSkillsText,
    baseCapabilities: existing.baseCapabilities ?? [],
    selectorDescriptor: selectorSkillsText || existing.selectorDescriptor || '',
    routingKeywords: existing.routingKeywords ?? [],
    metadata: {
      ...existing.metadata,
      projectUrl,
      avatarUrl,
      selectorSkillsText,
      themePreference,
      excludeFromBulkConfig,
    },
  };
}

/**
 * @description Picks a string from the partial update while allowing explicit clears.
 * @param input - Partial profile update.
 * @param key - Profile field name.
 * @param fallback - Existing persisted value.
 * @returns Trimmed string value.
 */
function pickString(input: AgentProfileUpdateInput, key: keyof AgentProfileUpdateInput, fallback: string): string {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * @description Picks an optional string from the partial update while allowing explicit clears.
 */
function pickOptionalString(
  input: AgentProfileUpdateInput,
  key: keyof AgentProfileUpdateInput,
  fallback?: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    return fallback;
  }
  const value = input[key];
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @description Picks an optional boolean from the partial update.
 */
function pickOptionalBoolean(
  input: AgentProfileUpdateInput,
  key: keyof AgentProfileUpdateInput,
  fallback: boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    return fallback;
  }
  return input[key] === true;
}

/**
 * @description Picks the persisted display name, rejecting blank overrides.
 * @param input - Partial profile update.
 * @param fallback - Existing name.
 * @returns Persistable name.
 */
function pickRequiredName(input: AgentProfileUpdateInput, fallback: string): string {
  const candidate = pickString(input, 'name', fallback);
  return candidate.length > 0 ? candidate : fallback;
}

/**
 * @description Builds the subset of bulk template fields that are still unset on a target bot.
 */
function buildUnsetBulkProfileUpdate(
  profile: AgentProfile,
  template: AgentBulkProfileTemplate,
): AgentBulkProfileTemplate {
  const update: AgentBulkProfileTemplate = {};

  if (template.status && isUnsetString(profile.status)) {
    update.status = template.status;
  }
  if (template.providerId && isUnsetString(profile.providerId)) {
    update.providerId = template.providerId;
  }
  if (template.modelId && isUnsetString(profile.modelId)) {
    update.modelId = template.modelId;
  }
  if (template.projectUrl && isUnsetString(profile.projectUrl)) {
    update.projectUrl = template.projectUrl;
  }
  if (template.selectorSkillsText && isUnsetString(profile.selectorSkillsText)) {
    update.selectorSkillsText = template.selectorSkillsText;
  }
  if (template.themePreference && isUnsetString(profile.themePreference)) {
    update.themePreference = template.themePreference;
  }

  return update;
}

/**
 * @description Treats blank/undefined strings as unset for bulk profile propagation.
 */
function isUnsetString(value: string | undefined): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
