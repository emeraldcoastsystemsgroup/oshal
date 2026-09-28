/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Little Monsters class-material live-acceptance case's own logic over a doubled HTTP transport: a tagged class, a PDF carried in a Send-to handle and an import answered 201 approved and listed in the class = pass, then the material and the class are deleted through the package routes and proven gone, with the memory-only handle recorded as kept; a "requested" import = fail with the class still removed; a class that survives its delete = red cleanup; a box without Little Monsters writes nothing. The generated PDF is parsed by the same pdf-parse the package's text extraction uses (a real parser, not a double). The real companion is `node scripts/operations/live-acceptance.js lm-class-material` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const lm = requireCjs('../../scripts/lib/live-acceptance-lm-class-material.js');
// The library entry the package's extractMaterialText requires, loaded past its index debug hook.
const pdfParse = requireCjs('pdf-parse/lib/pdf-parse.js') as (data: Buffer) => Promise<{ text: string; numpages: number }>;

const TAG = 'testlab-live-lm-class-material-0a1b2c3d';
const CLASS_ID = '5c1a55e5-0000-4000-8000-000000000001';
const MATERIAL_ID = '3a7e71a1-0000-4000-8000-000000000002';

function world(options: { shareStatus?: string; classDeleteStatus?: number; over?: Record<string, FakeHandler> } = {}) {
  const classes = new Set<string>();
  const materials = new Set<string>();
  const uploads: Array<{ fields: Record<string, string>; file: { name: string; type: string; bytes: Buffer } }> = [];
  const api = fakeApi({
    'GET /api/little-monsters/home-summary': () => ({ status: 200, json: { role: 'admin' } }),
    'POST /api/education/classes': () => { classes.add(CLASS_ID); return { status: 201, json: { classId: CLASS_ID } }; },
    'POST /api/education/import-artifact': () => { materials.add(MATERIAL_ID); return { status: 201, json: { material: { material_id: MATERIAL_ID }, shareStatus: options.shareStatus ?? 'approved', grounded: true } }; },
    'GET /api/education/classes/:id/shared-materials': () => ({ status: 200, json: { materials: [...materials].map((material_id) => ({ material_id })) } }),
    'DELETE /api/education/materials/:id': ({ params }) => { materials.delete(params.id); return { status: 200, json: { success: true } }; },
    'DELETE /api/education/classes/:id': ({ params }) => {
      if ((options.classDeleteStatus ?? 200) !== 200) return { status: options.classDeleteStatus! };
      classes.delete(params.id); return { status: 200, json: { success: true } };
    },
    'GET /api/education/classes/:id/info': ({ params }) => ({ status: classes.has(params.id) ? 200 : 404 }),
    'GET /api/education/classes': () => ({ status: 200, json: { classes: [...classes].map((class_id) => ({ class_id })) } }),
    ...(options.over || {}),
  });
  const upload = async (route: string, fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }) => {
    uploads.push({ fields, file });
    return route === '/api/artifacts/handles/upload'
      ? { status: 201, json: { ref: 'art_0123456789abcdef', expiresAt: '2026-09-28T13:00:00Z' } } : { status: 404, json: {} };
  };
  return { api, upload, uploads, classes, materials };
}

const run = (w: ReturnType<typeof world>) => lm.run({ api: w.api.api, upload: w.upload }, { tag: TAG });

describe('Little Monsters class-material live acceptance', () => {
  it('passes on an approved import listed in the class, then deletes the material and the class', async () => {
    const w = world();
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(`Class ${TAG}: import-artifact answered 201 approved (grounded true)`);
    const created = w.api.calls.find((c) => c.method === 'POST' && c.path === '/api/education/classes')!.body as { name: string };
    expect(created.name).toBe(TAG);
    expect(w.api.calls.find((c) => c.path === '/api/education/import-artifact')!.body).toEqual({ ref: 'art_0123456789abcdef', classId: CLASS_ID });
    expect(w.uploads[0].file).toMatchObject({ name: `${TAG}.pdf`, type: 'application/pdf' });
    expect(w.classes.size + w.materials.size).toBe(0);
    expect([...result.cleanup.removed].sort()).toEqual([`lm-class ${CLASS_ID}`, `lm-material ${MATERIAL_ID}`]);
    expect(result.cleanup.kept).toEqual(['send-to-handle art_0123456789abcdef (memory-only; expires 2026-09-28T13:00:00Z)']);
  });

  it('fails an import that is only requested and still removes the class', async () => {
    const w = world({ shareStatus: 'requested' });
    const result = await run(w);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('came back requested, not approved');
    expect(w.classes.size + w.materials.size).toBe(0);
  });

  it('turns a class that survives its delete into a red cleanup', async () => {
    const result = await run(world({ classDeleteStatus: 503 }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: DELETE /api/education/classes/${CLASS_ID} answered HTTP 503`);
    expect(result.cleanup.outstanding).toEqual([`lm-class ${CLASS_ID}`]);
  });

  it('writes nothing when Little Monsters is not installed', async () => {
    const w = world({ over: { 'GET /api/little-monsters/home-summary': () => ({ status: 404 }) } });
    const result = await run(w);
    expect(result.state).toBe('unavailable');
    expect(w.api.calls.map((c) => c.method)).toEqual(['GET']);
    expect(w.uploads).toEqual([]);
  });

  it('generates a PDF the package\'s own parser reads', async () => {
    const fixture = lm.createFixture(TAG);
    expect(fixture.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const parsed = await pdfParse(fixture.pdf);
    expect(parsed.numpages).toBe(1);
    expect(parsed.text).toContain(`Synthetic class handout ${TAG}.`);
  });
});
