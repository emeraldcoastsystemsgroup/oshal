/**
 * Live loopback proof for TV Mode pairing and phone push-to-talk surfaces.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { createTvPairingRoutes, createTvTokenAuthMiddleware } from '@/app/routes/tv-pairing-routes';
import { createJarvisVoiceRoutes } from '@/app/routes/jarvis-voice-routes';

type PairStart = {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  qr_url: string;
  device_code: string;
};

type Proof = {
  start: PairStart;
  pendingStatus: string;
  approveOk: boolean;
  pairedStatus: string;
  tokenIssued: boolean;
  consumedStatus: string;
  tvSurface: { status: number; hasJarvis: boolean; hasTasks: boolean; hasRemoteQr: boolean };
  remoteSurface: { status: number; hasPushToTalk: boolean; postsToAsk: boolean };
  qr: { status: number; contentType: string };
};

function auth(req: Request, res: Response, next: NextFunction): void {
  const oidc = (req as Request & { oidc?: { isAuthenticated?: () => boolean; user?: unknown } }).oidc;
  if (oidc?.isAuthenticated?.()) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function fakeBrowserLogin(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { oidc?: unknown }).oidc = {
    isAuthenticated: () => true,
    user: {
      sub: 'proof-user-tv-mode',
      oid: 'proof-user-tv-mode',
      name: 'TV Proof User',
      email: 'proof@example.test',
    },
  };
  next();
}

function buildApp(): express.Express {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'voice-tv-mode-live-proof-secret';
  process.env.APP_URL = process.env.APP_URL || 'http://127.0.0.1';
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createTvTokenAuthMiddleware());
  app.use(createTvPairingRoutes(auth));
  app.use(createJarvisVoiceRoutes(auth));
  app.post('/__proof/login', fakeBrowserLogin, (_req, res) => res.json({ ok: true }));
  return app;
}

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() as T };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function prove(baseUrl: string): Promise<Proof> {
  const start = await json<PairStart>(`${baseUrl}/api/tv/pair/start`, { method: 'POST', body: '{}' });
  assert(start.status === 200, `pair start failed: ${start.status}`);
  assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(start.body.user_code), `bad user code ${start.body.user_code}`);
  assert(start.body.verification_uri_complete.includes(start.body.user_code), 'complete verification URL must carry the user code');
  assert(start.body.qr_url.includes('/api/tv/pair/qr'), 'start response must expose QR URL');

  const pending = await json<{ status: string }>(`${baseUrl}/api/tv/pair/poll`, {
    method: 'POST',
    body: JSON.stringify({ device_code: start.body.device_code }),
  });
  assert(pending.body.status === 'pending', `expected pending, got ${pending.body.status}`);

  const approve = await json<{ ok: boolean }>(`${baseUrl}/api/tv/pair/approve`, {
    method: 'POST',
    body: JSON.stringify({ user_code: start.body.user_code }),
    headers: { 'x-proof-auth': 'browser' },
  });
  assert(approve.status === 401, 'approve should be auth-gated without browser session');

  const app = buildApp as unknown as { __unused?: never };
  void app;

  // Re-send approval through a route-local authenticated browser session by using the login
  // middleware shape directly in this proof app.
  const approved = await fetch(`${baseUrl}/api/tv/pair/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proof-authenticated': 'true' },
    body: JSON.stringify({ user_code: start.body.user_code }),
  });
  let approvedBody = await approved.json() as { ok?: boolean; error?: string };
  if (approved.status === 401) {
    // The production route correctly requires auth; for the loopback proof, approve by
    // starting a second app pass that injects req.oidc before the auth guard.
    throw new Error(`approval route remained unauthenticated in proof harness: ${JSON.stringify(approvedBody)}`);
  }

  const paired = await json<{ status: string; token?: string }>(`${baseUrl}/api/tv/pair/poll`, {
    method: 'POST',
    body: JSON.stringify({ device_code: start.body.device_code }),
  });
  assert(paired.body.status === 'approved' && paired.body.token, `expected approved token, got ${JSON.stringify(paired.body)}`);

  const consumed = await json<{ status: string }>(`${baseUrl}/api/tv/pair/poll`, {
    method: 'POST',
    body: JSON.stringify({ device_code: start.body.device_code }),
  });
  assert(consumed.body.status === 'expired', `expected consumed pairing to be expired, got ${consumed.body.status}`);

  const tv = await fetch(`${baseUrl}/api/jarvis/tv`, { headers: { 'x-oshal-tv-token': paired.body.token } });
  const tvHtml = await tv.text();
  assert(tv.status === 200, `TV surface failed: ${tv.status}`);
  assert(/OSHAL[\s\S]*Jarvis/i.test(tvHtml), 'TV surface must render Jarvis branding');
  assert(/Tasks/i.test(tvHtml), 'TV surface must render task panel');
  assert(/api\/jarvis\/remote/i.test(tvHtml), 'TV surface must include remote URL/QR');

  const remote = await fetch(`${baseUrl}/api/jarvis/remote`, { headers: { 'x-oshal-tv-token': paired.body.token } });
  const remoteHtml = await remote.text();
  assert(remote.status === 200, `remote surface failed: ${remote.status}`);
  assert(/Tap(&nbsp;|\s)*to(&nbsp;|\s)*talk/i.test(remoteHtml), 'remote surface must expose push-to-talk control');
  assert(/\/api\/jarvis\/ask/i.test(remoteHtml), 'remote surface must post to Jarvis ask');

  const qr = await fetch(`${baseUrl}/api/tv/pair/qr?target=remote`);
  assert(qr.status === 200, `remote QR failed: ${qr.status}`);
  assert((qr.headers.get('content-type') ?? '').includes('png'), `expected PNG QR, got ${qr.headers.get('content-type')}`);

  return {
    start: start.body,
    pendingStatus: pending.body.status,
    approveOk: Boolean(approvedBody.ok),
    pairedStatus: paired.body.status,
    tokenIssued: Boolean(paired.body.token),
    consumedStatus: consumed.body.status,
    tvSurface: {
      status: tv.status,
      hasJarvis: /OSHAL[\s\S]*Jarvis/i.test(tvHtml),
      hasTasks: /Tasks/i.test(tvHtml),
      hasRemoteQr: /api\/jarvis\/remote/i.test(tvHtml),
    },
    remoteSurface: {
      status: remote.status,
      hasPushToTalk: /Tap(&nbsp;|\s)*to(&nbsp;|\s)*talk/i.test(remoteHtml),
      postsToAsk: /\/api\/jarvis\/ask/i.test(remoteHtml),
    },
    qr: { status: qr.status, contentType: qr.headers.get('content-type') ?? '' },
  };
}

function renderMarkdown(proof: Proof, generatedAt: Date): string {
  return [
    `# Voice / TV Mode Proof - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - loopback HTTP execution of the real TV pairing and Jarvis voice route modules.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Result',
    '',
    'TV Mode pairing and phone push-to-talk are proven over HTTP: the TV starts a device-code flow, the browser approval path is auth-gated, the pairing becomes paired, a one-time token is issued and consumed, and the paired token opens both the Jarvis TV and remote surfaces.',
    '',
    '| Gate | Result |',
    '|---|---|',
    `| TV code format | ${proof.start.user_code} |`,
    `| Pending poll | ${proof.pendingStatus} |`,
    `| Paired poll | ${proof.pairedStatus} |`,
    `| Token issued | ${proof.tokenIssued} |`,
    `| One-time poll consumed | ${proof.consumedStatus} |`,
    `| TV Mode surface | HTTP ${proof.tvSurface.status}, Jarvis=${proof.tvSurface.hasJarvis}, tasks=${proof.tvSurface.hasTasks} |`,
    `| Push-to-talk remote | HTTP ${proof.remoteSurface.status}, mic=${proof.remoteSurface.hasPushToTalk}, postsToAsk=${proof.remoteSurface.postsToAsk} |`,
    `| Remote QR | HTTP ${proof.qr.status}, ${proof.qr.contentType} |`,
    '',
    'Raw proof:',
    '',
    '```json',
    JSON.stringify(proof, null, 2),
    '```',
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-voice-tv-mode-live.ts',
    '```',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'voice-tv-mode-live-proof-secret';
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    if (req.headers['x-proof-authenticated'] === 'true') {
      (req as Request & { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: {
          sub: 'proof-user-tv-mode',
          oid: 'proof-user-tv-mode',
          name: 'TV Proof User',
          email: 'proof@example.test',
        },
      };
    }
    next();
  });
  app.use(createTvTokenAuthMiddleware());
  app.use(createTvPairingRoutes(auth));
  app.use(createJarvisVoiceRoutes(auth));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const proof = await prove(baseUrl);
    const generatedAt = new Date();
    const outDir = path.join(process.cwd(), 'docs', 'evidence');
    mkdirSync(outDir, { recursive: true });
    const basename = `voice-tv-mode-${dateStamp(generatedAt)}`;
    const mdPath = path.join(outDir, `${basename}.md`);
    const jsonPath = path.join(outDir, `${basename}.json`);
    writeFileSync(mdPath, renderMarkdown(proof, generatedAt), 'utf8');
    writeFileSync(jsonPath, JSON.stringify({ proofTier: 'live', generatedAt: generatedAt.toISOString(), proof }, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, mdPath, jsonPath }, null, 2));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
