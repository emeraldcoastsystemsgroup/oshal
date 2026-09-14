/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Create disposable package files for actual catalog and lifecycle verification.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { SwarmAppManifest } from '@/features/swarm-apps';
import type { PackageTestCase } from '@/shared/package-testing';

/** @description Build an inert fixture suite declaration. @param overrides Focused case variations. @returns Catalog case metadata. */
export function packageTestCase(overrides: Partial<PackageTestCase> = {}): PackageTestCase {
  return { id: 'behavior', name: 'Behavior assertions', purpose: 'Verify real behavior using disposable fixtures.', level: 'unit',
    runner: { kind: 'vitest', scope: 'package', files: ['tests/behavior.spec.ts'] }, expected: ['Valid inputs succeed.', 'Invalid inputs are rejected.'],
    prerequisites: ['runner:vitest'], sideEffects: 'fixture-write', isolation: { mode: 'disposable', fixtures: ['tests/input.json'], cleanup: 'The suite deletes its temporary directory in teardown.' },
    limits: { timeoutMs: 30000, maxMemoryMb: 256 }, installation: 'never', ...overrides };
}
/** @description Declare a temporary package with catalog and smoke. @param name Fixture namespace. @returns Loadable manifest. */
export function packageManifest(name = 'catalog-fixture'): SwarmAppManifest {
  return { name, displayName: name, version: '1.0.0', status: 'active', suite: 'ai-home', uses: ['test-catalog'],
    testing: { version: 1, catalog: 'tests/test-lab.yaml' },
    routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: `/api/${name}`, auth: 'service-or-oidc' }],
    smoke: [{ name: 'ready', method: 'GET', path: `/api/${name}/ready`, auth: 'public', expect: { status: 200, jsonPointer: '/ready', rejectValues: [false] } }],
  };
}
/** @description Write real files while keeping the declared suite deliberately non-executable.
 * @param root Disposable parent directory. @param manifest Owning fixture manifest. @param cases Catalog cases. @returns Package paths and manifest. */
export function writeTestPackage(root: string, manifest = packageManifest(), cases: unknown[] = [packageTestCase()]) {
  const dir = join(root, manifest.name); mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'routes.js'), 'exports.createRoutes = () => (_req, _res, next) => next();');
  writeFileSync(join(dir, 'tests/behavior.spec.ts'), 'throw new Error("Catalog registration must never execute a suite");');
  writeFileSync(join(dir, 'tests/input.json'), '{"fixture":true}');
  writeFileSync(join(dir, 'tests/test-lab.yaml'), yaml.dump({ version: 1, cases }));
  const file = join(dir, 'oshal-app.yaml'); writeFileSync(file, yaml.dump(manifest)); return { dir, file, manifest };
}
