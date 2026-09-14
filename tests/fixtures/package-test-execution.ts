/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Write real disposable Node packages for isolated Test Lab execution and content-change assertions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { SwarmApplicationRecord } from '@/features/swarm-apps';
import { PackageTestSandbox, type PackageTestSandboxInput, type PackageTestSandboxResult } from '@/features/swarm-apps/services/package-test-sandbox';
import { packageManifest, packageTestCase } from './package-testing';

/** @description Select a local core image; the real sandbox resolves its immutable ID without pulling. */
export const PACKAGE_TEST_IMAGE = process.env.OSHAL_TEST_RUNNER_IMAGE || 'oshal-bot:latest';

/** @description Source-only variants for real isolated package execution fixtures. */
export interface PackageExecutionFixtureOptions {
  name?: string;
  broken?: boolean;
  delayMs?: number;
  prerequisites?: string[];
}

/** @description Observe catalog handoff while every execution still uses the real disposable Docker sandbox. */
export class ObservedPackageTestSandbox extends PackageTestSandbox {
  calls = 0;
  last?: PackageTestSandboxResult;
  private requestedResolve!: () => void;
  readonly requested = new Promise<void>(resolve => { this.requestedResolve = resolve; });

  /** @description Record the real handoff and outcome without replacing sandbox execution or cleanup.
   * @param input Controller-owned immutable execution input.
   * @returns Actual sandbox result. */
  override async run(input: PackageTestSandboxInput): Promise<PackageTestSandboxResult> {
    this.calls++; this.requestedResolve(); this.last = await super.run(input); return this.last;
  }
}

/** @description Produce actual Node assertions against a separately imported package implementation.
 * @param delayMs Optional asynchronous work for lifecycle and cancellation tests.
 * @returns A native node:test source file with two business assertions. */
function suiteSource(delayMs: number): string {
  return `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineTotal } = require('../lib/calculator.cjs');
test('whole-item totals preserve integer minor currency units', async () => {
  await new Promise(resolve => setTimeout(resolve, ${delayMs}));
  assert.equal(lineTotal(3, 125), 375);
});
test('negative quantities cannot create a negative invoice', () => {
  assert.throws(() => lineTotal(-1, 125), RangeError);
});
`;
}

/** @description Write a complete package and active record without registering or executing it.
 * @param root Generated temporary parent directory owned by the calling test.
 * @param options Focused fixture variants; no deployment data or inherited credentials.
 * @returns Source paths and the actual record accepted by InstalledAppTestCatalog. */
export function createPackageExecutionFixture(root: string, options: PackageExecutionFixtureOptions = {}) {
  const manifest = packageManifest(options.name ?? 'execution-fixture');
  const dir = join(root, manifest.name), file = join(dir, 'oshal-app.yaml');
  mkdirSync(join(dir, 'tests'), { recursive: true }); mkdirSync(join(dir, 'lib'));
  const test = packageTestCase({ id: 'invoice-totals', runner: { kind: 'node-test', scope: 'package', files: ['tests/invoice.test.cjs'] },
    expected: ['Integer currency totals are exact.', 'Negative quantity is refused.'], sideEffects: 'none',
    prerequisites: options.prerequisites ?? ['runner:node-test'], isolation: { mode: 'disposable', cleanup: 'Runner removes its disposable container and staged files.' },
    limits: { timeoutMs: 30000, maxMemoryMb: 256 } });
  writeFileSync(file, yaml.dump(manifest));
  writeFileSync(join(dir, 'routes.js'), 'exports.createRoutes = () => (_req, _res, next) => next();\n');
  writeFileSync(join(dir, 'tests/test-lab.yaml'), yaml.dump({ version: 1, cases: [test] }));
  const helperPath = join(dir, 'lib/calculator.cjs'), suitePath = join(dir, 'tests/invoice.test.cjs');
  writeFileSync(helperPath, `exports.lineTotal = (quantity, price) => {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(price) || price < 0) throw new RangeError('Invalid invoice input');
  return quantity * price${options.broken ? ' + 1' : ''};
};\n`);
  writeFileSync(suitePath, suiteSource(options.delayMs ?? 0));
  const record: SwarmApplicationRecord = { appId: manifest.name, name: manifest.name, displayName: manifest.displayName,
    description: 'Isolated invoice calculation fixture', version: '1.0.0', status: 'active', manifestPath: file, manifest,
    agentIds: [], toolNames: [], scope: 'person', ownerSub: 'fixture-owner', tenantId: null, guestTierApproved: null,
    loadedAt: new Date(), updatedAt: new Date() };
  return { dir, file, manifest, record, test, helperPath, suitePath, caseId: `app:${manifest.name}:test:${test.id}` };
}
