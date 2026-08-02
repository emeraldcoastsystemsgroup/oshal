/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The consolidation identity: value normalization, the sentinel-bearing identity source string, and the deployment-namespaced dedup key. Pure and dependency-free so the intake, the consolidation upsert and the admin read models all derive the same key from the same event without a database round trip.
 */

import { createHash } from 'node:crypto';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'alert-dedup-key' });

/**
 * @description The subset of a normalized alert the identity renderer reads. Declared
 * structurally rather than taking the full event row so the key can be computed at the door —
 * before an event row exists — and recomputed later from a stored row, with one code path.
 */
export interface IdentitySourceEvent {
  alertname?: string | null;
  target?: string | null;
  namespace?: string | null;
  container?: string | null;
  instance?: string | null;
  job?: string | null;
  severity?: string | null;
  labels?: Record<string, string> | null;
}

/**
 * @description The identity fields a rule uses when it declares none. Target plus alertname is
 * the narrowest pair that still separates "the same thing is broken again" from "a different
 * thing broke": dropping target merges every host under one alert name into a single incident,
 * dropping alertname merges every distinct failure on one host.
 */
export const DEFAULT_IDENTITY_FIELDS: readonly string[] = Object.freeze(['target', 'alertname']);

/**
 * @description Deployment namespace used when the environment names none. The key is prefixed
 * with it so a database shared by several environments cannot cross-suppress: staging firing
 * `NodeDown` on `web-1` must not silence production's identical alert.
 */
export const DEFAULT_DEPLOYMENT_ID = 'oshal-local';

/** @description Environment variable naming this deployment's suppression namespace. */
export const DEPLOYMENT_ID_ENV = 'OSHAL_DEPLOYMENT_ID';

/**
 * @description ASCII unit separator joining the resolved identity values. A control character
 * cannot appear in a normalized value, so no combination of field contents can reproduce the
 * boundary and two different field splits can never render the same string.
 */
const FIELD_SEPARATOR = '\u001F';

/** @description Dotted accessor prefix selecting a raw label rather than a promoted column. */
const LABEL_PREFIX = 'labels.';

/** @description Hex characters of the digest retained in the key. */
const DIGEST_LENGTH = 32;

/**
 * @description Readers for the promoted identity columns. A lookup table rather than a chain of
 * conditionals so the set of addressable fields is one visible list.
 */
const PROMOTED_READERS: Readonly<Record<string, (event: IdentitySourceEvent) => string | null | undefined>> =
  Object.freeze({
    target: (event) => event.target,
    alertname: (event) => event.alertname,
    namespace: (event) => event.namespace,
    container: (event) => event.container,
    instance: (event) => event.instance,
    job: (event) => event.job,
    severity: (event) => event.severity,
  });

/**
 * @description Canonicalizes one identity value: NFKC folds compatibility forms so a full-width
 * or ligature-bearing host name cannot mint a second identity for the same machine, then
 * lowercasing, whitespace collapse and trimming make wire-level padding and inconsistent spacing
 * invisible. Control characters collapse the same way as whitespace, which is what keeps a label
 * value from forging a field boundary in the rendered identity source.
 * Ports are deliberately preserved — a port is meaningful on every field except the target.
 * @param raw - Raw label or column value, possibly empty.
 * @returns The canonical value, or '' when nothing survives normalization.
 */
export function normalizeIdentityValue(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    return '';
  }
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
}

/**
 * @description Canonicalizes a target: identity normalization plus removal of a trailing
 * `:<digits>`. Scrape targets arrive as `host:port`, so the same machine observed by two
 * exporters would otherwise open two incidents. The port is only stripped when a non-colon
 * character precedes it, which keeps a bare IPv6 literal such as `::1` intact while still
 * reducing `[::1]:9090`.
 * @param raw - Raw target value, possibly empty.
 * @returns The canonical target, or '' when nothing survives normalization.
 */
export function normalizeTargetValue(raw: string): string {
  return normalizeIdentityValue(raw).replace(/^(.*[^:]):\d+$/, '$1');
}

/**
 * @description Reduces a configured field name to its canonical addressable form: promoted
 * column names fold to lowercase, while the label name after a `labels.` prefix keeps its case
 * because label keys are case-sensitive on the wire.
 * @param raw - Field name as configured on a claim rule.
 * @returns The canonical field spec, '' when the entry is blank.
 */
function canonicalizeFieldSpec(raw: string): string {
  const spec = typeof raw === 'string' ? raw.trim() : '';
  const dot = spec.indexOf('.');
  if (dot < 0) {
    return spec.toLowerCase();
  }
  const head = spec.slice(0, dot).toLowerCase();
  return head === 'labels' ? `${LABEL_PREFIX}${spec.slice(dot + 1)}` : spec.toLowerCase();
}

/**
 * @description Reads one raw label by exact key. Matching is exact rather than case-insensitive
 * so that an event carrying two keys differing only in case resolves the same way regardless of
 * the order they were serialized in — a scan would make the key depend on insertion order.
 * @param event - The event to read.
 * @param name - Label key.
 * @returns The label value, or '' when absent or not a string.
 */
function readLabel(event: IdentitySourceEvent, name: string): string {
  const labels = event.labels;
  if (!labels || typeof labels !== 'object') {
    return '';
  }
  const value = labels[name];
  return typeof value === 'string' ? value : '';
}

/**
 * @description Resolves one canonical field spec to its raw value. A promoted column wins, and
 * an empty promoted column falls through to the like-named label so an event normalized without
 * column promotion still resolves the same identity.
 * @param event - The event to read.
 * @param canonical - Canonical field spec from `canonicalizeFieldSpec`.
 * @returns The raw value, or '' when the field is absent.
 */
function resolveRawFieldValue(event: IdentitySourceEvent, canonical: string): string {
  if (canonical.startsWith(LABEL_PREFIX)) {
    return readLabel(event, canonical.slice(LABEL_PREFIX.length));
  }
  const reader = PROMOTED_READERS[canonical];
  if (reader) {
    const promoted = reader(event);
    if (typeof promoted === 'string' && promoted.trim().length > 0) {
      return promoted;
    }
  }
  return readLabel(event, canonical);
}

/**
 * @description Renders one field into its identity token. An absent field becomes the literal
 * `<fieldname>` sentinel instead of an empty string: with empty strings, an alert missing its
 * target and an alert missing its alertname both render to the same separator-only string and
 * two unrelated failures consolidate into one incident. The sentinel names which field is
 * missing, so the two stay distinct.
 * @param event - The event to read.
 * @param canonical - Canonical field spec.
 * @returns The normalized value, or the `<fieldname>` sentinel.
 */
function renderFieldToken(event: IdentitySourceEvent, canonical: string): string {
  const raw = resolveRawFieldValue(event, canonical);
  const normalized = canonical === 'target' ? normalizeTargetValue(raw) : normalizeIdentityValue(raw);
  return normalized.length > 0 ? normalized : `<${canonical}>`;
}

/**
 * @description Canonicalizes the configured field list, dropping blank entries and substituting
 * the default pair when nothing usable remains. An empty list would render every event to the
 * same identity string and collapse the whole estate into one incident, so it is treated as
 * unconfigured rather than as "group everything".
 * @param fields - Field names as configured.
 * @returns A non-empty list of canonical field specs.
 */
function resolveFieldSpecs(fields: readonly string[]): string[] {
  const specs = (Array.isArray(fields) ? fields : [])
    .map((field) => canonicalizeFieldSpec(field))
    .filter((field) => field.length > 0);
  if (specs.length > 0) {
    return specs;
  }
  logger.warn(
    { defaultFields: DEFAULT_IDENTITY_FIELDS },
    'identity field list is empty; falling back to the default identity fields',
  );
  return [...DEFAULT_IDENTITY_FIELDS];
}

/**
 * @description Renders the human-readable identity string the dedup key hashes, stored alongside
 * the key so an operator can see exactly which values produced a grouping without recomputing it.
 * @param event - The event whose identity is being resolved.
 * @param fields - Identity field names from the matched claim rule.
 * @returns Unit-separator-joined normalized values, each absent field replaced by its sentinel.
 */
export function renderIdentitySource(event: IdentitySourceEvent, fields: readonly string[]): string {
  return resolveFieldSpecs(fields)
    .map((canonical) => renderFieldToken(event, canonical))
    .join(FIELD_SEPARATOR);
}

/**
 * @description Reduces a deployment name to characters that cannot be confused with the key's
 * own structure. The key is `<deployment>:<digest>`, so a colon inside the name would make the
 * split ambiguous for anything reading the namespace back out.
 * @param raw - Deployment name.
 * @returns The sanitized name, or the default when nothing usable remains.
 */
function canonicalDeploymentId(raw: string): string {
  const cleaned = normalizeIdentityValue(raw)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : DEFAULT_DEPLOYMENT_ID;
}

/**
 * @description Resolves the suppression namespace for this process. Read per call rather than
 * captured at module load so a container restarted with a corrected value takes effect without
 * a rebuild.
 * @returns The sanitized deployment id, defaulting to `DEFAULT_DEPLOYMENT_ID`.
 */
export function resolveDeploymentId(): string {
  return canonicalDeploymentId(process.env[DEPLOYMENT_ID_ENV] ?? '');
}

/**
 * @description Renders the durable consolidation key. The digest is truncated because the key is
 * an index term rather than a security token — 32 hex characters is 128 bits, far past the point
 * where a collision is plausible at alert volumes, and it keeps the b-tree entry short.
 * @param event - The event whose identity is being keyed.
 * @param fields - Identity field names from the matched claim rule.
 * @param deploymentId - Suppression namespace, normally from `resolveDeploymentId()`.
 * @returns `<deployment>:<32 hex chars>`.
 */
export function renderDedupKey(
  event: IdentitySourceEvent,
  fields: readonly string[],
  deploymentId: string,
): string {
  const identitySource = renderIdentitySource(event, fields);
  const digest = createHash('sha256').update(identitySource, 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
  return `${canonicalDeploymentId(deploymentId)}:${digest}`;
}

/**
 * @description Whether an event carries enough identity to be consolidated at all. An event with
 * neither an alert name nor a target names nothing: every such event would land on one key and
 * one incident would absorb unrelated failures. Intake counts these and drops them rather than
 * inventing an identity for them.
 * @param event - The event to inspect.
 * @returns True when at least one of alertname / target resolves to a non-empty value.
 */
export function hasUsableIdentity(event: IdentitySourceEvent): boolean {
  const alertname = normalizeIdentityValue(resolveRawFieldValue(event, 'alertname'));
  const target = normalizeTargetValue(resolveRawFieldValue(event, 'target'));
  return alertname.length > 0 || target.length > 0;
}
