/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SSRF guard: assertPublicHttpUrl() rejects http(s) URLs whose host is internal or resolves to a private/loopback/link-local/metadata IP. Used before any server-side fetch of a user-supplied URL (BYO-LLM endpoint) to stop an authenticated user from making the server hit cloud-metadata (169.254.169.254), internal services, or loopback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Strip IPv6 brackets from url.hostname before the IP-literal check. Previously `http://[::1]/` left brackets on the host so net.isIP() returned 0, skipping isPrivateIp() and falling through to a DNS lookup of "[::1]" — loopback was only blocked by the lookup failing, and a legitimate public IPv6 literal was wrongly rejected as unresolvable. Now IPv6 literals are evaluated directly: private/loopback blocked with the correct reason, public IPv6 allowed.
 */

import dns from 'dns';
import net from 'net';

const lookup = dns.promises.lookup;

/**
 * @description True if an IPv4/IPv6 address is in a private/loopback/link-local/
 * CGNAT/reserved/multicast range (i.e. not a routable public address). A non-IP
 * input is treated as unsafe (true).
 */
export function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateV4(ip);
  if (type === 6) return isPrivateV6(ip);
  return true;
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0) return true;                         // 0.0.0.0/8 "this host"
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;// CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true;                        // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::1' || a === '::') return true;       // loopback / unspecified
  if (a.startsWith('fe80')) return true;            // link-local fe80::/10
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // ULA fc00::/7
  if (a.startsWith('ff')) return true;              // multicast ff00::/8
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped ::ffff:a.b.c.d
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

/**
 * @description Assert a URL is safe for the server to fetch: http(s) only, and its
 * host is neither an internal name nor resolves to any private/loopback/link-local/
 * metadata address. Throws Error on violation. Resolution happens at call time, so a
 * narrow DNS-rebind window remains — acceptable for an authenticated, low-frequency
 * feature; for stricter needs, pin and connect to the validated IP.
 * @param rawUrl - the user-supplied URL (e.g. a BYO-LLM base URL)
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) URLs are allowed');
  }
  // url.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]"); strip them so
  // net.isIP() recognises it and the IP-literal branch below evaluates it directly
  // instead of falling through to a (failing) DNS lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error('endpoint host is not allowed');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('endpoint resolves to a private address');
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error('could not resolve endpoint host');
  }
  if (!addrs.length) throw new Error('could not resolve endpoint host');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('endpoint resolves to a private address');
  }
}
