/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com | ADR-147 D10: the fence now resolves the hostname of the URL it is ABOUT TO FETCH and pins the approved address for the connection. Two gaps closed. (a) The fence judged URL text only, so an address literal was refused and a NAME pointing at the same box was not - which is the entire SSRF case. (b) The catalog URL is not always the registry URL (a github registry is read from raw.githubusercontent.com), so the check now runs on the address actually dialled. fetch() is replaced by https.request because only the request API accepts a `lookup`, and pinning is what makes this a fence rather than an advisory check - fetch would resolve the name a second time and hand a DNS rebind the race. The clone path carries the same pin through `http.curloptResolve`.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147: the host adapters that make "any git location" literally true. The single-store rail hard-wired GitHub in four places — marketplaceUrl built a raw.githubusercontent URL, install-remote refused any non-github.com source, and buildStoreGitAuth only attached credentials for github.com — so a GitLab or self-hosted repo could not even be READ, let alone installed from. This replaces those chokepoints with three strategies behind one interface: github (raw CDN), gitlab (files API, works for gitlab.com AND self-hosted), and generic-git (a sparse clone, the fallback that assumes no raw-file API at all and therefore covers Gitea, Bitbucket, and a plain HTTPS git server). Credentials keep riding `git --config-env` and an Authorization header, never argv and never the remote URL, so a token cannot leak through a process list or an error string.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Close four gaps this fence still had. The CLONE path followed the first redirect straight past the pin - curloptResolve maps only host:port and gits http.followRedirects defaults to initial - so it now refuses redirects, measured with git 2.51.2 against a redirecting origin. NAT64 64:ff9b::/96 was admitted, and on an IPv6-only network with NAT64 the gateway translates 64:ff9b::10.0.0.1 into 10.0.0.1 and the connection succeeds; 6to4, site-local and IPv4-compatible forms join it. And the pinned read used https.globalAgent, whose pool key ignores lookup, so a pooled keep-alive socket never consulted the pin.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import {
  gitResolveArgs, isBlockedAddress, pinnedLookup, resolveHostFence,
  type HostResolver, type PinnedAddress,
} from './registry-dns-fence';

const logger = createChildLogger({ module: 'registry-host-adapters' });

/** How a registry's catalog is read and how its git credential is shaped. */
export type RegistryHostKind = 'github' | 'gitlab' | 'generic-git';

/** Catalog fetch limits — mirrors the single-store rail's existing constants. */
const FETCH_TIMEOUT_MS = 10_000;
const CLONE_TIMEOUT_MS = 60_000;
export const MAX_CATALOG_BYTES = 5 * 1024 * 1024;

/** The subset of a registry row the adapters need. */
export interface RegistrySource {
  slug: string;
  url: string;
  ref: string;
  hostKind: RegistryHostKind;
  /** Resolved plaintext credential, or '' for a public repo. NEVER logged, never echoed. */
  token: string;
  /** When true, a private/loopback host is permitted (a self-hosted internal GitLab). */
  allowPrivateHost: boolean;
}

/** What a catalog read produced. `ok:false` is an honest degrade, never a thrown error. */
export interface CatalogFetchResult {
  ok: boolean;
  /** Raw marketplace.json text when ok. */
  text?: string;
  /** Human-readable reason when not ok. */
  reason?: string;
}

/**
 * @description Guesses the host kind from a repo URL so the operator does not have to know the
 * taxonomy. Anything unrecognized becomes `generic-git`, which is the one that always works —
 * a wrong guess degrades to a slower read, never to a failure.
 * @param url - the repo URL
 * @returns the inferred host kind
 */
export function inferHostKind(url: string): RegistryHostKind {
  const host = safeHost(url);
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  return 'generic-git';
}

/** Lowercased hostname, or '' when the URL will not parse. */
function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * @description Normalizes a repo URL to a stable comparable form: no trailing `.git`, no
 * trailing slash. Two registry rows differing only by those are the same registry, and the
 * uniqueness constraint has to see that.
 * @param url - the raw URL
 * @returns the normalized URL
 */
export function normalizeRepoUrl(url: string): string {
  // Trailing slashes come off FIRST: `…/b.git/` must normalize to `…/b`, and stripping `.git`
  // before the slash would leave the suffix in place and mint a duplicate registry row.
  return String(url ?? '').trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

/**
 * @description THE SSRF FENCE. An admin-typed URL is still an untrusted URL: the controller
 * fetches it server-side, so without this an operator (or anyone who reaches an operator-gated
 * route) could aim the swarm at internal infrastructure.
 *
 * Rules: https only — no http, git, ssh or file; a parseable host; and no address-literal or
 * loopback/link-local/private-range host unless the registry explicitly opts in (a self-hosted
 * internal GitLab is a real case, so this is a per-registry flag rather than a ban).
 *
 * This half judges the URL TEXT only and is synchronous, because the registry store validates a
 * row on save. The NAME is judged by resolveHostFence at fetch time, which resolves once and
 * pins the approved address — the durable answer to the TOCTOU that made an earlier version of
 * this comment argue against resolving at all.
 *
 * @param url - the URL to validate
 * @param allowPrivateHost - whether this registry may target a private/internal host
 * @returns null when acceptable, or the reason it is refused
 */
export function fetchFenceProblem(url: string, allowPrivateHost: boolean): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'not a valid URL'; }
  if (parsed.protocol !== 'https:') return 'only https:// registry URLs are allowed';
  if (parsed.username || parsed.password) return 'credentials must not be embedded in the URL';
  const host = parsed.hostname.toLowerCase();
  if (!host) return 'no host in URL';
  if (allowPrivateHost) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return 'private host — enable "allow private host" for a self-hosted registry';
  }
  // One judgement for every literal form — IPv4, IPv6, and the IPv4-mapped spelling that slips
  // 10.x past an IPv4-only regex. A NAME is not judged here: resolveHostFence does that.
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && isBlockedAddress(literal)) {
    return 'private address — enable "allow private host" for a self-hosted registry';
  }
  return null;
}

/**
 * @description Builds the raw-file URL for a registry's marketplace.json, when its host offers
 * one. Returns null for `generic-git`, which has no such API and reads by clone instead.
 * @param source - the registry
 * @returns the raw URL, or null when this host has no raw-file API
 */
export function catalogUrlFor(source: Pick<RegistrySource, 'url' | 'ref' | 'hostKind'>): string | null {
  const url = normalizeRepoUrl(source.url);
  const ref = encodeURIComponent(source.ref || 'main');
  if (source.hostKind === 'github') {
    const m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/.exec(url);
    return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${ref}/marketplace.json` : null;
  }
  if (source.hostKind === 'gitlab') {
    // GitLab's files API takes the URL-encoded FULL project path, so this works unchanged for
    // gitlab.com and for a self-hosted instance at any subpath depth.
    const m = /^https:\/\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return null;
    return `https://${m[1]}/api/v4/projects/${encodeURIComponent(m[2])}/repository/files/marketplace.json/raw?ref=${ref}`;
  }
  return null;
}

/** The auth header a host expects for its raw-file API. */
function catalogAuthHeaders(source: RegistrySource): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'oshal-app-loader', Accept: 'text/plain' };
  if (!source.token) return headers;
  if (source.hostKind === 'github') headers.Authorization = `token ${source.token}`;
  else if (source.hostKind === 'gitlab') headers['PRIVATE-TOKEN'] = source.token;
  else headers.Authorization = `Bearer ${source.token}`;
  return headers;
}

/** The pinned address for a URL about to be fetched, or the reason that host is refused. */
type FetchTargetGuard = { ok: true; pinned: PinnedAddress | null } | { ok: false; reason: string };

/**
 * @description Applies the DNS half of the fence to the URL that will ACTUALLY be dialled — for a
 * github registry that is raw.githubusercontent.com, not the repo URL — and returns the address the
 * connection must be pinned to. A registry carrying the explicit private-host opt-in skips both
 * halves: the operator has already said that host is theirs.
 * @param url - the URL about to be fetched or cloned
 * @param allowPrivateHost - the registry's opt-in
 * @param resolver - the resolver seam; production uses the process resolver
 * @returns the pinned address (or null when opted out), or the refusal reason
 */
async function guardFetchTarget(
  url: string, allowPrivateHost: boolean, resolver?: HostResolver,
): Promise<FetchTargetGuard> {
  if (allowPrivateHost) return { ok: true, pinned: null };
  let host: string;
  try { host = new URL(url).hostname; } catch { return { ok: false, reason: 'not a valid URL' }; }
  const fence = await resolveHostFence(host, resolver);
  return fence.ok ? { ok: true, pinned: fence.pinned } : { ok: false, reason: fence.reason };
}

/** What one catalog request came back with. A redirect is reported as a status, never followed. */
interface CatalogResponse { status: number; body: string | null; tooLarge: boolean }

/**
 * @description Issues the catalog GET against the PINNED address, capping the body as it arrives.
 * https.request rather than fetch because only the request API takes a `lookup`: fetch would
 * resolve the hostname a second time, which is exactly the race the fence exists to close. TLS is
 * unaffected — the certificate is still validated against the hostname.
 * @param url - the catalog URL
 * @param headers - the host's auth headers
 * @param pinned - the approved address, or null when the registry opted out
 * @returns the status and the capped body
 */
function requestCatalog(
  url: string, headers: Record<string, string>, pinned: PinnedAddress | null,
): Promise<CatalogResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
      servername: target.hostname,
      // A pooled keep-alive socket never consults `lookup` — the agent's pool key ignores it — so the
      // pin would only hold on a fresh connection. This read happens once per catalog fetch, so a
      // private agent costs nothing and keeps the guarantee whole.
      ...(pinned ? {
        agent: new https.Agent({ keepAlive: false }),
        lookup: pinnedLookup(pinned),
      } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      // A redirect that changes host would step around the fence entirely.
      if (status >= 300 && status < 400) { res.resume(); resolve({ status, body: null, tooLarge: false }); return; }
      if (Number(res.headers['content-length'] ?? '0') > MAX_CATALOG_BYTES) {
        res.destroy(); resolve({ status, body: null, tooLarge: true }); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_CATALOG_BYTES) { res.destroy(); resolve({ status, body: null, tooLarge: true }); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), tooLarge: false }));
      res.on('error', reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${FETCH_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Turns a non-2xx catalog status into the sentence an operator can act on. */
function httpCatalogReason(status: number, hasToken: boolean): string {
  if (status >= 300 && status < 400) return `registry redirected (HTTP ${status}) — refusing to follow`;
  if (status !== 404 && status !== 401 && status !== 403) return `catalog fetch failed (HTTP ${status})`;
  return `catalog not ${hasToken ? 'readable with the saved key' : 'publicly readable'} (HTTP ${status})`
    + `${hasToken ? '' : ' — add an access key if this registry is private'}`;
}

/**
 * @description Reads a registry's marketplace.json over its host's raw-file API, through the
 * resolved-and-pinned address.
 * Never throws — an unreachable or unauthorized registry is a row that renders as broken, not
 * an exception that takes down the whole aggregated catalog.
 * @param source - the registry
 * @param deps - the resolver seam
 * @returns the raw text, or an honest reason
 */
async function fetchCatalogOverHttp(source: RegistrySource, deps: CatalogFetchDeps): Promise<CatalogFetchResult> {
  const url = catalogUrlFor(source);
  if (!url) return { ok: false, reason: `cannot build a catalog URL for ${source.hostKind} repo ${source.url}` };
  const guard = await guardFetchTarget(url, source.allowPrivateHost, deps.resolver);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  try {
    const res = await requestCatalog(url, catalogAuthHeaders(source), guard.pinned);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: httpCatalogReason(res.status, Boolean(source.token)) };
    }
    if (res.tooLarge) return { ok: false, reason: `catalog exceeds ${MAX_CATALOG_BYTES} bytes` };
    return { ok: true, text: res.body ?? '' };
  } catch (err) {
    logger.warn({ err, slug: source.slug }, 'catalog fetch failed');
    return { ok: false, reason: `registry unreachable: ${(err as Error).message}` };
  }
}

/**
 * @description Builds the git environment that carries a registry credential WITHOUT putting it
 * in argv or in the remote URL. `--config-env` names an environment variable holding the header,
 * so the token never appears in a process listing, a git error string, or a captured log.
 * @param source - the registry
 * @returns the argument prefix and the env to run git with
 */
export function buildRegistryGitAuth(source: RegistrySource): { argsPrefix: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
    'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  if (!source.token) return { argsPrefix: [], env };

  // GitHub wants x-access-token, GitLab wants oauth2; a generic server takes either as Basic.
  const user = source.hostKind === 'gitlab' ? 'oauth2' : 'x-access-token';
  const basic = Buffer.from(`${user}:${source.token}`, 'utf8').toString('base64');
  const origin = new URL(normalizeRepoUrl(source.url)).origin;
  env.OSHAL_GIT_AUTH_HEADER = `Authorization: Basic ${basic}`;
  return { argsPrefix: [`--config-env=http.${origin}/.extraheader=OSHAL_GIT_AUTH_HEADER`], env };
}

/**
 * @description Reads marketplace.json by sparse-cloning ONLY that file. This is the
 * `generic-git` path and the reason "any git location" is a true statement rather than a
 * GitHub/GitLab statement: it assumes no raw-file API, no vendor, and no web UI — just git
 * over https.
 * @param source - the registry
 * @param deps - the resolver seam
 * @returns the raw text, or an honest reason
 */
async function fetchCatalogOverClone(source: RegistrySource, deps: CatalogFetchDeps): Promise<CatalogFetchResult> {
  const repo = normalizeRepoUrl(source.url);
  const guard = await guardFetchTarget(repo, source.allowPrivateHost, deps.resolver);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const auth = buildRegistryGitAuth(source);
  const pin = gitResolveArgs(repo, guard.pinned);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-registry-'));
  const ref = source.ref || 'main';
  try {
    await git([...pin, 'clone', '--depth', '1', '--filter=blob:none', '--sparse', '-b', ref, repo, tmp], auth);
    await git(['-C', tmp, 'sparse-checkout', 'set', '--no-cone', 'marketplace.json'], auth);
    const file = path.join(tmp, 'marketplace.json');
    if (!fs.existsSync(file)) return { ok: false, reason: 'no marketplace.json at the repository root' };
    if (fs.statSync(file).size > MAX_CATALOG_BYTES) {
      return { ok: false, reason: `catalog exceeds ${MAX_CATALOG_BYTES} bytes` };
    }
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    // Scrub the token out of any git error text before it becomes a UI string.
    const raw = (err as Error).message ?? String(err);
    const safe = source.token ? raw.split(source.token).join('***') : raw;
    logger.warn({ slug: source.slug }, 'catalog clone failed');
    return { ok: false, reason: `git read failed: ${safe.split('\n')[0]}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs one git command with the registry's auth env; rejects with git's own stderr. */
function git(args: string[], auth: { argsPrefix: string[]; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...auth.argsPrefix, ...args], {
      env: auth.env, timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout).trim());
    });
  });
}

/** The seam a caller may inject. Production omits it and the process resolver is used. */
export interface CatalogFetchDeps {
  /** Resolver used by the DNS half of the fence. */
  resolver?: HostResolver;
}

/**
 * @description Reads a registry's catalog by whichever route its host supports, applying the
 * SSRF fence first — the literal-URL half here, the resolve-and-pin half inside each route,
 * against the address it will actually dial. Fence failures are returned as a reason, never
 * thrown, so one misconfigured registry row cannot fail the aggregated page.
 * @param source - the registry
 * @param deps - the resolver seam
 * @returns the raw marketplace.json text, or an honest reason
 */
export async function fetchRegistryCatalog(
  source: RegistrySource, deps: CatalogFetchDeps = {},
): Promise<CatalogFetchResult> {
  const fence = fetchFenceProblem(normalizeRepoUrl(source.url), source.allowPrivateHost);
  if (fence) return { ok: false, reason: fence };
  return source.hostKind === 'generic-git'
    ? fetchCatalogOverClone(source, deps)
    : fetchCatalogOverHttp(source, deps);
}
