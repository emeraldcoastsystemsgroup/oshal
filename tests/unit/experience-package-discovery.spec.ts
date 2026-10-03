/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise authorized experience discovery and entry redirects, including fail-closed outages and concurrent package changes.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExperiencePackageRoutes, type ExperiencePackagePorts } from '@/app/routes/experience-package-routes';
import type { SwarmApplicationRecord } from '@/features/swarm-apps';
import type { ExperienceDeclaration } from '@/shared/experience-contract';

const actor = { sub: 'synthetic-user', issuer: 'https://fixture.invalid', isActive: true, isSwarmAdmin: false };
const declaration: ExperienceDeclaration = { version: 1, entry: '/api/synthetic-experience/app.html', shell: 'page', skin: 'family', label: 'Home' };
let record: SwarmApplicationRecord;
let ports: ExperiencePackagePorts;
const server = express().listen(0, '127.0.0.1');
const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
function mount() {
  const app = express();
  app.use('/api/ui', (req, res, next) => { if (!req.headers.cookie) { res.sendStatus(401); return; } next(); }, createExperiencePackageRoutes(ports));
  server.removeAllListeners('request'); server.on('request', app);
}
const get = (path: string, session = true) => fetch(`${origin()}/api/ui/experiences${path}`, { headers: session ? { cookie: 'session=synthetic' } : {}, redirect: 'manual' });
beforeEach(() => {
  record = { appId: 'synthetic-id', name: 'synthetic-experience', displayName: 'Synthetic Home', description: 'Synthetic package', status: 'active', manifestPath: '/fixture/oshal-app.yaml', version: '1.0.0', scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null, agentIds: [], toolNames: [], loadedAt: new Date(), updatedAt: new Date(), manifest: { name: 'synthetic-experience', displayName: 'Synthetic Home', experience: structuredClone(declaration) } };
  ports = {
    apps: { listExperiences: vi.fn().mockResolvedValue([{ app: 'synthetic-experience', label: 'Home' }, { app: 'denied', label: 'Hidden' }]), getAppForViewer: vi.fn(async () => record) },
    authorization: { resolveActor: vi.fn(async () => ({ ...actor })), runtime: { canDiscover: vi.fn(async name => name !== 'denied'), canNavigateHttpPath: vi.fn(async () => true) } },
  };
  mount();
});
afterAll(() => server.close());
describe('installed experience discovery and navigation', () => {
  it('requires a session and lists only currently authorized candidates without caching', async () => {
    expect((await get('', false)).status).toBe(401);
    const response = await get('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ experiences: [{ app: 'synthetic-experience', label: 'Home' }] });
    expect(ports.apps!.listExperiences).toHaveBeenCalledWith({ ownerSub: actor.sub, isOperator: false });
  });
  it('checks the named entry operation before redirecting a page or focused rail', async () => {
    const response = await get('/synthetic-experience/open');
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe(declaration.entry);
    expect(ports.authorization!.runtime.canNavigateHttpPath).toHaveBeenCalledWith(actor, declaration.entry);
    record.manifest.experience!.shell = 'rail';
    expect((await get('/synthetic-experience/open')).headers.get('location')).toBe('/cockpit/?app=synthetic-experience');
  });
  it('refuses inactive identities, denied discovery, denied entry and inactive packages', async () => {
    vi.mocked(ports.authorization!.resolveActor).mockResolvedValueOnce({ ...actor, isActive: false });
    expect((await get('')).status).toBe(403);
    vi.mocked(ports.authorization!.runtime.canDiscover).mockResolvedValueOnce(false);
    expect((await get('/synthetic-experience/open')).status).toBe(404);
    vi.mocked(ports.authorization!.runtime.canNavigateHttpPath!).mockResolvedValueOnce(false);
    expect((await get('/synthetic-experience/open')).status).toBe(403);
    record.status = 'inactive'; expect((await get('/synthetic-experience/open')).status).toBe(404);
  });
  it('refuses an uninstall or changed entry during the policy check', async () => {
    vi.mocked(ports.apps!.getAppForViewer).mockResolvedValueOnce(record).mockResolvedValueOnce(null);
    expect((await get('/synthetic-experience/open')).status).toBe(409);
    vi.mocked(ports.apps!.getAppForViewer).mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, manifest: { ...record.manifest, experience: { ...declaration, entry: '/api/synthetic-experience/new.html' } } });
    expect((await get('/synthetic-experience/open')).status).toBe(409);
    vi.mocked(ports.apps!.getAppForViewer).mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, appId: 'replacement-installation' });
    expect((await get('/synthetic-experience/open')).status).toBe(409);
  });
  it('fails closed for missing ports and policy failures instead of advertising a static fallback', async () => {
    ports = {}; mount(); expect((await get('')).status).toBe(503); expect((await get('/synthetic-experience/open')).status).toBe(503);
    ports.authorization = { resolveActor: async () => { throw new Error('fixture policy outage'); }, runtime: { canDiscover: async () => true } };
    ports.apps = { listExperiences: async () => [], getAppForViewer: async () => null };
    mount(); expect((await get('')).status).toBe(503);
  });
});
