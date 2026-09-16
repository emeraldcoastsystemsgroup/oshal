#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CLI for the registry-derived partner-app registration reference: rewrite the generated block in docs/partner-app-registration.md, or with --check exit non-zero when the document has drifted from the connector registry.
 */

/**
 * Regenerate (or verify) the registration reference block in the partner-app document.
 *
 * Usage: npx tsx scripts/connectors/gen-partner-registration.ts [--check]
 *
 * @module scripts/connectors/gen-partner-registration
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOC_FILE, REGEN_COMMAND, REPO_ROOT } from './partner-registration-reference';
import { checkDoc, spliceBlock } from './partner-registration-doc';

const check = process.argv.slice(2).includes('--check');
const { current, block, doc } = checkDoc();

if (check) {
  if (current) {
    // eslint-disable-next-line no-console
    console.log(`${DOC_FILE}: registration reference matches the connector registry`);
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`${DOC_FILE}: the registration reference has drifted from the connector registry. `
    + `Run \`${REGEN_COMMAND}\` and commit the result.`);
  process.exit(1);
}

if (current) {
  // eslint-disable-next-line no-console
  console.log(`${DOC_FILE}: already current, nothing written`);
} else {
  writeFileSync(join(REPO_ROOT, DOC_FILE), spliceBlock(doc, block), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`${DOC_FILE}: registration reference regenerated`);
}
