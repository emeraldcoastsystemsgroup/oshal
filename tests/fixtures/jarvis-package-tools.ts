/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise transient proposals against real installed package policy and executable handlers.
 */
import express from 'express';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { createJarvisPackageToolRoutes } from '@/app/routes/jarvis-package-tool-routes';
import { JarvisPackageToolService, type JarvisPackageToolMetadata } from '@/app/routes/jarvis-package-tool-service';
import { PackageToolsFixture, toolAlice } from './package-tools';

/** @description Build actual HTTP proposal adapters with real package factories, current policy and execution.
 * @param mode Manifest approval posture. @param configure Optional package setup before initial activation.
 * @returns A disposable fixture with exact authenticated test users.
 */
export async function createJarvisPackageToolsFixture(mode: 'auto' | 'ask' = 'auto', configure?: (fixture: PackageToolsFixture) => void) {
  const fixture = new PackageToolsFixture(); fixture.manifest.tools![0].defaultAuthMode = mode;
  configure?.(fixture);
  await fixture.mount(); await fixture.grant();
  const actors: Record<string, AuthorizationActor> = { alice: toolAlice, bob: { ...toolAlice, sub: 'bob' },
    collision: { ...toolAlice, issuer: 'https://other.example.test' } };
  const state = { now: Date.now(), enabled: true, mode, metadataWait: async () => {} };
  const metadata = async (name: string): Promise<JarvisPackageToolMetadata> => {
    await state.metadataWait(); return { name, enabled: state.enabled, defaultAuthMode: state.mode, displayName: 'Read fixture records',
      description: 'Read current owned records', routingTags: ['records', 'customer lookup', 'records'], tags: ['workspace', 'customer lookup'],
      inputSchema: { type: 'object', additionalProperties: false, properties: { tenantId: { type: 'string' } } } };
  };
  const service = new JarvisPackageToolService({ names: () => fixture.registry.names(), inspect: name => fixture.registry.inspect(name), metadata,
    authorize: (actor, operation) => fixture.runtime.authorize(actor, operation),
    execute: (name, input, sub, sessionId) => fixture.executor.executeTool(sessionId, name, input, undefined, sub),
    canUseSession: async (actor, id) => id === 'fixture-session' && actor.sub === toolAlice.sub && actor.issuer === toolAlice.issuer,
    now: () => state.now });
  fixture.app.use(express.json({ limit: '32kb' }));
  fixture.app.use('/api/jarvis/package-tools', createJarvisPackageToolRoutes(service, async req => {
    const actor = actors[req.get('x-fixture-user') ?? ''];
    if (!actor) throw Object.assign(new Error('package_tool_identity_required'), { status: 401 }); return actor;
  }));
  const base = await fixture.listen();
  const call = (path: string, body?: unknown, user = 'alice', headers: Record<string, string> = {}) => fetch(base + '/api/jarvis/package-tools' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-fixture-user': user, origin: base, 'x-oshal-package-tool': '1', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const propose = async (input: Record<string, unknown> = {}) => {
    const response = await call('/preview', { sessionId: 'fixture-session', toolName: 'package_read', input });
    if (!response.ok) throw new Error('Fixture preview failed: ' + await response.text()); return response.json();
  };
  return { fixture, service, state, actors, base, call, propose, metadata, close: () => fixture.close() };
}
