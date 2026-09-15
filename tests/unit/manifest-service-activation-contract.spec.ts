/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-157 S1: prove the manifest activation contract at the real loader boundary — `runsAs` is a closed vocabulary, `requires` is checked against the permissions the app's OWN imported catalog defines (an undefined name refuses the whole manifest), and a package that declares neither still loads exactly as before.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readManifest } from '@/features/swarm-apps';

const nodeRequire = createRequire(import.meta.url);
const { validateScheduleDeclarations: validatePackageSchedules } = nodeRequire(
  '../../scripts/oshal-app-schedules.js',
) as { validateScheduleDeclarations: (manifest: Record<string, unknown>) => string[] };

const packageDirs: string[] = [];

const CATALOG_YAML = [
  'version: 1',
  'resources:',
  '  scorecard:',
  '    scopes: [own]',
  'permissions:',
  '  metrics.write:',
  '    resource: scorecard',
  '    effect: write',
  '    minimumTier: editor',
  'roles:',
  '  contributor:',
  '    tier: editor',
  '    grants:',
  '      - permission: metrics.write',
  '        scope: own',
  'bindings:',
  '  jobs:',
  '    - id: metrics-app-daily-ingest',
  '      allOf: [metrics.write]',
  '',
].join('\n');

/**
 * @description Write one real package on disk and read it back through the actual manifest loader.
 * @param scheduleLines - The `schedules:` block body, already indented.
 * @param withCatalog - Whether the package imports an authorization catalog (ADR-149 §4).
 * @returns The absolute manifest path the loader is pointed at.
 */
function writePackage(scheduleLines: string[], withCatalog = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-service-activation-'));
  packageDirs.push(dir);
  if (withCatalog) writeFileSync(join(dir, 'authorization.yaml'), CATALOG_YAML, 'utf8');
  const manifestPath = join(dir, 'oshal-app.yaml');
  writeFileSync(manifestPath, [
    'name: metrics-app',
    'displayName: Metrics App',
    'suite: ai-productivity',
    ...(withCatalog
      ? ['uses:', '  - application-authorization', 'authorization:', '  version: 1', '  catalog: authorization.yaml']
      : []),
    'routes:',
    '  - module: route.js',
    '    factory: createRoutes',
    '    mountPath: /api/metrics-app',
    '    auth: service',
    'schedules:',
    ...scheduleLines,
    '',
  ].join('\n'), 'utf8');
  return manifestPath;
}

const baseSchedule = [
  '  - id: daily-ingest',
  '    cron: "15 6 * * *"',
  '    target: service-route',
  '    route: /api/metrics-app/ingest',
  '    handler: runDailyIngest',
];

afterAll(() => {
  for (const dir of packageDirs) rmSync(dir, { recursive: true, force: true });
});

describe('ADR-157 manifest activation contract', () => {
  it('accepts a classified service whose requires the catalog defines', () => {
    const manifest = readManifest(writePackage([...baseSchedule, '    runsAs: system', '    requires: [metrics.write]']));
    expect(manifest.schedules?.[0]).toMatchObject({ runsAs: 'system', requires: ['metrics.write'] });
  });

  it('accepts a user service and leaves an undeclared schedule unclassified', () => {
    const user = readManifest(writePackage([...baseSchedule, '    runsAs: user', '    requires: [metrics.write]']));
    expect(user.schedules?.[0]).toMatchObject({ runsAs: 'user' });
    const legacy = readManifest(writePackage(baseSchedule, false));
    expect(legacy.schedules?.[0]).toMatchObject({ target: 'service-route' });
    expect((legacy.schedules?.[0] as { runsAs?: string }).runsAs).toBeUndefined();
  });

  it('refuses a required permission the app catalog does not define', () => {
    expect(() => readManifest(writePackage([...baseSchedule, '    runsAs: system', '    requires: [scorecard.destroy]'])))
      .toThrow(/does not define: scorecard.destroy/);
  });

  it('refuses requires when the app imports no catalog at all', () => {
    expect(() => readManifest(writePackage([...baseSchedule, '    requires: [metrics.write]'], false)))
      .toThrow(/imports no authorization catalog/);
  });

  it.each([
    ['an unknown principal class', ['    runsAs: root', '    requires: [metrics.write]'], /runsAs must be system or user/],
    ['an empty requires list', ['    runsAs: system', '    requires: []'], /requires, when present, must be a non-empty array/],
    ['a duplicated permission', ['    runsAs: system', '    requires: [metrics.write, metrics.write]'], /names "metrics.write" twice/],
    ['a non-string permission', ['    runsAs: system', '    requires: [7]'], /entries must be non-empty permission names/],
  ])('refuses %s', (_name, lines, expected) => {
    expect(() => readManifest(writePackage([...baseSchedule, ...lines]))).toThrow(expected);
  });

  it('mirrors the shape rules in the pre-install package validator', () => {
    const manifest = {
      routes: [{ module: 'route.js', factory: 'createRoutes', mountPath: '/api/metrics-app', auth: 'service' }],
      schedules: [{
        id: 'daily-ingest', cron: '15 6 * * *', target: 'service-route',
        route: '/api/metrics-app/ingest', handler: 'runDailyIngest', runsAs: 'system', requires: ['metrics.write'],
      }],
    };
    expect(validatePackageSchedules(manifest)).toEqual([]);
    expect(validatePackageSchedules({ ...manifest, schedules: [{ ...manifest.schedules[0], runsAs: 'root' }] }))
      .toEqual(expect.arrayContaining([expect.stringContaining('runsAs must be system or user')]));
    expect(validatePackageSchedules({ ...manifest, schedules: [{ ...manifest.schedules[0], requires: [] }] }))
      .toEqual(expect.arrayContaining([expect.stringContaining('requires must be a non-empty array')]));
  });
});
