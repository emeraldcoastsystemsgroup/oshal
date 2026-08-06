#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Export only environment key names so operators never need a plaintext .env backup.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @description Convert dotenv text to a stable key-only inventory without reproducing values or comments. */
export function redactedEnvSchema(source) {
  const keys = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.add(match[1]);
  }
  if (keys.size === 0) throw new Error('Environment input contains no valid key assignments');
  return [
    '# Redacted environment key inventory. Values and source comments are intentionally omitted.',
    '# Re-enter current values through the approved secret/configuration workflow; do not restore from plaintext copies.',
    ...[...keys].sort().map((key) => `${key}=`),
    '',
  ].join('\n');
}

/** @description Read one dotenv file and either print or exclusively create a redacted schema file. */
export function exportEnvSchema(inputPath, outputPath) {
  const input = resolve(inputPath);
  const redacted = redactedEnvSchema(readFileSync(input, 'utf8'));
  if (outputPath) {
    const output = resolve(outputPath);
    if (output === input) throw new Error('Refusing to overwrite the source environment file');
    writeFileSync(output, redacted, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return output;
  }
  process.stdout.write(redacted);
  return null;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [input = '.env', output] = process.argv.slice(2);
    if (process.argv.length > 4) throw new Error('Usage: export-env-schema.mjs [input.env] [new-output-file]');
    const created = exportEnvSchema(input, output);
    if (created) console.log(`Redacted environment schema created: ${created}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
