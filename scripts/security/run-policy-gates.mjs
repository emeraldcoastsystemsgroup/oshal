#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Discover and run the SEC-06 route-auth, machine-write, migration, RLS, and workflow-contract families; zero discovery fails closed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Include the mutation-tested active-only backlog contract in policy discovery.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXACT_POLICY_SPECS = [
  'tests/unit/server-route-auth-inventory.spec.ts',
  'tests/unit/manifest-route-auth.spec.ts',
  'tests/unit/machine-write-identity.spec.ts',
  'tests/unit/security-ci-contract.spec.ts',
  'tests/unit/backlog-active-only.spec.ts',
];

/** @description Recursively enumerate files below a directory in stable order. */
function filesBelow(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const candidate = join(root, name);
    if (statSync(candidate).isDirectory()) out.push(...filesBelow(candidate));
    else out.push(candidate);
  }
  return out.sort();
}

/** @description Discover all migration/RLS guards by name so new guards join CI automatically. */
export function discoverPolicySpecs(root = process.cwd()) {
  const named = filesBelow(join(root, 'tests', 'unit'))
    .filter((file) => /(?:migration|rls).*\.spec\.ts$/i.test(file))
    .map((file) => file.replaceAll('\\', '/').replace(`${root.replaceAll('\\', '/')}/`, ''));
  return [...new Set([...EXACT_POLICY_SPECS, ...named])].sort();
}

/** @description Refuse deleted, empty, or declaration-free test files before invoking Vitest. */
function assertRunnable(root, files) {
  if (files.length < EXACT_POLICY_SPECS.length + 4) {
    throw new Error(`SEC-06 discovered only ${files.length} policy specs; expected inventory plus migration/RLS families`);
  }
  for (const file of files) {
    const full = join(root, file);
    if (!existsSync(full)) throw new Error(`Required security policy spec is missing: ${file}`);
    const source = readFileSync(full, 'utf8');
    if (!/\b(?:it|test)\s*\(/.test(source)) throw new Error(`Security policy spec declares no tests: ${file}`);
  }
}

/** @description Execute exactly the discovered files using the repository's locked Vitest CLI. */
export function main(root = process.cwd()) {
  const files = discoverPolicySpecs(root);
  assertRunnable(root, files);
  const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Vitest CLI is missing; run npm ci before the SEC-06 policy gate');
  console.log(`Running ${files.length} discovered SEC-06 policy spec(s)`);
  const result = spawnSync(process.execPath, [vitest, 'run', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SEC-06 policy specs failed with exit ${result.status}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
