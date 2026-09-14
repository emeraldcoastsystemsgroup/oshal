/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove current exact-principal discovery, one-shot approval, revocation and expiry on real HTTP package execution.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createJarvisPackageToolsFixture } from '../fixtures/jarvis-package-tools';
import { resolveJarvisPackageToolDirective } from '@/app/routes/jarvis-package-tool-directives';
import { buildToolsBlock } from '@/app/routes/jarvis-tool-catalog';
import { toolAlice, TOOL_TENANT } from '../fixtures/package-tools';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let fixture: Awaited<ReturnType<typeof createJarvisPackageToolsFixture>>;
beforeEach(async () => { vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true'); fixture = await createJarvisPackageToolsFixture(); });
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });

it('advertises only current user tools, preserving tenant selection and semantic usage without data', async () => {
  let tools = (await (await fixture.call('/catalog')).json()).tools;
  expect(tools[0]).toMatchObject({ name: 'package_read', app: 'package-fixture', mode: 'auto' });
  expect(tools[0].keywords).toEqual(['records', 'customer lookup', 'workspace']);
  expect(buildToolsBlock({ packageTools: tools })).toContain('customer lookup');
  expect(buildToolsBlock({ packageTools: tools })).toContain('oshal:package-tool'); expect(fixture.fixture.results).toBe(0);
  expect((await (await fixture.call('/catalog', undefined, 'bob')).json()).tools).toEqual([]);
  await fixture.fixture.grant({ action: 'revoke' }); await fixture.fixture.grant({ role: 'tenant_reader', tenantId: TOOL_TENANT });
  tools = (await (await fixture.call('/catalog')).json()).tools; expect(tools).toHaveLength(1); expect(tools[0].tenantId).toBe(TOOL_TENANT);
});
it('binds an immutable input and refuses forged identity, confirmation and cross-origin execution', async () => {
  await fixture.fixture.grant({ role: 'tenant_reader', tenantId: TOOL_TENANT });
  const proposal = await fixture.propose({ tenantId: TOOL_TENANT });
  for (const body of [{ proposalId: proposal.id, confirmed: true }, { proposalId: proposal.id, actor: toolAlice }, { proposalId: proposal.id, input: {} }]) {
    expect((await fixture.call('/execute', body)).status).toBe(400);
  }
  expect((await fixture.call('/execute', { proposalId: proposal.id }, 'bob')).status).toBe(403);
  expect((await fixture.call('/execute', { proposalId: proposal.id }, 'collision')).status).toBe(403);
  expect((await fixture.call('/execute', { proposalId: proposal.id }, 'alice', { origin: 'https://foreign.test' })).status).toBe(403);
  expect(fixture.fixture.results).toBe(0);
  const response = await fixture.call('/execute', { proposalId: proposal.id }); expect(response.status).toBe(200);
  expect((await response.json()).result.input).toEqual({ tenantId: TOOL_TENANT });
});
it('consumes a proposal exactly once under concurrent requests and never retries a completed action', async () => {
  const proposal = await fixture.propose();
  const responses = await Promise.all([fixture.call('/execute', { proposalId: proposal.id }), fixture.call('/execute', { proposalId: proposal.id })]);
  expect(responses.map(row => row.status).sort()).toEqual([200, 409]); expect(fixture.fixture.results).toBe(1);
  expect((await fixture.call('/execute', { proposalId: proposal.id })).status).toBe(409);
  expect((await fixture.call('/result', { proposalId: proposal.id })).status).toBe(410); expect(fixture.fixture.results).toBe(1);
});
it.each(['revoke', 'off', 'mode', 'unmount', 'reload'])('refuses a proposal after %s and returns no old input through polling', async action => {
  const proposal = await fixture.propose();
  if (action === 'revoke') await fixture.fixture.grant({ action: 'revoke' });
  else if (action === 'off') fixture.state.enabled = false;
  else if (action === 'mode') fixture.state.mode = 'ask';
  else if (action === 'unmount') fixture.fixture.mounter.unmount('package-fixture');
  else await fixture.fixture.mount();
  expect((await fixture.call('/execute', { proposalId: proposal.id })).status).toBeGreaterThanOrEqual(400);
  expect(await fixture.service.readProposal(toolAlice, proposal.id)).toBeUndefined(); expect(fixture.fixture.results).toBe(0);
});
it('expires proposals and independently expires or revokes completed private results', async () => {
  const expired = await fixture.propose(); fixture.state.now += 120_001;
  expect((await fixture.call('/execute', { proposalId: expired.id })).status).toBe(410);
  const proposal = await fixture.propose(); expect((await fixture.call('/execute', { proposalId: proposal.id })).status).toBe(200);
  await fixture.fixture.grant({ action: 'revoke' });
  const replay = await fixture.call('/result', { proposalId: proposal.id }); expect(replay.status).toBe(410); expect(await replay.text()).not.toContain('count');
  await fixture.fixture.grant(); fixture.state.now += 30_001;
  expect((await fixture.call('/result', { proposalId: proposal.id })).status).toBe(410); expect(fixture.fixture.results).toBe(1);
});
it('refuses late source or policy changes while execution is pending before releasing a result', async () => {
  const proposal = await fixture.propose(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  fixture.fixture.wait = () => { entered(); return new Promise<void>(done => { release = done; }); };
  const pending = fixture.call('/execute', { proposalId: proposal.id }); await started;
  await fixture.fixture.grant({ action: 'revoke' }); release();
  const response = await pending; expect(response.status).toBeGreaterThanOrEqual(400); expect(await response.text()).not.toContain('count');
  expect((await fixture.call('/execute', { proposalId: proposal.id })).status).toBe(409);
});
it('accepts only one offered model proposal and replaces invented completion with a review instruction', async () => {
  fixture.state.mode = 'ask'; const offered = await fixture.service.discover(toolAlice);
  const directive = '```oshal:package-tool\n' + JSON.stringify({ toolName: 'package_read', input: {} }) + '\n```';
  const reply = await resolveJarvisPackageToolDirective('Already changed!\n' + directive, fixture.service, toolAlice, 'fixture-session', offered);
  expect(reply.answer).toContain('Review'); expect(reply.answer).not.toContain('Already'); expect(reply.proposal?.mode).toBe('ask'); expect(fixture.fixture.results).toBe(0);
  for (const answer of [directive + directive, directive.replace('"input":{}', '"input":{},"confirmed":true'), '```oshal:package-tool\n{bad}\n```']) {
    expect((await resolveJarvisPackageToolDirective(answer, fixture.service, toolAlice, 'fixture-session', offered)).proposal).toBeUndefined();
  }
  expect((await resolveJarvisPackageToolDirective(directive, fixture.service, toolAlice, 'fixture-session', [])).proposal).toBeUndefined();
});
it('requires explicit review when a package labels a write-effect tool AUTO', async () => {
  await fixture.close(); fixture = await createJarvisPackageToolsFixture('auto', packageFixture => {
    const catalog = packageFixture.catalog;
    catalog.permissions['records.read'].effect = 'write'; catalog.permissions['records.read'].minimumTier = 'editor';
    catalog.roles.reader.tier = 'editor'; catalog.roles.tenant_reader.tier = 'editor';
  });
  expect((await fixture.propose()).mode).toBe('ask'); expect(fixture.fixture.results).toBe(0);
});
