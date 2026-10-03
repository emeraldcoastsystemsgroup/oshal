/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Experience declarations refuse unsafe entries, unsupported shapes and undeclared members; actual loader never admits an unimplemented hosting floor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { validateExperienceDeclaration } from '@/shared/experience-contract';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';

const base = () => ({
  name: 'synthetic-experience', displayName: 'Synthetic experience',
  uses: ['application-authorization', 'experience', 'app-dependencies'],
  authorization: { version: 1, catalog: 'authorization.yaml' },
  routes: [{ mountPath: '/api/synthetic-experience', auth: 'oidc' }],
  dependencies: { required: { apps: ['synthetic-calendar'] }, optional: { apps: ['synthetic-finance'] } },
  experience: { version: 1, entry: '/api/synthetic-experience/app.html', shell: 'page', skin: 'family', label: 'Home',
    surfaces: [{ app: 'synthetic-calendar', surface: 'calendar-home', audience: 'family' }] },
});
const dirs: string[] = [];
afterEach(() => {
  const root = resolve(tmpdir()) + sep;
  for (const dir of dirs.splice(0)) {
    const target = resolve(dir);
    if (!target.startsWith(root) || !target.slice(root.length).startsWith('oshal-experience-contract-')) {
      throw new Error('Refusing fixture cleanup outside the owned temporary directory');
    }
    rmSync(target, { recursive: true, force: true });
  }
});

describe('experience package declaration', () => {
  it('leaves existing ordinary applications alone', () => {
    expect(() => validateExperienceDeclaration({ name: 'finance' })).not.toThrow();
  });
  it.each(['page', 'rail'])('validates an owned %s document and optional member without writing grants', shell => {
    const m = base(); m.experience.shell = shell;
    m.experience.surfaces.push({ app: 'synthetic-finance', surface: 'finance-home', audience: 'family' });
    const before = JSON.stringify(m);
    expect(() => validateExperienceDeclaration(m)).not.toThrow();
    expect(JSON.stringify(m)).toBe(before);
  });
  it.each([null, [], 'family', {}, { ...base().experience, version: 2 },
    { ...base().experience, shell: 'kiosk' }, { ...base().experience, typo: true },
    { ...base().experience, label: '' }, { ...base().experience, label: 'Home\n' },
    { ...base().experience, skin: '../../family.css' }])('refuses malformed declaration %j', experience => {
    expect(() => validateExperienceDeclaration({ ...base(), experience })).toThrow();
  });
  it.each(['https://example.invalid/app', '//example.invalid/app', '/\\example.invalid/app',
    '/api/synthetic-experience/../other/app', '/api/synthetic-experience/%2e%2e/app',
    '/api/synthetic-experience/app?audience=family', '/api/synthetic-experience/app#entry',
    '/api/synthetic-experience//app', '/api/synthetic-experience/app\t', '/api/synthetic-experience-other/app',
    '/api/finance/app'])('refuses unsafe or foreign entry %s', entry => {
    expect(() => validateExperienceDeclaration({ ...base(), experience: { ...base().experience, entry } })).toThrow();
  });
  it.each(['public', 'service', undefined])('refuses entry with route authentication %s', auth => {
    expect(() => validateExperienceDeclaration({ ...base(), routes: [{ mountPath: '/api/synthetic-experience', auth }] })).toThrow(/session-authenticated/);
  });
  it('refuses an anonymous or earlier public mount on the same entry', () => {
    const m = base();
    expect(() => validateExperienceDeclaration({ ...m, routes: [{ ...m.routes[0], allowAnonymous: true }] })).toThrow();
    expect(() => validateExperienceDeclaration({ ...m, routes: [{ mountPath: '/api', auth: 'public' }, ...m.routes] })).toThrow();
  });
  it.each([undefined, { version: 2, catalog: 'authorization.yaml' },
    { version: 1, catalog: '../authorization.yaml' }])('requires package authorization %j', authorization => {
    expect(() => validateExperienceDeclaration({ ...base(), authorization })).toThrow(/authorization catalog/);
  });
  it('refuses an absent compatibility floor and a code-free group', () => {
    expect(() => validateExperienceDeclaration({ ...base(), uses: ['application-authorization'] })).toThrow(/requires uses/);
    expect(() => validateExperienceDeclaration({ ...base(), kind: 'group' })).toThrow(/ordinary application/);
  });
  it.each([{ app: 'undeclared', surface: 'home' }, { app: 'synthetic-calendar', surface: '../home' },
    { app: 'synthetic-calendar', surface: 'home', audience: 'admin' },
    { app: 'synthetic-calendar', surface: 'home', arbitraryOverride: 'css' }])('refuses unsupported member reference %j', ref => {
    expect(() => validateExperienceDeclaration({ ...base(), experience: { ...base().experience, surfaces: [ref] } })).toThrow();
  });
  it('refuses duplicate surfaces and conflicting dependency forms', () => {
    const m = base(); m.experience.surfaces.push(m.experience.surfaces[0]);
    expect(() => validateExperienceDeclaration(m)).toThrow(/repeat/);
    expect(() => validateExperienceDeclaration({ ...base(), dependencies: { apps: ['synthetic-calendar'], optional: { apps: [] } } })).toThrow(/mixes/);
  });
  it('the real loader refuses an experience without its floor instead of silently installing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-experience-contract-')); dirs.push(dir);
    const m = base(); m.uses = ['application-authorization', 'app-dependencies'];
    const file = join(dir, 'oshal-app.yaml'); writeFileSync(file, dump(m));
    expect(() => readManifest(file)).toThrow(/experience requires uses/);
  });
  it('the real loader refuses the still-unimplemented hosting floor even for a structurally valid package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-experience-contract-')); dirs.push(dir);
    const file = join(dir, 'oshal-app.yaml'); writeFileSync(file, dump(base()));
    expect(() => readManifest(file)).toThrow(/unknown kernel skill.*experience/);
  });
});
