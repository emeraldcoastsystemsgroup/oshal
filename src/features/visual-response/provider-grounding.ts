/**
 * Deterministic provider grounding for the two visuals whose fields come from live connectors.
 * The model may choose presentation or suggest an action, but it never supplies the bound facts.
 */

import { z } from 'zod';
import type {
  GalleryVisualResponseSpec,
  GmailSummaryProviderRecord,
  NwsWeatherProviderRecord,
  PriorityEmailVisualResponseSpec,
  VisualResponseProviderRecord,
  VisualResponseSource,
  VisualResponseSpec,
  WalmartCatalogProviderRecord,
  WeatherVisualResponseSpec,
} from './types';
import { parseVisualResponseSpec } from './visual-response-schema';

const shortText = (maximum: number) => z.string().trim().min(1).max(maximum);
const finiteNumber = z.number().finite();
const percent = finiteNumber.min(0).max(100);
const httpsUrl = (maximum: number, allowsHost: (host: string) => boolean) => z.string().trim().min(1).max(maximum).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !parsed.port
      && !parsed.username
      && !parsed.password
      && allowsHost(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}, 'An approved credential-free HTTPS URL is required');
const walmartImageUrl = httpsUrl(1_500, (host) => host === 'i5.walmartimages.com');
const walmartProductUrl = httpsUrl(1_500, (host) => host === 'walmart.com' || host.endsWith('.walmart.com'));

const nwsWeatherProviderRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('nws-weather'),
  provider: z.literal('nws'),
  sourceRef: shortText(180),
  retrievedAt: shortText(80),
  record: z.object({
    location: shortText(120),
    timestamp: shortText(80),
    current: z.object({
      tempF: finiteNumber.min(-200).max(200),
      tempC: finiteNumber.min(-200).max(200),
      condition: shortText(100),
      humidityPercent: percent.optional(),
      precipitationPercent: percent.optional(),
      windSpeedMph: finiteNumber.min(0).max(500).optional(),
      windDirection: shortText(24).optional(),
      validFrom: shortText(80).optional(),
    }).strict(),
    periods: z.array(z.object({
      label: shortText(40),
      tempF: finiteNumber.min(-200).max(200),
      tempC: finiteNumber.min(-200).max(200),
      condition: shortText(100),
      precipitationPercent: percent.optional(),
    }).strict()).max(6),
  }).strict(),
}).strict();

const gmailSummaryProviderRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('gmail-summary'),
  provider: z.literal('gmail'),
  sourceRef: shortText(180),
  retrievedAt: shortText(80),
  mailbox: shortText(120),
  messages: z.array(z.object({
    sourceRef: shortText(180),
    id: shortText(180),
    sender: shortText(160),
    subject: shortText(240),
    receivedAt: shortText(80).optional(),
    unread: z.boolean(),
    important: z.boolean(),
    starred: z.boolean(),
  }).strict()).max(50),
}).strict();

const walmartCatalogProviderRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('walmart-catalog'),
  provider: z.literal('walmart'),
  sourceRef: shortText(180),
  retrievedAt: shortText(80),
  query: shortText(200),
  items: z.array(z.object({
    sourceRef: shortText(180),
    productId: shortText(120),
    title: shortText(180),
    brand: shortText(100).optional(),
    price: finiteNumber.min(0).max(1_000_000).optional(),
    currency: z.literal('USD'),
    imageUrl: walmartImageUrl,
    productUrl: walmartProductUrl,
  }).strict()).min(1).max(6),
}).strict().superRefine((value, context) => {
  const itemRefs = new Set<string>();
  value.items.forEach((item, index) => {
    if (itemRefs.has(item.sourceRef)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'sourceRef'],
        message: 'Walmart item source references must be unique',
      });
    }
    itemRefs.add(item.sourceRef);
  });
});

export const VisualResponseProviderRecordSchema = z.union([
  nwsWeatherProviderRecordSchema,
  gmailSummaryProviderRecordSchema,
  walmartCatalogProviderRecordSchema,
]);

const PROVIDER_RECORD_FENCE = /```oshal:provider-record\s*([\s\S]*?)```/gi;
const UNTERMINATED_PROVIDER_RECORD_FENCE = /```oshal:provider-record\b[\s\S]*$/i;

export interface ProviderGroundedVisual {
  visualSpec: VisualResponseSpec;
  records: VisualResponseProviderRecord[];
  sources: VisualResponseSource[];
}

/** Parse one post-model CLI capture record. Invalid records fail closed. */
export function parseVisualResponseProviderRecord(input: unknown): VisualResponseProviderRecord | null {
  const parsed = VisualResponseProviderRecordSchema.safeParse(input);
  return parsed.success ? parsed.data as VisualResponseProviderRecord : null;
}

/** Remove all model/work-product provider fences. Text is never a provider-record transport. */
export function stripVisualResponseProviderRecordFences(text: string): string {
  return text
    .replace(PROVIDER_RECORD_FENCE, '')
    .replace(UNTERMINATED_PROVIDER_RECORD_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Rebuild weather/email visuals from provider records. Model-authored provider fields are ignored;
 * only email suggestions tied to a real message reference survive, and remain explicitly labelled.
 */
export function groundProviderBoundVisualSpec(
  input: unknown,
  records: VisualResponseProviderRecord[] | undefined,
): ProviderGroundedVisual | null {
  const candidate = parseVisualResponseSpec(input);
  const available = (records || []).map(parseVisualResponseProviderRecord).filter(isProviderRecord);
  if (candidate?.kind === 'weather') {
    const record = findReferencedWeather(candidate, available);
    return record ? groundedWeather(record, candidate.units) : null;
  }
  if (candidate?.kind === 'priority-email') {
    const record = findReferencedGmail(candidate, available);
    return record ? groundedPriorityEmail(record, candidate) : null;
  }
  if (candidate?.kind === 'gallery') {
    const record = findReferencedWalmart(candidate, available);
    return record ? groundedWalmartGallery(record) : null;
  }
  if (candidate) return { visualSpec: candidate, records: [], sources: [] };

  const weather = available.filter((record): record is NwsWeatherProviderRecord => record.kind === 'nws-weather');
  const gmail = available.filter((record): record is GmailSummaryProviderRecord => record.kind === 'gmail-summary');
  const walmart = available.filter((record): record is WalmartCatalogProviderRecord => record.kind === 'walmart-catalog');
  const recognizedRecordCount = weather.length + gmail.length + walmart.length;
  if (weather.length === 1 && recognizedRecordCount === 1) return groundedWeather(weather[0], 'imperial');
  if (gmail.length === 1 && recognizedRecordCount === 1) return groundedPriorityEmail(gmail[0]);
  if (walmart.length === 1 && recognizedRecordCount === 1) return groundedWalmartGallery(walmart[0]);
  return null;
}

function findReferencedWeather(
  candidate: WeatherVisualResponseSpec,
  records: VisualResponseProviderRecord[],
): NwsWeatherProviderRecord | undefined {
  return records.find((record): record is NwsWeatherProviderRecord => (
    record.kind === 'nws-weather' && candidate.sourceRefs.includes(record.sourceRef)
  ));
}

function findReferencedGmail(
  candidate: PriorityEmailVisualResponseSpec,
  records: VisualResponseProviderRecord[],
): GmailSummaryProviderRecord | undefined {
  return records.find((record): record is GmailSummaryProviderRecord => (
    record.kind === 'gmail-summary' && candidate.sourceRefs.includes(record.sourceRef)
  ));
}

function findReferencedWalmart(
  candidate: GalleryVisualResponseSpec,
  records: VisualResponseProviderRecord[],
): WalmartCatalogProviderRecord | undefined {
  return records.find((record): record is WalmartCatalogProviderRecord => (
    record.kind === 'walmart-catalog' && candidate.sourceRefs.includes(record.sourceRef)
  ));
}

function groundedWeather(record: NwsWeatherProviderRecord, units: 'imperial' | 'metric'): ProviderGroundedVisual {
  const source = record.record;
  const current = source.current;
  const wind = formatWind(current.windDirection, current.windSpeedMph, units);
  const visualSpec: WeatherVisualResponseSpec = {
    schemaVersion: 1,
    kind: 'weather',
    title: `Weather \u00B7 ${source.location}`,
    asOf: current.validFrom || source.timestamp || record.retrievedAt,
    sourceRefs: [record.sourceRef],
    location: source.location,
    units,
    current: {
      temperature: units === 'imperial' ? current.tempF : current.tempC,
      condition: current.condition,
      ...(current.humidityPercent === undefined ? {} : { humidityPercent: current.humidityPercent }),
      ...(current.precipitationPercent === undefined ? {} : { precipitationPercent: current.precipitationPercent }),
      ...(wind ? { wind } : {}),
    },
    ...(source.periods.length ? {
      periods: source.periods.map((period) => ({
        label: period.label,
        temperature: units === 'imperial' ? period.tempF : period.tempC,
        condition: period.condition,
        ...(period.precipitationPercent === undefined ? {} : { precipitationPercent: period.precipitationPercent }),
      })),
    } : {}),
  };
  return {
    visualSpec,
    records: [record],
    sources: [{ type: 'tool', id: record.sourceRef, label: 'National Weather Service forecast' }],
  };
}

function groundedPriorityEmail(
  record: GmailSummaryProviderRecord,
  candidate?: PriorityEmailVisualResponseSpec,
): ProviderGroundedVisual | null {
  const suggestions = new Map((candidate?.items || []).map((item) => [item.sourceRef, item]));
  const items: PriorityEmailVisualResponseSpec['items'] = [];
  for (const message of record.messages) {
    const suggestion = suggestions.get(message.sourceRef);
    const providerImportance = message.important ? 'important' : message.starred ? 'starred' : undefined;
    const isSuggestion = !providerImportance
      && suggestion?.importance === 'suggested'
      && Boolean(suggestion.reason?.trim());
    if (!providerImportance && !isSuggestion) continue;
    const importance = providerImportance || 'suggested';
    const reason = providerImportance
      ? gmailProviderReason(message.important, message.starred)
      : `Jarvis suggestion: ${suggestion!.reason!.trim()}`;
    items.push({
      sourceRef: message.sourceRef,
      sender: message.sender,
      subject: message.subject,
      ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
      unread: message.unread,
      importance,
      reason,
      ...(suggestion?.suggestedAction ? { suggestedAction: suggestion.suggestedAction } : {}),
    });
  }
  const selected = items.slice(0, 6);
  if (!selected.length) return null;
  const sourceRefs = [record.sourceRef, ...selected.map((item) => item.sourceRef)];
  const visualSpec: PriorityEmailVisualResponseSpec = {
    schemaVersion: 1,
    kind: 'priority-email',
    title: 'Priority email',
    asOf: record.retrievedAt,
    sourceRefs,
    mailbox: record.mailbox,
    totalCount: items.length,
    items: selected,
  };
  return {
    visualSpec,
    records: [record],
    sources: [
      { type: 'connector', id: record.sourceRef, label: 'Gmail metadata snapshot' },
      ...selected.map((item) => ({
        type: 'connector' as const,
        id: item.sourceRef,
        label: 'Gmail message metadata',
      })),
    ],
  };
}

function groundedWalmartGallery(record: WalmartCatalogProviderRecord): ProviderGroundedVisual {
  const items = record.items.slice(0, 4);
  const sourceRefs = [record.sourceRef, ...items.map((item) => item.sourceRef)];
  const title = `Walmart · ${record.query}`.slice(0, 120);
  const visualSpec: GalleryVisualResponseSpec = {
    schemaVersion: 1,
    kind: 'gallery',
    title,
    asOf: record.retrievedAt,
    sourceRefs,
    items: items.map((item) => ({
      sourceRef: item.sourceRef,
      title: item.title,
      ...(item.brand ? { brand: item.brand } : {}),
      ...(item.price === undefined ? {} : { price: item.price }),
      currency: 'USD',
    })),
    caption: 'Live Walmart catalog results',
  };
  return {
    visualSpec,
    records: [record],
    sources: [
      { type: 'connector', id: record.sourceRef, label: 'Walmart catalog search' },
      ...items.map((item) => ({
        type: 'connector' as const,
        id: item.sourceRef,
        label: 'Walmart product',
      })),
    ],
  };
}

function gmailProviderReason(important: boolean, starred: boolean): string {
  if (important && starred) return 'Marked important and starred by Gmail';
  if (important) return 'Marked important by Gmail';
  return 'Starred in Gmail';
}

function formatWind(
  direction: string | undefined,
  speedMph: number | undefined,
  units: 'imperial' | 'metric',
): string | undefined {
  if (!direction && speedMph === undefined) return undefined;
  if (speedMph === undefined) return direction;
  const speed = units === 'imperial' ? speedMph : Math.round(speedMph * 1.609344);
  return [direction, `${speed} ${units === 'imperial' ? 'mph' : 'km/h'}`].filter(Boolean).join(' ');
}

function isProviderRecord(value: VisualResponseProviderRecord | null): value is VisualResponseProviderRecord {
  return value !== null;
}
