import type { ConnectorSpec, SpecResource } from './spec';

export type ConnectorActionType = 'read' | 'write' | 'destructive';

export interface ConnectorActionProfile {
  provider: string;
  resource: string;
  tool?: string;
  method: SpecResource['method'];
  path: string;
  actionType: ConnectorActionType;
  requiresConfirmation: boolean;
  supportsDryRun: boolean;
  idempotent: boolean;
  inputs: string[];
}

const READ_LIKE_RESOURCE = /(^|[-_])(get|list|search|query|lookup|find|read|fetch|metadata|whoami|me|history|stats|recommendations?|trending|watch|events?|messages?|records?|contacts?|projects?|issues?|incidents?|changes?|bookmarks?|entities?|metrics?|problems?|files?|folders?|calendars?|meetings?|channels?|guilds?|repos?|repositories?|tasks?|deals?)([-_]|$)/i;
const DESTRUCTIVE_RESOURCE = /(^|[-_])(delete|remove|destroy|revoke|cancel|purge|drop|disable)([-_]|$)/i;

export function extractSpecResourcePlaceholders(resource: SpecResource): string[] {
  const found = new Set<string>();
  collectPlaceholders(resource.path, found);
  collectPlaceholders(resource.query, found);
  collectPlaceholders(resource.body, found);
  collectPlaceholders(resource.headers, found);
  return Array.from(found).sort();
}

export function inferConnectorActionType(resource: SpecResource): ConnectorActionType {
  if (resource.safety?.action) return resource.safety.action;
  const label = `${resource.name} ${resource.tool ?? ''}`;
  if (resource.method === 'GET') return 'read';
  if (resource.method === 'DELETE' || DESTRUCTIVE_RESOURCE.test(label)) return 'destructive';
  if (READ_LIKE_RESOURCE.test(label)) return 'read';
  return 'write';
}

export function requiresConnectorConfirmation(resource: SpecResource): boolean {
  const actionType = inferConnectorActionType(resource);
  if (resource.safety?.requiresConfirmation !== undefined) {
    return resource.safety.requiresConfirmation;
  }
  return actionType !== 'read';
}

export function supportsConnectorDryRun(resource: SpecResource): boolean {
  if (resource.safety?.supportsDryRun !== undefined) {
    return resource.safety.supportsDryRun;
  }
  return inferConnectorActionType(resource) !== 'read';
}

export function isConnectorActionDryRun(inputs: Record<string, unknown>): boolean {
  return inputs.dryRun === true
    || inputs.dry_run === true
    || inputs.previewOnly === true
    || inputs.__dryRun === true;
}

export function describeConnectorAction(spec: ConnectorSpec, resource: SpecResource): ConnectorActionProfile {
  const actionType = inferConnectorActionType(resource);
  return {
    provider: spec.provider,
    resource: resource.name,
    tool: resource.tool,
    method: resource.method,
    path: resource.path,
    actionType,
    requiresConfirmation: requiresConnectorConfirmation(resource),
    supportsDryRun: supportsConnectorDryRun(resource),
    idempotent: resource.safety?.idempotent ?? (resource.method === 'GET' || actionType === 'read'),
    inputs: extractSpecResourcePlaceholders(resource),
  };
}

export function actionProfilesForSpec(spec: ConnectorSpec): ConnectorActionProfile[] {
  return spec.resources.map((resource) => describeConnectorAction(spec, resource));
}

export function buildConnectorActionPreview(
  spec: ConnectorSpec,
  resource: SpecResource,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const profile = describeConnectorAction(spec, resource);
  const missingInputs = profile.inputs.filter((name) => inputs[name] === undefined || inputs[name] === null || inputs[name] === '');
  return {
    dryRun: true,
    provider: spec.provider,
    resource: resource.name,
    tool: resource.tool,
    actionType: profile.actionType,
    method: resource.method,
    pathTemplate: resource.path,
    pathPreview: renderPathPreview(resource.path, inputs),
    queryPreview: resource.query ? renderPreviewValue(resource.query, inputs) : undefined,
    bodyPreview: resource.body !== undefined ? renderPreviewValue(resource.body, inputs) : undefined,
    missingInputs,
    requiresConfirmation: profile.requiresConfirmation,
    supportsDryRun: profile.supportsDryRun,
    message: 'Connector dry run only. No provider request was sent.',
  };
}

function renderPathPreview(tmpl: string, inputs: Record<string, unknown>): string {
  return tmpl.replace(/\{(\w+)\}/g, (_, key) => {
    const value = inputs[key];
    return value === undefined || value === null ? `{${key}}` : encodeURIComponent(String(value));
  });
}

function renderPreviewValue(value: unknown, inputs: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\{(\w+)\}$/);
    if (whole) return inputs[whole[1]] ?? `{${whole[1]}}`;
    return value.replace(/\{(\w+)\}/g, (_, key) => {
      const bound = inputs[key];
      return bound === undefined || bound === null ? `{${key}}` : String(bound);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderPreviewValue(item, inputs));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderPreviewValue(val, inputs);
    }
    return out;
  }
  return value;
}

function collectPlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{(\w+)\}/g)) {
      found.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPlaceholders(item, found));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectPlaceholders(item, found));
  }
}
