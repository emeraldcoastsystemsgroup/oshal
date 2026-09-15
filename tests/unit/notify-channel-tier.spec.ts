/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the per-channel credential tier on the Notifications routing table. GET /api/notify/prefs must report, for every sendable channel, whose account would carry it for the caller (their own account, the deployment's service, or none), and a real /test send must take the branch that tier named. The page's own script then runs under a minimal fake DOM with its fetch answered by the real route over HTTP, and every channel option in the saved-topic card and the add picker must name that account kind.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const twilioOperation = vi.hoisted(() => ({ sendUserTwilioSms: vi.fn() }));
vi.mock('@/app/routes/twilio-sms-operation', () => ({ sendUserTwilioSms: twilioOperation.sendUserTwilioSms }));

import { createNotifyRoutes } from '@/app/routes/notify-routes';
import type { AppContext } from '@/app/composition/app-context';
import { NOTIFY_CHANNELS } from '@/features/notifications';

/** Native fetch captured before any test stubs the global (the Twilio capture below). */
const realFetch = globalThis.fetch;

const ME = { sub: 'tier-me-sub', email: 'me@example.test' };
const PHONE = '+15557654321';
const DEPLOYMENT_FROM = '+15550001111';
const SENDABLE = NOTIFY_CHANNELS.filter((c) => c !== 'none');

/** What exists for this caller and this deployment. */
interface World { gmail: boolean; ownTwilio: boolean; deploymentTwilio: boolean; telegram: boolean; savedSms?: boolean }

/** A saved 'test' topic routed to SMS, so /test and the page's topic card both have a row. */
const SMS_ROW = {
  user_sub: ME.sub, topic: 'test', channel: 'sms', enabled: true, quiet_hours_start: null,
  quiet_hours_end: null, phone: PHONE, telegram_chat_id: null, updated_at: null,
};

/** Postgres double answering the connection probes and the prefs reads for `world`. */
function poolFor(world: World): AppContext['pool'] {
  const query = vi.fn(async (sql: string) => {
    if (/provider='google'/.test(sql)) return { rows: world.gmail ? [{ scopes: 'https://www.googleapis.com/auth/gmail.send' }] : [] };
    if (/provider='twilio'/.test(sql)) return { rows: world.ownTwilio ? [{ connected: 1 }] : [] };
    if (/FROM user_notification_prefs/.test(sql)) return { rows: world.savedSms ? [SMS_ROW] : [] };
    return { rows: [] };
  });
  return { query } as unknown as AppContext['pool'];
}

/** Set (or clear) the deployment's notification service credentials for `world`. */
function stubDeployment(world: World): void {
  vi.stubEnv('TWILIO_ACCOUNT_SID', world.deploymentTwilio ? 'ACtest' : '');
  vi.stubEnv('TWILIO_AUTH_TOKEN', world.deploymentTwilio ? 'tok' : '');
  vi.stubEnv('TWILIO_FROM_NUMBER', world.deploymentTwilio ? DEPLOYMENT_FROM : '');
  vi.stubEnv('TWILIO_TO_NUMBER', '');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', world.telegram ? 'bot-token-fixture' : '');
}

/** requiresAuth stub mirroring OIDC: 401 without a session. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  if (!(req as unknown as { oidc?: { user?: unknown } }).oidc?.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

/** Serve the real /api/notify router for `world` on an ephemeral port, signed in as ME. */
async function withRoute<T>(world: World, fn: (base: string) => Promise<T>): Promise<T> {
  stubDeployment(world);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: ME }; next(); });
  app.use('/api/notify', createNotifyRoutes({ pool: poolFor(world) } as AppContext, requiresAuthStub));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The per-channel tiers GET /api/notify/prefs reports. */
async function reportedTiers(base: string): Promise<Record<string, unknown> | undefined> {
  const res = await realFetch(`${base}/api/notify/prefs`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { tiers?: Record<string, unknown> }).tiers;
}

afterEach(() => {
  twilioOperation.sendUserTwilioSms.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const OWN_SMS_WORLD: World = { gmail: true, ownTwilio: true, deploymentTwilio: true, telegram: false };
const SERVICE_WORLD: World = { gmail: false, ownTwilio: false, deploymentTwilio: true, telegram: true };

describe('GET /api/notify/prefs reports the account tier behind every channel', () => {
  it.each([
    ['own Gmail and own Twilio, deployment Twilio, no Telegram bot', OWN_SMS_WORLD,
      { email: 'own', sms: 'own', voice: 'deployment', telegram: 'unavailable' }],
    ['nothing connected, deployment Twilio and Telegram bot', SERVICE_WORLD,
      { email: 'unavailable', sms: 'deployment', voice: 'deployment', telegram: 'deployment' }],
    ['own Twilio only, no deployment service', { gmail: false, ownTwilio: true, deploymentTwilio: false, telegram: false },
      { email: 'unavailable', sms: 'own', voice: 'unavailable', telegram: 'unavailable' }],
    ['nothing anywhere', { gmail: false, ownTwilio: false, deploymentTwilio: false, telegram: false },
      { email: 'unavailable', sms: 'unavailable', voice: 'unavailable', telegram: 'unavailable' }],
  ])('%s', async (_name, world, expected) => {
    const tiers = await withRoute(world, reportedTiers);
    expect(tiers).toEqual(expected);
    expect(Object.keys(tiers ?? {}).sort()).toEqual([...SENDABLE].sort());
  });

  it('an SMS reported as your own account is sent through your own Twilio, not the deployment', async () => {
    twilioOperation.sendUserTwilioSms.mockResolvedValueOnce({ delivered: true, id: 'SM-own' });
    const twilioApi = vi.fn(async () => ({ ok: true, json: async () => ({ sid: 'SM-deployment' }) }) as Response);
    vi.stubGlobal('fetch', twilioApi);
    await withRoute({ ...OWN_SMS_WORLD, savedSms: true }, async (base) => {
      expect((await reportedTiers(base))?.sms).toBe('own');
      const res = await realFetch(`${base}/api/notify/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, topic: 'test' }),
      });
      expect(res.status).toBe(200);
    });
    expect(twilioOperation.sendUserTwilioSms).toHaveBeenCalledTimes(1);
    expect(twilioOperation.sendUserTwilioSms.mock.calls[0].slice(1, 3)).toEqual([ME.sub, PHONE]);
    expect(twilioApi).not.toHaveBeenCalled();
  });

  it("an SMS reported as the deployment's service is sent from the deployment's number", async () => {
    const captured: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body || '') });
      return { ok: true, json: async () => ({ sid: 'SM-deployment' }) } as Response;
    }));
    await withRoute({ ...SERVICE_WORLD, savedSms: true }, async (base) => {
      expect((await reportedTiers(base))?.sms).toBe('deployment');
      const res = await realFetch(`${base}/api/notify/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, topic: 'test' }),
      });
      expect(res.status).toBe(200);
    });
    expect(twilioOperation.sendUserTwilioSms).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('api.twilio.com');
    const params = new URLSearchParams(captured[0].body);
    expect([params.get('From'), params.get('To')]).toEqual([DEPLOYMENT_FROM, PHONE]);
  });
});

// ── The page: its real script, fed by the real route ─────────────────────────────────────────

const PAGE = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'cockpit', 'tools', 'notify.html'), 'utf8');
/** The page's inline script (the head's theme script carries a src and is not matched). */
const PAGE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? '';
/** Every element the page's markup gives an id, so getElementById answers exactly what the page holds. */
const STATIC_ELEMENTS = [...PAGE.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"/gi)].map((m) => ({ tag: m[1].toLowerCase(), id: m[2] }));

/** The DOM surface the page script touches, and nothing more — a new dependency fails here first. */
class FakeNode {
  children: FakeNode[] = [];
  className = '';
  value = '';
  selected = false;
  style: Record<string, string> = {};
  classList = { toggle: (_name: string, _on?: boolean): void => undefined };
  constructor(readonly tag: string, private own = '') {}
  get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(''); }
  set textContent(value: string) { this.own = String(value); this.children = []; }
  appendChild(node: FakeNode): FakeNode { this.children.push(node); return node; }
  replaceChildren(...nodes: FakeNode[]): void { this.own = ''; this.children = nodes; }
  addEventListener(): void { /* the load path under test dispatches no events */ }
}

/** Every descendant of `root` with the given tag, in document order. */
function descendants(root: FakeNode, tag: string): FakeNode[] {
  return root.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...descendants(c, tag)]);
}

/** Run the page against the route at `base`; resolves once its load() has rendered. */
async function renderPage(base: string): Promise<Map<string, FakeNode>> {
  const byId = new Map(STATIC_ELEMENTS.map(({ tag, id }) => [id, new FakeNode(tag)]));
  const document = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => new FakeNode('#text', text),
  };
  const pageFetch = (url: string, init: RequestInit = {}) => {
    const { credentials: _sameOrigin, ...rest } = init;
    return realFetch(new URL(url, base), rest);
  };
  runInContext(PAGE_SCRIPT, createContext({ document, fetch: pageFetch, console }));
  const status = byId.get('status')!;
  for (let i = 0; i < 300 && !/saved topic pref|Could not|Network error|Not signed in/.test(status.textContent); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(status.textContent).toMatch(/saved topic pref/);
  return byId;
}

/** The option labels under `root`, keyed by channel value. */
function optionLabels(root: FakeNode): Record<string, string> {
  return Object.fromEntries(descendants(root, 'option').map((o) => [o.value, o.textContent]));
}

/** How a label must name each account kind. */
const ACCOUNT_KIND: Record<string, RegExp> = {
  own: /your own account/i,
  deployment: /deployment's service/i,
  unavailable: /unavailable/i,
};

describe('the routing table names the account that would carry each channel', () => {
  it.each([
    ['own Gmail and own Twilio', OWN_SMS_WORLD],
    ['nothing connected, deployment service configured', SERVICE_WORLD],
  ])('%s', async (_name, world) => {
    await withRoute({ ...world, savedSms: true }, async (base) => {
      const tiers = (await reportedTiers(base)) as Record<string, string>;
      const byId = await renderPage(base);
      const pickers = { card: optionLabels(byId.get('cards')!), add: optionLabels(byId.get('newChannel')!) };
      for (const labels of Object.values(pickers)) {
        expect(Object.keys(labels)).toEqual([...NOTIFY_CHANNELS]);
        expect(labels.none).toBe('none (mute this topic)');
        for (const channel of SENDABLE) {
          const label = labels[channel];
          expect(label.startsWith(channel), label).toBe(true);
          for (const [kind, words] of Object.entries(ACCOUNT_KIND)) {
            expect(words.test(label), `${channel} → "${label}" (tier ${tiers[channel]})`).toBe(kind === tiers[channel]);
          }
        }
      }
    });
  });

  it('SMS flips between your own account and the deployment service with the connection alone', async () => {
    const own = await withRoute({ ...SERVICE_WORLD, ownTwilio: true, savedSms: true }, async (base) => optionLabels((await renderPage(base)).get('cards')!).sms);
    const service = await withRoute({ ...SERVICE_WORLD, savedSms: true }, async (base) => optionLabels((await renderPage(base)).get('cards')!).sms);
    expect(own).toMatch(ACCOUNT_KIND.own);
    expect(service).toMatch(ACCOUNT_KIND.deployment);
  });
});
