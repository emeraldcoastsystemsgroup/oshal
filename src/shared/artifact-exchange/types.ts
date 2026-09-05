/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 1: the artifact-exchange declaration types, the fail-closed manifest validator the swarm-app loader calls (a malformed artifacts: block fails the app load, never half-registers), and the MIME-glob matcher the menu uses. Pure module — no I/O — so the vitest guards cover every reject shape.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 2 (Amendment B): `overlay` — a KERNEL-RESERVED dispatch shape (send-to.js opens the page in an in-place iframe overlay with the ref; the email compose built-in is the first user). Manifests may NOT declare it — the validator refuses it, so an app cannot point the overlay at an arbitrary page; kernel boot registrations bypass the manifest validator by construction.
 */

/** The two dispatch modes an accepting app may declare (ADR-139 D4/D4a). */
export const ARTIFACT_ACTION_MODES = ['open', 'post'] as const;

/** One dispatch mode: `open` navigates the cockpit to the app pre-loaded; `post` acts headlessly. */
export type ArtifactActionMode = (typeof ARTIFACT_ACTION_MODES)[number];

/**
 * @description One action an app offers for artifacts it accepts (a "Send to…" menu entry).
 * `open` mode needs no endpoint — the cockpit navigates to `/cockpit/?app=<name>&artifact=<ref>`
 * and the shell forwards the ref to the app's surface (ADR-139 D4a). `post` mode declares the
 * app-owned endpoint that receives `{ ref }`; the endpoint is guarded by the app's own mount.
 */
export interface ArtifactAcceptDeclaration {
  /** Stable per-app action id (slug) — distinguishes multiple actions one app registers. */
  id: string;
  /** Menu label, e.g. "Restyle in Portrait Studio". */
  label: string;
  /** Optional menu icon (an emoji or short glyph). */
  icon?: string;
  /** MIME globs this action takes: exact (`application/pdf`), family (`image/*`), or `*\/*`. */
  types: string[];
  /** How the dispatch happens. */
  mode: ArtifactActionMode;
  /** post mode only: the root-relative `/api/...` endpoint that receives `{ ref }`. */
  endpoint?: string;
  /** KERNEL-RESERVED (Amendment B): an in-place overlay page send-to.js opens with `?artifact=<ref>`
   *  instead of navigating. Refused in manifests — only kernel boot registrations may set it. */
  overlay?: string;
}

/** @description A source declaration (phase 3 — parsed and validated now, consumed later). */
export interface ArtifactProvideDeclaration {
  /** MIME globs this app can enumerate for a picker. */
  types: string[];
  /** Optional root-relative listing endpoint for the generic picker. */
  list?: string;
}

/** @description The manifest `artifacts:` block (ADR-139 D1). */
export interface ArtifactActionsDeclaration {
  accepts?: ArtifactAcceptDeclaration[];
  provides?: ArtifactProvideDeclaration[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MIME_PART_RE = /^[a-z0-9][a-z0-9.+-]*$/;
const MAX_LABEL = 60;
const MAX_ICON = 8;
const MAX_PATH = 200;

/**
 * @description Is this a well-formed MIME glob the registry accepts? Exactly three shapes:
 * `*\/*`, `family\/*`, or `family/subtype` — anything else (a bare `image/`, a `*` family,
 * spaces, uppercase-only tricks) is refused so a typo cannot silently match nothing.
 * @param glob - The candidate glob.
 * @returns True when the glob is one of the three sanctioned shapes.
 */
export function isValidArtifactTypeGlob(glob: unknown): boolean {
  if (typeof glob !== 'string') return false;
  const g = glob.trim().toLowerCase();
  if (g === '*/*') return true;
  const parts = g.split('/');
  if (parts.length !== 2) return false;
  if (!MIME_PART_RE.test(parts[0])) return false;
  return parts[1] === '*' ? true : MIME_PART_RE.test(parts[1]);
}

/**
 * @description Does a concrete MIME type match a declared glob? Parameters on the type
 * (`; charset=…`) are ignored; comparison is case-insensitive.
 * @param glob - A validated declaration glob. @param mime - The artifact's MIME type.
 * @returns True on match.
 */
export function matchesArtifactType(glob: string, mime: string): boolean {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!m.includes('/')) return false;
  const g = glob.trim().toLowerCase();
  if (g === '*/*') return true;
  if (g.endsWith('/*')) return m.startsWith(g.slice(0, -1));
  return m === g;
}

/** @description Is this a root-relative `/api/...` path with no scheme/host/traversal tricks? */
function isSafeApiPath(p: unknown): boolean {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > MAX_PATH) return false;
  if (!p.startsWith('/api/')) return false;
  if (p.includes('://') || p.includes('\\') || p.includes('..') || p.includes('#')) return false;
  if (/\s/.test(p)) return false;
  return true;
}

function acceptError(i: number, msg: string): string {
  return `artifacts.accepts[${i}]: ${msg}`;
}

/**
 * @description Validate a manifest `artifacts:` block, fail-closed (ADR-139 D1): the loader
 * throws on the first defect so a malformed declaration fails the APP LOAD rather than
 * half-registering. Absent/undefined is legal (the app simply doesn't participate).
 * @param decl - The parsed `artifacts:` value from the manifest (any shape — unvalidated YAML).
 * @returns null when valid (or absent); otherwise a human-readable defect description.
 */
export function validateArtifactActionsDeclaration(decl: unknown): string | null {
  if (decl === undefined || decl === null) return null;
  if (typeof decl !== 'object' || Array.isArray(decl)) return 'artifacts: must be a map with accepts:/provides: lists';
  const d = decl as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    if (key !== 'accepts' && key !== 'provides') return `artifacts.${key}: unknown key (only accepts/provides exist)`;
  }
  const accepts = d.accepts;
  if (accepts !== undefined) {
    if (!Array.isArray(accepts)) return 'artifacts.accepts: must be a list';
    const seen = new Set<string>();
    for (let i = 0; i < accepts.length; i++) {
      const a = accepts[i] as Record<string, unknown>;
      if (!a || typeof a !== 'object' || Array.isArray(a)) return acceptError(i, 'must be a map');
      if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return acceptError(i, 'id must be a lowercase slug (a-z, 0-9, dashes, ≤41 chars)');
      if (seen.has(a.id)) return acceptError(i, `duplicate id "${a.id}"`);
      seen.add(a.id);
      if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > MAX_LABEL) return acceptError(i, `label must be a non-empty string ≤${MAX_LABEL} chars`);
      if (a.icon !== undefined && (typeof a.icon !== 'string' || a.icon.length > MAX_ICON)) return acceptError(i, `icon must be a short string ≤${MAX_ICON} chars`);
      if (!Array.isArray(a.types) || a.types.length === 0) return acceptError(i, 'types must be a non-empty list of MIME globs');
      for (const t of a.types) {
        if (!isValidArtifactTypeGlob(t)) return acceptError(i, `"${String(t)}" is not a valid MIME glob (use type/subtype, type/*, or */*)`);
      }
      if (a.mode !== 'open' && a.mode !== 'post') return acceptError(i, `mode must be one of: ${ARTIFACT_ACTION_MODES.join(', ')}`);
      if (a.mode === 'post' && !isSafeApiPath(a.endpoint)) return acceptError(i, 'post mode requires a root-relative /api/... endpoint (no scheme, no .., ≤200 chars)');
      if (a.mode === 'open' && a.endpoint !== undefined) return acceptError(i, 'open mode takes no endpoint — the cockpit navigates to the app surface (ADR-139 D4a)');
      if (a.overlay !== undefined) return acceptError(i, 'overlay is kernel-reserved (Amendment B) — apps declare open or post');
    }
  }
  const provides = d.provides;
  if (provides !== undefined) {
    if (!Array.isArray(provides)) return 'artifacts.provides: must be a list';
    for (let i = 0; i < provides.length; i++) {
      const p = provides[i] as Record<string, unknown>;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return `artifacts.provides[${i}]: must be a map`;
      if (!Array.isArray(p.types) || p.types.length === 0) return `artifacts.provides[${i}]: types must be a non-empty list of MIME globs`;
      for (const t of p.types) {
        if (!isValidArtifactTypeGlob(t)) return `artifacts.provides[${i}]: "${String(t)}" is not a valid MIME glob`;
      }
      if (p.list !== undefined && !isSafeApiPath(p.list)) return `artifacts.provides[${i}]: list must be a root-relative /api/... path`;
    }
  }
  return null;
}
