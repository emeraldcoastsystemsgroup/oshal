/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — swarm-app manifest + persona validation gate: every swarm-apps/*.yaml passes the real readManifest, each bot's persona path resolves + parses + has a perspective, and routable worker personas carry a router selector (ADR-083). Fails on a boot-breaking config so it can't ship.
 *
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D2: validate swarm-apps-build/ too — the explicit-load variant dirs were invisible to CI, so readManifest's fail-closed checks would first have fired at POST /api/swarm/apps/load, in production. (swarm-apps-little-monsters/ was DELETED: a pre-carve leftover whose personas the carve had already removed — it could not load.)
 * WHY: 39 manifests + ~97 personas load at boot; a malformed one throws in the loader and can break
 * autoload — a risk ADR-085 amplifies (an installed app PACKAGE brings its own manifest + personas).
 * The loader (readManifest) already enforces the contract at runtime; this runs it at gate time so a
 * broken manifest/persona is caught before it ships, not on the next boot.
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/validate-manifests.ts [--quiet]
 * Exit 0 = all valid (warns allowed).  1 = ≥1 error.  2 = nothing found.
 */

import './lib/silence-logger'; // MUST be first — quiets the loader's INFO logging before it initializes
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { readManifest } from '@/features/swarm-apps';

interface Issue { level: 'error' | 'warn'; where: string; message: string; }

/** Manifest dirs that ship in the repo (deployed-apps/ is runtime-only, not committed). */
// ADR-085 D2: the explicit-load VARIANT dir is validated too. It was invisible to CI, so the
// fail-closed checks in readManifest (routes/auth, uses, ui.assistant) would first have fired at
// POST /api/swarm/apps/load — in production, with no prior signal. It carries route declarations.
const MANIFEST_DIRS = ['swarm-apps', 'swarm-apps-build'];

/** Lists committed manifest files: flat *.yaml plus one-level package folders (<name>/oshal-app.yaml). */
function manifestFiles(): string[] {
  const out: string[] = [];
  for (const dir of MANIFEST_DIRS) {
    const abs = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs)) {
      const full = path.join(abs, entry);
      if (entry.endsWith('.yaml') || entry.endsWith('.yml')) { out.push(full); continue; }
      const pkg = path.join(full, 'oshal-app.yaml');
      try { if (fs.statSync(full).isDirectory() && fs.existsSync(pkg)) out.push(pkg); } catch { /* skip */ }
    }
  }
  return out;
}

/** Reads a persona YAML; returns its parsed object or null (with the parse error captured by the caller). */
function readPersona(personaPath: string): Record<string, unknown> {
  const raw = fs.readFileSync(personaPath, 'utf-8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('persona is empty or not a YAML object');
  return parsed as Record<string, unknown>;
}

/** Validates one manifest + the personas its bots reference. Pushes any issues onto `issues`. */
function validateManifest(file: string, issues: Issue[]): void {
  const rel = path.relative(process.cwd(), file);
  let manifest;
  try {
    manifest = readManifest(file);
  } catch (err) {
    issues.push({ level: 'error', where: rel, message: err instanceof Error ? err.message : 'readManifest failed' });
    return;
  }

  const isWorkerType = Boolean(manifest.workflow && manifest.ticketType);
  for (const bot of manifest.bots ?? []) {
    if (!bot.persona) continue; // an inline/registry bot may declare no persona path
    const personaPath = path.resolve(process.cwd(), bot.persona);
    const pRel = path.relative(process.cwd(), personaPath);
    if (!fs.existsSync(personaPath)) {
      issues.push({ level: 'error', where: rel, message: `bot "${bot.agentId}" persona path does not resolve: ${bot.persona}` });
      continue;
    }
    let persona: Record<string, unknown>;
    try {
      persona = readPersona(personaPath);
    } catch (err) {
      issues.push({ level: 'error', where: pRel, message: err instanceof Error ? err.message : 'persona parse failed' });
      continue;
    }
    if (!persona.perspective && !persona.systemPrompt && !persona.system_prompt) {
      issues.push({ level: 'error', where: pRel, message: 'persona has no `perspective` (the system-prompt block the loader requires)' });
    }
    // ADR-083 mis-route guard: a routable worker persona without a selector falls back to dumping the
    // whole perspective as its router signal. Warn so it's fixed, not silently mis-routed.
    const hasSelector = Boolean(persona.selector_descriptor || persona.selectorDescriptor);
    const hasKeywords = Boolean(persona.routing_keywords || persona.routingKeywords);
    if (isWorkerType && manifest.workflow?.workerBot === bot.name && !hasSelector && !hasKeywords) {
      issues.push({ level: 'warn', where: pRel, message: 'worker persona has no selector_descriptor/routing_keywords — router may mis-route (ADR-083)' });
    }
  }
}

function main(): void {
  const quiet = process.argv.includes('--quiet');
  const files = manifestFiles();
  if (files.length === 0) {
    process.stderr.write('validate-manifests: no manifests found under swarm-apps/\n');
    process.exitCode = 2;
    return;
  }

  const issues: Issue[] = [];
  for (const f of files) validateManifest(f, issues);

  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');

  if (!quiet || issues.length > 0) {
    for (const i of issues) process.stdout.write(`  [${i.level}] ${i.where}: ${i.message}\n`);
  }
  process.stdout.write(`\nManifest validation — ${files.length} manifests: ${errors.length} error(s), ${warns.length} warning(s).\n`);

  if (errors.length > 0) { process.exitCode = 1; return; }
  process.stdout.write(`OK — all ${files.length} manifests + their personas pass.\n`);
}

main();
