/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial typed contract for fact-locked visual response artifacts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | FactLockedAnswerPacket.trustedLocalImages — server-selected workspace image paths for gallery grounding, revalidated beneath the shared workspace root at receipt time (never client-supplied).
 */

/**
 * @description One accountable source that contributed to the already-finalized answer.
 */
export interface VisualResponseSource {
  type: 'agent' | 'tool' | 'connector' | 'artifact';
  id: string;
  label?: string;
}

export const VISUAL_RESPONSE_KINDS = [
  'weather', 'priority-email', 'table', 'chart', 'summary', 'timeline', 'diagram', 'gallery',
  'map', 'gauge', 'checklist', 'agenda', 'comparison', 'profile', 'image',
] as const;

export type VisualResponseKind = typeof VISUAL_RESPONSE_KINDS[number];

interface VisualResponseSpecBase {
  schemaVersion: 1;
  kind: VisualResponseKind;
  title: string;
  asOf?: string;
  sourceRefs: string[];
}

export interface WeatherVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'weather';
  location: string;
  units: 'imperial' | 'metric';
  current: {
    temperature: number;
    condition: string;
    high?: number;
    low?: number;
    feelsLike?: number;
    humidityPercent?: number;
    wind?: string;
    precipitationPercent?: number;
  };
  periods?: Array<{
    label: string;
    temperature: number;
    condition: string;
    precipitationPercent?: number;
  }>;
}

export interface PriorityEmailVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'priority-email';
  mailbox?: string;
  totalCount?: number;
  items: Array<{
    /** Provider-owned message reference used to bind displayed fields to one Gmail record. */
    sourceRef: string;
    sender: string;
    subject: string;
    receivedAt?: string;
    unread?: boolean;
    importance?: 'important' | 'starred' | 'suggested';
    reason?: string;
    suggestedAction?: string;
  }>;
}

/** Minimal, presentation-safe NWS record captured from the successful forecast CLI command. */
export interface NwsWeatherProviderRecord {
  schemaVersion: 1;
  kind: 'nws-weather';
  provider: 'nws';
  sourceRef: string;
  retrievedAt: string;
  record: {
    location: string;
    timestamp: string;
    current: {
      tempF: number;
      tempC: number;
      condition: string;
      humidityPercent?: number;
      precipitationPercent?: number;
      windSpeedMph?: number;
      windDirection?: string;
      validFrom?: string;
    };
    periods: Array<{
      label: string;
      tempF: number;
      tempC: number;
      condition: string;
      precipitationPercent?: number;
    }>;
  };
}

/** Minimal Gmail metadata record captured from the successful read-only digest CLI command. */
export interface GmailSummaryProviderRecord {
  schemaVersion: 1;
  kind: 'gmail-summary';
  provider: 'gmail';
  sourceRef: string;
  retrievedAt: string;
  mailbox: string;
  messages: Array<{
    sourceRef: string;
    id: string;
    sender: string;
    subject: string;
    receivedAt?: string;
    unread: boolean;
    important: boolean;
    starred: boolean;
  }>;
}

/**
 * Presentation-safe live Walmart catalog data captured from a successful allowlisted search.
 * Image and product URLs remain provider evidence only; they never enter a model-authored visual
 * specification or the automatic browser image path.
 */
export interface WalmartCatalogProviderRecord {
  schemaVersion: 1;
  kind: 'walmart-catalog';
  provider: 'walmart';
  sourceRef: string;
  retrievedAt: string;
  query: string;
  items: Array<{
    sourceRef: string;
    productId: string;
    title: string;
    brand?: string;
    price?: number;
    currency: 'USD';
    imageUrl: string;
    productUrl: string;
  }>;
}

/** Provider records cross the worker boundary independently of the model-authored presentation. */
export type VisualResponseProviderRecord =
  | NwsWeatherProviderRecord
  | GmailSummaryProviderRecord
  | WalmartCatalogProviderRecord;

export interface TableVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'table';
  columns: string[];
  rows: string[][];
  caption?: string;
}

export interface ChartVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'chart';
  chartType: 'bar' | 'line';
  categories: string[];
  series: Array<{
    name: string;
    values: number[];
    unit?: string;
  }>;
  caption?: string;
}

export interface SummaryVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'summary';
  metrics?: Array<{
    label: string;
    value: string;
    detail?: string;
  }>;
  bullets?: string[];
  caption?: string;
}

export interface TimelineVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'timeline';
  items: Array<{
    label: string;
    title: string;
    detail?: string;
  }>;
  caption?: string;
}

export interface DiagramVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'diagram';
  layout: 'flow' | 'hierarchy';
  nodes: Array<{
    id: string;
    label: string;
    detail?: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    label: string;
  }>;
  caption?: string;
}

/**
 * A provider-bound product gallery. Items carry only display facts and opaque source references;
 * trusted server ingestion resolves image bytes from the corresponding provider record.
 */
export interface GalleryVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'gallery';
  items: Array<{
    sourceRef: string;
    title: string;
    brand?: string;
    price?: number;
    currency: 'USD';
  }>;
  caption?: string;
}

/**
 * A schematic location / route map. Coordinates are plotted in relative geographic space (no map
 * tiles — the renderer is deterministic and offline), so it reads as a route/location diagram, not a
 * satellite image.
 */
export interface MapVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'map';
  places: Array<{
    label: string;
    lat: number;
    lng: number;
    detail?: string;
    marker?: 'origin' | 'stop' | 'destination' | 'point';
  }>;
  /** Connect the places in order with a route line (origin → … → destination). */
  route?: boolean;
  distance?: string;
  duration?: string;
  caption?: string;
}

/** One or more ratio/progress ring gauges (budget used, goal progress, application steps, …). */
export interface GaugeVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'gauge';
  gauges: Array<{
    label: string;
    percent: number;
    /** Optional centered display value (e.g. "$18.2k", "3/5"); defaults to the percent. */
    value?: string;
    detail?: string;
    tone?: 'accent' | 'good' | 'warn' | 'bad';
  }>;
  caption?: string;
}

/** A list of items with status (remediation steps, application requirements, a to-do list, …). */
export interface ChecklistVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'checklist';
  items: Array<{
    label: string;
    status: 'done' | 'todo' | 'in-progress' | 'blocked';
    detail?: string;
  }>;
  caption?: string;
}

/** A day/schedule view: what is on, when, and where. */
export interface AgendaVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'agenda';
  dateLabel?: string;
  items: Array<{
    time: string;
    title: string;
    detail?: string;
    location?: string;
    status?: 'confirmed' | 'tentative' | 'cancelled';
  }>;
  caption?: string;
}

/** Side-by-side options compared across shared attributes (jobs, flights, plans, products). */
export interface ComparisonVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'comparison';
  options: Array<{ label: string; badge?: string; recommended?: boolean }>;
  /** One row per attribute; `values` must carry exactly one entry per option. */
  attributes: Array<{ label: string; values: string[] }>;
  caption?: string;
}

/** A person/entity card: who they are and the facts that matter about them. */
export interface ProfileVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'profile';
  name: string;
  subtitle?: string;
  /** Avatar initials; derived from `name` when omitted (presentation only, never a new fact). */
  initials?: string;
  fields?: Array<{ label: string; value: string }>;
  bullets?: string[];
  caption?: string;
}

/**
 * One to three real pictures that help explain the answer — "images on the fly".
 *
 * The spec carries only opaque `sourceRef`s and captions; it never carries a URL or bytes. Trusted
 * server ingestion resolves each ref to bytes it already verified (a workspace deliverable beneath
 * the shared root, or an allowlisted provider image), transcodes it, and embeds it as a hashed
 * `data:` PNG. A model therefore cannot point this at an arbitrary or hostile image.
 * `caption` is required per item: it is the picture's accessible description.
 */
export interface ImageVisualResponseSpec extends VisualResponseSpecBase {
  kind: 'image';
  items: Array<{ sourceRef: string; caption: string }>;
  caption?: string;
}

export type VisualResponseSpec =
  | WeatherVisualResponseSpec
  | PriorityEmailVisualResponseSpec
  | TableVisualResponseSpec
  | ChartVisualResponseSpec
  | SummaryVisualResponseSpec
  | TimelineVisualResponseSpec
  | DiagramVisualResponseSpec
  | GalleryVisualResponseSpec
  | MapVisualResponseSpec
  | GaugeVisualResponseSpec
  | ChecklistVisualResponseSpec
  | AgendaVisualResponseSpec
  | ComparisonVisualResponseSpec
  | ProfileVisualResponseSpec
  | ImageVisualResponseSpec;

/**
 * @description Immutable input to the visual renderer. `factLocked: true` makes the boundary
 * explicit: presentation code may arrange these words, but must not add or reinterpret facts.
 */
export interface FactLockedAnswerPacket {
  factLocked: true;
  sourceSurface: string;
  sourceSessionId: string;
  sourceJobId: string;
  request: string;
  answer: string;
  sources?: VisualResponseSource[];
  /** Trusted CLI records used to deterministically bind provider-owned response fields. */
  providerRecords?: VisualResponseProviderRecord[];
  /** Server-selected workspace images. Paths are revalidated beneath the shared workspace root. */
  trustedLocalImages?: Array<{ sourceRef: string; path: string }>;
  /** Absence is deliberate: ordinary conversational answers stay text/orb-only. */
  visualSpec?: VisualResponseSpec;
}

/**
 * @description Provenance returned with every image so a client can retain and replay the exact
 * fact-locked visual without asking an LLM to regenerate it.
 */
export interface VisualResponseProvenance {
  factLocked: true;
  renderer: string;
  answerSha256: string;
  visualSpecSha256: string;
  /** Stable digest of the grounded typed spec before mutable provider image receipts are added. */
  inputSpecSha256?: string;
  visualKind: VisualResponseKind;
  sourceSurface: string;
  sourceSessionId: string;
  sourceJobId: string;
  sources: VisualResponseSource[];
  /** Hash-only receipt metadata for provider images embedded after server-side transcoding. */
  imageReceipts?: Array<{
    sourceRef: string;
    sourceUrlSha256: string;
    sourceContentSha256: string;
    contentSha256: string;
    sourceBytes: number;
    outputBytes: number;
    mimeType: 'image/png';
    width: number;
    height: number;
  }>;
  generatedAt: string;
}

/**
 * @description Client-safe metadata for a persisted image artifact.
 */
export interface VisualResponseArtifact {
  artifactId: string;
  type: 'image';
  kind: VisualResponseKind;
  url: string;
  mimeType: 'image/svg+xml';
  alt: string;
  width: number;
  height: number;
  createdAt: string;
  provenance: VisualResponseProvenance;
}

/**
 * @description Server-side persisted artifact payload used by the authenticated image route.
 */
export interface VisualResponseContent {
  metadata: VisualResponseArtifact;
  content: Buffer;
  contentSha256: string;
}

/**
 * @description Output of the deterministic SVG renderer before persistence assigns an artifact id.
 */
export interface RenderedVisualResponse {
  content: Buffer;
  mimeType: 'image/svg+xml';
  alt: string;
  width: number;
  height: number;
  answerSha256: string;
  visualSpecSha256: string;
  kind: VisualResponseKind;
  renderer: string;
}
