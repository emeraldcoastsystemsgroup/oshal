/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression tests for bulk bot profile configuration and exclusion rules
 */

import { expect, test } from '@playwright/test';
import { AgentProfileService } from '../src/features/agent-profile/services/agent-profile-service';
import type { AgentProfile, AgentSummary } from '../src/entities/agent';

test.describe('AgentProfileService bulk configuration', () => {
  test('configureUnsetProfiles only fills blank fields and skips excluded bots', async () => {
    const repository = new InMemoryAgentProfileRepository([
      createProfile({
        agentId: '00000000-0000-4000-8000-000000000001',
        name: 'template-bot',
        providerId: '',
        modelId: '',
        projectUrl: '',
        selectorSkillsText: '',
      }),
      createProfile({
        agentId: '00000000-0000-4000-8000-000000000002',
        name: 'already-configured',
        providerId: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        projectUrl: 'https://example.com/repo',
        selectorSkillsText: 'existing skill',
      }),
      createProfile({
        agentId: '00000000-0000-4000-8000-000000000003',
        name: 'excluded-bot',
        providerId: '',
        modelId: '',
        projectUrl: '',
        selectorSkillsText: '',
        excludeFromBulkConfig: true,
      }),
    ]);
    const service = createService(repository);

    const result = await service.configureUnsetProfiles({
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      projectUrl: 'https://github.com/acme/swarm',
      selectorSkillsText: 'bulk skill',
      themePreference: 'ocean',
    });

    expect(result.updatedAgents).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(result.skippedAgents).toEqual([
      { agentId: '00000000-0000-4000-8000-000000000002', reason: 'already-configured' },
      { agentId: '00000000-0000-4000-8000-000000000003', reason: 'excluded' },
    ]);

    const updated = await repository.getAgentProfile('00000000-0000-4000-8000-000000000001');
    expect(updated?.providerId).toBe('openai-codex');
    expect(updated?.modelId).toBe('gpt-5.3-codex');
    expect(updated?.projectUrl).toBe('https://github.com/acme/swarm');
    expect(updated?.selectorSkillsText).toBe('bulk skill');
    expect(updated?.themePreference).toBe('midnight');

    const untouched = await repository.getAgentProfile('00000000-0000-4000-8000-000000000002');
    expect(untouched?.providerId).toBe('openai-codex');
    expect(untouched?.projectUrl).toBe('https://example.com/repo');
  });

  test('configureAllProfiles overwrites eligible bots and leaves excluded bots alone', async () => {
    const repository = new InMemoryAgentProfileRepository([
      createProfile({
        agentId: '00000000-0000-4000-8000-000000000011',
        name: 'bot-one',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
      }),
      createProfile({
        agentId: '00000000-0000-4000-8000-000000000012',
        name: 'bot-two',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
        excludeFromBulkConfig: true,
      }),
    ]);
    const service = createService(repository);

    const result = await service.configureAllProfiles({
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      status: 'paused',
    });

    expect(result.updatedAgents).toEqual(['00000000-0000-4000-8000-000000000011']);
    expect(result.skippedAgents).toEqual([
      { agentId: '00000000-0000-4000-8000-000000000012', reason: 'excluded' },
    ]);

    const updated = await repository.getAgentProfile('00000000-0000-4000-8000-000000000011');
    expect(updated?.providerId).toBe('openai-codex');
    expect(updated?.modelId).toBe('gpt-5.3-codex');
    expect(updated?.status).toBe('paused');

    const excluded = await repository.getAgentProfile('00000000-0000-4000-8000-000000000012');
    expect(excluded?.providerId).toBe('anthropic');
    expect(excluded?.status).toBe('active');
  });
});

function createService(repository: InMemoryAgentProfileRepository): AgentProfileService {
  return new AgentProfileService({
    repository,
    recomposeSelector: async () => undefined,
  });
}

class InMemoryAgentProfileRepository {
  private readonly profiles = new Map<string, AgentProfile>();

  constructor(profiles: AgentProfile[]) {
    for (const profile of profiles) {
      this.profiles.set(profile.agentId, structuredClone(profile));
    }
  }

  async getAgentProfile(agentId: string): Promise<AgentProfile | null> {
    const profile = this.profiles.get(agentId);
    return profile ? structuredClone(profile) : null;
  }

  async listAgents(): Promise<AgentSummary[]> {
    return Array.from(this.profiles.values()).map((profile) => ({
      agentId: profile.agentId,
      name: profile.name,
      status: profile.status,
      providerId: profile.providerId,
      modelId: profile.modelId,
      projectUrl: profile.projectUrl,
      avatarUrl: profile.avatarUrl,
      themePreference: profile.themePreference,
      excludeFromBulkConfig: profile.excludeFromBulkConfig,
      updatedAt: profile.updatedAt,
    }));
  }

  async updateAgentProfile(input: {
    agentId: string;
    name: string;
    status: string;
    providerId: string;
    modelId?: string;
    metadata: Record<string, unknown>;
    baseCapabilities: string[];
    baseSelectorDescriptor: string;
    baseRoutingKeywords: string[];
  }): Promise<AgentProfile | null> {
    const existing = this.profiles.get(input.agentId);
    if (!existing) {
      return null;
    }

    const updated: AgentProfile = {
      ...existing,
      name: input.name,
      status: input.status,
      providerId: input.providerId,
      modelId: input.modelId,
      projectUrl: typeof input.metadata.projectUrl === 'string' ? input.metadata.projectUrl : '',
      selectorSkillsText: typeof input.metadata.selectorSkillsText === 'string' ? input.metadata.selectorSkillsText : '',
      avatarUrl: typeof input.metadata.avatarUrl === 'string' ? input.metadata.avatarUrl : '',
      themePreference: typeof input.metadata.themePreference === 'string' ? input.metadata.themePreference : 'midnight',
      excludeFromBulkConfig: input.metadata.excludeFromBulkConfig === true,
      metadata: structuredClone(input.metadata),
      updatedAt: new Date().toISOString(),
    };
    this.profiles.set(input.agentId, updated);
    return structuredClone(updated);
  }
}

function createProfile(overrides: Partial<AgentProfile> & { agentId: string; name: string }): AgentProfile {
  return {
    agentId: overrides.agentId,
    name: overrides.name,
    status: overrides.status ?? 'active',
    providerId: overrides.providerId ?? 'anthropic',
    modelId: overrides.modelId,
    persona: overrides.persona || {},
    projectUrl: overrides.projectUrl ?? '',
    selectorSkillsText: overrides.selectorSkillsText ?? '',
    avatarUrl: overrides.avatarUrl ?? '',
    themePreference: overrides.themePreference ?? 'midnight',
    excludeFromBulkConfig: overrides.excludeFromBulkConfig === true,
    metadata: {
      projectUrl: overrides.projectUrl ?? '',
      selectorSkillsText: overrides.selectorSkillsText ?? '',
      avatarUrl: overrides.avatarUrl ?? '',
      themePreference: overrides.themePreference ?? 'midnight',
      excludeFromBulkConfig: overrides.excludeFromBulkConfig === true,
    },
    updatedAt: overrides.updatedAt || new Date().toISOString(),
  };
}
