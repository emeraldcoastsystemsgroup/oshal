/**
 * Runtime contract for fact-locked visual specifications. Presentation directives cross an LLM
 * text boundary, so compile-time types alone are not a security or reliability boundary.
 */

import { z } from 'zod';
import type { VisualResponseSpec } from './types';

const shortText = (maximum: number) => z.string().trim().min(1).max(maximum);
const finiteNumber = z.number().finite();
const percent = finiteNumber.min(0).max(100);
const chartNumber = finiteNumber.min(-1_000_000_000_000).max(1_000_000_000_000);

const baseShape = {
  schemaVersion: z.literal(1).optional().default(1),
  title: shortText(120),
  asOf: z.string().trim().min(1).max(80).optional(),
};

const optionalSourceRefs = z.array(shortText(180)).max(12).optional().default([]);
const requiredProviderSourceRefs = z.array(shortText(180)).min(1).max(12);

const weatherSchema = z.object({
  ...baseShape,
  kind: z.literal('weather'),
  sourceRefs: requiredProviderSourceRefs,
  location: shortText(120),
  units: z.enum(['imperial', 'metric']),
  current: z.object({
    temperature: finiteNumber.min(-200).max(200),
    condition: shortText(100),
    high: finiteNumber.min(-200).max(200).optional(),
    low: finiteNumber.min(-200).max(200).optional(),
    feelsLike: finiteNumber.min(-200).max(200).optional(),
    humidityPercent: percent.optional(),
    wind: shortText(80).optional(),
    precipitationPercent: percent.optional(),
  }).strict(),
  periods: z.array(z.object({
    label: shortText(40),
    temperature: finiteNumber.min(-200).max(200),
    condition: shortText(100),
    precipitationPercent: percent.optional(),
  }).strict()).max(6).optional(),
}).strict();

const priorityEmailSchema = z.object({
  ...baseShape,
  kind: z.literal('priority-email'),
  sourceRefs: requiredProviderSourceRefs,
  mailbox: shortText(120).optional(),
  totalCount: z.number().int().min(0).max(100_000).optional(),
  items: z.array(z.object({
    sourceRef: shortText(180),
    sender: shortText(160),
    subject: shortText(240),
    receivedAt: z.string().trim().min(1).max(80).optional(),
    unread: z.boolean().optional(),
    importance: z.enum(['important', 'starred', 'suggested']).optional(),
    reason: shortText(160).optional(),
    suggestedAction: shortText(120).optional(),
  }).strict()).min(1).max(6),
}).strict();

const tableSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('table'),
  columns: z.array(shortText(80)).min(2).max(6),
  rows: z.array(z.array(z.string().trim().max(240)).max(6)).min(1).max(8),
  caption: shortText(200).optional(),
}).strict().superRefine((value, context) => {
  value.rows.forEach((row, index) => {
    if (row.length !== value.columns.length) {
      context.addIssue({
        code: 'custom',
        path: ['rows', index],
        message: 'Each table row must have exactly one cell per column',
      });
    }
  });
});

const chartSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('chart'),
  chartType: z.enum(['bar', 'line']),
  categories: z.array(shortText(60)).min(1).max(12),
  series: z.array(z.object({
    name: shortText(60),
    values: z.array(chartNumber).min(1).max(12),
    unit: z.string().trim().max(20).optional(),
  }).strict()).min(1).max(3),
  caption: shortText(200).optional(),
}).strict().superRefine((value, context) => {
  value.series.forEach((series, index) => {
    if (series.values.length !== value.categories.length) {
      context.addIssue({
        code: 'custom',
        path: ['series', index, 'values'],
        message: 'Each chart series must have one value per category',
      });
    }
  });
});

const summarySchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('summary'),
  metrics: z.array(z.object({
    label: shortText(60),
    value: shortText(80),
    detail: shortText(120).optional(),
  }).strict()).max(4).optional(),
  bullets: z.array(shortText(240)).max(6).optional(),
  caption: shortText(200).optional(),
}).strict().superRefine((value, context) => {
  if (!(value.metrics?.length || value.bullets?.length)) {
    context.addIssue({ code: 'custom', message: 'A summary needs at least one metric or bullet' });
  }
});

const timelineSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('timeline'),
  items: z.array(z.object({
    label: shortText(40),
    title: shortText(80),
    detail: shortText(160).optional(),
  }).strict()).min(2).max(6),
  caption: shortText(200).optional(),
}).strict();

const diagramNodeId = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/,
  'Diagram node ids must be 1-40 safe identifier characters',
);

const diagramSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('diagram'),
  layout: z.enum(['flow', 'hierarchy']).optional().default('flow'),
  nodes: z.array(z.object({
    id: diagramNodeId,
    label: shortText(80),
    detail: shortText(140).optional(),
  }).strict()).min(2).max(8),
  edges: z.array(z.object({
    from: diagramNodeId,
    to: diagramNodeId,
    label: shortText(48),
  }).strict()).min(1).max(12),
  caption: shortText(200).optional(),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.nodes.forEach((node, index) => {
    if (ids.has(node.id)) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: 'Diagram node ids must be unique' });
    }
    ids.add(node.id);
  });
  const edgeKeys = new Set<string>();
  value.edges.forEach((edge, index) => {
    // Parallel edges would render on the same line and make both labels ambiguous. Treat one
    // directed node pair as one relationship regardless of model-authored label wording.
    const edgeKey = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(edgeKey)) {
      context.addIssue({ code: 'custom', path: ['edges', index], message: 'Diagram edges must be unique' });
    }
    edgeKeys.add(edgeKey);
    if (!ids.has(edge.from)) {
      context.addIssue({ code: 'custom', path: ['edges', index, 'from'], message: 'Diagram edge source must reference a node' });
    }
    if (!ids.has(edge.to)) {
      context.addIssue({ code: 'custom', path: ['edges', index, 'to'], message: 'Diagram edge target must reference a node' });
    }
    if (edge.from === edge.to) {
      context.addIssue({ code: 'custom', path: ['edges', index], message: 'Diagram self-edges are not supported' });
    }
  });
  if (ids.size === value.nodes.length && value.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))) {
    const indegree = new Map(value.nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(value.nodes.map((node) => [node.id, [] as string[]]));
    value.edges.forEach((edge) => {
      indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
      outgoing.get(edge.from)!.push(edge.to);
    });
    const queue = value.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift()!;
      visited += 1;
      for (const target of outgoing.get(id) || []) {
        const remaining = (indegree.get(target) || 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) queue.push(target);
      }
    }
    if (visited !== value.nodes.length) {
      context.addIssue({ code: 'custom', path: ['edges'], message: 'Diagram edges must be acyclic' });
    }
  }
});

const gallerySchema = z.object({
  ...baseShape,
  kind: z.literal('gallery'),
  sourceRefs: requiredProviderSourceRefs,
  items: z.array(z.object({
    sourceRef: shortText(180),
    title: shortText(180),
    brand: shortText(100).optional(),
    price: finiteNumber.min(0).max(1_000_000).optional(),
    currency: z.literal('USD'),
  }).strict()).min(1).max(4),
  caption: shortText(200).optional(),
}).strict().superRefine((value, context) => {
  const itemRefs = new Set<string>();
  value.items.forEach((item, index) => {
    if (itemRefs.has(item.sourceRef)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'sourceRef'],
        message: 'Gallery item source references must be unique',
      });
    }
    itemRefs.add(item.sourceRef);
    if (!value.sourceRefs.includes(item.sourceRef)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'sourceRef'],
        message: 'Every gallery item must be included in sourceRefs',
      });
    }
  });
});

const mapSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('map'),
  places: z.array(z.object({
    label: shortText(80),
    lat: finiteNumber.min(-90).max(90),
    lng: finiteNumber.min(-180).max(180),
    detail: shortText(120).optional(),
    marker: z.enum(['origin', 'stop', 'destination', 'point']).optional(),
  }).strict()).min(1).max(8),
  route: z.boolean().optional(),
  distance: shortText(40).optional(),
  duration: shortText(40).optional(),
  caption: shortText(200).optional(),
}).strict();

const gaugeSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('gauge'),
  gauges: z.array(z.object({
    label: shortText(60),
    percent: percent,
    value: shortText(24).optional(),
    detail: shortText(80).optional(),
    tone: z.enum(['accent', 'good', 'warn', 'bad']).optional(),
  }).strict()).min(1).max(4),
  caption: shortText(200).optional(),
}).strict();

const checklistSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('checklist'),
  items: z.array(z.object({
    label: shortText(120),
    status: z.enum(['done', 'todo', 'in-progress', 'blocked']),
    detail: shortText(160).optional(),
  }).strict()).min(1).max(8),
  caption: shortText(200).optional(),
}).strict();

const agendaSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('agenda'),
  dateLabel: shortText(60).optional(),
  items: z.array(z.object({
    time: shortText(24),
    title: shortText(90),
    detail: shortText(140).optional(),
    location: shortText(80).optional(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  }).strict()).min(1).max(7),
  caption: shortText(200).optional(),
}).strict();

const comparisonSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('comparison'),
  options: z.array(z.object({
    label: shortText(60),
    badge: shortText(24).optional(),
    recommended: z.boolean().optional(),
  }).strict()).min(2).max(3),
  attributes: z.array(z.object({
    label: shortText(60),
    values: z.array(z.string().trim().max(80)).min(2).max(3),
  }).strict()).min(1).max(6),
  caption: shortText(200).optional(),
}).strict().superRefine((value, context) => {
  value.attributes.forEach((attribute, index) => {
    if (attribute.values.length !== value.options.length) {
      context.addIssue({
        code: 'custom',
        path: ['attributes', index, 'values'],
        message: 'Each comparison attribute must have exactly one value per option',
      });
    }
  });
});

const profileSchema = z.object({
  ...baseShape,
  sourceRefs: optionalSourceRefs,
  kind: z.literal('profile'),
  name: shortText(80),
  subtitle: shortText(100).optional(),
  initials: shortText(3).optional(),
  fields: z.array(z.object({
    label: shortText(40),
    value: shortText(90),
  }).strict()).max(6).optional(),
  bullets: z.array(shortText(160)).max(4).optional(),
  caption: shortText(200).optional(),
}).strict();

// `image` binds bytes the same way `gallery` does: required provider/workspace sourceRefs that the
// server already verified. The spec never carries a URL, so a model cannot aim it at a hostile image.
const imageSchema = z.object({
  ...baseShape,
  kind: z.literal('image'),
  sourceRefs: requiredProviderSourceRefs,
  items: z.array(z.object({
    sourceRef: shortText(180),
    // Required: this is the picture's accessible description, not decoration.
    caption: shortText(160),
  }).strict()).min(1).max(3),
  caption: shortText(200).optional(),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.sourceRef)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'sourceRef'], message: 'Image item source references must be unique' });
    }
    seen.add(item.sourceRef);
    if (!value.sourceRefs.includes(item.sourceRef)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'sourceRef'], message: 'Every image item must be included in sourceRefs' });
    }
  });
});

// Some variants carry cross-field refinements and therefore become ZodEffects in Zod 3; a plain
// union preserves those refinements whereas discriminatedUnion cannot unwrap them.
export const VisualResponseSpecSchema = z.union([
  weatherSchema,
  priorityEmailSchema,
  tableSchema,
  chartSchema,
  summarySchema,
  timelineSchema,
  diagramSchema,
  gallerySchema,
  mapSchema,
  gaugeSchema,
  checklistSchema,
  agendaSchema,
  comparisonSchema,
  profileSchema,
  imageSchema,
]);

/** Parse an untrusted visual directive. Invalid directives deliberately become text-only. */
export function parseVisualResponseSpec(input: unknown): VisualResponseSpec | null {
  const result = VisualResponseSpecSchema.safeParse(input);
  return result.success ? result.data as VisualResponseSpec : null;
}
