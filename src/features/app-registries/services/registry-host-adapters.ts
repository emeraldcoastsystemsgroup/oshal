/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147: the host adapters that make "any git location" literally true. The single-store rail hard-wired GitHub in four places — marketplaceUrl built a raw.githubusercontent URL, install-remote refused any non-github.com source, and buildStoreGitAuth only attached credentials for github.com — so a GitLab or self-hosted repo could not even be READ, let alone installed from. This replaces those chokepoints with three strategies behind one interface: github (raw CDN), gitlab (files API, works for gitlab.com AND self-hosted), and generic-git (a sparse clone, the fallback that assumes no raw-file API at all and therefore covers Gitea, Bitbucket, and a plain HTTPS git server). Credentials keep riding `git --config-env` and an Authorization header, never argv and never the remote URL, so a token cannot leak through a process list or an error string.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

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
 * DNS is deliberately NOT resolved here. Resolving to validate invites a TOCTOU rebind between
 * the check and the fetch, and the check would still be advisory; the durable fence is the
 * explicit opt-in flag plus not following cross-host redirects.
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
  // IPv4 literal in a private, loopback, link-local or carrier-grade-NAT range.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate = a === 10 || a === 127 || a === 0
      || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    if (isPrivate) return 'private address — enable "allow private host" for a self-hosted registry';
  }
  // IPv6 loopback / unique-local / link-local, in bracketed or bare form.
  const v6 = host.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || /^f[cd][0-9a-f]{2}:/i.test(v6) || /^fe80:/i.test(v6)) {
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

/**
 * @description Reads a registry's marketplace.json over its host's raw-file API.
 * Never throws — an unreachable or unauthorized registry is a row that renders as broken, not
 * an exception that takes down the whole aggregated catalog.
 * @param source - the registry
 * @returns the raw text, or an honest reason
 */
async function fetchCatalogOverHttp(source: RegistrySource): Promise<CatalogFetchResult> {
  const url = catalogUrlFor(source);
  if (!url) return { ok: false, reason: `cannot build a catalog URL for ${source.hostKind} repo ${source.url}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: catalogAuthHeaders(source),
      // A redirect that changes host would step around the fence entirely.
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, reason: `registry redirected (HTTP ${res.status}) — refusing to follow` };
    }
    if (!res.ok) {
      const priv = res.status === 404 || res.status === 401 || res.status === 403;
      return {
        ok: false,
        reason: priv
          ? `catalog not ${source.token ? 'readable with the saved key' : 'publicly readable'} (HTTP ${res.status})${source.token ? '' : ' — add an access key if this registry is private'}`
          : `catalog fetch failed (HTTP ${res.status})`,
      };
    }
    const text = await readCapped(res);
    return text === null
      ? { ok: false, reason: `catalog exceeds ${MAX_CATALOG_BYTES} bytes` }
      : { ok: true, text };
  } catch (err) {
    logger.warn({ err, slug: source.slug }, 'catalog fetch failed');
    return { ok: false, reason: `registry unreachable: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a response body, refusing anything over the cap without buffering the whole thing. */
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_CATALOG_BYTES) return null;
  const text = await res.text();
  return Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES ? null : text;
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
 * @returns the raw text, or an honest reason
 */
async function fetchCatalogOverClone(source: RegistrySource): Promise<CatalogFetchResult> {
  const auth = buildRegistryGitAuth(source);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-registry-'));
  const repo = normalizeRepoUrl(source.url);
  const ref = source.ref || 'main';
  try {
    await git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '-b', ref, repo, tmp], auth);
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

/**
 * @description Reads a registry's catalog by whichever route its host supports, applying the
 * SSRF fence first. Fence failures are returned as a reason, never thrown, so one misconfigured
 * registry row cannot fail the aggregated page.
 * @param source - the registry
 * @returns the raw marketplace.json text, or an honest reason
 */
export async function fetchRegistryCatalog(source: RegistrySource): Promise<CatalogFetchResult> {
  const fence = fetchFenceProblem(normalizeRepoUrl(source.url), source.allowPrivateHost);
  if (fence) return { ok: false, reason: fence };
  return source.hostKind === 'generic-git'
    ? fetchCatalogOverClone(source)
    : fetchCatalogOverHttp(source);
}
