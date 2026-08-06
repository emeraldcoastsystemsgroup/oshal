/**
 * ConnectorSpec -> Markdown doc generator (ADR-065 Phase 3).
 *
 * Makes "with docs" free: every connector's auth, scopes, rate limits, resources,
 * action safety, pagination, and webhook events are derived straight from its
 * connector.yaml, so docs can't drift from the spec.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Document source-catalog category evidence separately from operation tags.
 * -----------------------------------------------------------------------------
 *
 * @module connectors/runtime/spec-to-doc
 */

import type { ConnectorSpec, SpecResource } from './spec';
import { describeConnectorAction } from './action-safety';

/** The {placeholder} inputs a resource binds, gathered from its path/query/body templates. */
function inputsOf(r: SpecResource): string[] {
  const found = new Set<string>();
  const scan = (s: string) => { for (const m of s.matchAll(/\{(\w+)\}/g)) found.add(m[1]); };
  scan(r.path);
  if (r.query) for (const v of Object.values(r.query)) scan(String(v));
  if (r.body !== undefined) scan(JSON.stringify(r.body));
  return [...found];
}

function authLine(spec: ConnectorSpec): string {
  const a = spec.auth;
  switch (a.type) {
    case 'oauth2': return `OAuth2 (bearer)${a.scopes?.length ? ` - scopes: ${a.scopes.join(', ')}` : ''}`;
    case 'basic': return 'HTTP Basic (username/password)';
    case 'apiKeyHeader': return `API key in header \`${a.header}\``;
    case 'apiKeyQuery': return `API key in query param \`${a.param}\``;
    default: return 'None';
  }
}

function tableCell(value: string | undefined): string {
  return (value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Render a connector spec to a Markdown doc page. */
export function specToMarkdown(spec: ConnectorSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.displayName || spec.provider} connector`, '');
  lines.push('> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.', '');
  lines.push('| | |', '| --- | --- |');
  lines.push(`| **Provider** | \`${spec.provider}\` |`);
  if (spec.version) lines.push(`| **Version** | ${spec.version} |`);
  lines.push(`| **Base URL** | \`${spec.baseUrl}\` |`);
  lines.push(`| **Auth** | ${authLine(spec)} |`);
  if (spec.metadata?.description) lines.push(`| **Description** | ${tableCell(spec.metadata.description)} |`);
  if (spec.metadata?.tags?.length) lines.push(`| **Tags** | ${spec.metadata.tags.map((tag) => `\`${tag}\``).join(', ')} |`);
  if (spec.metadata?.icon) lines.push(`| **Icon** | ${tableCell(spec.metadata.iconTitle || spec.metadata.icon)}${spec.metadata.iconVerified ? ' (verified)' : ''} |`);
  if (spec.metadata?.sourceCatalog) lines.push(`| **Source catalog** | ${tableCell(spec.metadata.sourceCatalog)}${spec.metadata.sourceUrl ? ` (${spec.metadata.sourceUrl})` : ''} |`);
  if (spec.metadata?.sourceCategories?.length) lines.push(`| **Source categories** | ${spec.metadata.sourceCategories.map((category) => `\`${category}\``).join(', ')} |`);
  if (spec.rateLimit) lines.push(`| **Rate limit** | burst ${spec.rateLimit.burst ?? 0}, ${spec.rateLimit.perSecond ?? 0}/s |`);
  if (spec.retry) lines.push(`| **Retry** | up to ${spec.retry.maxRetries ?? 3}, ${spec.retry.honorRetryAfter === false ? 'ignores' : 'honors'} Retry-After |`);
  if (spec.pagination) lines.push(`| **Pagination** | ${spec.pagination.strategy}${spec.pagination.param ? ` (\`${spec.pagination.param}\`)` : ''} |`);
  lines.push('');

  lines.push('## Resources', '');
  lines.push('| Resource | Tool | Action | Method | Path | Inputs |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of spec.resources) {
    const inputs = inputsOf(r);
    const action = describeConnectorAction(spec, r);
    lines.push(`| \`${r.name}\` | ${r.tool ? `\`${r.tool}\`` : '-'} | ${action.actionType}${action.requiresConfirmation ? ' (confirm)' : ''} | ${r.method} | \`${r.path}\` | ${inputs.length ? inputs.map((i) => `\`${i}\``).join(', ') : '-'} |`);
  }
  lines.push('');

  if (spec.webhooks?.length) {
    lines.push('## Webhook Events', '');
    lines.push('| Event | Verification |', '| --- | --- |');
    for (const w of spec.webhooks) lines.push(`| \`${w.event}\` | ${(w.verify as { type?: string })?.type || 'unknown'} |`);
    lines.push('');
  }

  lines.push('## Tools Exposed', '');
  const tools = spec.resources.filter((r) => r.tool).map((r) => r.tool);
  lines.push(tools.length ? tools.map((t) => `- \`${t}\``).join('\n') : '_(none)_');
  lines.push('');
  return lines.join('\n');
}
