/**
 * Proves the server-side request forgery (SSRF) guard used before any fetch of a
 * user-supplied URL (BYO-LLM endpoint): src/shared/security/ssrf-guard.ts.
 *
 * Guarantee under test: an authenticated user cannot make the server reach a private,
 * loopback, link-local, or cloud-metadata address — neither via an IP literal nor via
 * a hostname that resolves to one. Public destinations pass. DNS is mocked so the suite
 * is deterministic and offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// dns.promises.lookup is captured at module load, so mock it before importing the guard.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('dns', () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

import { isPrivateIp, assertPublicHttpUrl } from '../../src/shared/security/ssrf-guard';

describe('isPrivateIp', () => {
  it.each([
    ['0.0.0.0', '"this host" 0.0.0.0/8'],
    ['10.1.2.3', 'private 10/8'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'cloud-metadata link-local'],
    ['172.16.0.1', 'private 172.16/12 low'],
    ['172.31.255.255', 'private 172.16/12 high'],
    ['192.168.1.1', 'private 192.168/16'],
    ['100.64.0.1', 'CGNAT 100.64/10'],
    ['192.0.0.1', 'IETF protocol 192.0.0/24'],
    ['198.18.0.1', 'benchmark 198.18/15'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
  ])('treats IPv4 %s as private (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['11.0.0.1'], // just outside 10/8
    ['172.15.0.1'], // just below 172.16/12
    ['172.32.0.1'], // just above 172.16/12
    ['100.63.255.255'], // just below CGNAT
    ['100.128.0.1'], // just above CGNAT
  ])('treats public IPv4 %s as public', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'ULA fc00::/7'],
    ['fd12:3456::1', 'ULA fd'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
  ])('treats IPv6 %s as private (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([['2001:4860:4860::8888'], ['::ffff:8.8.8.8']])('treats public IPv6 %s as public', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it.each([['999.1.1.1'], ['1.2.3'], ['not-an-ip'], ['']])('treats malformed %s as unsafe (private)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });
});

describe('assertPublicHttpUrl', () => {
  beforeEach(() => lookupMock.mockReset());

  it('rejects a syntactically invalid URL', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/invalid URL/);
  });

  it.each([['ftp://example.com/x'], ['file:///etc/passwd'], ['gopher://example.com']])(
    'rejects non-http(s) scheme %s',
    async (u) => {
      await expect(assertPublicHttpUrl(u)).rejects.toThrow(/only http/);
    },
  );

  it.each([
    ['http://localhost/v1'],
    ['http://api.localhost/v1'],
    ['http://printer.local/'],
    ['https://db.internal/x'],
  ])('rejects internal host name %s', async (u) => {
    await expect(assertPublicHttpUrl(u)).rejects.toThrow(/not allowed/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects an IP-literal in a private range without any DNS lookup', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:11434/v1')).rejects.toThrow(/private address/);
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private address/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('accepts a public IP-literal without a DNS lookup', async () => {
    await expect(assertPublicHttpUrl('https://8.8.8.8/v1')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    ['http://[::1]:11434/v1', 'IPv6 loopback'],
    ['http://[fe80::1]/v1', 'IPv6 link-local'],
    ['http://[fd00::1]/v1', 'IPv6 ULA'],
  ])('rejects a private IPv6 literal %s (%s) with no DNS lookup', async (u) => {
    await expect(assertPublicHttpUrl(u)).rejects.toThrow(/private address/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('accepts a public IPv6 literal without a DNS lookup', async () => {
    await expect(assertPublicHttpUrl('https://[2001:4860:4860::8888]/v1')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a hostname that RESOLVES to a private address (DNS-based SSRF)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5' }]);
    await expect(assertPublicHttpUrl('https://evil.example.com/v1')).rejects.toThrow(/private address/);
  });

  it('rejects when ANY of multiple resolved addresses is private', async () => {
    lookupMock.mockResolvedValue([{ address: '8.8.8.8' }, { address: '169.254.169.254' }]);
    await expect(assertPublicHttpUrl('https://mixed.example.com/v1')).rejects.toThrow(/private address/);
  });

  it('accepts a hostname that resolves only to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
    await expect(assertPublicHttpUrl('https://example.com/v1')).resolves.toBeUndefined();
  });

  it('rejects when resolution fails or returns no addresses', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertPublicHttpUrl('https://nope.example.com/')).rejects.toThrow(/could not resolve/);
    lookupMock.mockResolvedValueOnce([]);
    await expect(assertPublicHttpUrl('https://empty.example.com/')).rejects.toThrow(/could not resolve/);
  });
});
