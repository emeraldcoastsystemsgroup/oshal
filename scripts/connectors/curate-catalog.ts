#!/usr/bin/env ts-node
/**
 * Connector curation backfill — writes a derived category + plain-language description into every
 * connector spec that lacks one, and FAILS LOUDLY on any connector it cannot categorise.
 *
 * The catalog was mass-imported: 307 specs, 17% with a category, 17% with a description, and a
 * runtime `inferCategory` that quietly labelled the rest 'General'. That catch-all is the actual bug
 * — an uncurated shelf that looks curated. This CLI is the backfill, and the same derivation
 * (src/app/connectors/runtime/curation.ts) is what the runtime catalog uses, so the file on disk and
 * the marketplace entry can never disagree.
 *
 * Human curation always wins: a spec that already declares `metadata.category` /
 * `metadata.description` is left exactly as it is.
 *
 *   npm run connectors:curate            # check only — non-zero when a connector is uncategorisable
 *   npm run connectors:curate -- --write # backfill the specs (refuses to write if ANY fail)
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — check/write backfill over swarm-apps/connectors, fail-closed on any uncategorisable connector (no 'other'/'General' default), text-level metadata upsert that preserves the rest of each file byte-for-byte.
 *
 * @module scripts/connectors/curate-catalog
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { loadConnectorSpec } from '../../src/app/connectors/runtime/spec';
import { deriveConnectorCategory, deriveConnectorDescription, connectorSetupLane } from '../../src/app/connectors/runtime/curation';

const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');
const WRITE = process.argv.includes('--write');

interface Row {
  file: string;
  provider: string;
  category?: string;
  description?: string;
  lane: string;
  declaredCategory: boolean;
  declaredDescription: boolean;
}

/** Render a string as a double-quoted YAML scalar (the shape the curated specs already use). */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * @description Set one key inside a spec's top-level `metadata:` block, creating the block when the
 * file has none. Text-level on purpose: a yaml round-trip would reformat 307 hand-tuned files and
 * bury the actual change in noise.
 * @param text - the whole YAML file
 * @param key - the metadata key to set
 * @param value - the scalar value (quoted for you)
 * @returns the updated file text
 */
export function upsertMetadataKey(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  const blockStart = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  const entry = `  ${key}: ${yamlString(value)}`;
  if (blockStart < 0) {
    const trimmed = text.replace(/\s*$/, '');
    return `${trimmed}\nmetadata:\n${entry}\n`;
  }
  let blockEnd = blockStart + 1;
  while (blockEnd < lines.length && (/^\s+\S/.test(lines[blockEnd]) || lines[blockEnd].trim() === '')) blockEnd += 1;
  const existing = lines.slice(blockStart + 1, blockEnd).findIndex((line) => new RegExp(`^\\s+${key}:`).test(line));
  if (existing >= 0) {
    lines[blockStart + 1 + existing] = entry;
  } else {
    lines.splice(blockStart + 1, 0, entry);
  }
  return lines.join('\n');
}

function main(): void {
  const files = readdirSync(SPEC_DIR).filter((f) => /\.ya?ml$/i.test(f)).sort();
  const rows: Row[] = [];
  const unloadable: Array<{ file: string; error: string }> = [];
  const uncategorisable: string[] = [];

  for (const file of files) {
    const full = path.join(SPEC_DIR, file);
    let spec;
    try {
      spec = loadConnectorSpec(full);
    } catch (err) {
      unloadable.push({ file, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const declaredCategory = Boolean(spec.metadata?.category?.trim());
    const declaredDescription = Boolean(spec.metadata?.description?.trim());
    const category = deriveConnectorCategory(spec);
    if (!category) uncategorisable.push(spec.provider);
    rows.push({
      file, provider: spec.provider, category,
      description: deriveConnectorDescription(spec),
      lane: connectorSetupLane(spec), declaredCategory, declaredDescription,
    });
  }

  // FAIL LOUDLY, and before writing anything: a half-curated catalog is harder to reason about than
  // an uncurated one, and a default category would hide exactly the connectors that need attention.
  if (unloadable.length || uncategorisable.length) {
    for (const u of unloadable) console.error(`  spec will not load: ${u.file} — ${u.error}`);
    for (const p of uncategorisable) {
      console.error(`  no category derivable: ${p} — add an anchor to CATEGORY_RULES in src/app/connectors/runtime/curation.ts`);
    }
    console.error(`\n✗ connector curation FAILED: ${unloadable.length} unloadable, ${uncategorisable.length} uncategorisable (nothing written).`);
    process.exit(1);
  }

  const needCategory = rows.filter((r) => !r.declaredCategory);
  const needDescription = rows.filter((r) => !r.declaredDescription);
  console.log(`Connector curation — ${rows.length} specs, all categorisable.`);
  console.log(`  already declared: ${rows.length - needCategory.length} category, ${rows.length - needDescription.length} description`);
  console.log(`  to backfill:      ${needCategory.length} category, ${needDescription.length} description`);
  const byCategory = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.category as string] = (acc[r.category as string] ?? 0) + 1;
    return acc;
  }, {});
  console.log('  categories:');
  for (const [category, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${category.padEnd(26)} ${n}`);
  }

  if (!WRITE) {
    console.log('\nCheck only. Re-run with --write to backfill the specs.');
    return;
  }
  let written = 0;
  for (const row of rows) {
    if (row.declaredCategory && row.declaredDescription) continue;
    const full = path.join(SPEC_DIR, row.file);
    let text = readFileSync(full, 'utf8');
    if (!row.declaredCategory) text = upsertMetadataKey(text, 'category', row.category as string);
    if (!row.declaredDescription) text = upsertMetadataKey(text, 'description', row.description as string);
    writeFileSync(full, text, 'utf8');
    written += 1;
  }
  console.log(`\n✔ backfilled ${written} spec file(s).`);
}

main();
