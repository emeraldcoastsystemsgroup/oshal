/**
 * Controller route registrars — the set of source files that register routes on the controller's
 * Express `app`, discovered from the composition entry instead of assumed.
 *
 * WHY THIS EXISTS: the route-auth scanners (the Security Center's auditRoutes and its route-surface
 * contracts, plus the CI inventory specs) all read `src/app/server.ts` alone. On 2026-09-24
 * (708768f5, server bootstrap decomposition) roughly half of the controller's `/api` mounts moved
 * into `server-auxiliary-routes.ts` and registrar modules that receive `app`. Every scanner kept
 * reporting "clean" over the 56 mounts it could still see, and the route-surface contracts whose
 * registration moved were silently treated as inactive. A fixed file list would rot the same way
 * at the next split, so the set is DISCOVERED: walk the static import graph from the entry,
 * staying inside `src/app/` (the composition layer), and keep every file that calls
 * `app.<method>(`. Separate processes (bot-node, sat-node, edge-agent) are not imported by the
 * controller entry, so they stay out without an exclusion list.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: comment-aware source parsing shared by the route scanners, and import-graph discovery of every controller registrar from src/app/server.ts so the Security Center route audit and the CI route inventories see the mounts the 2026-09-24 server decomposition moved out of server.ts.
 *
 * @module features/security/controller-route-registrars
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'security:controller-route-registrars' });

/** One controller registrar: its repository-relative path and raw source text. */
export interface RegistrarSource {
  /** Path relative to the scan root, forward slashes (e.g. `src/app/server-auxiliary-routes.ts`). */
  file: string;
  /** Raw source text as read from disk. */
  text: string;
}

/** Reads a file's text; injectable so discovery can be tested without touching the tree. */
export type RegistrarSourceReader = (absolutePath: string) => string;

/** The controller composition entry, relative to the scan root. */
export const CONTROLLER_ENTRY = 'src/app/server.ts';

/** A call that registers a route or middleware on the controller app. */
const APP_REGISTRATION_RE = /\bapp\.(use|get|post|put|patch|delete|all)\s*\(/;

/** Static and dynamic import specifiers: `from '…'`, `import('…')`, `require('…')`. */
const IMPORT_SPECIFIER_RE = /\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * @description Replace comments with spaces (newlines preserved so indices keep their line
 * numbers) while leaving string/template literals intact. A `//` inside a URL string must not eat
 * the rest of the line, and a mount example inside a doc comment must not become a mount.
 * @param src - Raw TypeScript source.
 * @returns Source of identical length/line structure with comments blanked.
 */
export function stripRouteSourceComments(src: string): string {
  const out: string[] = [];
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const pair = c + (src[i + 1] ?? '');
    if (state === 'code') {
      if (pair === '//') { state = 'line'; out.push(' '); continue; }
      if (pair === '/*') { state = 'block'; out.push(' '); continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out.push(c);
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out.push(c); } else out.push(' ');
    } else if (state === 'block') {
      if (pair === '*/') { state = 'code'; out.push('  '); i++; } else out.push(c === '\n' ? c : ' ');
    } else {
      // Inside a string/template literal: copy verbatim, honour escapes, exit on the close quote.
      if (c === '\\') { out.push(c, src[i + 1] ?? ''); i++; continue; }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
        state = 'code';
      }
      out.push(c);
    }
  }
  return out.join('');
}

/**
 * @description Given comment-stripped source and the index of a call's opening paren, return the
 * full argument text up to the MATCHING close paren. String-aware, so parens inside path strings,
 * `express.json({ limit: '12mb' })` or `serviceSecretOr(requiresAuth)` cannot truncate the walk.
 * @param text - Comment-stripped source.
 * @param openIdx - Index of the `(` that opens the call.
 * @returns The argument text (exclusive of the outer parens), or null when unterminated.
 */
export function balancedCallArgs(text: string, openIdx: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * @description Resolve an import specifier to a `.ts` file on disk. Only the `@/` alias and
 * relative specifiers can point into the tree; package imports resolve to null.
 * @param root - Absolute scan root.
 * @param fromFile - Absolute path of the importing file.
 * @param specifier - The import specifier.
 * @returns The absolute `.ts` path, or null when it is not a local source file.
 */
function resolveLocalImport(root: string, fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(root, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  const candidates = [`${base}.ts`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')];
  return candidates.find((candidate) => candidate.endsWith('.ts') && fs.existsSync(candidate)) ?? null;
}

/**
 * @description The local imports of one file that stay inside the composition layer.
 * @param root - Absolute scan root.
 * @param fromFile - Absolute path of the importing file.
 * @param stripped - The file's comment-stripped source.
 * @returns Absolute paths of imported files under `<root>/src/app/`.
 */
function compositionImports(root: string, fromFile: string, stripped: string): string[] {
  const appDir = path.join(root, 'src', 'app') + path.sep;
  const found: string[] = [];
  for (const match of stripped.matchAll(IMPORT_SPECIFIER_RE)) {
    const resolved = resolveLocalImport(root, fromFile, match[1] ?? match[2] ?? match[3]);
    if (resolved && resolved.startsWith(appDir)) found.push(resolved);
  }
  return found;
}

/**
 * @description Discover every controller registrar: the entry file plus each file reachable from
 * it through local imports inside `src/app/` that registers on `app`. The entry is always
 * returned (even with no registrations, and even when it lives outside `src/app/`, which is how
 * the specs scan a synthetic server file on its own).
 * @param root - Absolute scan root (SECURITY_SCAN_ROOT / repository root).
 * @param entryFile - Absolute or root-relative entry path; defaults to src/app/server.ts.
 * @param readSource - File reader; defaults to UTF-8 from disk.
 * @returns Registrars in discovery order, entry first. Throws when the entry is unreadable.
 */
export function discoverControllerRegistrars(
  root: string,
  entryFile: string = CONTROLLER_ENTRY,
  readSource: RegistrarSourceReader = (absolutePath) => fs.readFileSync(absolutePath, 'utf8'),
): RegistrarSource[] {
  const entry = path.resolve(root, entryFile);
  const registrars: RegistrarSource[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const absolute = queue.shift() as string;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = readSourceOrSkip(absolute, absolute === entry, readSource);
    if (text === null) continue;
    const stripped = stripRouteSourceComments(text);
    if (absolute === entry || APP_REGISTRATION_RE.test(stripped)) {
      registrars.push({ file: path.relative(root, absolute).replace(/\\/g, '/'), text });
    }
    queue.push(...compositionImports(root, absolute, stripped));
  }
  return registrars;
}

/**
 * @description Read one discovered file. The entry must be readable (the caller reports that as
 * an unavailable scan); an unreadable transitive import is skipped rather than failing the scan.
 * @param absolute - Absolute file path.
 * @param isEntry - Whether this is the composition entry.
 * @param readSource - File reader.
 * @returns The file text, or null for an unreadable non-entry file.
 */
function readSourceOrSkip(absolute: string, isEntry: boolean, readSource: RegistrarSourceReader): string | null {
  try {
    return readSource(absolute);
  } catch (err) {
    if (isEntry) throw err;
    logger.error({ err, file: absolute }, 'controller registrar discovery: resolved import is unreadable; skipping it');
    return null;
  }
}
