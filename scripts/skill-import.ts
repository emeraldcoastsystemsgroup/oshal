/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CLI wrapper for the skill-import adapter — reads a SKILL.md folder, runs the pure importer + security audit, prints the verdict, and (with --write) stages a deploy-ready persona + swarm-apps manifest. Bundled scripts are copied to quarantine/, never wired for execution.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/skill-import.ts <skill-dir-or-SKILL.md> [flags]
 * Flags:
 *   --write <outDir>       actually stage artifacts under <outDir> (default: dry-run, print only)
 *   --source-url <url>     provenance stamped into persona + manifest
 *   --source-ref <ref>     provenance (e.g. a git tag/commit)
 *   --rag-collection <c>   RAG collection for bundled references/
 *   --harness <h>          persona runtime harness (default codex-cli)
 *   --model <m>            persona runtime model
 *   --sandbox <s>          persona runtime sandbox (default workspace-write)
 *   --json                 emit the machine-readable import result as JSON
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { importSkill, parseSkillMd, buildRagIngestPayloads, ragCollectionFor } from '@/features/skill-import';
import type { SkillImportOptions, SkillImportResult, RagIngestOutcome } from '@/features/skill-import';
import { serializeManifest } from '@/features/swarm-apps';
import type { SwarmAppManifest } from '@/features/swarm-apps';

interface CliArgs {
  skillPath: string;
  writeDir?: string;
  opts: SkillImportOptions;
  json: boolean;
  /** POST the skill's references/ docs into its RAG collection after a successful import. */
  ingestRefs: boolean;
  /** API base for the ingest call. */
  api: string;
  /** Personal access token (oshal_pat_…) — /api/rag is requiresAuth-gated. */
  token: string;
}

/** Parses argv into a skill path + import options. Throws with usage on a missing skill path. */
function parseArgs(argv: string[]): CliArgs {
  const opts: SkillImportOptions = {};
  let skillPath = '';
  let writeDir: string | undefined;
  let json = false;
  let ingestRefs = false;
  let api = process.env.OSHAL_API_URL || 'http://localhost:35457';
  let token = process.env.OSHAL_CLI_TOKEN || '';
  const src: NonNullable<SkillImportOptions['source']> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') writeDir = argv[++i];
    else if (a === '--source-url') src.url = argv[++i];
    else if (a === '--source-ref') src.ref = argv[++i];
    else if (a === '--rag-collection') opts.ragCollection = argv[++i];
    else if (a === '--harness') opts.harness = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--sandbox') opts.sandbox = argv[++i];
    else if (a === '--ingest-refs') ingestRefs = true;
    else if (a === '--api') api = argv[++i];
    else if (a === '--token') token = argv[++i];
    else if (a === '--json') json = true;
    else if (!a.startsWith('--') && !skillPath) skillPath = a;
  }
  if (!skillPath) throw new Error('Usage: skill-import.ts <skill-dir-or-SKILL.md> [--write <outDir>] [--ingest-refs] [--source-url ...] [--json]');
  if (src.url || src.ref) { src.path = skillPath; opts.source = src; }
  return { skillPath, writeDir, opts, json, ingestRefs, api: api.replace(/\/+$/, ''), token };
}

/**
 * POSTs each bundled reference doc into the skill's RAG collection. /api/rag is requiresAuth-gated,
 * so a personal access token (Bearer oshal_pat_…, from `swarm-cli login`) is required unless the
 * target is a MOCK_OIDC dev server. Never throws — every doc resolves to its own outcome.
 */
async function ingestReferences(
  result: SkillImportResult,
  skillDir: string,
  args: CliArgs,
  fetchedOn: string,
): Promise<RagIngestOutcome[]> {
  const collection = args.opts.ragCollection || ragCollectionFor(result.slug);
  const docs = (args.opts.referenceDocs ?? []).map((rel) => ({
    fileName: path.basename(rel),
    content: fs.readFileSync(path.join(skillDir, rel), 'utf-8'),
  }));
  const payloads = buildRagIngestPayloads({
    slug: result.slug,
    collection,
    docs,
    sourceUrl: args.opts.source?.url,
    license: result.persona?.source.license,
    fetchedOn,
  });

  const outcomes: RagIngestOutcome[] = [];
  for (const payload of payloads) {
    const docId = payload.metadata.doc_id;
    try {
      const resp = await fetch(`${args.api}/api/rag/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(args.token ? { Authorization: `Bearer ${args.token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (resp.status === 401 || resp.status === 403 || resp.status === 302) {
        outcomes.push({ docId, ingested: false, error: `auth required (HTTP ${resp.status}) — set OSHAL_CLI_TOKEN (swarm-cli login) or pass --token` });
        continue;
      }
      const json = (await resp.json().catch(() => ({}))) as { success?: boolean; chunkCount?: number; error?: string };
      if (!resp.ok || !json.success) {
        outcomes.push({ docId, ingested: false, error: json.error || `http_${resp.status}` });
        continue;
      }
      outcomes.push({ docId, ingested: true, chunkCount: json.chunkCount });
    } catch (err) {
      outcomes.push({ docId, ingested: false, error: err instanceof Error ? err.message : 'ingest_failed' });
    }
  }
  return outcomes;
}

/** Resolves the SKILL.md file inside a folder (or accepts a direct .md path). */
function resolveSkillMd(skillPath: string): string {
  const stat = fs.statSync(skillPath);
  const file = stat.isDirectory() ? path.join(skillPath, 'SKILL.md') : skillPath;
  if (!fs.existsSync(file)) throw new Error(`No SKILL.md found at ${file}`);
  return file;
}

/** Lists relative paths of files in a bundled subdir (scripts/, references/), or [] if absent. */
function listBundled(skillDir: string, sub: string): string[] {
  const dir = path.join(skillDir, sub);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir)
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .map(f => `${sub}/${f}`);
}

/** Renders the audit verdict as an operator-readable report. */
function renderReport(result: SkillImportResult): string {
  const { audit } = result;
  const lines = [
    `Skill import: ${audit.name}  →  slug "${result.slug}"`,
    `Verdict: ${audit.pass ? 'PASS' : 'BLOCKED'}   installState: ${audit.installState.toUpperCase()}`,
    `Granted tools: [${result.toolTranslation.granted.join(', ')}]`,
  ];
  if (result.toolTranslation.unmapped.length) lines.push(`Ungranted foreign tools: ${result.toolTranslation.unmapped.join(', ')}`);
  if (result.quarantinedScripts.length) lines.push(`Quarantined scripts (NOT wired): ${result.quarantinedScripts.join(', ')}`);
  for (const i of audit.issues) lines.push(`  [${i.level}] ${i.code}: ${i.message}`);
  return lines.join('\n');
}

/** Stages the persona + manifest + a quarantine copy of bundled scripts under outDir. */
function writeArtifacts(result: SkillImportResult, skillDir: string, outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const personaFile = path.join(outDir, `${result.slug}.persona.yaml`);
  const manifestFile = path.join(outDir, `${result.slug}.manifest.yaml`);
  // lineWidth:-1 keeps the markdown `perspective` a readable literal `|` block (house style),
  // not a folded `>-` scalar that collapses its newlines.
  fs.writeFileSync(personaFile, yaml.dump(result.persona, { lineWidth: -1, noRefs: true }), 'utf-8');
  fs.writeFileSync(manifestFile, serializeManifest(result.manifest as unknown as SwarmAppManifest), 'utf-8');
  const written = [personaFile, manifestFile];

  if (result.quarantinedScripts.length) {
    const qDir = path.join(outDir, 'quarantine');
    fs.mkdirSync(qDir, { recursive: true });
    for (const rel of result.quarantinedScripts) {
      const dest = path.join(qDir, path.basename(rel));
      fs.copyFileSync(path.join(skillDir, rel), dest);
      written.push(dest);
    }
    const note = `# QUARANTINE\n\nThese bundled scripts from the imported skill were NOT wired for execution.\nReview each one, then wire it as an OSHAL tool only after operator approval.\n\n${result.quarantinedScripts.map(s => `- ${s}`).join('\n')}\n`;
    const noteFile = path.join(qDir, 'QUARANTINE.md');
    fs.writeFileSync(noteFile, note, 'utf-8');
    written.push(noteFile);
  }
  return written;
}

/** Entry point. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillMd = resolveSkillMd(args.skillPath);
  const skillDir = path.dirname(skillMd);
  const parsed = parseSkillMd(fs.readFileSync(skillMd, 'utf-8'));
  const opts: SkillImportOptions = {
    ...args.opts,
    bundledScripts: listBundled(skillDir, 'scripts'),
    referenceDocs: listBundled(skillDir, 'references'),
  };
  args.opts = opts;
  const result = importSkill(parsed, opts);

  if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }

  process.stdout.write(renderReport(result) + '\n\n');
  if (!result.audit.pass) {
    process.stdout.write('BLOCKED — no artifacts emitted. Fix the errors above and re-import.\n');
    process.exitCode = 2;
    return;
  }
  if (args.writeDir) {
    const written = writeArtifacts(result, skillDir, args.writeDir);
    process.stdout.write(`Staged:\n${written.map(w => `  ${w}`).join('\n')}\n\n`);
  } else {
    process.stdout.write('(dry-run — pass --write <outDir> to stage the persona + manifest)\n\n');
  }

  if (args.ingestRefs) {
    const refs = opts.referenceDocs ?? [];
    if (refs.length === 0) {
      process.stdout.write('--ingest-refs: the skill bundles no references/ — nothing to ingest.\n\n');
    } else {
      const fetchedOn = new Date().toISOString().slice(0, 10);
      const outcomes = await ingestReferences(result, skillDir, args, fetchedOn);
      const ok = outcomes.filter(o => o.ingested).length;
      process.stdout.write(`RAG ingest → ${args.opts.ragCollection || ragCollectionFor(result.slug)} (${ok}/${outcomes.length}):\n`);
      for (const o of outcomes) {
        process.stdout.write(o.ingested
          ? `  ok    ${o.docId}${o.chunkCount != null ? ` (${o.chunkCount} chunks)` : ''}\n`
          : `  FAIL  ${o.docId} — ${o.error}\n`);
      }
      process.stdout.write('\n');
      if (ok < outcomes.length) process.exitCode = 3;
    }
  }

  if (args.writeDir) {
    process.stdout.write([
      'Deploy (operator, after reviewing the audit):',
      `  1. Copy ${result.slug}.persona.yaml → ai-lab/bot-personas/${result.slug}.yaml`,
      `  2. Copy ${result.slug}.manifest.yaml → deployed-apps/${result.slug}.yaml (or swarm-apps/)`,
      '  3. Flip status: inactive → active, then inject via Bot Forge or POST /api/swarm/apps/load',
      '',
    ].join('\n'));
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
