/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 completeness-sweep guards: (1) no silent catch handlers anywhere in the spatial-mapping slice or its routes — every .catch/catch must do something (CLAUDE.md: no swallowed exceptions); (2) the ?app=spaces surface states the room-scale/8GB-VRAM scene-size bound the ADR promises is "stated in the surface, not hidden".
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SLICE_DIRS = ['src/features/spatial-mapping'];

/** An empty catch handler: `.catch(() => {})` / `catch (e) {}` bodies that are only whitespace/comments. */
// no /g flag — a global regex makes .test() stateful across files (lastIndex carryover)
const SILENT_CATCH = /\bcatch\s*(\(\s*\w*\s*\)\s*(=>)?\s*)?\{\s*(\/\*[^]*?\*\/|\/\/[^\n]*\n)?\s*\}/;

function tsFilesUnder(dir: string): string[] {
  const abs = path.resolve(process.cwd(), dir);
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(path.relative(process.cwd(), full)));
    else if (/\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('spatial-mapping conventions (ADR-111 sweep guards)', () => {
  it('has no silent catch handlers in the slice or its routes', () => {
    const files = SLICE_DIRS.flatMap(tsFilesUnder);
    expect(files.length).toBeGreaterThan(5);
    const offenders = files
      .filter((f) => SILENT_CATCH.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(process.cwd(), f).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('states the room-scale / 8GB-VRAM scene-size bound on the upload surface', () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'src/api/spaces.html'), 'utf8');
    expect(html).toMatch(/room-scale/i);
    expect(html).toMatch(/8\s?GB/i);
    expect(html).toMatch(/multiple linked scans/i);
  });
});
