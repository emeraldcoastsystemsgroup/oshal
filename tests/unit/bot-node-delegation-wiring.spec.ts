/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin production composition for service-secret-first signed HTTP authorization, verified identity forwarding, replay shutdown, key-role separation, and unsigned runtime/fallback prohibition.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing wiring boundary: ${start} -> ${end}`);
  return text.slice(startIndex, endIndex);
}

describe('bot-node delegation production wiring', () => {
  it('orders machine authentication, signed delegation, entitlement, and execution', () => {
    const server = source('src/app/bot-node-server.ts');
    const route = between(server, "app.post(\n    '/api/swarm-execute'", '// ── /api/token-chase/replay-call');
    const machine = route.indexOf('authorizeBotNodeExecutionCall');
    const delegation = route.indexOf('delegationRuntime.authorize');
    const entitlement = route.indexOf('executeEntitlementGate');
    const execution = route.indexOf('runBotNodeExecutionWithSystemIdentity(() => executionHandler(envelope))');
    expect(machine).toBeGreaterThan(-1);
    expect(machine).toBeLessThan(delegation);
    expect(delegation).toBeLessThan(entitlement);
    expect(entitlement).toBeLessThan(execution);
    expect(route).toContain('verifiedDelegation?.sub ?? body.userSub');
    expect(route).toContain('principalIssuer: verifiedDelegation.principal_iss');
  });

  it('guards Redis execution and closes the replay ledger on shutdown', () => {
    const server = source('src/app/bot-node-server.ts');
    expect(server).toContain('prohibitUnsignedMeshExecution(delegationRuntime.enforcementEnabled, executionHandler)');
    expect(server).toContain('await delegationRuntime.close()');
  });

  it('keeps the private key controller-only in local compose', () => {
    const compose = source('docker-compose.oshal-local.yml');
    const botEnvironment = between(compose, 'x-bot-env: &bot-env', '\nservices:');
    const controller = compose.slice(compose.indexOf('\n  oshal-api:'));
    expect(botEnvironment).toContain('OSHAL_DELEGATION_PUBLIC_KEYS');
    expect(botEnvironment).not.toContain('OSHAL_DELEGATION_SIGNING_PRIVATE_KEY');
    expect(controller).toContain('OSHAL_DELEGATION_PUBLIC_KEYS: ""');
    expect(controller).toContain('OSHAL_DELEGATION_SIGNING_PRIVATE_KEY');
  });

  it('prohibits every unsigned alternate execution path under enforcement', () => {
    const batch = source('src/app/bot-node-batch.ts');
    const legacy = source('scripts/bot-entrypoint.sh');
    const manifest = source('src/features/swarm-orchestration/services/dispatch-manifest-worker.ts');
    const incident = source('src/features/swarm-orchestration/services/dispatch-incident-worker.ts');
    const engine = source('src/features/swarm-orchestration/services/engine-services-adapter.ts');
    expect(batch).toContain('assertDelegationBatchRuntimeAllowed()');
    expect(legacy).toContain('BOT_RUNTIME=any-bot cannot run while HTTP delegation enforcement is configured');
    expect(manifest).toContain('deps.botNodeClient.isDelegationEnforced()');
    expect(incident).toContain('botNodeClient.isDelegationEnforced()');
    expect(engine.match(/isDelegationEnforced\(\)/g)).toHaveLength(2);
    expect(incident).toContain("'x-oshal-user-sub': ticket.ownerSub");
  });
});
