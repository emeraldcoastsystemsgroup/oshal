/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real loopback HTTP companion for the host and Lab adapters: exact binary responses, authenticated versus anonymous requests, Create's single image multipart part through real multer, and the existing file-part default. Synthetic credentials, temporary listeners, no installed service or database.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';

interface Reply { status: number; bytes: Buffer; byteLength: number; sha256: string; contentType: string }
export interface ImageHttpPorts {
  api(method: string, route: string): Promise<Reply>;
  anonymous(method: string, route: string): Promise<Reply>;
  upload(route: string, fields: Record<string, string>, file: { field?: string; name: string; type: string; bytes: Buffer }): Promise<Reply>;
}

/**
 * @description Exercise an adapter with real fetch and multer over an ephemeral loopback server.
 * @param bind - Bind the shipping adapter to this synthetic server, never an installed service.
 * @param identity - The synthetic credential this adapter must send (and omit for anonymous reads).
 * @returns Resolves only after all wire assertions pass and the listener closes.
 */
export async function assertImageHttpPorts(bind: (base: string) => ImageHttpPorts, identity: { authorization?: string; cookie?: string }): Promise<void> {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const app = express();
  const seen: Array<{ authorization?: string; cookie?: string }> = [];
  const files: Array<{ field: string; name: string; type: string; bytes: Buffer; fields: Record<string, string> }> = [];
  app.use((req, _res, next) => { seen.push({ authorization: req.headers.authorization, cookie: req.headers.cookie }); next(); });
  app.get('/api/create/project-assets/fixture', (_req, res) => { res.type('image/png').send(bytes); });
  const receive: express.RequestHandler = (req, res) => {
    if (!req.file) { res.status(400).json({ error: 'missing_file' }); return; }
    files.push({ field: req.file.fieldname, name: req.file.originalname, type: req.file.mimetype, bytes: req.file.buffer, fields: { ...req.body } });
    res.status(201).json({ uploaded: true });
  };
  app.post('/api/create/project-assets', multer({ storage: multer.memoryStorage(), limits: { fields: 0, files: 1, fileSize: 1024 * 1024 } }).single('image'), receive);
  app.post('/api/artifacts/handles/upload', multer({ storage: multer.memoryStorage(), limits: { fields: 1, files: 1, fileSize: 1024 * 1024 } }).single('file'), receive);
  const reject: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json({ error: 'invalid_project_upload' }); };
  app.use(reject);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const ports = bind(`http://127.0.0.1:${address.port}`);
    const read = await ports.api('GET', '/api/create/project-assets/fixture');
    assert.equal(read.status, 200);
    assert.equal(read.contentType, 'image/png');
    assert.deepEqual(read.bytes, bytes);
    assert.equal(read.byteLength, bytes.length);
    assert.equal(read.sha256, createHash('sha256').update(bytes).digest('hex'));
    const file = { name: 'fixture.png', type: 'image/png', bytes };
    assert.equal((await ports.upload('/api/create/project-assets', {}, { ...file, field: 'image' })).status, 201);
    assert.deepEqual(files[0], { field: 'image', name: file.name, type: file.type, bytes, fields: {} });
    assert.equal((await ports.upload('/api/create/project-assets', {}, file)).status, 400);
    assert.equal((await ports.upload('/api/artifacts/handles/upload', { type: 'image/png' }, file)).status, 201);
    assert.deepEqual(files[1], { field: 'file', name: file.name, type: file.type, bytes, fields: { type: 'image/png' } });
    assert.equal(files.length, 2);
    const anonymous = await ports.anonymous('GET', '/api/create/project-assets/fixture');
    assert.equal(anonymous.status, 200);
    assert.deepEqual(anonymous.bytes, bytes);
    const expected = { authorization: identity.authorization, cookie: identity.cookie };
    assert.deepEqual(seen, [expected, expected, expected, expected, { authorization: undefined, cookie: undefined }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, rejectClose) => server.close(error => error ? rejectClose(error) : resolve()));
  }
}
