/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Lock-in coverage for the perAgentRuntime config ownership section (ADR-034)
 */

import { expect, test } from '@playwright/test';
import { buildConfigOwnershipContract } from '../src/app/routes/config-ownership-contract';

/**
 * @description Source-level lock-in: the config ownership contract must declare a
 * perAgentRuntime section owned by the OSHAL control plane, per ADR-034. This is the
 * surface (provider/model/mode/credentials/MCP/flags) that previously had no owner and
 * caused the any-bot <-> OSHAL ownership contention.
 */
test('config ownership contract declares OSHAL-owned perAgentRuntime section', async () => {
  const contract = buildConfigOwnershipContract({
    settingsPath: '/tmp/settings.json',
    secretsPath: '/tmp/secrets.json',
  });

  const runtime = (contract as Record<string, any>).perAgentRuntime;
  expect(runtime, 'perAgentRuntime section must exist (ADR-034)').toBeTruthy();
  expect(runtime.owner).toContain('OSHAL');
  expect(runtime.routeBase).toBe('/api/agents/:agentId/runtime');
  expect(Array.isArray(runtime.routes)).toBe(true);
  expect(runtime.routes.length).toBeGreaterThanOrEqual(2);

  // The authoritative store is the Postgres agent_config record (single source of truth).
  expect(runtime.persistedTo.storage).toContain('agent_config');

  // The bidirectional sync model must be described: push-down, broadcast-up, standalone, central-wins.
  expect(runtime.syncModel.pushDown).toContain('switchProvider');
  expect(runtime.syncModel.broadcastUp).toContain('swarm.config-change');
  expect(runtime.syncModel.standalone).toContain('pull');
  expect(runtime.syncModel.conflictResolution).toContain('central-wins');

  // Core runtime params are enumerated, and the bot-side stores are marked as derived caches.
  expect(runtime.examples).toEqual(expect.arrayContaining(['providerId', 'modelId']));
  expect(runtime.derivedCaches.join(' ')).toContain('config:llm-provider');
});
