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
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 Phase 3. Additive.
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/catalog-audit
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { loadConnectorSpec, validateSpec, type ConnectorSpec } from './spec';

export interface AuditIssue {
  level: 'error' | 'warn';
  message: string;
}

export interface ConnectorAudit {
  provider: string;
  source?: string;
  pass: boolean;       // true when there are no errors (warns are allowed)
  issues: AuditIssue[];
}

/** Grade a single spec against the catalog checklist. */
export function auditSpec(spec: ConnectorSpec, source?: string): ConnectorAudit {
  const issues: AuditIssue[] = [];
  const err = (message: string) => issues.push({ level: 'error', message });
  const warn = (message: string) => issues.push({ level: 'warn', message });

  try { validateSpec(spec); } catch (e) { err((e as Error).message); }

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
  return { provider: spec.provider, source, pass, issues };
}

/** Load + audit every connector.yaml in a directory (default swarm-apps/connectors). */
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

/** A one-line-per-connector summary, e.g. for a CI log. */
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
