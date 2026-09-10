/** Application-owned, versioned context contracts. No business execution or installation. */
import type { SwarmAppManifest } from '../types';

export interface AppIntegrationReceiver {
  id: string;
  contextType: string;
  version: number;
  surface: string;
  /** Explicit allow-list of text fields, each bounded to 2,000 characters at consumption. */
  fields: string[];
}

export interface AppIntegrationOffer {
  id: string;
  label: string;
  targetApp: string;
  targetAction: string;
  contextType: string;
  version: number;
}

export interface AppIntegrationDeclaration {
  accepts?: AppIntegrationReceiver[];
  offers?: AppIntegrationOffer[];
}

export interface ResolvedAppIntegration extends AppIntegrationOffer {
  sourceApp: string;
  state: 'available' | 'unavailable' | 'incompatible';
  surface?: string;
  fields?: string[];
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const FIELD = /^[a-z][a-zA-Z0-9]{0,63}$/;
const FORBIDDEN = new Set(['constructor', 'prototype', '__proto__']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reject malformed declarations at load, before they can become navigation authority. */
export function validateAppIntegrations(manifest: SwarmAppManifest, file: string): void {
  if (manifest.integrations === undefined) return;
  const fail = (detail: string): never => { throw new Error(`Manifest ${file}: integrations ${detail}`); };
  const declaration: unknown = manifest.integrations;
  if (!object(declaration)) fail('must be an object');
  const decl = declaration as Record<string, unknown>;
  if (Object.keys(decl).some(k => !['accepts', 'offers'].includes(k))) fail('has unknown fields');
  if (manifest.kind === 'group') fail('belong to executable member apps, not groups');
  for (const kind of ['accepts', 'offers'] as const) {
    const rows = decl[kind];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > 24) fail(`${kind} must be an array of at most 24 entries`);
    const seen = new Set<string>();
    for (const row of rows as unknown[]) {
      if (!object(row)) fail(`${kind} entries must be objects`);
      const r = row as Record<string, unknown>;
      const allowed = kind === 'accepts' ? ['id', 'contextType', 'version', 'surface', 'fields']
        : ['id', 'contextType', 'version', 'label', 'targetApp', 'targetAction'];
      if (Object.keys(r).some(k => !allowed.includes(k))) fail(`${kind} has unknown fields`);
      for (const k of ['id', 'contextType', ...(kind === 'offers' ? ['targetApp', 'targetAction'] : [])]) {
        if (typeof r[k] !== 'string' || !ID.test(r[k] as string)) fail(`${kind}.${k} must be a bounded slug`);
      }
      if (seen.has(r.id as string)) fail(`${kind} repeats an id`);
      seen.add(r.id as string);
      if (!Number.isSafeInteger(r.version) || (r.version as number) < 1 || (r.version as number) > 1000) fail('version must be an integer from 1 to 1000');
      if (kind === 'accepts') {
        const surface = manifest.ui?.static?.find(s => s.toolName === r.surface);
        // Context uses same-origin browser storage; third-party frames cannot receive it.
        if (!surface || !/^\/(?!\/)/.test(surface.iframeUrl) || /[\\\r\n]/.test(surface.iframeUrl)) fail('receiver must name an owned same-origin static surface');
        if (!Array.isArray(r.fields) || !r.fields.length || r.fields.length > 12
          || r.fields.some(f => typeof f !== 'string' || !FIELD.test(f) || FORBIDDEN.has(f))
          || new Set(r.fields).size !== r.fields.length) fail('receiver fields must be 1-12 unique text field names');
      } else if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 60) fail('offer label must be 1-60 characters');
    }
  }
}

/** Resolve against exactly the active manifests visible to this caller, never the store catalog. */
export function resolveAppIntegrations(source: SwarmAppManifest, active: readonly SwarmAppManifest[]): ResolvedAppIntegration[] {
  return (source.integrations?.offers ?? []).map(offer => {
    const target = active.find(m => m.name === offer.targetApp && m.status !== 'inactive');
    const receiver = target?.integrations?.accepts?.find(a => a.id === offer.targetAction);
    const match = receiver && receiver.version === offer.version && receiver.contextType === offer.contextType;
    return { ...offer, sourceApp: source.name,
      state: !target ? 'unavailable' : !match ? 'incompatible' : 'available',
      ...(match ? { surface: receiver.surface, fields: [...receiver.fields] } : {}),
    };
  });
}
