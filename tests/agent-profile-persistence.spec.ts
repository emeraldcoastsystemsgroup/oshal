/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright and service-level coverage for dedicated agent-profile persistence and per-agent isolation
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage to preserve seeded routing metadata when selector descriptor prose is edited
 */

import { expect, test } from '@playwright/test';
import { AgentProfileService } from '../src/features/agent-profile';

const DEFAULT_AGENT_ID = '00000000-0000-4000-8000-000000000032';
const AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAukB9WnG6QAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * @description Validates dedicated agent-profile persistence through the standalone chat settings modal.
 */
test('chat settings save agent profile through dedicated agent-profile endpoint', async ({ page }) => {
  await page.goto('/chat');
  await page.click('#openToolsConfigBtn');
  await page.click('[data-config-section="agent"]');

  await page.fill('#agentNameInput', 'Tenant Alpha Bot');
  await page.fill('#projectUrlInput', 'https://git.example.com/alpha/repo');
  await page.fill('#selectorSkillsInput', 'kubernetes, sre');
  await page.setInputFiles('#agentAvatarFileInput', {
    name: 'tenant-alpha.png',
    mimeType: 'image/png',
    buffer: AVATAR_PNG,
  });
  await page.click('#saveToolsConfigBtn');
  await expect(page.locator('#modalStatus')).toContainText('Saved agent, MCP, tool switch, and tool auth configuration.');

  const profile = await page.evaluate(async (agentId) => {
    const response = await fetch(`/api/agents/${agentId}/profile`, { credentials: 'include' });
    const payload = await response.json();
    return payload.profile;
  }, DEFAULT_AGENT_ID);

  expect(profile.name).toBe('Tenant Alpha Bot');
  expect(profile.projectUrl).toBe('https://git.example.com/alpha/repo');
  expect(profile.selectorSkillsText).toBe('kubernetes, sre');
  expect(profile.avatarUrl).toMatch(/^data:image\/png;base64,/);

  await page.reload();
  await expect(page.locator('#agentSummary')).toContainText('Tenant Alpha Bot');
});

/**
 * @description Confirms persisted agent-profile updates remain isolated by agentId.
 */
test('agent profile service keeps per-agent tenants independent', async () => {
  const repository = createFakeRepository();
  const recomposed: string[] = [];
  const service = new AgentProfileService({
    repository,
    recomposeSelector: async (agentId) => {
      recomposed.push(agentId);
      return null;
    },
  });

  await service.updateAgentProfile('agent-a', {
    name: 'Tenant A',
    projectUrl: 'https://git.example.com/a/repo',
    selectorSkillsText: 'platform, kubernetes',
    themePreference: 'graphite',
  });

  const agentA = await service.getAgentProfile('agent-a');
  const agentB = await service.getAgentProfile('agent-b');

  expect(agentA?.name).toBe('Tenant A');
  expect(agentA?.projectUrl).toBe('https://git.example.com/a/repo');
  expect(agentA?.themePreference).toBe('graphite');
  expect(agentB?.name).toBe('Tenant B');
  expect(agentB?.projectUrl).toBe('https://git.example.com/b/repo');
  expect(agentB?.themePreference).toBe('midnight');
  expect(recomposed).toEqual(['agent-a']);
});

test('agent profile service preserves existing routing metadata when selector text is descriptive prose', async () => {
  const repository = createFakeRepository();
  const service = new AgentProfileService({
    repository,
    recomposeSelector: async () => null,
  });

  await service.updateAgentProfile('agent-a', {
    selectorSkillsText: 'Select for IN-DEPTH RESEARCH, ANALYSIS, or INVESTIGATION.',
  });

  const saved = repository.records.get('agent-a');
  expect(saved?.baseCapabilities).toEqual(['platform-engineering', 'kubernetes']);
  expect(saved?.routingKeywords).toEqual(['platform', 'kubernetes', 'sre']);
  expect(saved?.selectorDescriptor).toBe('Select for IN-DEPTH RESEARCH, ANALYSIS, or INVESTIGATION.');
});

/**
 * @description Builds a small in-memory repository fixture for agent-profile service tests.
 * @returns Fake repository compatible with AgentProfileService.
 */
function createFakeRepository() {
  const records = new Map([
    ['agent-a', createProfile('agent-a', 'Tenant A Base', 'https://git.example.com/base-a', 'midnight')],
    ['agent-b', createProfile('agent-b', 'Tenant B', 'https://git.example.com/b/repo', 'midnight')],
  ]);

  return {
    records,
    async getAgentProfile(agentId: string) {
      return records.get(agentId) || null;
    },
    async listAgents() {
      return Array.from(records.values()).map((profile) => ({
        agentId: profile.agentId,
        name: profile.name,
        status: profile.status,
        providerId: profile.providerId,
        modelId: profile.modelId,
        baseCapabilities: profile.baseCapabilities,
        selectorDescriptor: profile.selectorDescriptor,
        routingKeywords: profile.routingKeywords,
        projectUrl: profile.projectUrl,
        avatarUrl: profile.avatarUrl,
        themePreference: profile.themePreference,
        updatedAt: profile.updatedAt,
      }));
    },
    async updateAgentProfile(input: {
      agentId: string;
      name: string;
      metadata: Record<string, unknown>;
      baseCapabilities: string[];
      baseSelectorDescriptor: string;
      baseRoutingKeywords: string[];
    }) {
      const existing = records.get(input.agentId);
      if (!existing) {
        return null;
      }

      const next = {
        ...existing,
        name: input.name,
        projectUrl: String(input.metadata.projectUrl || ''),
        selectorSkillsText: String(input.metadata.selectorSkillsText || ''),
        avatarUrl: String(input.metadata.avatarUrl || ''),
        themePreference: String(input.metadata.themePreference || 'midnight'),
        baseCapabilities: input.baseCapabilities,
        selectorDescriptor: input.baseSelectorDescriptor,
        routingKeywords: input.baseRoutingKeywords,
        metadata: { ...input.metadata },
        updatedAt: new Date().toISOString(),
      };
      records.set(input.agentId, next);
      return next;
    },
  };
}

/**
 * @description Creates a normalized fake profile fixture.
 * @param agentId - Agent identifier.
 * @param name - Display name.
 * @param projectUrl - Project URL.
 * @param themePreference - Theme id.
 * @returns Fake agent-profile record.
 */
function createProfile(agentId: string, name: string, projectUrl: string, themePreference: string) {
  return {
    agentId,
    name,
    status: 'active',
    providerId: 'openai-codex',
    modelId: 'gpt-5.4',
    baseCapabilities: ['platform-engineering', 'kubernetes'],
    selectorDescriptor: 'Select this agent when platform and Kubernetes work is needed.',
    routingKeywords: ['platform', 'kubernetes', 'sre'],
    projectUrl,
    selectorSkillsText: '',
    avatarUrl: '',
    themePreference,
    metadata: {
      projectUrl,
      selectorSkillsText: '',
      avatarUrl: '',
      themePreference,
    },
    updatedAt: new Date().toISOString(),
  };
}
