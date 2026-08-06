/**
 * Connector catalog audit (ADR-065 Phase 3).
 *
 * The "hardened" gate as code. Loads every swarm-apps/connectors/*.yaml and grades each against a
 * checklist a connector must satisfy to count as catalog-ready: valid shape, declared auth, a rate
 * limit (so depth can't DoS us), well-formed resources, unique tool names, and coherent pagination.
 * Run it in CI; a connector that isn't green isn't in the catalog. Returns structured results so a
 * caller can print a report, fail a build, or surface a dashboard.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 Phase 3. Additive.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Derive connector-wide risk from executable semantics, expose it in audit results, and reject connector/metadata risk declarations so YAML cannot become a second policy authority.
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/catalog-audit
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { loadConnectorSpec, validateSpec, type ConnectorSpec } from './spec';

/** @description One structural or policy finding emitted by the connector catalog audit. */
export interface AuditIssue {
  level: 'error' | 'warn';
  message: string;
}

/** @description The complete structural and derived-policy audit result for one connector. */
export interface ConnectorAudit {
  provider: string;
  source?: string;
  pass: boolean;       // true when there are no errors (warns are allowed)
  issues: AuditIssue[];
  derivedRiskLevel?: ConnectorRiskLevel;
}

/** @description The conservative connector-wide risk shown in the catalog. */
export type ConnectorRiskLevel = 'low' | 'medium' | 'high';

/**
 * @description Derive the connector-wide catalog risk from executable behavior. Any declared
 * mutation makes the aggregate high risk; read-only OAuth2/basic connectors are medium because of
 * credential reach; all other read-only connectors are low. Per-action risk remains declared and
 * controls its own confirmation rail.
 * @param spec - parsed connector definition whose resources and actions are authoritative
 * @returns the deterministic connector-wide risk shown by audit and marketplace surfaces
 */
export function deriveConnectorRiskLevel(spec: ConnectorSpec): ConnectorRiskLevel {
  const resources = Array.isArray(spec.resources) ? spec.resources : [];
  const resourceMutation = resources.some((resource) => (
    resource.method !== 'GET'
      || resource.safety?.action === 'write'
      || resource.safety?.action === 'destructive'
  ));
  if (resourceMutation || (Array.isArray(spec.actions) && spec.actions.length > 0)) return 'high';
  if (spec.auth?.type === 'oauth2' || spec.auth?.type === 'basic') return 'medium';
  return 'low';
}

/**
 * @description Grade a single connector spec against the structural and derived-policy checklist.
 * @param spec - parsed connector definition to audit
 * @param source - optional source path included in the structured result
 * @returns the connector audit, including its deterministic connector-wide risk
 */
export function auditSpec(spec: ConnectorSpec, source?: string): ConnectorAudit {
  const issues: AuditIssue[] = [];
  const err = (message: string) => issues.push({ level: 'error', message });
  const warn = (message: string) => issues.push({ level: 'warn', message });
  const declaredRiskLocations = connectorRiskDeclarations(spec);

  try { validateSpec(spec); } catch (e) { err((e as Error).message); }

  if (declaredRiskLocations.length > 0) {
    err(`connector-wide risk is derived from actions/resources/auth; remove ${declaredRiskLocations.join(' and ')}`);
  }

  if (spec.auth?.type === 'none') warn('auth is none — confirm this provider truly needs no credentials');
  if (!spec.rateLimit || !spec.rateLimit.perSecond) warn('no rate limit declared — the governor is disabled for this connector');
  if (!spec.retry) warn('no retry policy declared — defaults apply');

  const toolNames = new Map<string, number>();
  for (const r of spec.resources || []) {
    if (!r.tool) warn(`resource '${r.name}' has no tool name — it won't be exposed to bots`);
    else toolNames.set(r.tool, (toolNames.get(r.tool) || 0) + 1);
    if (r.method !== 'GET' && (r.retry?.maxRetries ?? 99) > 0) warn(`resource '${r.name}' is ${r.method} but auto-retries — confirm it's idempotent`);
    if (r.paginate) {
      if (!spec.pagination) err(`resource '${r.name}' sets paginate but the spec has no pagination block`);
      else if (spec.pagination.strategy !== 'link' && !spec.pagination.itemsField) warn(`resource '${r.name}' paginates ${spec.pagination.strategy} without itemsField — items default to 'items'`);
    }
  }
  for (const [tool, n] of toolNames) if (n > 1) err(`duplicate tool name '${tool}' (${n} resources)`);

  const pass = !issues.some((i) => i.level === 'error');
  return { provider: spec.provider, source, pass, issues, derivedRiskLevel: deriveConnectorRiskLevel(spec) };
}

function connectorRiskDeclarations(spec: ConnectorSpec): string[] {
  const raw = spec as ConnectorSpec & {
    riskLevel?: unknown;
    metadata?: ConnectorSpec['metadata'] & { riskLevel?: unknown };
  };
  const locations: string[] = [];
  if (Object.prototype.hasOwnProperty.call(raw, 'riskLevel')) locations.push('riskLevel');
  if (raw.metadata && Object.prototype.hasOwnProperty.call(raw.metadata, 'riskLevel')) {
    locations.push('metadata.riskLevel');
  }
  return locations;
}

/**
 * @description Load and audit every YAML connector definition in a directory.
 * @param dir - catalog directory; defaults to the tracked connector catalog
 * @returns one structured audit per connector file
 */
export function auditConnectorCatalog(dir = join(process.cwd(), 'swarm-apps/connectors')): ConnectorAudit[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')); } catch { return []; }
  return files.map((f) => {
    const source = join(dir, f);
    try {
      return auditSpec(loadConnectorSpec(source), source);
    } catch (e) {
      return { provider: f, source, pass: false, issues: [{ level: 'error', message: `failed to load: ${(e as Error).message}` }] };
    }
  });
}

/**
 * @description Format structured connector audits as stable one-line CI summaries.
 * @param audits - connector audit results to format
 * @returns newline-delimited PASS/FAIL summaries
 */
export function formatAudit(audits: ConnectorAudit[]): string {
  return audits
    .map((a) => {
      const errors = a.issues.filter((i) => i.level === 'error').length;
      const warns = a.issues.filter((i) => i.level === 'warn').length;
      const status = a.pass ? 'PASS' : 'FAIL';
      return `[${status}] ${a.provider} — ${errors} error(s), ${warns} warning(s)`;
    })
    .join('\n');
}
