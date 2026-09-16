/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147 D10, the half that did not ship: the fence read the URL TEXT only, so it refused `https://10.0.0.7/x` and waved through `https://registry.example.test/x` that resolves to the same box - which is the whole SSRF case, because an attacker who can publish a DNS record does not need to type an address literal. The original note said resolving was a TOCTOU and therefore not worth doing; that is only true of validate-then-fetch. This resolves ONCE, judges every answer, and then PINS the approved address for the connection (a `lookup` that returns it, and `http.curloptResolve` for the clone), so there is no second resolution for a rebind to win. Refusal is on ANY private answer, not just the one that would be used, and an empty answer is a refusal rather than a blind fetch.
 */

import dns from 'dns';
import net from 'net';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'registry-dns-fence' });

/**
 * The resolver seam. Production passes the process resolver; a guard passes a real `dns.Resolver`
 * aimed at a local DNS server, so the fence can be proven over the wire rather than against a stub.
 */
export interface HostResolver {
  /** A records for a name. Rejects (ENODATA/ENOTFOUND) when there are none. */
  resolve4(hostname: string): Promise<string[]>;
  /** AAAA records for a name. Rejects (ENODATA/ENOTFOUND) when there are none. */
  resolve6(hostname: string): Promise<string[]>;
  /**
   * Optional last resort: the OS resolver, which also reads the hosts file and a container's
   * search domains. Consulted only when DNS answered nothing at all.
   */
  lookupAll?(hostname: string): Promise<Array<{ address: string; family: number }>>;
}

/** The single address the fence approved, and which the connection must then use. */
export interface PinnedAddress {
  /** The hostname as typed — still what TLS validates against. */
  host: string;
  /** The approved literal address. */
  address: string;
  /** 4 or 6, matching `address`. */
  family: 4 | 6;
}

/** Either the pinned address, or the reason the host is refused. Never throws. */
export type HostFenceResult = { ok: true; pinned: PinnedAddress } | { ok: false; reason: string };

/** The process resolver, with a bounded timeout so a dead DNS server cannot hang a page. */
const systemResolver = new dns.promises.Resolver({ timeout: 5_000, tries: 2 });

/**
 * The resolver the fence uses when no seam is injected: DNS first, the OS resolver as a last
 * resort so a hosts-file or search-domain name is not refused as unresolvable.
 */
export const DEFAULT_HOST_RESOLVER: HostResolver = {
  resolve4: (hostname) => systemResolver.resolve4(hostname),
  resolve6: (hostname) => systemResolver.resolve6(hostname),
  lookupAll: (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true }),
};

/** IPv4 ranges the controller must never be aimed at from an operator-typed registry URL. */
function isBlockedV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

/** The IPv6 equivalents, including both spellings of an IPv4-mapped address. */
function isBlockedV6(address: string): boolean {
  const text = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) return isBlockedV4(dotted[1]);
  const packed = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
  if (packed) {
    const hi = parseInt(packed[1], 16);
    const lo = parseInt(packed[2], 16);
    return isBlockedV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'));
  }
  return text === '::' || text === '::1'
    || /^f[cd][0-9a-f]{2}:/.test(text)
    || /^fe[89ab][0-9a-f]:/.test(text)
    || /^ff[0-9a-f]{2}:/.test(text);
}

/**
 * @description Judges one literal address: true when the controller must not connect to it.
 *
 * Covers loopback, the unspecified address, RFC1918, link-local (including the cloud metadata
 * endpoint), CGNAT, benchmark, multicast and reserved space, plus both spellings of an
 * IPv4-mapped IPv6 address — the form that otherwise smuggles 10.x past an IPv4-only check.
 * Anything it cannot parse is blocked: an address the fence does not understand is one it
 * cannot vouch for.
 *
 * @param address - a literal address, with or without brackets or a zone suffix.
 * @returns true when the address must be refused.
 */
export function isBlockedAddress(address: string): boolean {
  const text = String(address ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(text);
  if (family === 4) return isBlockedV4(text);
  if (family === 6) return isBlockedV6(text);
  return true;
}

/** Runs one resolution, treating "no record of this type" as an empty answer rather than a throw. */
async function settle<T>(query: string, host: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (err) {
    // ENODATA/ENOTFOUND is the ordinary answer for a name with no record of this type. It is not
    // an error path: the caller fails CLOSED on an empty result, which is the security outcome.
    logger.debug({ err, host, query }, 'registry host resolution returned no answer');
    return [];
  }
}

/** Every address a name answers with, A records first — the order the connection would prefer. */
async function resolveAll(host: string, resolver: HostResolver): Promise<PinnedAddress[]> {
  const found: PinnedAddress[] = [];
  for (const address of await settle('A', host, () => resolver.resolve4(host))) {
    found.push({ host, address, family: 4 });
  }
  for (const address of await settle('AAAA', host, () => resolver.resolve6(host))) {
    found.push({ host, address, family: 6 });
  }
  if (found.length || !resolver.lookupAll) return found;
  const lookup = resolver.lookupAll;
  for (const entry of await settle('lookup', host, () => lookup(host))) {
    found.push({ host, address: entry.address, family: entry.family === 6 ? 6 : 4 });
  }
  return found;
}

/** The refusal an operator sees, naming the answer that caused it. */
function privateRefusal(host: string, address: string): string {
  return `"${host}" resolves to the private address ${address}`
    + ' — enable "allow private host" for a self-hosted registry';
}

/**
 * @description Resolves a registry hostname ONCE and either refuses it or returns the address the
 * connection must be pinned to.
 *
 * This is the durable form of the fence. Validate-then-fetch is a TOCTOU — the name is resolved a
 * second time by the connection, and a rebind wins that race — so the approved address travels
 * with the result and the caller connects to it directly. Every answer is judged, not just the one
 * that would be used, because a record set holding one public and one private address is the same
 * attack with an extra hop. A name that answers nothing is refused rather than fetched blind.
 *
 * @param host - the hostname (or literal address) from the URL about to be fetched.
 * @param resolver - the resolver seam; defaults to the process resolver.
 * @returns the pinned address, or the reason the host is refused.
 */
export async function resolveHostFence(
  host: string, resolver: HostResolver = DEFAULT_HOST_RESOLVER,
): Promise<HostFenceResult> {
  const name = String(host ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!name) return { ok: false, reason: 'no host in URL' };
  const literal = net.isIP(name);
  if (literal) {
    return isBlockedAddress(name)
      ? { ok: false, reason: privateRefusal(name, name) }
      : { ok: true, pinned: { host: name, address: name, family: literal === 6 ? 6 : 4 } };
  }
  const answers = await resolveAll(name, resolver);
  if (!answers.length) {
    return { ok: false, reason: `"${name}" did not resolve to any address — refusing to fetch it` };
  }
  const blocked = answers.find((answer) => isBlockedAddress(answer.address));
  if (blocked) return { ok: false, reason: privateRefusal(name, blocked.address) };
  return { ok: true, pinned: answers[0] };
}

/** The shape node's net/tls layer calls a custom `lookup` with. */
type LookupDone = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * @description Builds the `lookup` an https request uses so the socket goes to the address the
 * fence approved, with no second resolution for a rebind to win. TLS is unaffected: the request
 * still validates the certificate against the hostname, so pinning the address does not weaken it.
 * @param pinned - the approved address.
 * @returns a lookup function for `https.request`/`net.connect`.
 */
export function pinnedLookup(pinned: PinnedAddress): net.LookupFunction {
  const lookup = (hostname: string, options: dns.LookupOptions | LookupDone, callback?: LookupDone): void => {
    const done = (typeof options === 'function' ? options : callback) as LookupDone;
    const wantsAll = typeof options === 'object' && options !== null && options.all === true;
    if (wantsAll) done(null, [{ address: pinned.address, family: pinned.family }]);
    else done(null, pinned.address, pinned.family);
  };
  return lookup as net.LookupFunction;
}

/**
 * @description The same pin for a git clone, which resolves through libcurl rather than node.
 * `http.curloptResolve` maps the host:port to the approved address for that one command. A git
 * build old enough not to know the option ignores it, which degrades to today's check-then-clone
 * rather than failing the clone.
 * @param url - the repository URL about to be cloned.
 * @param pinned - the approved address, or null when the registry opted out of the fence.
 * @returns git argument pairs to place before the subcommand, or an empty list.
 */
export function gitResolveArgs(url: string, pinned: PinnedAddress | null): string[] {
  if (!pinned) return [];
  let target: URL;
  try { target = new URL(url); } catch { return []; }
  const port = target.port || '443';
  const address = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
  return ['-c', `http.curloptResolve=${target.hostname}:${port}:${address}`];
}
