/**
 * AI Test Lab — deterministic rich-visual catalog (ADR-063, extends the visual-response proof).
 *
 * One canned, schema-valid fact-locked packet per visual `kind`. The lab renders these through the
 * REAL `renderVisualResponse` SVG renderer (same code path Jarvis uses), so "does the rich display
 * still work for kind X?" is provable WITHOUT a live provider account or a running bot node. The
 * three provider-bound kinds (weather / priority-email / gallery) also carry `liveAsk` — the natural
 * phrase that drives the same visual through Jarvis end-to-end for the live tier.
 *
 * These are explicitly Test-Lab SAMPLE facts used to exercise the renderer; they are never presented
 * as a real deliverable and never leave the lab surface.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — canned packet per visual
 *            | kind + renderCatalogVisual() so every rich-display kind is proven deterministically.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Corrected catalog docs to
 *            | describe the current 15-kind visual-response set after the new renderers landed.
 * ---------------------------------------------------------------------------
 * @module test-lab-visual-catalog
 */

import {
  renderVisualResponse,
  VISUAL_RESPONSE_KINDS,
  type FactLockedAnswerPacket,
  type RenderedVisualResponse,
  type VisualResponseKind,
} from '@/features/visual-response';

/** A catalog entry: how to describe the kind + the exact packet the lab renders. */
export interface VisualCatalogEntry {
  kind: VisualResponseKind;
  label: string;
  description: string;
  /** Present for provider-bound kinds: the phrase that drives the same visual through Jarvis. */
  liveAsk?: string;
  packet: FactLockedAnswerPacket;
}

/** Shared packet envelope for the sample renders (surface/session/job ids are cosmetic here). */
function packet(
  request: string,
  answer: string,
  visualSpec: FactLockedAnswerPacket['visualSpec'],
): FactLockedAnswerPacket {
  return {
    factLocked: true,
    sourceSurface: 'test-lab',
    sourceSessionId: 'test-lab-visual-catalog',
    sourceJobId: `test-lab:${visualSpec?.kind || 'unknown'}`,
    request,
    answer,
    visualSpec,
  };
}

/**
 * @description The 15-kind rich-visual catalog. Each entry is schema-valid so the renderer
 * accepts it; each is representative so the produced SVG looks like the real thing on the surface.
 */
export const VISUAL_CATALOG: VisualCatalogEntry[] = [
  {
    kind: 'weather',
    label: 'Weather',
    description: 'Current conditions + short forecast (the flagship “ask for weather, see the image” win).',
    liveAsk: "What's the weather in Destin, Florida right now?",
    packet: packet(
      "What's the weather in Destin today?",
      'In Destin it is sunny and 78°F, feeling like 80°. High 84°, low 71°, 10% chance of rain, wind SW 8 mph.',
      {
        schemaVersion: 1,
        kind: 'weather',
        title: 'Destin, FL — Today',
        asOf: 'Test Lab sample',
        sourceRefs: ['nws:sample-forecast'],
        location: 'Destin, FL',
        units: 'imperial',
        current: {
          temperature: 78, condition: 'Sunny', high: 84, low: 71,
          feelsLike: 80, humidityPercent: 62, wind: 'SW 8 mph', precipitationPercent: 10,
        },
        periods: [
          { label: 'This Afternoon', temperature: 84, condition: 'Sunny', precipitationPercent: 5 },
          { label: 'Tonight', temperature: 71, condition: 'Clear', precipitationPercent: 5 },
          { label: 'Tomorrow', temperature: 82, condition: 'Partly Cloudy', precipitationPercent: 20 },
        ],
      },
    ),
  },
  {
    kind: 'priority-email',
    label: 'Priority inbox',
    description: 'The messages that need attention, bound to real Gmail records (provider-fact locked).',
    liveAsk: 'What are my most important unread emails?',
    packet: packet(
      'What are my most important emails?',
      'Three messages stand out: a contract from Legal (unread), an invoice reminder, and a starred note from Enrique.',
      {
        schemaVersion: 1,
        kind: 'priority-email',
        title: 'Priority inbox',
        asOf: 'Test Lab sample',
        sourceRefs: ['gmail:sample-1', 'gmail:sample-2', 'gmail:sample-3'],
        mailbox: 'you@example.com',
        totalCount: 3,
        items: [
          { sourceRef: 'gmail:sample-1', sender: 'Legal Team', subject: 'Signature needed: MSA v4', unread: true, importance: 'important', reason: 'Awaiting your signature', suggestedAction: 'Review & sign' },
          { sourceRef: 'gmail:sample-2', sender: 'Billing', subject: 'Invoice #10432 due Friday', unread: true, importance: 'important', reason: 'Payment due in 2 days' },
          { sourceRef: 'gmail:sample-3', sender: 'Enrique León', subject: 'Re: interview availability', importance: 'starred', reason: 'You starred this thread' },
        ],
      },
    ),
  },
  {
    kind: 'table',
    label: 'Table',
    description: 'Structured rows/columns (job pack, order options, positions).',
    packet: packet(
      'Show my top job matches as a table.',
      'Your three strongest recent matches by fit score.',
      {
        schemaVersion: 1,
        kind: 'table',
        title: 'Top job matches',
        asOf: 'Test Lab sample',
        sourceRefs: ['career-hunter:sample'],
        columns: ['Role', 'Company', 'Fit'],
        rows: [
          ['Staff AI Architect', 'Northwind', '94'],
          ['Principal Platform Eng', 'Acme Cloud', '91'],
          ['Lead ML Engineer', 'Globex', '88'],
        ],
        caption: 'Ranked by AI fit score.',
      },
    ),
  },
  {
    kind: 'chart',
    label: 'Chart',
    description: 'Bar/line series (equity curve, spend, calibration).',
    packet: packet(
      'Chart my portfolio value this week.',
      'Account value rose from $51.2k to $52.4k across the week.',
      {
        schemaVersion: 1,
        kind: 'chart',
        title: 'Account value — this week',
        asOf: 'Test Lab sample',
        sourceRefs: ['trading:sample'],
        chartType: 'line',
        categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        series: [{ name: 'Equity', values: [51.2, 51.6, 51.4, 52.0, 52.4], unit: 'k$' }],
        caption: 'Daily close, USD thousands.',
      },
    ),
  },
  {
    kind: 'summary',
    label: 'Summary',
    description: 'Metric tiles + bullets (a briefing card).',
    packet: packet(
      'Give me a morning brief.',
      'Calendar is light, two priority emails, portfolio up 0.9%.',
      {
        schemaVersion: 1,
        kind: 'summary',
        title: 'Morning brief',
        asOf: 'Test Lab sample',
        sourceRefs: ['jarvis:sample'],
        metrics: [
          { label: 'Meetings today', value: '2', detail: 'Next at 10:00' },
          { label: 'Priority email', value: '2', detail: '1 needs a signature' },
          { label: 'Portfolio', value: '+0.9%', detail: 'vs S&P +0.4%' },
        ],
        bullets: [
          'Contract from Legal is awaiting your signature.',
          'Invoice #10432 is due Friday.',
        ],
        caption: 'Assembled from your connected apps.',
      },
    ),
  },
  {
    kind: 'timeline',
    label: 'Timeline',
    description: 'Ordered events (itinerary, incident history, project plan).',
    packet: packet(
      'Show my trip itinerary.',
      'Depart JFK 08:15, land LHR 20:05, hotel check-in 21:30.',
      {
        schemaVersion: 1,
        kind: 'timeline',
        title: 'Trip to London',
        asOf: 'Test Lab sample',
        sourceRefs: ['travel:sample'],
        items: [
          { label: '08:15', title: 'Depart JFK', detail: 'BA178, Terminal 7' },
          { label: '20:05', title: 'Arrive LHR', detail: 'Terminal 5' },
          { label: '21:30', title: 'Hotel check-in', detail: 'The Nadler Kensington' },
        ],
        caption: 'Local times.',
      },
    ),
  },
  {
    kind: 'diagram',
    label: 'Diagram',
    description: 'Flow/hierarchy of nodes + edges (RCA topology, workflow, dependency map).',
    packet: packet(
      'Diagram the incident root cause.',
      'A deploy pushed a bad config that starved the DB pool and timed out the API.',
      {
        schemaVersion: 1,
        kind: 'diagram',
        title: 'Incident root cause',
        asOf: 'Test Lab sample',
        sourceRefs: ['rca:sample'],
        layout: 'flow',
        nodes: [
          { id: 'deploy', label: 'Deploy 14:02', detail: 'Bad config shipped' },
          { id: 'pool', label: 'DB pool starved' },
          { id: 'api', label: 'API timeouts', detail: '503s to users' },
        ],
        edges: [
          { from: 'deploy', to: 'pool', label: 'reduced max conns' },
          { from: 'pool', to: 'api', label: 'no connection' },
        ],
        caption: 'Left-to-right causal flow.',
      },
    ),
  },
  {
    kind: 'gallery',
    label: 'Product gallery',
    description: 'Provider-bound product cards (live Walmart search → gallery).',
    liveAsk: 'Search Walmart for lego star wars sets',
    packet: packet(
      'Find lego star wars sets at Walmart.',
      'Three sets in stock: Millennium Falcon, X-Wing, and AT-AT.',
      {
        schemaVersion: 1,
        kind: 'gallery',
        title: 'LEGO Star Wars — Walmart',
        asOf: 'Test Lab sample',
        sourceRefs: ['walmart:sample-1', 'walmart:sample-2', 'walmart:sample-3'],
        items: [
          { sourceRef: 'walmart:sample-1', title: 'LEGO Millennium Falcon 75257', brand: 'LEGO', price: 169.99, currency: 'USD' },
          { sourceRef: 'walmart:sample-2', title: 'LEGO X-Wing Starfighter 75355', brand: 'LEGO', price: 64.99, currency: 'USD' },
          { sourceRef: 'walmart:sample-3', title: 'LEGO AT-AT 75288', brand: 'LEGO', price: 159.99, currency: 'USD' },
        ],
        caption: 'Sample product cards (no live images in deterministic mode).',
      },
    ),
  },
  {
    kind: 'map',
    label: 'Map / route',
    description: 'Locations or a route plotted in relative geographic space (travel, rides, “where is X”).',
    packet: packet(
      'Show my drive from Destin to New Orleans.',
      'It is about 235 miles, roughly 3h 40m, via I-10 W with a stop in Mobile.',
      {
        schemaVersion: 1,
        kind: 'map',
        title: 'Destin → New Orleans',
        asOf: 'Test Lab sample',
        sourceRefs: ['travel:sample'],
        route: true,
        distance: '235 mi',
        duration: '3h 40m',
        places: [
          { label: 'Destin, FL', lat: 30.393, lng: -86.496, marker: 'origin', detail: 'Depart 9:00 AM' },
          { label: 'Mobile, AL', lat: 30.695, lng: -88.043, marker: 'stop', detail: 'Coffee stop' },
          { label: 'New Orleans, LA', lat: 29.951, lng: -90.072, marker: 'destination', detail: 'Arrive ~12:40 PM' },
        ],
        caption: 'Schematic route (relative positions, no map tiles).',
      },
    ),
  },
  {
    kind: 'gauge',
    label: 'Gauges / progress',
    description: 'Ratio and progress rings (budget used, goal progress, application steps).',
    packet: packet(
      'How am I tracking this month?',
      'Budget is 68% spent, job applications are 60% of your weekly goal, and cloud storage is 42% full.',
      {
        schemaVersion: 1,
        kind: 'gauge',
        title: 'This month at a glance',
        asOf: 'Test Lab sample',
        sourceRefs: ['jarvis:sample'],
        gauges: [
          { label: 'Budget used', percent: 68, value: '68%', detail: '$2,040 of $3,000', tone: 'warn' },
          { label: 'Weekly apply goal', percent: 60, value: '3/5', detail: '2 to go', tone: 'accent' },
          { label: 'Storage', percent: 42, value: '42%', detail: '105 GB free', tone: 'good' },
        ],
        caption: 'Live figures come from your connected apps.',
      },
    ),
  },
  {
    kind: 'checklist',
    label: 'Checklist / status',
    description: 'Items with status — remediation steps, application requirements, a to-do list.',
    packet: packet(
      'What is left on my application to Northwind?',
      'Résumé and cover letter are done, the portfolio link is in progress, and references are still to do.',
      {
        schemaVersion: 1,
        kind: 'checklist',
        title: 'Northwind application',
        asOf: 'Test Lab sample',
        sourceRefs: ['career-hunter:sample'],
        items: [
          { label: 'Tailored résumé', status: 'done', detail: 'Generated 2 days ago' },
          { label: 'Cover letter', status: 'done' },
          { label: 'Portfolio link', status: 'in-progress', detail: 'Waiting on the case-study page' },
          { label: 'Two references', status: 'todo', detail: 'Ask Jordan and Priya' },
          { label: 'Salary expectation', status: 'blocked', detail: 'Need the band from recruiter' },
        ],
        caption: 'Everything needed before you submit.',
      },
    ),
  },
  {
    kind: 'agenda',
    label: 'Agenda / day',
    description: 'What is on today — time, title, where (calendar, itinerary, schedule).',
    packet: packet(
      'What does my day look like?',
      'Three things today: a 10:00 standup, a 13:30 interview with Northwind, and a 17:00 dentist appointment.',
      {
        schemaVersion: 1,
        kind: 'agenda',
        title: 'Your day',
        asOf: 'Test Lab sample',
        sourceRefs: ['calendar:sample'],
        dateLabel: 'Thursday, July 16',
        items: [
          { time: '10:00 AM', title: 'Team standup', location: 'Zoom', detail: '15 min', status: 'confirmed' },
          { time: '1:30 PM', title: 'Interview — Northwind (Staff AI Architect)', location: 'Google Meet', detail: 'With the hiring manager', status: 'confirmed' },
          { time: '4:00 PM', title: 'Budget review', location: 'Office', status: 'tentative' },
          { time: '5:00 PM', title: 'Dentist', location: 'Destin Dental', status: 'cancelled' },
        ],
      },
    ),
  },
  {
    kind: 'comparison',
    label: 'Comparison',
    description: 'Options side by side across shared attributes (jobs, flights, plans, products).',
    packet: packet(
      'Compare my two best job offers.',
      'Northwind pays more and is fully remote; Acme Cloud has the stronger title but requires hybrid.',
      {
        schemaVersion: 1,
        kind: 'comparison',
        title: 'Northwind vs Acme Cloud',
        asOf: 'Test Lab sample',
        sourceRefs: ['career-hunter:sample'],
        options: [
          { label: 'Northwind', badge: 'Best pay', recommended: true },
          { label: 'Acme Cloud' },
        ],
        attributes: [
          { label: 'Title', values: ['Staff AI Architect', 'Principal Platform Eng'] },
          { label: 'Base', values: ['$215,000', '$198,000'] },
          { label: 'Location', values: ['Remote (US)', 'Hybrid — 3 days'] },
          { label: 'Fit score', values: ['94', '91'] },
          { label: 'Next step', values: ['Onsite loop', 'Recruiter screen'] },
        ],
        caption: 'Ranked by AI fit score.',
      },
    ),
  },
  {
    kind: 'profile',
    label: 'Profile / contact',
    description: 'A person or entity card — who they are and the facts that matter.',
    packet: packet(
      'Who is the recruiter for the Northwind role?',
      'Enrique León is the technical recruiter at Northwind; you last spoke on July 12 about interview availability.',
      {
        schemaVersion: 1,
        kind: 'profile',
        title: 'Recruiter',
        asOf: 'Test Lab sample',
        sourceRefs: ['gmail:sample-3'],
        name: 'Enrique León',
        subtitle: 'Technical Recruiter · Northwind',
        fields: [
          { label: 'Email', value: 'enrique@northwind.example' },
          { label: 'Last contact', value: 'Jul 12, 2026' },
          { label: 'Role owned', value: 'Staff AI Architect' },
        ],
        bullets: [
          'Starred thread: "Re: interview availability".',
          'Asked for your availability the week of Jul 20.',
        ],
      },
    ),
  },
  {
    kind: 'image',
    label: 'Image (on the fly)',
    description: 'Real pictures a bot produced, embedded only from server-verified bytes. Renders an honest IMAGE placeholder here because the lab supplies no workspace receipt.',
    packet: packet(
      'Show me the chart you generated for the incident.',
      'Here is the latency plot I rendered, alongside the before/after topology.',
      {
        schemaVersion: 1,
        kind: 'image',
        title: 'Generated figures',
        asOf: 'Test Lab sample',
        sourceRefs: ['workspace:sample-1', 'workspace:sample-2'],
        items: [
          { sourceRef: 'workspace:sample-1', caption: 'Latency p99 climbing from 120ms to 4.2s after the 14:02 deploy.' },
          { sourceRef: 'workspace:sample-2', caption: 'Topology before and after the DB pool change.' },
        ],
        caption: 'Bytes are embedded only from a verified workspace receipt.',
      },
    ),
  },
];

/** Compile-time guard: the catalog must cover every declared visual kind. */
const CATALOG_KINDS = new Set(VISUAL_CATALOG.map((entry) => entry.kind));
for (const kind of VISUAL_RESPONSE_KINDS) {
  if (!CATALOG_KINDS.has(kind)) throw new Error(`test-lab visual catalog is missing kind: ${kind}`);
}

/**
 * @description Look up a catalog entry by kind.
 * @param kind - One of the eight visual-response kinds.
 * @returns The catalog entry, or undefined for an unknown kind.
 */
export function getCatalogEntry(kind: string): VisualCatalogEntry | undefined {
  return VISUAL_CATALOG.find((entry) => entry.kind === kind);
}

/**
 * @description Render a catalog entry to immutable SVG bytes via the real renderer.
 * @param kind - One of the eight visual-response kinds.
 * @returns The rendered SVG result, or undefined for an unknown kind. Renderer errors propagate so
 *   the caller can classify the kind as a real regression rather than silently degrading.
 */
export function renderCatalogVisual(kind: string): RenderedVisualResponse | undefined {
  const entry = getCatalogEntry(kind);
  if (!entry) return undefined;
  return renderVisualResponse(entry.packet);
}
