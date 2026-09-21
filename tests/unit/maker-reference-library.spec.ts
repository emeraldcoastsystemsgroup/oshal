/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the open maker-reference library. Four things rot silently and each has a case here: (1) the catalogue's fixed field set, so a reference cannot be added half-formed; (2) the reuse posture being DERIVED from the licence, so a non-commercial or unstated-licence build can never be recorded as copyable; (3) ingest being a rebuild rather than an append, driven over a REAL HTTP server that speaks the RAG API, because the generic ingest endpoint mints timestamped chunk ids and a second run would otherwise leave the bots two copies to cite; (4) the review itself — the three engineering personas' own eval suites are loaded and their structural citation assertions are run against an UNCITED answer, which must fail, and against a cited one, which must pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  MAKER_REFERENCE_COLLECTION,
  MAKER_REFERENCE_DIR,
  REUSE_ALLOWED,
  REUSE_FORBIDDEN,
  deriveDocId,
  loadReferenceRecords,
  normaliseReference,
  renderReferenceDocument,
  reusePostureForLicence,
  slugForDocId,
  validateReference,
} from '../../scripts/lib/maker-reference-library.mjs';
import { main as makerReferenceCli } from '../../scripts/maker-reference.mjs';
import {
  evaluateStructuralAssertion,
  loadPersonaEvalSuite,
} from '../../src/features/persona-evals';

const ROOT = process.cwd();
const CATALOGUE = join(ROOT, MAKER_REFERENCE_DIR);
const PERSONAS = ['animatronics-bot', 'small-motors-bot', 'robotics-bot'] as const;

/** A complete record, used as the base for the "one field missing" cases. */
const COMPLETE = {
  sourceUrl: 'https://github.com/example-org/example-rig',
  title: 'Example rig',
  whatItIs: 'A worked example of the catalogue shape.',
  mechanism: 'A four-bar linkage driven from one servo horn.',
  actuators: 'one MG996R hobby servo',
  controller: 'Arduino Uno with a PCA9685',
  licence: 'MIT',
  takeaway: 'The linkage geometry, and why the horn is on the short link.',
  addedOn: '2026-09-21',
};

describe('the maker-reference catalogue holds the same fields for every build', () => {
  it('every committed record validates, carries a web: doc_id and is named after it', () => {
    const { records, problems } = loadReferenceRecords(CATALOGUE);
    expect(problems).toEqual([]);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(validateReference(record)).toEqual([]);
      expect(record.docId.startsWith('web:')).toBe(true);
      expect(record.actuators.length).toBeGreaterThan(0);
      expect(record.mechanism.length).toBeGreaterThan(0);
      expect(record.controller.length).toBeGreaterThan(0);
      expect(record.takeaway.length).toBeGreaterThan(0);
    }
    const onDisk = readdirSync(CATALOGUE).filter((f) => f.endsWith('.yaml')).sort();
    expect(records.map((r) => `${slugForDocId(r.docId)}.yaml`).sort()).toEqual(onDisk);
  });

  it('a record missing any single required field is refused, not written half-formed', () => {
    for (const field of ['title', 'whatItIs', 'mechanism', 'actuators', 'controller', 'takeaway', 'addedOn']) {
      const incomplete = { ...COMPLETE, [field]: field === 'actuators' ? [] : '' };
      const problems = validateReference(normaliseReference(incomplete));
      expect(problems.join(' | ')).toContain(`missing required field: ${field}`);
    }
    expect(validateReference(normaliseReference(COMPLETE))).toEqual([]);
  });

  it('the doc_id is a pure function of the URL, so re-adding a build addresses one record', () => {
    const canonical = 'web:github.com/example-org/example-rig';
    expect(deriveDocId('https://github.com/example-org/example-rig')).toBe(canonical);
    expect(deriveDocId('https://github.com/example-org/example-rig/')).toBe(canonical);
    expect(deriveDocId('https://www.github.com/Example-Org/Example-Rig')).toBe(canonical);
    expect(deriveDocId('https://github.com/example-org/other-rig')).not.toBe(canonical);
    expect(() => deriveDocId('ftp://example.org/thing')).toThrow(/http/);
  });
});

describe('a licence that forbids reuse is recorded as not-to-copy, never as copyable', () => {
  it('the posture is derived from the licence text', () => {
    expect(reusePostureForLicence('MIT')).toBe(REUSE_ALLOWED);
    expect(reusePostureForLicence('Apache-2.0')).toBe(REUSE_ALLOWED);
    expect(reusePostureForLicence('CC BY-NC (Attribution - Non-Commercial)')).toBe(REUSE_FORBIDDEN);
    expect(reusePostureForLicence('CC BY-NC-SA 4.0')).toBe(REUSE_FORBIDDEN);
    expect(reusePostureForLicence('CC BY-ND 4.0')).toBe(REUSE_FORBIDDEN);
    expect(reusePostureForLicence('unknown')).toBe(REUSE_FORBIDDEN);
    expect(reusePostureForLicence('')).toBe(REUSE_FORBIDDEN);
    expect(reusePostureForLicence('All rights reserved')).toBe(REUSE_FORBIDDEN);
    expect(reusePostureForLicence('proprietary, source-available')).toBe(REUSE_FORBIDDEN);
  });

  it('a caller cannot declare a non-commercial build copyable, and a hand-edited record is refused', () => {
    const declared = normaliseReference({ ...COMPLETE, licence: 'CC BY-NC 3.0', reuse: REUSE_ALLOWED });
    expect(declared.reuse).toBe(REUSE_FORBIDDEN);

    const handEdited = { ...declared, reuse: REUSE_ALLOWED };
    expect(validateReference(handEdited).join(' | ')).toContain('forbids reuse');

    // Tightening is allowed; loosening is not.
    expect(normaliseReference({ ...COMPLETE, forceNoCopy: true }).reuse).toBe(REUSE_FORBIDDEN);
  });

  it('the catalogue holds at least one not-to-copy build and its document says so first', () => {
    const { records } = loadReferenceRecords(CATALOGUE);
    const forbidden = records.filter((r) => r.reuse === REUSE_FORBIDDEN);
    expect(forbidden.length).toBeGreaterThan(0);
    for (const record of forbidden) {
      const body = renderReferenceDocument(record);
      expect(body).toContain('NOT TO COPY');
      expect(body).toContain(`doc_id: ${record.docId}`);
      expect(body).toContain(`Reuse: ${REUSE_FORBIDDEN}`);
    }
  });
});

describe('adding a reference is one command, and re-running it updates rather than duplicates', () => {
  it('the same URL twice leaves one record, carrying the second run\'s note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maker-ref-add-'));
    const previous = process.env.MAKER_REFERENCE_DIR;
    process.env.MAKER_REFERENCE_DIR = dir;
    try {
      const args = (note: string) => [
        'add', COMPLETE.sourceUrl,
        '--note', note,
        '--title', COMPLETE.title,
        '--what', COMPLETE.whatItIs,
        '--mechanism', COMPLETE.mechanism,
        '--actuators', COMPLETE.actuators,
        '--controller', COMPLETE.controller,
        '--licence', COMPLETE.licence,
      ];
      expect(await makerReferenceCli(args('first pass'))).toBe(0);
      expect(readdirSync(dir)).toHaveLength(1);
      expect(await makerReferenceCli(args('second pass, corrected'))).toBe(0);

      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const record = yaml.load(readFileSync(join(dir, files[0]), 'utf8')) as Record<string, unknown>;
      expect(record.takeaway).toBe('second pass, corrected');
      expect(record.docId).toBe(deriveDocId(COMPLETE.sourceUrl));
    } finally {
      if (previous === undefined) delete process.env.MAKER_REFERENCE_DIR;
      else process.env.MAKER_REFERENCE_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a command run missing a required field exits non-zero and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maker-ref-refuse-'));
    const previous = process.env.MAKER_REFERENCE_DIR;
    process.env.MAKER_REFERENCE_DIR = dir;
    try {
      const code = await makerReferenceCli(['add', COMPLETE.sourceUrl, '--note', 'only a note']);
      expect(code).toBe(1);
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.MAKER_REFERENCE_DIR;
      else process.env.MAKER_REFERENCE_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A standing HTTP server that speaks the two RAG endpoints the ingest command drives. */
interface FakeRagStore {
  server: Server;
  base: string;
  /** Documents currently held, keyed by the doc_id the ingest metadata carried. */
  documents: Map<string, { content: string; metadata: Record<string, string>; collection: string }>;
  /** Every request path/method, in order, so "dropped before ingest" is observable. */
  calls: string[];
}

/** Starts the server on an ephemeral loopback port. */
async function startFakeRagStore(): Promise<FakeRagStore> {
  const documents = new Map<string, { content: string; metadata: Record<string, string>; collection: string }>();
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === 'DELETE' && req.url?.startsWith('/api/rag/collections/')) {
      const name = decodeURIComponent(req.url.slice('/api/rag/collections/'.length));
      for (const [key, value] of [...documents]) if (value.collection === name) documents.delete(key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/rag/ingest') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // A timestamped key: the real ingest API mints one chunk id per call, so an append
        // would accumulate. Keying on it here is what makes a duplicate visible.
        documents.set(`${body.metadata?.doc_id}#${documents.size}`, {
          content: body.content,
          metadata: body.metadata ?? {},
          collection: body.collection,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, documentCount: 1, chunkCount: 1 }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}`, documents, calls };
}

describe('ingest rebuilds the collection, so a second run leaves one document per build', () => {
  let store: FakeRagStore;
  const savedApi = process.env.OSHAL_API;

  beforeAll(async () => {
    store = await startFakeRagStore();
    process.env.OSHAL_API = store.base;
  });

  afterAll(async () => {
    if (savedApi === undefined) delete process.env.OSHAL_API;
    else process.env.OSHAL_API = savedApi;
    await new Promise<void>((done) => store.server.close(() => done()));
  });

  it('holds one document per catalogue record, with the full field set, after one run and after two', async () => {
    const { records } = loadReferenceRecords(CATALOGUE);

    expect(await makerReferenceCli(['ingest'])).toBe(0);
    expect(store.documents.size).toBe(records.length);

    for (const record of records) {
      const held = [...store.documents.values()].find((d) => d.metadata.doc_id === record.docId);
      expect(held, `no ingested document for ${record.docId}`).toBeTruthy();
      expect(held!.collection).toBe(MAKER_REFERENCE_COLLECTION);
      expect(held!.metadata.source_url).toBe(record.sourceUrl);
      expect(held!.metadata.license).toBe(record.licence);
      expect(held!.metadata.reuse).toBe(record.reuse);
      expect(held!.metadata.provenance).toBe('fetched-from-web');
      expect(held!.metadata.mechanism).toBe(record.mechanism);
      expect(held!.metadata.controller).toBe(record.controller);
      expect(held!.content).toContain(`doc_id: ${record.docId}`);
    }

    store.calls.length = 0;
    expect(await makerReferenceCli(['ingest'])).toBe(0);
    expect(store.documents.size).toBe(records.length);
    expect(store.calls[0]).toBe(`DELETE /api/rag/collections/${MAKER_REFERENCE_COLLECTION}`);
  });
});

describe('the engineering personas search the catalogue and cite what they used', () => {
  it.each(PERSONAS)('%s names the collection, the search, the doc_id rule and the not-to-copy rule', (persona) => {
    const parsed = yaml.load(
      readFileSync(join(ROOT, 'ai-lab', 'bot-personas', `${persona}.yaml`), 'utf8'),
    ) as { perspective?: string };
    const perspective = parsed.perspective ?? '';
    expect(perspective).toContain(`collection=${MAKER_REFERENCE_COLLECTION}`);
    expect(perspective).toContain('/api/rag/search');
    expect(perspective).toContain('doc_id');
    expect(perspective).toContain('web:');
    expect(perspective).toContain('not-to-copy');
    expect(perspective.toLowerCase()).toContain('fails review');
  });

  it.each(PERSONAS)('%s has a loadable eval suite whose citation task is structural', (persona) => {
    const suite = loadPersonaEvalSuite(persona);
    expect(suite.persona).toBe(persona);
    const citationTasks = suite.tasks.filter((t) =>
      t.assertions.some((a) => a.tier === 'structural' && (a.type === 'citation-block' || /cite/.test(a.id ?? ''))));
    expect(citationTasks.length).toBeGreaterThan(0);
  });
});

/** An answer that leans on a build and carries its provenance. */
const CITED_ANSWERS: Record<string, string> = {
  'animatronics-bot': [
    'Use a two-axis gimbal behind the eyeball rather than four pushrods: one servo pans, one tilts.',
    '',
    '> **Citation:** `web:learn.adafruit.com/crickit-controlled-animatronic-eyeball` (score=0.81)',
    '> Source: https://learn.adafruit.com/crickit-controlled-animatronic-eyeball',
    '> Licence: unknown - Reuse: not-to-copy',
    '>',
    '> Quoted: "Two-axis gimbal behind the eyeball - one servo pans, one tilts."',
  ].join('\n'),
  'small-motors-bot': [
    'Do not buy a bigger RC servo. Close the loop: a brushless motor with an encoder and a real current loop (field-oriented control) holds position without sagging.',
    '',
    '> **Citation:** `web:github.com/odriverobotics/odrive` (score=0.88)',
    '> Source: https://github.com/odriverobotics/ODrive',
    '> Licence: MIT - Reuse: allowed',
    '>',
    '> Quoted: "A current loop plus encoder feedback turns a hobby brushless motor into a position and velocity servo."',
  ].join('\n'),
  'robotics-bot': [
    'Build it on serial bus servos: motor to printed bracket to motor down the limb, with position readback daisy-chained, and a lightly geared leader arm teleoperating the follower. STS3215-class bus servos.',
    '',
    '> **Citation:** `web:github.com/therobotstudio/so-arm100` (score=0.91)',
    '> Source: https://github.com/TheRobotStudio/SO-ARM100',
    '> Licence: Apache-2.0 - Reuse: allowed',
    '>',
    '> Quoted: "Serial-bus-servo arm: motor to printed bracket to motor down the limb."',
  ].join('\n'),
};

/** The same engineering advice, with the provenance stripped out. Nothing else changes. */
const UNCITED_ANSWERS: Record<string, string> = {
  'animatronics-bot': 'Use a two-axis gimbal behind the eyeball rather than four pushrods: one servo pans, one tilts. Two hobby servos will do it.',
  'small-motors-bot': 'Do not buy a bigger RC servo. Close the loop: a brushless motor with an encoder and a real current loop (field-oriented control) holds position without sagging.',
  'robotics-bot': 'Build it on serial bus servos: motor to printed bracket to motor down the limb, with position readback daisy-chained, and a lightly geared leader arm teleoperating the follower. STS3215-class bus servos.',
};

describe('review: an uncited answer fails, the same answer with its doc_id passes', () => {
  it.each(PERSONAS)('%s — the citation assertions are what separate the two', (persona) => {
    const suite = loadPersonaEvalSuite(persona);
    const task = suite.tasks.find((t) => t.assertions.some((a) => a.type === 'citation-block'));
    expect(task, `${persona} has no citation-block task`).toBeTruthy();
    const structural = task!.assertions.filter((a) => a.tier === 'structural');
    expect(structural.length).toBeGreaterThan(0);

    const cited = structural.map((a) => evaluateStructuralAssertion(a, CITED_ANSWERS[persona], {}));
    expect(
      cited.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.detail}`),
      'the cited answer must satisfy every structural assertion',
    ).toEqual([]);

    const uncited = structural.map((a) => evaluateStructuralAssertion(a, UNCITED_ANSWERS[persona], {}));
    const failed = uncited.filter((r) => r.status === 'fail');
    expect(failed.length, 'an uncited answer must fail review').toBeGreaterThan(0);
    expect(failed.some((r) => r.id === 'has-citation-block')).toBe(true);
  });
});
