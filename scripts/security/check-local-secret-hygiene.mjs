#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Refuse ignored plaintext credential backups before local CI can judge an otherwise clean source export.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_BACKUP_NAMES = [
  /^\.env\.(?:bak|backup|old|copy)(?:[-._].*)?$/i,
  /^(?:credentials|secrets)\.(?:env|json)\.(?:bak|backup|old|copy)(?:[-._].*)?$/i,
];

/** @description Return root-level ignored backup names that can silently retain live credentials. */
export function findLocalSecretBackups(root) {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Local secret-hygiene root is not a directory: ${resolvedRoot}`);
  }
  return readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SECRET_BACKUP_NAMES.some((pattern) => pattern.test(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

/** @description Fail before source-only secret scanning masks an ignored credential duplicate. */
export function assertLocalSecretHygiene(root) {
  const backups = findLocalSecretBackups(root);
  if (backups.length) {
    throw new Error(
      `Plaintext credential backup(s) are forbidden: ${backups.join(', ')}. `
      + 'Remove them recoverably, rotate exposed credentials when necessary, and use export-env-schema.mjs.',
    );
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    assertLocalSecretHygiene(process.argv[2] ?? process.cwd());
    console.log('Local secret-hygiene check passed: no plaintext credential backups');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
