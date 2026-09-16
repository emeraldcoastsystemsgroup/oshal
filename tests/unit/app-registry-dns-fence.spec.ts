/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147 D10 guard. The defect this covers is a NAME, not a literal: the fence only ever read the URL text, so `https://registry.example.test/acme/apps` sailed through and the controller then fetched whatever that name resolved to - an internal 10.x box, or 169.254.169.254. A spec that stubs DNS proves nothing about that, because the step that was missing IS the resolver step; so this runs a REAL DNS server on loopback (hand-encoded A/AAAA answers over UDP) and a REAL node dns.Resolver pointed at it, and drives the production catalog fetch through it. The pin half is proven at the socket: pinnedLookup sends https.request to a real local listener under a hostname that does not resolve, and the same request without the pin cannot resolve at all - so the address the fence approved, not a second lookup, is what the connection uses.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the pin's WIRING, which was the one control here with no guard: deleting `lookup: pinnedLookup(pinned)` from the catalog read and the curloptResolve args from the clone left this file 15/15 green while the fence silently degraded to validate-then-fetch. This drives the real fetchRegistryCatalog and asserts the lookup it hands https.request yields the approved address, and that the name is resolved exactly once.
 */

import dgram from 'dgram';
import dns from 'dns';
import https from 'https';
import net from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fetchRegistryCatalog, resolveHostFence, pinnedLookup, isBlockedAddress,
  type HostResolver, type RegistrySource,
} from '@/features/app-registries';

/* -- a real DNS server, so the guard crosses the resolver boundary ------------------------- */

/** What the zone answers for one question: v4 strings for an A query, v6 strings for AAAA. */
type Answerer = (name: string, qtype: number, nth: number) => string[];

const TYPE_A = 1;
const TYPE_AAAA = 28;

/** Packs a dotted-quad into the 4 rdata bytes of an A record. */
function encodeIPv4(address: string): Buffer {
  return Buffer.from(address.split('.').map((part) => Number(part) & 0xff));
}

/** Packs an IPv6 address (including `::` and a dotted IPv4 tail) into the 16 rdata bytes of AAAA. */
function encodeIPv6(address: string): Buffer {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, dotted.index)}${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }
  const [headText, tailText] = text.split('::');
  const head = headText ? headText.split(':') : [];
  const tail = tailText === undefined ? null : (tailText ? tailText.split(':') : []);
  const groups = tail === null ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const buf = Buffer.alloc(16);
  groups.forEach((group, i) => buf.writeUInt16BE(parseInt(group || '0', 16), i * 2));
  return buf;
}

/** Reads the single question out of a query: the name, the type, and where the section ends. */
function parseQuestion(msg: Buffer): { name: string; qtype: number; end: number } | null {
  let off = 12;
  const labels: string[] = [];
  while (off < msg.length) {
    const len = msg[off];
    if (len === 0) { off += 1; break; }
    if (len > 63) return null;
    labels.push(msg.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  return { name: labels.join('.').toLowerCase(), qtype: msg.readUInt16BE(off), end: off + 4 };
}

/** Builds a NOERROR reply carrying `rdatas` as answers of `rtype`, echoing the question verbatim. */
function buildReply(msg: Buffer, end: number, rtype: number, rdatas: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(rdatas.length, 6);
  const answers = rdatas.map((rdata) => {
    const rec = Buffer.alloc(12 + rdata.length);
    rec.writeUInt16BE(0xc00c, 0);
    rec.writeUInt16BE(rtype, 2);
    rec.writeUInt16BE(1, 4);
    rec.writeUInt32BE(30, 6);
    rec.writeUInt16BE(rdata.length, 10);
    rdata.copy(rec, 12);
    return rec;
  });
  return Buffer.concat([header, msg.subarray(12, end), ...answers]);
}

/** Starts the loopback DNS server and hands back its port plus the question log. */
function startDnsServer(answer: Answerer): Promise<{ port: number; questions: string[]; close: () => Promise<void> }> {
  const questions: string[] = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const q = parseQuestion(msg);
    if (!q) return;
    questions.push(`${q.qtype}:${q.name}`);
    const nth = questions.filter((entry) => entry === `${q.qtype}:${q.name}`).length;
    const addresses = q.qtype === TYPE_A || q.qtype === TYPE_AAAA ? answer(q.name, q.qtype, nth) : [];
    const rdatas = addresses.map((a) => (q.qtype === TYPE_A ? encodeIPv4(a) : encodeIPv6(a)));
    sock.send(buildReply(msg, q.end, q.qtype, rdatas), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    sock.bind(0, '127.0.0.1', () => resolve({
      port: (sock.address() as net.AddressInfo).port,
      questions,
      close: () => new Promise<void>((done) => sock.close(() => done())),
    }));
  });
}

/** The zone every case below resolves against. */
const ZONE: Record<number, Record<string, string[]>> = {
  [TYPE_A]: {
    'registry.private.test': ['10.0.0.7'],
    'metadata.evil.test': ['169.254.169.254'],
    'mixed.evil.test': ['93.184.216.34', '10.0.0.9'],
    'registry.public.test': ['93.184.216.34'],
  },
  [TYPE_AAAA]: {
    'v6.private.test': ['fd00::1'],
    'mapped.evil.test': ['::ffff:10.1.2.3'],
  },
};

let server: { port: number; questions: string[]; close: () => Promise<void> };
let resolver: HostResolver;

beforeAll(async () => {
  server = await startDnsServer((name, qtype) => ZONE[qtype]?.[name] ?? []);
  const wire = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  wire.setServers([`127.0.0.1:${server.port}`]);
  resolver = { resolve4: (h) => wire.resolve4(h), resolve6: (h) => wire.resolve6(h) };
});

afterAll(async () => { if (server) await server.close(); });

/** A registry row differing only in the fields a case cares about. */
const source = (over: Partial<RegistrySource>): RegistrySource => ({
  slug: 'acme', url: 'https://registry.private.test/acme/apps', ref: 'main',
  hostKind: 'gitlab', token: '', allowPrivateHost: false, ...over,
});

describe('the registry fence resolves the hostname, through a real resolver', () => {
  it('refuses a public-looking name that resolves into 10.0.0.0/8', async () => {
    const result = await fetchRegistryCatalog(source({}), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private/i);
    expect(result.reason).toContain('10.0.0.7');
    expect(server.questions).toContain(`${TYPE_A}:registry.private.test`);
  });

  it('refuses it on the generic-git clone path too, before git is ever spawned', async () => {
    const result = await fetchRegistryCatalog(source({ hostKind: 'generic-git' }), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private/i);
    expect(result.reason).toContain('10.0.0.7');
    expect(result.reason).not.toMatch(/git read failed/);
  });

  it('refuses a name that resolves to the cloud metadata endpoint', async () => {
    const result = await fetchRegistryCatalog(source({ url: 'https://metadata.evil.test/acme/apps' }), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('169.254.169.254');
  });

  it('refuses a unique-local AAAA answer', async () => {
    const result = await fetchRegistryCatalog(source({ url: 'https://v6.private.test/acme/apps' }), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('fd00::1');
  });

  it('refuses an IPv4-mapped private address hidden in an AAAA answer', async () => {
    const result = await fetchRegistryCatalog(source({ url: 'https://mapped.evil.test/acme/apps' }), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private/i);
  });

  it('refuses when ANY answer is private, not just the first', async () => {
    const result = await fetchRegistryCatalog(source({ url: 'https://mixed.evil.test/acme/apps' }), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('10.0.0.9');
  });

  it('refuses a name that resolves to nothing rather than fetching it blind', async () => {
    const result = await fetchRegistryCatalog(source({ url: 'https://absent.evil.test/acme/apps' }), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not resolve/i);
  });

  it('lets the explicit allow-private-host opt-in through without a DNS refusal', async () => {
    const result = await fetchRegistryCatalog(source({ allowPrivateHost: true }), { resolver });
    expect(result.ok).toBe(false);
    expect(result.reason).not.toMatch(/resolves to the private address/i);
  });

  it('accepts a public answer and pins the address it saw', async () => {
    const fence = await resolveHostFence('registry.public.test', resolver);
    expect(fence.ok).toBe(true);
    if (fence.ok) {
      expect(fence.pinned.address).toBe('93.184.216.34');
      expect(fence.pinned.family).toBe(4);
    }
  });

  it('pins one resolution: a later answer cannot move the address already approved', async () => {
    const rebind = await startDnsServer((name, qtype, nth) => {
      if (qtype !== TYPE_A || name !== 'rebind.evil.test') return [];
      return [nth === 1 ? '203.0.113.9' : '10.0.0.5'];
    });
    const wire = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    wire.setServers([`127.0.0.1:${rebind.port}`]);
    const seam: HostResolver = { resolve4: (h) => wire.resolve4(h), resolve6: (h) => wire.resolve6(h) };
    try {
      const first = await resolveHostFence('rebind.evil.test', seam);
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.pinned.address).toBe('203.0.113.9');
      const second = await resolveHostFence('rebind.evil.test', seam);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toContain('10.0.0.5');
      if (first.ok) expect(first.pinned.address).toBe('203.0.113.9');
    } finally {
      await rebind.close();
    }
  });
});

describe('the production read is wired to the pin, not merely validated by it', () => {
  it('hands https.request a lookup that yields the approved address, and resolves the name once', async () => {
    // Deleting the pin from fetchRegistryCatalog left the rest of this file green: the fence then
    // validates an address and fetches whatever DNS says next, which is the TOCTOU it exists to
    // close. This case fails if the wiring goes away, not just if the helper does.
    const queries: string[] = [];
    const server = await startDnsServer((name, qtype) => {
      queries.push(`${qtype}:${name}`);
      return qtype === TYPE_A && name === 'wired.test' ? ['203.0.113.77'] : [];
    });
    const wire = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    wire.setServers([`127.0.0.1:${server.port}`]);
    const resolver: HostResolver = { resolve4: (h) => wire.resolve4(h), resolve6: (h) => wire.resolve6(h) };

    const seen: Array<Record<string, unknown>> = [];
    const realRequest = https.request;
    (https as { request: unknown }).request = ((options: Record<string, unknown>, ...rest: unknown[]) => {
      seen.push(options);
      // Fail the connection immediately; the assertion is about what was ASKED for, not the body.
      const bad = { ...options, host: '127.0.0.1', hostname: '127.0.0.1', port: 1, lookup: undefined };
      return (realRequest as (o: unknown, ...r: unknown[]) => unknown)(bad, ...rest);
    }) as typeof https.request;

    try {
      await fetchRegistryCatalog(source({ url: 'https://wired.test/acme/apps' }), { resolver }).catch(() => undefined);
    } finally {
      (https as { request: unknown }).request = realRequest;
      await server.close();
    }

    expect(seen.length, 'the catalog read never reached https.request').toBeGreaterThan(0);
    const lookup = seen[0].lookup as ((h: string, o: unknown, cb: (e: Error | null, a?: string, f?: number) => void) => void) | undefined;
    expect(lookup, 'fetchRegistryCatalog did not pass a pinned lookup — the fence is validate-then-fetch').toBeTypeOf('function');

    const resolved = await new Promise<string>((done, fail) => {
      lookup!('wired.test', {}, (err, address) => (err ? fail(err) : done(String(address))));
    });
    expect(resolved, 'the pinned lookup did not yield the approved address').toBe('203.0.113.77');
    // One resolution for the whole read: a second would be the rebinding window reopening.
    expect(queries.filter((q) => q.endsWith(':wired.test') && q.startsWith(String(TYPE_A))))
      .toHaveLength(1);
  });
});

describe('the approved address is what the socket connects to', () => {
  let listener: net.Server;
  let port = 0;
  const arrivals: string[] = [];

  beforeAll(async () => {
    listener = net.createServer((socket) => { arrivals.push(String(socket.remoteAddress)); socket.destroy(); });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    port = (listener.address() as net.AddressInfo).port;
  });

  afterAll(async () => { await new Promise<void>((resolve) => listener.close(() => resolve())); });

  it('reaches the pinned address under a hostname that does not resolve', async () => {
    const before = arrivals.length;
    await new Promise<void>((resolve) => {
      const req = https.request({
        hostname: 'registry.public.test', port, path: '/marketplace.json', method: 'GET',
        lookup: pinnedLookup({ host: 'registry.public.test', address: '127.0.0.1', family: 4 }),
      });
      req.on('error', () => resolve());
      req.on('response', (res) => { res.resume(); resolve(); });
      req.end();
    });
    expect(arrivals.length).toBe(before + 1);
  });

  it('without the pin the same request cannot resolve that hostname at all', async () => {
    const before = arrivals.length;
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const req = https.request({ hostname: 'registry.public.test', port, path: '/marketplace.json', method: 'GET' });
      req.on('error', (e) => resolve(e as NodeJS.ErrnoException));
      req.on('response', (res) => { res.resume(); resolve(new Error('unexpectedly connected') as NodeJS.ErrnoException); });
      req.end();
    });
    expect(err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN').toBe(true);
    expect(arrivals.length).toBe(before);
  });
});

describe('the address judgement itself', () => {
  it('blocks every private, loopback, link-local, CGNAT and unspecified form', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '172.16.0.1',
      '172.31.255.254', '192.168.1.1', '100.64.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.1.2.3']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('lets public addresses through, including the ranges next to the private ones', () => {
    for (const address of ['93.184.216.34', '172.32.0.1', '11.0.0.1', '100.128.0.1', '2606:4700::1111']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('fails closed on anything it cannot parse', () => {
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});
