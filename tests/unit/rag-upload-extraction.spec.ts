/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-135 P0 guard: /api/rag/upload must EXTRACT text, never embed raw bytes. The route did `f.buffer.toString('utf-8')` while every upload surface advertises .pdf/.docx, so a binary document ingested as mojibake — reported as success, unsearchable forever, and invisible to the person who uploaded it. Crosses the real boundary the defect lived on: a real Express app, real multer multipart, real doc-extract (real yauzl on a real .docx built here by the shipped `docx` writer). Only the vector store is doubled, because the defect was never in the store — it was in what the route handed to it.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { createRagRoutes } from '@/app/routes/rag-routes';
import type { RagService } from '@/features/rag';

/** Captures what the route decided to ingest. */
function fakeRagService(captured: string[][]) {
  return {
    ingest: async (texts: string[]) => {
      captured.push(texts);
      return { chunkCount: texts.length, documentCount: texts.length };
    },
  } as unknown as RagService;
}

async function withServer(
  captured: string[][],
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/rag', createRagRoutes(fakeRagService(captured)));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A real .docx, written by the dependency the repo already ships. */
async function realDocx(text: string): Promise<Buffer> {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun(text)] })] }],
  });
  return Packer.toBuffer(doc);
}

function upload(files: Array<{ name: string; type: string; bytes: Buffer }>, collection = 'guard-collection') {
  const form = new FormData();
  form.append('collection', collection);
  for (const file of files) {
    form.append('files', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  }
  return form;
}

describe('POST /api/rag/upload — text extraction', () => {
  it('extracts a real .docx instead of ingesting its zip bytes', async () => {
    const captured: string[][] = [];
    const phrase = 'Turbine bearing clearance measured at 0.42 millimetres.';
    const bytes = await realDocx(phrase);
    // Precondition: the raw file is a binary zip, so the old code path would have
    // ingested unreadable bytes rather than this sentence.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    await withServer(captured, async (base) => {
      const res = await fetch(`${base}/api/rag/upload`, {
        method: 'POST',
        body: upload([{ name: 'inspection.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes }]),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { accepted: Array<{ format: string }>; rejected: unknown[] };
      expect(body.accepted[0].format).toBe('docx');
      expect(body.rejected).toHaveLength(0);
    });

    expect(captured).toHaveLength(1);
    expect(captured[0][0]).toContain(phrase);
    expect(captured[0][0]).not.toContain('PK');
  });

  it('refuses an unreadable PDF with 422 and ingests nothing', async () => {
    const captured: string[][] = [];
    // Real PDF magic bytes, unparseable content — exactly what the old code would
    // have embedded as mojibake and reported as a successful ingest.
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02]), Buffer.from('garbage')]);
    await withServer(captured, async (base) => {
      const res = await fetch(`${base}/api/rag/upload`, {
        method: 'POST',
        body: upload([{ name: 'scan.pdf', type: 'application/pdf', bytes }]),
      });
      expect(res.status).toBe(422);
      const body = await res.json() as { rejected: Array<{ name: string; reason: string }> };
      expect(body.rejected[0].name).toBe('scan.pdf');
      expect(body.rejected[0].reason).toBeTruthy();
    });
    expect(captured).toHaveLength(0);
  });

  it('ingests the readable files of a mixed batch and reports the rest', async () => {
    const captured: string[][] = [];
    const good = Buffer.from('Runbook: restart the ingest worker before the nightly sweep.', 'utf8');
    const bad = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0x01, 0x02]), Buffer.from('nope')]);
    await withServer(captured, async (base) => {
      const res = await fetch(`${base}/api/rag/upload`, {
        method: 'POST',
        body: upload([
          { name: 'runbook.txt', type: 'text/plain', bytes: good },
          { name: 'broken.pdf', type: 'application/pdf', bytes: bad },
        ]),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { accepted: Array<{ name: string }>; rejected: Array<{ name: string }> };
      expect(body.accepted.map((f) => f.name)).toEqual(['runbook.txt']);
      expect(body.rejected.map((f) => f.name)).toEqual(['broken.pdf']);
    });
    expect(captured[0]).toHaveLength(1);
    expect(captured[0][0]).toContain('nightly sweep');
  });

  it('does not truncate a long document at the prompt-sized default cap', async () => {
    const captured: string[][] = [];
    // The doc-extract default is 20k characters, right for feeding a prompt and wrong
    // for a corpus: truncating here drops a document's tail out of every later search.
    const long = `${'lorem ipsum dolor sit amet. '.repeat(2000)}TAIL_MARKER_KEPT`;
    await withServer(captured, async (base) => {
      const res = await fetch(`${base}/api/rag/upload`, {
        method: 'POST',
        body: upload([{ name: 'long.txt', type: 'text/plain', bytes: Buffer.from(long, 'utf8') }]),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { truncated: string[] };
      expect(body.truncated).toHaveLength(0);
    });
    expect(captured[0][0].length).toBeGreaterThan(20000);
    expect(captured[0][0]).toContain('TAIL_MARKER_KEPT');
  });
});
