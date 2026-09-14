/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve the actual Career group through current member declarations and real profile synthesis without business dispatch or persistence writes.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SwarmAppService, readManifest, resolveGroupToolbar, resolveGroupSetup, assertGroupResolvable,
  type SwarmAppManifest, type SwarmApplicationRecord } from '@/features/swarm-apps';
import type { Pool } from 'pg';
import type { SwarmAppRepository } from '@/features/swarm-apps';
import type { AgentProfileRepository } from '@/entities/agent';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const store = resolve(process.env.OSHAL_PUBLIC_STORE_ROOT || resolve(process.cwd(), '../oshal-applications'));
const fixtureNames = ['intelligent-career', 'career-hunter', 'portrait-studio', 'social', 'print-ingest'];
// Standalone core checkouts can report this prerequisite as skipped; an explicitly selected bad checkout must fail.
const fixturesAvailable = Boolean(process.env.OSHAL_PUBLIC_STORE_ROOT)
  || fixtureNames.every(name => existsSync(resolve(store, name, 'oshal-app.yaml')));
const restored = ['career-recruiters', 'career-approvals', 'career-insights'];

/** Read real checked-out declarations only; installing or activating an app is outside this fixture. */
function fixture() {
  const group = readManifest(resolve(store, 'intelligent-career/oshal-app.yaml'));
  const members = new Map((group.dependencies?.apps ?? []).map(name => [name, readManifest(resolve(store, name, 'oshal-app.yaml'))]));
  const records = new Map<string, SwarmApplicationRecord>();
  for (const manifest of [group, ...members.values()]) records.set(manifest.name, record(manifest));
  const findByName = vi.fn(async (name: string) => records.get(name) ?? null);
  const query = vi.fn(() => { throw new Error('This navigation fixture must never query business storage'); });
  const service = new SwarmAppService({ query } as unknown as Pool, { findByName } as unknown as SwarmAppRepository,
    {} as AgentProfileRepository);
  return { group, members, records, service, query };
}

/** Supply only an in-memory installation record; no database or package handlers run. */
function record(manifest: SwarmAppManifest): SwarmApplicationRecord {
  return { appId: manifest.name, name: manifest.name, displayName: manifest.displayName,
    description: manifest.description ?? '', version: manifest.version ?? '0.0.0',
    manifestPath: resolve(store, manifest.name, 'oshal-app.yaml'), manifest, status: 'active', agentIds: [], toolNames: [],
    scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null,
    loadedAt: new Date(0), updatedAt: new Date(0) };
}

describe.skipIf(!fixturesAvailable)('actual Intelligent Career navigation (requires public-store member fixtures)', () => {
  it('synthesizes all six delegated Career pages with the member URLs and retained setup landing', async () => {
    const f = fixture(), before = JSON.stringify([...f.records]);
    assertGroupResolvable(f.group, f.members);
    const profile = await f.service.synthesiseProfile(f.group.name);
    const career = f.members.get('career-hunter')!;
    for (const name of ['career-board', 'career-strengthen', 'career-settings', ...restored]) {
      const item = profile!.ribbon.items.find(item => typeof item !== 'string' && item.id === `tool-${name}`);
      expect(item && typeof item !== 'string' && item.toolUi?.iframeUrl).toBe(career.ui!.static!.find(s => s.toolName === name)!.iframeUrl);
    }
    expect(profile!.defaultView).toBe('tool-intelligent-career-setup');
    expect(profile!.ribbon.items).toContainEqual(expect.objectContaining({ id: profile!.defaultView,
      toolUi: expect.objectContaining({ iframeUrl: '/api/swarm/apps/intelligent-career/setup-dashboard?group=intelligent-career' }) }));
    const plan = await f.service.getGroupSetupPlan(f.group.name);
    expect(plan).toMatchObject({ group: 'intelligent-career', firstSurface: 'career-board', members: f.group.dependencies!.apps });
    expect(plan!.steps).toHaveLength(7);
    expect(JSON.stringify([...f.records])).toBe(before); expect(f.query).not.toHaveBeenCalled();
  });

  it('follows a changed member URL and label at synthesis rather than retaining copied aliases', async () => {
    const f = fixture(), member = f.members.get('career-hunter')!;
    const surface = member.ui!.static!.find(s => s.toolName === 'career-recruiters')!;
    surface.iframeUrl = '/api/career-hunter/recruiters-ui?fixture=updated'; surface.label = 'Updated member label';
    const profile = await f.service.synthesiseProfile(f.group.name);
    expect(profile!.ribbon.items).toContainEqual(expect.objectContaining({ id: 'tool-career-recruiters', label: 'Updated member label',
      toolUi: expect.objectContaining({ iframeUrl: surface.iframeUrl }) }));
    expect(f.query).not.toHaveBeenCalled();
  });
});

describe.skipIf(!fixturesAvailable)('actual Career degraded-member navigation (requires public-store member fixtures)', () => {
  it('refuses activation when a newly referenced surface disappears and omits only that stale tile on synthesis', async () => {
    const f = fixture(), member = f.members.get('career-hunter')!;
    member.ui!.static = member.ui!.static!.filter(s => s.toolName !== 'career-recruiters');
    expect(() => assertGroupResolvable(f.group, f.members)).toThrow(/career-recruiters/);
    expect(resolveGroupToolbar(f.group, f.members).missing).toEqual([expect.objectContaining({ app: 'career-hunter', surface: 'career-recruiters' })]);
    const profile = await f.service.synthesiseProfile(f.group.name);
    expect(profile!.ribbon.items).not.toContainEqual(expect.objectContaining({ id: 'tool-career-recruiters' }));
    expect(profile!.ribbon.items).toContainEqual(expect.objectContaining({ id: 'tool-career-approvals' }));
  });

  it('retains all seven setup steps and makes an inactive member unavailable without inventing a substitute', async () => {
    const f = fixture(); expect(resolveGroupSetup(f.group, f.members)).toHaveLength(7);
    f.records.get('career-hunter')!.status = 'inactive'; f.members.delete('career-hunter');
    expect(() => assertGroupResolvable(f.group, f.members)).toThrow(/not installed and active/);
    const profile = await f.service.synthesiseProfile(f.group.name);
    for (const name of restored) expect(profile!.ribbon.items).not.toContainEqual(expect.objectContaining({ id: `tool-${name}` }));
    expect(resolveGroupSetup(f.group, f.members).filter(step => step.app === 'career-hunter').every(step => !!step.unavailable)).toBe(true);
    expect(profile!.ribbon.items).toContainEqual(expect.objectContaining({ id: 'tool-portrait-studio' }));
    expect(f.query).not.toHaveBeenCalled();
  });
});

describe.skipIf(!fixturesAvailable)('actual Career group setup availability (requires public-store member fixtures)', () => {
  it('returns no setup plan for an inactive group, independently of its active members', async () => {
    const f = fixture(); f.records.get(f.group.name)!.status = 'inactive';
    expect(await f.service.getGroupSetupPlan(f.group.name)).toBeNull();
    expect(await f.service.getGroupSetupPlan('career-hunter')).toBeNull();
    expect(await f.service.getGroupSetupPlan('missing-group')).toBeNull();
    expect(f.query).not.toHaveBeenCalled();
  });
});
