import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  renderVisualResponse,
  TrustedImageReceiptService,
  VisualResponseService,
  type FactLockedAnswerPacket,
  type GalleryVisualResponseSpec,
  type TrustedImageReceipt,
  type WalmartCatalogProviderRecord,
} from '../../src/features/visual-response';

const SOURCE_REF = 'walmart:item:10849069';
const IMAGE_URL = 'https://i5.walmartimages.com/seo/fish-food.jpeg?odnHeight=573&odnWidth=573';

function record(imageUrl = IMAGE_URL): WalmartCatalogProviderRecord {
  return {
    schemaVersion: 1,
    kind: 'walmart-catalog',
    provider: 'walmart',
    sourceRef: 'walmart:catalog:abc123',
    retrievedAt: '2026-07-12T14:00:00.000Z',
    query: 'fish food',
    items: [{
      sourceRef: SOURCE_REF,
      productId: '10849069',
      title: 'TetraMin Tropical Flakes',
      brand: 'Tetra',
      price: 7.97,
      currency: 'USD',
      imageUrl,
      productUrl: 'https://www.walmart.com/ip/10849069',
    }],
  };
}

function spec(): GalleryVisualResponseSpec {
  return {
    schemaVersion: 1,
    kind: 'gallery',
    title: 'Fish food options',
    sourceRefs: ['walmart:catalog:abc123', SOURCE_REF],
    items: [{
      sourceRef: SOURCE_REF,
      title: 'TetraMin Tropical Flakes',
      brand: 'Tetra',
      price: 7.97,
      currency: 'USD',
    }],
  };
}

function packet(): FactLockedAnswerPacket {
  const walmart = record();
  return {
    factLocked: true,
    sourceSurface: 'jarvis-task',
    sourceSessionId: 'gallery-session',
    sourceJobId: 'gallery-job',
    request: 'Show me fish food.',
    answer: 'I found one live option.',
    sources: [
      { type: 'connector', id: walmart.sourceRef, label: 'Walmart catalog search' },
      { type: 'connector', id: SOURCE_REF, label: 'Walmart product' },
    ],
    providerRecords: [walmart],
    visualSpec: spec(),
  };
}

function syntheticReceipt(): TrustedImageReceipt {
  const digest = 'a'.repeat(64);
  return {
    sourceRef: SOURCE_REF,
    mimeType: 'image/png',
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    width: 2,
    height: 2,
    sourceUrlSha256: digest,
    sourceContentSha256: 'b'.repeat(64),
    contentSha256: 'c'.repeat(64),
    sourceBytes: 8,
    outputBytes: 4,
  };
}

async function sourceJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 900, height: 600, channels: 3, background: { r: 240, g: 180, b: 30 } },
  }).withMetadata({ exif: { IFD0: { Artist: 'must-not-survive' } } }).jpeg().toBuffer();
}

describe('trusted provider image receipt', () => {
  it('receives a ticket image only from beneath the shared workspace root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-local-image-'));
    const previous = process.env.OSHAL_WORKSPACE_ROOT;
    process.env.OSHAL_WORKSPACE_ROOT = root;
    try {
      const imagePath = path.join(root, 'ticket', 'deliverables', 'van-buren.png');
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(imagePath, await sharp({
        create: { width: 640, height: 360, channels: 3, background: { r: 20, g: 100, b: 180 } },
      }).png().toBuffer());
      const localRef = 'workspace-image:van-buren';
      const localSpec = { ...spec(), sourceRefs: ['ticket:1', localRef], items: [{ sourceRef: localRef, title: 'Van Buren', currency: 'USD' as const }] };
      const service = new TrustedImageReceiptService();

      const received = await service.receiveLocalGalleryImages([{ sourceRef: localRef, path: imagePath }], localSpec);
      const escaped = await service.receiveLocalGalleryImages([{ sourceRef: localRef, path: path.join(root, '..', 'outside.png') }], localSpec);

      expect(received.get(localRef)).toMatchObject({ mimeType: 'image/png', sourceRef: localRef });
      expect(escaped.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.OSHAL_WORKSPACE_ROOT;
      else process.env.OSHAL_WORKSPACE_ROOT = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches only the approved CDN and emits a bounded metadata-free PNG receipt', async () => {
    const jpeg = await sourceJpeg();
    const fetchImpl = vi.fn(async () => new Response(jpeg, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.byteLength) },
    }));
    const urlGuard = vi.fn(async () => undefined);
    const service = new TrustedImageReceiptService({ fetchImpl: fetchImpl as typeof fetch, urlGuard });

    const first = await service.receiveGalleryImages(record(), spec());
    const second = await service.receiveGalleryImages(record(), spec());
    const receipt = first.get(SOURCE_REF)!;

    expect(receipt).toMatchObject({ sourceRef: SOURCE_REF, mimeType: 'image/png' });
    expect(receipt.content.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(receipt.width).toBeLessThanOrEqual(480);
    expect(receipt.height).toBeLessThanOrEqual(320);
    expect(receipt.sourceBytes).toBe(jpeg.byteLength);
    expect(receipt.outputBytes).toBe(receipt.content.byteLength);
    expect(receipt.sourceUrlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.sourceContentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.contentSha256).toBe(second.get(SOURCE_REF)?.contentSha256);
    const metadata = await sharp(receipt.content).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.exif).toBeUndefined();
    expect(urlGuard).toHaveBeenCalledWith(IMAGE_URL);
    expect(fetchImpl).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'i5.walmartimages.com' }), expect.objectContaining({ redirect: 'manual' }));
  });

  it.each([
    ['unapproved host', 'https://example.com/fish.jpg', 200, 'image/jpeg'],
    ['redirect', IMAGE_URL, 302, 'image/jpeg'],
    ['active content', IMAGE_URL, 200, 'image/svg+xml'],
    ['MIME mismatch', IMAGE_URL, 200, 'image/png'],
  ])('isolates %s failures without returning bytes', async (_label, imageUrl, status, contentType) => {
    const jpeg = await sourceJpeg();
    const fetchImpl = vi.fn(async () => new Response(jpeg, {
      status,
      headers: { 'content-type': contentType },
    }));
    const service = new TrustedImageReceiptService({
      fetchImpl: fetchImpl as typeof fetch,
      urlGuard: async () => undefined,
    });

    const received = await service.receiveGalleryImages(record(imageUrl), spec());

    expect(received.size).toBe(0);
    if (imageUrl.includes('example.com')) expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops reading a response that exceeds the compressed-byte ceiling', async () => {
    const tooLarge = Buffer.alloc((3 * 1024 * 1024) + 1, 0xff);
    const service = new TrustedImageReceiptService({
      fetchImpl: (async () => new Response(tooLarge, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })) as typeof fetch,
      urlGuard: async () => undefined,
    });

    await expect(service.receiveGalleryImages(record(), spec())).resolves.toHaveProperty('size', 0);
  });

  it('embeds only received PNG bytes in the deterministic gallery SVG', () => {
    const receipt = syntheticReceipt();
    const rendered = renderVisualResponse(packet(), new Map([[SOURCE_REF, receipt]]));
    const svg = rendered.content.toString('utf8');

    expect(rendered.kind).toBe('gallery');
    expect(rendered.alt).toContain('TetraMin Tropical Flakes');
    expect(rendered.alt).toContain('$7.97');
    expect(svg).toContain(`href="data:image/png;base64,${receipt.content.toString('base64')}"`);
    expect(svg).toContain('TetraMin Tropical Flakes');
    expect(svg).toContain('$7.97');
    expect(svg).not.toContain('walmartimages.com');
    expect(svg).not.toContain('https://www.walmart.com');
  });

  it('persists hash-only image receipt provenance beside the owner-scoped gallery artifact', async () => {
    const receipt = syntheticReceipt();
    const receiver = new TrustedImageReceiptService({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      urlGuard: async () => undefined,
    });
    vi.spyOn(receiver, 'receiveGalleryImages').mockResolvedValue(new Map([[SOURCE_REF, receipt]]));
    const pool = { query: vi.fn(async (sqlValue: string) => String(sqlValue).includes('SELECT artifact_id')
      ? { rows: [], rowCount: 0 }
      : {
          rows: [{ artifact_id: '8f3b2cb0-4bba-45f5-8d73-10732fa13469', created_at: '2026-07-12T14:00:00.000Z' }],
          rowCount: 1,
        }) };
    const service = new VisualResponseService(pool as never, receiver);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    const artifact = await service.createArtifact('owner-a', packet());

    expect(artifact.kind).toBe('gallery');
    expect(artifact.provenance.imageReceipts).toEqual([expect.objectContaining({
      sourceRef: SOURCE_REF,
      sourceUrlSha256: 'a'.repeat(64),
      sourceContentSha256: 'b'.repeat(64),
      contentSha256: 'c'.repeat(64),
      mimeType: 'image/png',
    })]);
    const insertCall = pool.query.mock.calls.find(([sqlValue]) => String(sqlValue).includes('INSERT INTO visual_response_artifacts'))!;
    const params = insertCall[1] as unknown[];
    expect(String(params[11])).not.toContain(IMAGE_URL);
    expect((params[9] as Buffer).toString('utf8')).toContain('data:image/png;base64,');
  });

  it('reuses an immutable gallery before refetching mutable provider bytes', async () => {
    const receipt = syntheticReceipt();
    const receiver = new TrustedImageReceiptService({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      urlGuard: async () => undefined,
    });
    const receive = vi.spyOn(receiver, 'receiveGalleryImages')
      .mockResolvedValue(new Map([[SOURCE_REF, receipt]]));
    let stored: Record<string, unknown> | undefined;
    const pool = { query: vi.fn(async (sqlValue: string, values: unknown[] = []) => {
      const sql = String(sqlValue).replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT artifact_id')) {
        return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO visual_response_artifacts')) {
        stored = {
          artifact_id: values[0], mime_type: values[5], width: values[6], height: values[7],
          alt_text: values[8], content: values[9], content_sha256: values[10],
          provenance: JSON.parse(String(values[11])), created_at: '2026-07-12T14:00:00.000Z',
        };
        return { rows: [{ artifact_id: values[0], created_at: stored.created_at }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) };
    const service = new VisualResponseService(pool as never, receiver);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    const first = await service.createArtifact('owner-a', packet());
    receive.mockRejectedValue(new Error('CDN should not be reached on immutable replay'));
    const replay = await service.createArtifact('owner-a', packet());

    expect(replay).toEqual(first);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(first.provenance.inputSpecSha256).toMatch(/^[a-f0-9]{64}$/);

    const conflicting = packet();
    conflicting.providerRecords = [{
      ...record(),
      items: [{ ...record().items[0], title: 'Different provider-owned product' }],
    }];
    await expect(service.createArtifact('owner-a', conflicting))
      .rejects.toThrow('immutability conflict');
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
