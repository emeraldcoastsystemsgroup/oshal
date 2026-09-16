/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Derive the partner-app registration reference from the live connector registry instead of a hand-typed table. The doc covered 14 of the wired hub connectors; its env keys were transcribed by hand and the precedence order was invisible. Every value here is read back out of providerCreds()/redirectUri() by probing them, so a renamed variable or a changed fallback order moves the doc instead of silently drifting.
 */

/**
 * Registry-derived partner-app registration reference.
 *
 * Nothing in the rendered block is transcribed: the credential environment keys are found by
 * setting one candidate variable at a time and asking `providerCreds()` what it resolved, their
 * precedence is found by setting two at a time and seeing which one wins, and the redirect
 * override key is found the same way through `redirectUri()`. Counts come from `PROVIDERS`.
 *
 * @module scripts/connectors/partner-registration-reference
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS, providerCreds, type ProviderDef } from '../../src/app/routes/connector-provider-registry';
import { redirectUri } from '../../src/app/routes/connector-oauth-ceremony';

/** @description Repository root, resolved from this module rather than the caller's cwd. */
export const REPO_ROOT = join(__dirname, '..', '..');
/** @description The connector registry that owns `PROVIDERS`, `providerCreds()` and the auth modes. */
export const REGISTRY_FILE = 'src/app/routes/connector-provider-registry.ts';
/** @description The module that turns a provider id into the exact registered callback URI. */
export const CEREMONY_FILE = 'src/app/routes/connector-oauth-ceremony.ts';
/** @description The operator-facing document whose reference block this module generates. */
export const DOC_FILE = 'docs/partner-app-registration.md';
/** @description Opening marker of the generated block; everything to the closing marker is rewritten. */
export const BEGIN_MARKER = '<!-- BEGIN GENERATED: connector-registration-reference -->';
/** @description Closing marker of the generated block. */
export const END_MARKER = '<!-- END GENERATED: connector-registration-reference -->';
/** @description The command that regenerates the block, named inside the block itself. */
export const REGEN_COMMAND = 'npm run connectors:partner-doc';

/**
 * `auth: 'link'` providers are served by their own route module, so `providerCreds()` resolves
 * nothing for them; their platform app credentials are read where the flow itself lives.
 */
const LINK_CRED_SOURCES: Record<string, { file: string; fn: string }> = {
  plaid: { file: 'src/app/routes/connector-plaid-link.ts', fn: 'plaidCreds' },
};

/** @description One row of the "needs a partner app registered" table. */
export interface RegistrationRow {
  id: string;
  label: string;
  /** 'A' = redirect/consent OAuth app; 'Link' = a client-side widget exchange. */
  shape: 'A' | 'Link';
  redirectPath: string;
  /** Environment keys that override the callback URI, verified through `redirectUri()`. */
  overrides: string[];
  /** Keys `providerCreds()` resolves to the client id, highest precedence first. */
  clientId: string[];
  /** Keys `providerCreds()` resolves to the client secret, highest precedence first. */
  clientSecret: string[];
  /** Where a pasted token is generated, for an OAuth connector that also accepts one. */
  tokenFallbackUrl?: string;
  /** For a `link` provider: the module and keys that hold its platform app credentials. */
  linkCreds?: { file: string; fn: string; env: string[] };
}

/** @description One row of the "Personal Access Token paste only" table. */
export interface TokenRow { id: string; label: string; tokenHelpUrl: string }

/**
 * @description The provider's authorization model with the registry default applied — the registry
 * omits `auth` for the redirect/consent flow, so an absent value means 'oauth'.
 * @param def - a provider definition from `PROVIDERS`
 * @returns the effective authorization model
 */
export function authMode(def: ProviderDef): 'oauth' | 'token' | 'link' {
  return def.auth ?? 'oauth';
}

/**
 * @description Read a repository file as UTF-8 text.
 * @param relative - path relative to the repository root
 * @returns the file content
 */
export function readRepoFile(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

/**
 * @description Index of the `}` that closes the `{` at `open`.
 * @param source - the file's text
 * @param open - index of the opening brace
 * @returns index of the matching closing brace
 */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unterminated brace');
}

/**
 * @description Find the body of a named function by brace matching, so the environment-name harvest
 * below is scoped to that function and cannot pick up an unrelated read elsewhere in the file. An
 * inline object return type (`function f(): { a: string } {`) opens a brace of its own, so a run of
 * braces that is immediately followed by another brace is skipped until the real body is reached.
 * @param source - the file's text
 * @param fnName - the function's declared name
 * @returns the body text between its outermost braces
 */
export function functionBody(source: string, fnName: string): string {
  const declaration = new RegExp(`function\\s+${fnName}\\s*\\(`).exec(source);
  if (!declaration) throw new Error(`function ${fnName} not found`);
  let cursor = declaration.index;
  for (;;) {
    const open = source.indexOf('{', cursor);
    if (open < 0) throw new Error(`function ${fnName} has no body`);
    const close = matchingBrace(source, open);
    if (!/^\s*\{/.test(source.slice(close + 1, close + 8))) return source.slice(open + 1, close);
    cursor = close + 1;
  }
}

/**
 * @description Every `process.env.NAME` a function reads, in source order, de-duplicated. These are
 * only CANDIDATES — each one is confirmed by probing the function before it reaches the document.
 * @param source - the file's text
 * @param fnName - the function's declared name
 * @returns the candidate environment variable names
 */
export function envNamesInFunction(source: string, fnName: string): string[] {
  const names: string[] = [];
  const body = functionBody(source, fnName);
  for (const match of body.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

const sentinel = (key: string): string => `probe-value-for-${key}`;

/**
 * @description Evaluate `read` with exactly `set` present out of `candidates`, then restore the
 * process environment. A probe must not be answerable by a value the operator happens to have set.
 * @param candidates - every variable to clear for the duration of the probe
 * @param set - the variables to give their sentinel value
 * @param read - the function to evaluate under that environment
 * @returns whatever `read` returned
 */
function withOnly<T>(candidates: string[], set: string[], read: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of candidates) { saved.set(key, process.env[key]); delete process.env[key]; }
  for (const key of set) process.env[key] = sentinel(key);
  try {
    return read();
  } finally {
    for (const key of candidates) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  }
}

/**
 * @description Split `providerCreds()` into its per-provider branches and harvest the environment
 * names each one reads, in the order of its `||` chain. The order has to come from the branch rather
 * than from a pairwise probe because Windows resolves `process.env` case-insensitively, which makes
 * the two lowercase Meta fallbacks indistinguishable from their upper-case twins at runtime — a
 * probe-ordered table would render differently on a developer box than in the Linux container.
 * @param registrySource - text of the connector registry module
 * @returns provider id → the credential variables its branch reads, in precedence order
 */
export function credBranchEnv(registrySource: string): Record<string, string[]> {
  const body = functionBody(registrySource, 'providerCreds');
  const branches: Record<string, string[]> = {};
  const declaration = /if\s*\(provider === '([^']+)'\)\s*\{/g;
  for (let match = declaration.exec(body); match; match = declaration.exec(body)) {
    const open = match.index + match[0].length - 1;
    const branch = body.slice(open, matchingBrace(body, open) + 1);
    const names: string[] = [];
    for (const read of branch.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!names.includes(read[1])) names.push(read[1]);
    }
    branches[match[1]] = names;
  }
  return branches;
}

/**
 * @description Confirm, through `providerCreds()` itself, which of a provider's branch variables it
 * actually resolves and to which field. A name that appears in the source but no longer reaches the
 * returned credentials never makes it into the document.
 * @param provider - stable connector provider id
 * @param branchKeys - the provider's branch variables, in precedence order
 * @param candidates - every variable `providerCreds()` reads anywhere, cleared during the probe
 * @returns the honoured client id and client secret keys, highest precedence first
 */
export function resolveCredEnv(
  provider: string, branchKeys: string[], candidates: string[],
): { clientId: string[]; clientSecret: string[] } {
  const clientId: string[] = [];
  const clientSecret: string[] = [];
  for (const key of branchKeys) {
    const creds = withOnly(candidates, [key], () => providerCreds(provider));
    if (creds.clientId === sentinel(key)) clientId.push(key);
    if (creds.clientSecret === sentinel(key)) clientSecret.push(key);
  }
  return { clientId, clientSecret };
}

/**
 * @description Resolve the credentials a provider reports when exactly `set` of its variables carry
 * their sentinel value. Exported so a guard can assert the rendered precedence against the real
 * function instead of against this module's own bookkeeping.
 * @param provider - stable connector provider id
 * @param candidates - every variable to clear for the probe
 * @param set - the variables to set
 * @returns the credentials `providerCreds()` resolved
 */
export function probeCreds(
  provider: string, candidates: string[], set: string[],
): { clientId: string; clientSecret: string } {
  return withOnly(candidates, set, () => providerCreds(provider));
}

/**
 * @description The sentinel value a probe assigns to one variable, so a guard can recognise it.
 * @param key - the environment variable name
 * @returns the sentinel value
 */
export function probeSentinel(key: string): string {
  return sentinel(key);
}

/**
 * @description Ask `redirectUri()` which environment variables override a provider's callback URI.
 * The conventional per-provider name is offered alongside every literal key that function reads, and
 * only the ones it actually returns are reported — so a changed convention surfaces as a missing
 * override rather than a document that still names a variable nothing reads.
 * @param provider - stable connector provider id
 * @param ceremonySource - text of the module that owns `redirectUri()`
 * @returns the honoured override keys, highest precedence first
 */
export function resolveRedirectOverrides(provider: string, ceremonySource: string): string[] {
  const conventional = `${provider.toUpperCase().replace(/-/g, '_')}_REDIRECT_URI`;
  const literals = envNamesInFunction(ceremonySource, 'redirectUri');
  const probed = [conventional, ...literals.filter((key) => key !== conventional)];
  // APP_URL is cleared alongside them so the non-override answer can never look like a sentinel.
  const candidates = [...probed, 'APP_URL'];
  const honoured = probed.filter((key) => withOnly(candidates, [key], () => redirectUri(provider)) === sentinel(key));
  return honoured.sort((a, b) => {
    const resolved = withOnly(candidates, [a, b], () => redirectUri(provider));
    if (resolved === sentinel(a)) return -1;
    if (resolved === sentinel(b)) return 1;
    return 0;
  });
}

/**
 * @description Build the "needs a partner app registered" rows: every `PROVIDERS` entry whose auth
 * model is the redirect/consent flow or a Link widget exchange.
 * @returns one row per oauth/link provider, in registry order
 */
export function registrationRows(): RegistrationRow[] {
  const registrySource = readRepoFile(REGISTRY_FILE);
  const ceremonySource = readRepoFile(CEREMONY_FILE);
  const candidates = envNamesInFunction(registrySource, 'providerCreds');
  const branches = credBranchEnv(registrySource);
  const rows: RegistrationRow[] = [];
  for (const [id, def] of Object.entries(PROVIDERS)) {
    const mode = authMode(def);
    if (mode === 'token') continue;
    const link = LINK_CRED_SOURCES[id];
    rows.push({
      id,
      label: def.label,
      shape: mode === 'link' ? 'Link' : 'A',
      redirectPath: def.redirectPath,
      overrides: resolveRedirectOverrides(id, ceremonySource),
      ...resolveCredEnv(id, branches[id] ?? [], candidates),
      tokenFallbackUrl: def.allowTokenFallback ? def.tokenHelpUrl : undefined,
      linkCreds: link ? { ...link, env: envNamesInFunction(readRepoFile(link.file), link.fn) } : undefined,
    });
  }
  return rows;
}

/**
 * @description Build the "Personal Access Token paste only" rows: every `PROVIDERS` entry whose auth
 * model is a pasted token, so there is no partner app to register at all.
 * @returns one row per token provider, in registry order
 */
export function tokenRows(): TokenRow[] {
  return Object.entries(PROVIDERS)
    .filter(([, def]) => authMode(def) === 'token')
    .map(([id, def]) => ({ id, label: def.label, tokenHelpUrl: def.tokenHelpUrl ?? '' }));
}
