/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the cockpit's UI profiles reach the api pod. Found live on the first Docker Desktop install: the config-seed Secret mounted over /app/config-seed hid the image's profiles directory, UIProfileService logged "No profile directory found" and served its built-in fallback ribbon (no Jarvis, no workspace navigation). Every fact here is read from its source — the lookup candidates from ui-profile-service.ts resolved against Dockerfile.oshal's WORKDIR, the shipped seed from Dockerfile.oshal's config-seed.dist COPY, the default profile name from the service — so renaming any of them turns this red instead of leaving a render that looks right.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmTemplate } from '../helpers/helm-template';

const SERVICE_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'features', 'ui-profile', 'services', 'ui-profile-service.ts'), 'utf8');
const DOCKERFILE = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.oshal'), 'utf8');

/** The image's working directory: the last WORKDIR before the runtime starts (the api runs from it). */
function imageWorkdir(): string {
  const dirs = [...DOCKERFILE.matchAll(/^WORKDIR\s+(\S+)/gm)].map(m => m[1]);
  expect(dirs.length, 'Dockerfile.oshal declares a WORKDIR').toBeGreaterThan(0);
  return dirs[dirs.length - 1];
}

/** UIProfileService's directory candidates, in lookup order, as absolute paths inside the image. */
function profileCandidates(): string[] {
  const rel = [...SERVICE_SRC.matchAll(/path\.resolve\(process\.cwd\(\),\s*'([^']+)'\)/g)].map(m => m[1]);
  expect(rel.length, 'ui-profile-service.ts lists its profile directory candidates').toBeGreaterThan(0);
  return rel.map(r => path.posix.resolve(imageWorkdir(), r));
}

/** Where the image ships the tracked profiles (Dockerfile: COPY config-seed/ ./config-seed.dist/). */
function shippedProfilesDir(): string {
  const m = DOCKERFILE.match(/^COPY\s+config-seed\/\s+(\S+?)\/?\s*$/m);
  expect(m, 'Dockerfile.oshal copies config-seed/ into the image').toBeTruthy();
  return path.posix.join(path.posix.resolve(imageWorkdir(), m![1]), 'profiles');
}

function defaultProfileName(): string {
  const m = SERVICE_SRC.match(/DEFAULT_PROFILE_NAME\s*=\s*'([^']+)'/);
  expect(m, 'ui-profile-service.ts names its default profile').toBeTruthy();
  return m![1];
}

function apiPod(opts: { sets?: string[]; valuesFiles?: string[] }) {
  const objects = helmTemplate(opts);
  const api = containerOf(objects, 'Deployment', 'oshal-api', 'api');
  const deployment = objects.find(o => o.kind === 'Deployment' && o.metadata?.name === 'oshal-api')!;
  const volumes: Array<Record<string, any>> = deployment.spec.template.spec.volumes || [];
  const mounts: Array<Record<string, any>> = api.volumeMounts || [];
  const script = String((api.args || []).join('\n'));
  return { api, volumes, mounts, script };
}

/** The directory UIProfileService will actually use, given what is mounted: the first candidate that exists. */
function effectiveProfileDir(mounts: Array<Record<string, any>>): { dir: string; mount: Record<string, any> } | null {
  for (const candidate of profileCandidates()) {
    const mount = mounts.find(m => m.mountPath === candidate);
    if (mount) return { dir: candidate, mount };
  }
  return null;
}

const POSTURES: Array<[string, { sets?: string[]; valuesFiles?: string[] }]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
  ['no config-seed Secret', { sets: ['api.configSeedSecret='] }],
];

describe('the cockpit UI profiles reach the api pod', () => {
  it('the repo ships the default profile the service asks for', () => {
    const file = path.join(REPO_ROOT, 'config-seed', 'profiles', `${defaultProfileName()}.json`);
    expect(fs.existsSync(file), `${file} exists`).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).name).toBe(defaultProfileName());
  });

  for (const [label, opts] of POSTURES) {
    it(`${label}: a profile directory candidate is mounted and seeded from the image`, () => {
      const { volumes, mounts, script } = apiPod(opts);
      const effective = effectiveProfileDir(mounts);
      expect(effective, `one of ${profileCandidates().join(', ')} is mounted on the api container`).not.toBeNull();
      const volume = volumes.find(v => v.name === effective!.mount.name)!;
      expect(volume.emptyDir, 'with no operator ConfigMap the profile directory is a writable emptyDir').toBeDefined();
      expect(effective!.mount.readOnly).not.toBe(true);
      const seed = new RegExp(`cp -n ${shippedProfilesDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\*\\.json ${effective!.dir}/`);
      expect(script, 'the api start script seeds the shipped profiles without overwriting').toMatch(seed);
    }, RENDER_TIMEOUT_MS);
  }

  it('the config-seed Secret mount never shadows the profile directory', () => {
    const { mounts } = apiPod({});
    const effective = effectiveProfileDir(mounts)!;
    const shadowing = mounts.filter(m => m !== effective.mount && effective.dir.startsWith(`${m.mountPath}/`)
      && m.mountPath !== path.posix.dirname(effective.dir));
    expect(shadowing, 'no other mount sits between the profile directory and a parent the service reads').toEqual([]);
    const secretMount = mounts.find(m => m.name === 'config-seed');
    if (secretMount) {
      expect(profileCandidates().includes(path.posix.join(secretMount.mountPath, 'profiles'))
        && effective.dir !== path.posix.join(secretMount.mountPath, 'profiles')
        && profileCandidates().indexOf(effective.dir) > profileCandidates().indexOf(path.posix.join(secretMount.mountPath, 'profiles')),
      'the flat Secret occupies an earlier candidate that holds no profiles, so the mounted later candidate is the one used')
        .toBe(true);
    }
  }, RENDER_TIMEOUT_MS);

  it('api.uiProfilesConfigMap replaces the seed with the operator\'s profiles, read-only', () => {
    const { volumes, mounts } = apiPod({ sets: ['api.uiProfilesConfigMap=operator-profiles'] });
    const effective = effectiveProfileDir(mounts)!;
    expect(effective).not.toBeNull();
    const volume = volumes.find(v => v.name === effective.mount.name)!;
    expect(volume.configMap?.name).toBe('operator-profiles');
    expect(volume.emptyDir).toBeUndefined();
    expect(effective.mount.readOnly).toBe(true);
  }, RENDER_TIMEOUT_MS);
});
