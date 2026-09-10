/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145: the Home plan. Pure builders for the cross-app landing view — one card per active group (aggregating its members' probes) plus one per active app that no shown group already covers, and the D2 coercion that bounds/normalises whatever a package's summary probe answers. Lives here rather than in swarm-app-service.ts, which is already far past its 800-line budget.
 *
 * @module app-home-plan
 * Home customization | Codex | Carry selectable metric pointers and allowed same-app destinations to Home.
 */

import type {
  SwarmAppManifest,
  SwarmAppSummaryDeclaration,
  SwarmAppSummaryItem,
  SwarmAppSummaryTile,
  SwarmAppSummaryTone,
} from '../types';
import { isGroupManifest } from './swarm-app-group';
import { resolveAppIntegrations, type ResolvedAppIntegration } from './app-integrations';

/** ADR-145 D2 bounds. Four tiles and five items force the author to decide what matters. */
export const MAX_SUMMARY_TILES = 4;
export const MAX_SUMMARY_ITEMS = 5;
const MAX_LABEL_CHARS = 24;
const MAX_VALUE_CHARS = 16;
const MAX_TEXT_CHARS = 120;

const TONES: ReadonlySet<string> = new Set<SwarmAppSummaryTone>(['neutral', 'good', 'warn']);

/** One readiness probe the Home card renders as a todo, with the label a group gave it. */
export interface HomePlanTodo {
  app: string;
  label: string;
  path: string;
  readyPointer: string;
  detailPointer?: string;
  /** Surface to open for this step, when a group's setup[] named one. */
  fix?: string;
}

/** One summary probe the Home card asks in the viewer's own session. */
export interface HomePlanSummaryProbe {
  integrations?: ResolvedAppIntegration[];
  metricsPointer?: string;
  surfaces?: string[];
  app: string;
  path: string;
  tilesPointer?: string;
  itemsPointer?: string;
}

/** One card on the Home view: an app, or a group standing for its members. */
export interface HomePlanEntry {
  integrationSources?: Array<{ app: string; surfaces: Array<{ name: string; url: string }>; offers: ResolvedAppIntegration[] }>;
  icon?: string;
  /** Manifest name of the app or group this card represents. */
  name: string;
  displayName: string;
  kind: 'app' | 'group';
  description?: string;
  suite?: string;
  /** Member app names — the group's members, or [name] for a plain app. */
  members: string[];
  /** Ribbon surface the card's title opens. */
  firstSurface?: string;
  firstSurfaceUrl?: string;
  summary: HomePlanSummaryProbe[];
  todos: HomePlanTodo[];
}

/**
 * @description Humanise a readiness slug for a card that has no group setup[] label to borrow
 * ("profile-picture" -> "Profile picture"). Only used when nothing better exists.
 * @param slug - The readiness declaration's name.
 * @returns A sentence-cased label.
 */
function humanise(slug: string): string {
  const spaced = slug.replace(/[-_]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : slug;
}

/**
 * @description Collect an app's own summary probe and readiness todos, labelled by a group's
 * `setup[]` where one references them (a group author writes the human sentence; the member
 * only declares the slug).
 * @param manifest - The member app's manifest.
 * @param labels - Map of `<app>/<readinessName>` to the group's step label + fix surface.
 * @returns The probes this app contributes to a card.
 */
function probesFor(
  manifest: SwarmAppManifest,
  labels: ReadonlyMap<string, { label: string; fix?: string }>,
  active: readonly SwarmAppManifest[],
): { summary: HomePlanSummaryProbe[]; todos: HomePlanTodo[] } {
  const summary: HomePlanSummaryProbe[] = [];
  if (manifest.summary) {
    const decl = manifest.summary as SwarmAppSummaryDeclaration;
    summary.push({
      app: manifest.name,
      integrations: resolveAppIntegrations(manifest, active),
      path: decl.path,
      metricsPointer: decl.metricsPointer,
      surfaces: (manifest.ui?.static ?? []).map(s => s.toolName),
      tilesPointer: decl.tilesPointer,
      itemsPointer: decl.itemsPointer,
    });
  }
  const todos: HomePlanTodo[] = (manifest.readiness ?? []).map((probe) => {
    const named = labels.get(`${manifest.name}/${probe.name}`);
    return {
      app: manifest.name,
      label: named?.label ?? humanise(probe.name),
      path: probe.path,
      readyPointer: probe.readyPointer,
      detailPointer: probe.detailPointer,
      fix: named?.fix,
    };
  });
  return { summary, todos };
}

/**
 * @description Build the Home view's plan from the ACTIVE manifests (ADR-145 D9). One card per
 * active group — aggregating every member's summary and readiness probes, so a grouped app is not
 * also listed loose — plus one card per active app that no shown group already covers. Groups are
 * emitted first because a group is the front door its members sit behind.
 *
 * Pure: it reads manifests and returns a plan. It performs no I/O, asks no probe, and reads no
 * app table — the page asks every probe itself, in the viewer's own session (ADR-145 D6).
 *
 * @param manifests - Every ACTIVE manifest (apps and groups).
 * @returns Cards in render order.
 */
export function buildHomePlan(manifests: readonly SwarmAppManifest[]): HomePlanEntry[] {
  const integrationSource = (m: SwarmAppManifest) => ({ app: m.name,
    surfaces: (m.ui?.static ?? []).map(s => ({ name: s.toolName, url: s.iframeUrl })),
    offers: resolveAppIntegrations(m, manifests) });
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const groups = manifests.filter((m) => isGroupManifest(m));
  const covered = new Set<string>();

  const entries: HomePlanEntry[] = [];

  for (const group of groups) {
    // A group's setup[] carries the human label + fix surface for a member's readiness slug.
    const labels = new Map<string, { label: string; fix?: string }>();
    for (const step of group.setup ?? []) {
      labels.set(`${step.app}/${step.readiness}`, { label: step.label, fix: step.fix });
    }
    const members = (group.dependencies?.apps ?? []).filter((name) => byName.has(name));
    const summary: HomePlanSummaryProbe[] = [];
    const todos: HomePlanTodo[] = [];
    for (const name of members) {
      covered.add(name);
      const part = probesFor(byName.get(name) as SwarmAppManifest, labels, manifests);
      summary.push(...part.summary);
      todos.push(...part.todos);
    }
    entries.push({
      name: group.name,
      displayName: group.displayName,
      icon: group.ui?.static?.[0]?.icon,
      kind: 'group',
      description: group.description,
      suite: group.suite,
      members,
      integrationSources: members.map(name => integrationSource(byName.get(name)!)),
      firstSurface: `${group.name}-setup`,
      firstSurfaceUrl: `/api/swarm/apps/${encodeURIComponent(group.name)}/setup-dashboard`,
      summary,
      todos,
    });
  }

  for (const manifest of manifests) {
    if (isGroupManifest(manifest) || covered.has(manifest.name)) continue;
    const part = probesFor(manifest, new Map(), manifests);
    entries.push({
      name: manifest.name,
      displayName: manifest.displayName,
      icon: manifest.ui?.static?.[0]?.icon,
      kind: 'app',
      description: manifest.description,
      suite: manifest.suite,
      members: [manifest.name],
      integrationSources: [integrationSource(manifest)],
      firstSurface: manifest.ui?.static?.[0]?.toolName,
      firstSurfaceUrl: manifest.ui?.static?.[0]?.iframeUrl,
      summary: part.summary,
      todos: part.todos,
    });
  }

  return entries;
}

/**
 * @description Resolve an RFC 6901 pointer, reporting whether the location exists at all — the
 * same contract the group setup dashboard uses, so a missing location is distinguishable from a
 * present `null` and can render "can't check" rather than a fact.
 * @param value - The document to resolve against.
 * @param pointer - An RFC 6901 pointer.
 * @returns Whether the location was found, and its value when it was.
 */
export function atPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value };
  if (!pointer.startsWith('/')) return { found: false };
  let cursor: any = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object') return { found: false };
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(key)) return { found: false };
      const idx = Number(key);
      if (idx >= cursor.length) return { found: false };
      cursor = cursor[idx];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return { found: false };
    cursor = cursor[key];
  }
  return { found: true, value: cursor };
}

/** Trim to a bound without inventing an ellipsis the app did not write. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * @description Normalise a tone fail-safe. An unrecognised or absent tone becomes 'neutral';
 * a wrong tone must never ESCALATE, or one buggy package paints the whole Home view red.
 * @param value - Whatever the probe put in the tone field.
 * @returns A tone from the closed enum.
 */
export function coerceTone(value: unknown): SwarmAppSummaryTone {
  return typeof value === 'string' && TONES.has(value) ? (value as SwarmAppSummaryTone) : 'neutral';
}

/**
 * @description Coerce one package's status response into the bounded shape the card renders
 * (ADR-145 D2). Over-cap TRUNCATES rather than rejecting — a chatty app degrades to its first
 * four tiles instead of breaking the page for every other app — and a pointer that is missing or
 * resolves to the wrong type yields `checked: false`, which the card shows as "can't check" and
 * never as a fact or a zero.
 *
 * @param body - The parsed JSON the probe answered.
 * @param decl - The pointers this app declared.
 * @returns Bounded tiles and items, plus whether each declared pointer actually resolved.
 */
export function coerceSummaryPayload(
  body: unknown,
  decl: Pick<SwarmAppSummaryDeclaration, 'tilesPointer' | 'itemsPointer' | 'metricsPointer'>,
): { tiles: SwarmAppSummaryTile[]; items: SwarmAppSummaryItem[]; checked: boolean } {
  let checked = false;
  const tiles: SwarmAppSummaryTile[] = [];
  const items: SwarmAppSummaryItem[] = [];

  const metricPointer = decl.metricsPointer || decl.tilesPointer;
  if (metricPointer) {
    const found = atPointer(body, metricPointer);
    if (found.found && Array.isArray(found.value)) {
      checked = true;
      const bounded = found.value.slice(0, decl.metricsPointer ? 24 : MAX_SUMMARY_TILES);
      for (const raw of bounded) {
        if (!raw || typeof raw !== 'object') continue;
        const t = raw as Record<string, unknown>;
        if (typeof t.label !== 'string' || typeof t.value !== 'string') continue;
        if (decl.metricsPointer && (bounded.filter(other => other?.id === t.id).length !== 1 || typeof t.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(t.id))) continue;
        tiles.push({
          ...(decl.metricsPointer ? { id: t.id as string, defaultVisible: t.defaultVisible !== false } : {}),
          label: clamp(t.label, MAX_LABEL_CHARS),
          value: clamp(t.value, MAX_VALUE_CHARS),
          tone: coerceTone(t.tone),
        });
      }
    }
  }

  if (decl.itemsPointer) {
    const found = atPointer(body, decl.itemsPointer);
    if (found.found && Array.isArray(found.value)) {
      checked = true;
      for (const raw of found.value.slice(0, MAX_SUMMARY_ITEMS)) {
        if (!raw || typeof raw !== 'object') continue;
        const it = raw as Record<string, unknown>;
        if (typeof it.text !== 'string') continue;
        items.push({
          ...(typeof it.metricId === 'string' ? { metricId: it.metricId } : {}),
          text: clamp(it.text, MAX_TEXT_CHARS),
          ...(typeof it.detail === 'string' ? { detail: clamp(it.detail, 400) } : {}),
          ...(it.highlight === true ? { highlight: true } : {}),
          tone: coerceTone(it.tone),
          ...(typeof it.fix === 'string' ? { fix: it.fix } : {}),
        });
      }
    }
  }

  return { tiles, items, checked };
}
