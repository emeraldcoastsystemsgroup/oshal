import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractHandoffs,
  extractJarvisDirectives,
  detectExplicitDirectVisualKind,
  findJarvisTaskSessionId,
  finishTask,
  markJarvisSessionTaskStatus,
  mapJarvisTaskStatusFromTicketStatus,
  maskPendingComplexSummaries,
  persistJarvisTurn,
  providerRecordsMatchingTrustedIntent,
  saveTaskPending,
  storedVisual,
  summarizeProviderBoundRecords,
  trustedProviderRecordsFromJarvisWorkMessage,
  visualSpecFromCompletedMarkdownTable,
  visualSpecForDelayedCompletion,
  visualSpecForDirectRequest,
  withImageDeliverableContract,
  visualSpecForOutcome,
  workspaceGalleryFromCompletedResult,
} from '../../src/app/routes/jarvis-routes';

describe('completed workspace image galleries', () => {
  it('materializes the linked Markdown gallery as trusted local image inputs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gallery-'));
    const previous = process.env.OSHAL_WORKSPACE_ROOT;
    process.env.OSHAL_WORKSPACE_ROOT = root;
    try {
      const ticketId = '7b456715-507d-4c37-9672-04e34a954739';
      const deliverables = path.join(root, ticketId, 'deliverables');
      fs.mkdirSync(path.join(deliverables, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(deliverables, 'assets', 'downtown.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      fs.writeFileSync(path.join(deliverables, 'gallery.md'), '# Gallery\n\n![Downtown Van Buren](assets/downtown.jpg)\n');
      const result = `Ready: [gallery.md](/app/workspace-shared/${ticketId}/deliverables/gallery.md)`;

      const gallery = await workspaceGalleryFromCompletedResult(result, 'Display Van Buren images', ticketId, `ticket:${ticketId}`);

      expect(gallery?.visualSpec).toMatchObject({
        kind: 'gallery',
        items: [{ title: 'Downtown Van Buren', currency: 'USD' }],
      });
      expect(gallery?.localImages[0].path).toBe(path.join(deliverables, 'assets', 'downtown.jpg'));
      expect(gallery?.sources[0].id).toMatch(/^workspace-image:/);
    } finally {
      if (previous === undefined) delete process.env.OSHAL_WORKSPACE_ROOT;
      else process.env.OSHAL_WORKSPACE_ROOT = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unlinked Markdown and image paths that escape deliverables', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gallery-'));
    const previous = process.env.OSHAL_WORKSPACE_ROOT;
    process.env.OSHAL_WORKSPACE_ROOT = root;
    try {
      const ticketId = 'ticket-safe';
      const deliverables = path.join(root, ticketId, 'deliverables');
      fs.mkdirSync(deliverables, { recursive: true });
      fs.writeFileSync(path.join(deliverables, 'gallery.md'), '![Escape](../../secret.png)');
      expect(await workspaceGalleryFromCompletedResult('No gallery link', 'Images', ticketId, `ticket:${ticketId}`)).toBeUndefined();
      expect(await workspaceGalleryFromCompletedResult('[gallery](gallery.md)', 'Images', ticketId, `ticket:${ticketId}`)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OSHAL_WORKSPACE_ROOT;
      else process.env.OSHAL_WORKSPACE_ROOT = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ADR-083: the free-text keyword selector (resolveTaskBotAgentId) is DELETED — the queue
// manager routes task tickets by call-out (task-call-out.ts, covered by its own spec).
// Jarvis's remaining routing contract is the handoff directive itself: a good description,
// a complexity hint, and an EXPLICIT platform flag for OSHAL-self changes.
describe('extractHandoffs directive contract (ADR-083)', () => {
  const fence = (json: string) => `On it — I'll report back.\n\n\`\`\`handoff\n${json}\n\`\`\``;

  it('parses a plain task hand-off with defaults (simple, non-platform)', () => {
    const { cleanAnswer, handoffs } = extractHandoffs(fence(
      '{"action":"create","title":"Audit trading desk","description":"Trace the morning timeline."}',
    ));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].complexity).toBe('simple');
    expect(handoffs[0].platform).toBe(false);
    expect(cleanAnswer).not.toContain('handoff');
  });

  it('keeps independent commerce domains as separate hand-offs', () => {
    const reply = [
      "On it — I'll handle both parts and report back.",
      '```handoff',
      JSON.stringify({
        action: 'create', complexity: 'simple', title: "Order Ben & Jerry's ice cream",
        description: "Use Uber Eats to find Ben & Jerry's ice cream and prepare the checkout handoff.",
      }),
      '```',
      '```handoff',
      JSON.stringify({
        action: 'create', complexity: 'simple', title: 'Buy fish food',
        description: 'Use Walmart to find fish food and add the selected item to the cart.',
      }),
      '```',
    ].join('\n');

    const { cleanAnswer, handoffs } = extractHandoffs(reply);

    expect(cleanAnswer).toBe("On it — I'll handle both parts and report back.");
    expect(handoffs).toHaveLength(2);
    expect(handoffs.map((handoff) => handoff.title)).toEqual([
      "Order Ben & Jerry's ice cream",
      'Buy fish food',
    ]);
    expect(handoffs.every((handoff) => handoff.complexity === 'simple')).toBe(true);
  });

  it('carries the explicit platform flag for OSHAL-self changes (ADR-081 gate feed)', () => {
    const { handoffs } = extractHandoffs(fence(
      '{"action":"create","platform":true,"complexity":"complex","title":"Add Google Drive to files","description":"Wire the Drive backend into the storage app."}',
    ));
    expect(handoffs[0].platform).toBe(true);
    expect(handoffs[0].complexity).toBe('complex');
  });

  it('never infers platform from free text — a URL containing "oshal" stays a plain task', () => {
    // Live misroute 2026-07-09: a resume-link complaint containing oshal.agenticfederal.us
    // was regex-pinned to the privileged dev bot. The flag must be explicit, never inferred.
    const { handoffs } = extractHandoffs(fence(
      '{"action":"create","title":"Recheck broken resume link","description":"https://oshal.agenticfederal.us/api/career-hunter/resume/1053679 returns 404."}',
    ));
    expect(handoffs[0].platform).toBe(false);
  });

  it('coerces a non-boolean platform value to false (defensive parse)', () => {
    const { handoffs } = extractHandoffs(fence(
      '{"action":"create","platform":"yes","title":"T","description":"D"}',
    ));
    expect(handoffs[0].platform).toBe(false);
  });
});

describe('typed Jarvis visual directive contract', () => {
  const weather = {
    kind: 'weather',
    title: 'Weather now',
    location: 'Chicago, IL',
    units: 'imperial',
    current: { temperature: 71, condition: 'Partly cloudy', humidityPercent: 62 },
    sourceRefs: ['weather-observation:123'],
  };
  const visualFence = (value: unknown) => `Here is the forecast.\n\n\`\`\`oshal:visual\n${JSON.stringify(value)}\n\`\`\``;

  it.each([
    ['weather', weather],
    ['priority-email', {
      kind: 'priority-email', title: 'Direct priority email',
      sourceRefs: ['gmail:summary:direct', 'gmail:message:direct'],
      items: [{
        sourceRef: 'gmail:message:direct', sender: 'Ada', subject: 'Decision needed',
        unread: true, importance: 'important', reason: 'Marked important by Gmail',
      }],
    }],
    ['table', {
      kind: 'table', title: 'Direct table', sourceRefs: [],
      columns: ['Option', 'Cost'], rows: [['Alpha', '$10']],
    }],
    ['chart', {
      kind: 'chart', title: 'Direct chart', sourceRefs: [], chartType: 'bar',
      categories: ['Alpha'], series: [{ name: 'Cost', values: [10] }],
    }],
    ['summary', {
      kind: 'summary', title: 'Direct summary', sourceRefs: [], bullets: ['One result'],
    }],
  ] as const)('keeps a valid direct %s directive text-only while preserving delayed eligibility', (kind, spec) => {
    const parsed = extractJarvisDirectives(visualFence(spec));

    expect(parsed.cleanAnswer).toBe('Here is the forecast.');
    expect(parsed.visualSpec?.kind).toBe(kind);
    expect(visualSpecForOutcome(parsed, 'direct')).toBeUndefined();
    expect(visualSpecForDelayedCompletion(parsed)?.kind).toBe(kind);
  });

  it('validates and strips one supported delayed-completion visual directive', () => {
    const parsed = extractJarvisDirectives(visualFence(weather));

    expect(parsed.cleanAnswer).toBe('Here is the forecast.');
    expect(parsed.visualSpec).toMatchObject(weather);
    expect(parsed.handoffs).toEqual([]);
    expect(visualSpecForDelayedCompletion(parsed)).toMatchObject(weather);
  });

  it('strips but never trusts a provider record embedded in a direct model answer', () => {
    const providerRecord = {
      schemaVersion: 1,
      kind: 'nws-weather',
      provider: 'nws',
      sourceRef: 'weather-observation:123',
      retrievedAt: '2026-07-10T14:00:00.000Z',
      record: {
        location: 'Chicago, IL',
        timestamp: '2026-07-10T14:00:00.000Z',
        current: { tempF: 82, tempC: 28, condition: 'Sunny' },
        periods: [],
      },
    };
    const parsed = extractJarvisDirectives([
      visualFence(weather),
      '```oshal:provider-record',
      JSON.stringify(providerRecord),
      '```',
    ].join('\n'));

    expect(parsed.cleanAnswer).toBe('Here is the forecast.');
    expect(parsed.cleanAnswer).not.toContain('provider-record');
    expect(parsed).not.toHaveProperty('providerRecords');
    expect(visualSpecForDelayedCompletion(parsed)).toMatchObject(weather);
  });

  it('allows an explicitly requested direct timeline only when every displayed fact is in the answer', () => {
    const answer = 'Release plan. Today: Define scope. Tomorrow: Implement. Friday: Verify and ship.';
    const parsed = extractJarvisDirectives(`${answer}\n\n${visualFence({
      kind: 'timeline', title: 'Release plan', sourceRefs: [],
      items: [
        { label: 'Today', title: 'Define scope' },
        { label: 'Tomorrow', title: 'Implement' },
        { label: 'Friday', title: 'Verify and ship' },
      ],
    }).replace('Here is the forecast.\n\n', '')}`);

    expect(detectExplicitDirectVisualKind('Show this as a timeline.')).toBe('timeline');
    expect(visualSpecForDirectRequest(parsed, 'Show this as a timeline.', 'jarvis-answer:1')).toMatchObject({
      kind: 'timeline', sourceRefs: ['jarvis-answer:1'],
    });
  });

  it('allows an explicitly requested direct diagram only when relationships are stated verbatim', () => {
    const spec = {
      kind: 'diagram', title: 'Request flow', sourceRefs: [], layout: 'flow',
      nodes: [{ id: 'user', label: 'User' }, { id: 'jarvis', label: 'Jarvis' }, { id: 'worker', label: 'Worker' }],
      edges: [
        { from: 'user', to: 'jarvis', label: 'asks' },
        { from: 'jarvis', to: 'worker', label: 'dispatches' },
      ],
    };
    const parsed = extractJarvisDirectives([
      'Request flow. User asks Jarvis. Jarvis dispatches Worker.',
      '```oshal:visual', JSON.stringify(spec), '```',
    ].join('\n'));

    expect(detectExplicitDirectVisualKind('Draw a diagram of this request flow.')).toBe('diagram');
    expect(visualSpecForDirectRequest(parsed, 'Draw a diagram of this request flow.', 'jarvis-answer:2')).toMatchObject({
      kind: 'diagram', sourceRefs: ['jarvis-answer:2'],
    });
    expect(visualSpecForDirectRequest(
      extractJarvisDirectives(['Request flow. User and Worker are involved.', '```oshal:visual', JSON.stringify(spec), '```'].join('\n')),
      'Draw a diagram of this request flow.',
      'jarvis-answer:2',
    )).toBeUndefined();
  });

  it.each([
    ['implicit mention', 'The timeline has three steps.'],
    ['negated request', "Don't draw a timeline; explain it."],
    ['capability question', 'Can you make a timeline?'],
    ['named capability question', 'Can Jarvis draw a diagram?'],
    ['quoted instruction', 'The document says "draw a timeline". What does that mean?'],
    ['code request', 'Fix the timeline renderer component.'],
  ])('does not activate a direct visual for %s', (_label, request) => {
    expect(detectExplicitDirectVisualKind(request)).toBeUndefined();
  });

  it('rejects a direct kind mismatch, source claim, legacy kind, and attempted handoff', () => {
    const timeline = {
      kind: 'timeline', title: 'Plan', sourceRefs: [],
      items: [{ label: 'One', title: 'Start' }, { label: 'Two', title: 'Finish' }],
    };
    const answer = 'Plan. One: Start. Two: Finish.';
    const parsed = extractJarvisDirectives([answer, '```oshal:visual', JSON.stringify(timeline), '```'].join('\n'));
    expect(visualSpecForDirectRequest(parsed, 'Draw a diagram.', 'jarvis-answer:3')).toBeUndefined();
    expect(visualSpecForDirectRequest(
      extractJarvisDirectives([answer, '```oshal:visual', JSON.stringify({ ...timeline, sourceRefs: ['made-up'] }), '```'].join('\n')),
      'Make a timeline.', 'jarvis-answer:3',
    )).toBeUndefined();
    expect(visualSpecForDirectRequest(
      extractJarvisDirectives(visualFence({ kind: 'summary', title: 'Plan', sourceRefs: [], bullets: ['Start'] })),
      'Show a visual summary card.', 'jarvis-answer:3',
    )).toBeUndefined();
    expect(visualSpecForDirectRequest(
      extractJarvisDirectives([answer, '```oshal:visual', JSON.stringify(timeline), '```', '```handoff', '{"title":"Later"}', '```'].join('\n')),
      'Make a timeline.', 'jarvis-answer:3',
    )).toBeUndefined();
  });

  it('accepts provider records only from structured manifest-worker bot-node metadata', () => {
    const providerRecord = {
      schemaVersion: 1,
      kind: 'nws-weather',
      provider: 'nws',
      sourceRef: 'nws:forecast:captured',
      retrievedAt: '2026-07-10T14:00:00.000Z',
      record: {
        location: 'Chicago, IL',
        timestamp: '2026-07-10T14:00:00.000Z',
        current: { tempF: 82, tempC: 28, condition: 'Sunny' },
        periods: [],
      },
    };
    expect(trustedProviderRecordsFromJarvisWorkMessage({
      metadata: {
        source: 'manifest-worker-bot-node',
        manifestWorkerResult: true,
        providerRecords: [providerRecord, providerRecord, { kind: 'forged' }],
      },
    })).toEqual([providerRecord]);
    expect(trustedProviderRecordsFromJarvisWorkMessage({
      metadata: { source: 'model-text', manifestWorkerResult: true, providerRecords: [providerRecord] },
    })).toEqual([]);
    expect(trustedProviderRecordsFromJarvisWorkMessage({
      metadata: { source: 'manifest-worker-bot-node', manifestWorkerResult: false, providerRecords: [providerRecord] },
    })).toEqual([]);

    expect(providerRecordsMatchingTrustedIntent({
      metadata: {
        source: 'manifest-worker-bot-node', manifestWorkerResult: true, providerRecords: [providerRecord],
      },
    })).toEqual([]);
    expect(providerRecordsMatchingTrustedIntent({
      metadata: {
        source: 'manifest-worker-bot-node', manifestWorkerResult: true, providerRecords: [providerRecord],
        providerIntent: {
          schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Chicago, IL',
        },
      },
    })).toEqual([providerRecord]);
    expect(providerRecordsMatchingTrustedIntent({
      metadata: {
        source: 'manifest-worker-bot-node', manifestWorkerResult: true, providerRecords: [providerRecord],
        providerIntent: {
          schemaVersion: 1, kind: 'walmart-catalog', operation: 'product-search', query: 'fish food', limit: 2,
        },
      },
    })).toEqual([]);
  });

  it('summarizes trusted provider facts without model-authored values', () => {
    expect(summarizeProviderBoundRecords([{
      schemaVersion: 1,
      kind: 'nws-weather',
      provider: 'nws',
      sourceRef: 'nws:forecast:captured',
      retrievedAt: '2026-07-10T14:00:00.000Z',
      record: {
        location: 'Destin, FL', timestamp: '2026-07-10T14:00:00.000Z',
        current: {
          tempF: 86, tempC: 30, condition: 'Partly Cloudy', humidityPercent: 72,
          windSpeedMph: 9, windDirection: 'S', validFrom: '2026-07-10T10:00:00-05:00',
        },
        periods: [{ label: 'Tonight', tempF: 79, tempC: 26, condition: 'Mostly Clear' }],
      },
    }])).toBe(
      'In Destin, FL, it is 86°F (30°C) with Partly Cloudy. Humidity 72%, wind S 9 mph. '
      + 'Next: Tonight: 79°F, Mostly Clear. Source: National Weather Service, updated 2026-07-10T10:00:00-05:00.',
    );

    expect(summarizeProviderBoundRecords([{
      schemaVersion: 1,
      kind: 'gmail-summary',
      provider: 'gmail',
      sourceRef: 'gmail:summary:captured',
      retrievedAt: '2026-07-10T14:00:00.000Z',
      mailbox: 'connected Gmail',
      messages: [{
        sourceRef: 'gmail:message:1', id: '1', sender: 'Ada', subject: 'Decision needed',
        unread: true, important: true, starred: false,
      }],
    }])).toContain('Gmail flagged 1 priority message');

    expect(summarizeProviderBoundRecords([{
      schemaVersion: 1,
      kind: 'walmart-catalog',
      provider: 'walmart',
      sourceRef: 'walmart:catalog:captured',
      retrievedAt: '2026-07-12T14:30:00.000Z',
      query: 'fish food',
      items: [{
        sourceRef: 'walmart:item:1', productId: '10849069', title: 'TetraMin [Tropical] | Flakes',
        brand: 'Tetra', price: 7.97, currency: 'USD',
        imageUrl: 'https://i5.walmartimages.com/asr/tetra.jpeg',
        productUrl: 'https://www.walmart.com/ip/10849069?affiliate=|PUBID|',
      }],
    }])).toBe([
      'I found 1 live Walmart result for “fish food.” This was a read-only search; nothing was added to a cart or ordered.',
      '',
      '| Product | Current price |',
      '|---|---:|',
      '| [TetraMin (Tropical) ¦ Flakes](https://www.walmart.com/ip/10849069?affiliate=%7CPUBID%7C) | $7.97 |',
      '',
      'Source: Walmart catalog, retrieved 2026-07-12T14:30:00.000Z.',
    ].join('\n'));
  });

  it('strips malformed or duplicated visual directives without creating a visual', () => {
    const malformed = extractJarvisDirectives(visualFence({ kind: 'weather', title: 'Missing fields' }));
    expect(malformed.cleanAnswer).toBe('Here is the forecast.');
    expect(malformed.visualSpec).toBeUndefined();

    const duplicated = extractJarvisDirectives(`${visualFence(weather)}\n${visualFence(weather)}`);
    expect(duplicated.cleanAnswer).toBe('Here is the forecast.\n\nHere is the forecast.');
    expect(duplicated.visualSpec).toBeUndefined();

    const proseWrapped = extractJarvisDirectives(
      `Here is the forecast.\n\n\`\`\`oshal:visual\nResult: ${JSON.stringify(weather)}\n\`\`\``,
    );
    expect(proseWrapped.cleanAnswer).toBe('Here is the forecast.');
    expect(proseWrapped.visualSpec).toBeUndefined();

    const truncated = extractJarvisDirectives('Here is the forecast.\n\n```oshal:visual\n{"kind":"weather"');
    expect(truncated).toEqual({ cleanAnswer: 'Here is the forecast.', handoffs: [] });
  });

  it('suppresses a schema-valid visual when the same response hands work off', () => {
    const reply = [
      visualFence(weather),
      '```handoff',
      '{"action":"create","title":"Refresh forecast","description":"Fetch current weather."}',
      '```',
    ].join('\n');
    const parsed = extractJarvisDirectives(reply);

    expect(parsed.visualSpec).toMatchObject(weather);
    expect(parsed.handoffs).toHaveLength(1);
    expect(visualSpecForDelayedCompletion(parsed)).toBeUndefined();
    expect(parsed.cleanAnswer).not.toContain('oshal:visual');
    expect(parsed.cleanAnswer).not.toContain('handoff');
  });

  it('suppresses a visual whenever a malformed handoff fence was attempted', () => {
    const parsed = extractJarvisDirectives(`${visualFence(weather)}\n\n\`\`\`handoff\n{"title":"unfinished"}`);

    expect(parsed.visualSpec).toMatchObject(weather);
    expect(parsed.handoffs).toEqual([]);
    expect(parsed.hadHandoffFence).toBe(true);
    expect(visualSpecForDelayedCompletion(parsed)).toBeUndefined();
  });

  it('keeps the legacy handoff parser compatible while stripping visual control syntax', () => {
    const parsed = extractHandoffs(visualFence(weather));
    expect(parsed).toEqual({ cleanAnswer: 'Here is the forecast.', handoffs: [] });
  });
});

describe('completed Markdown table visual fallback', () => {
  const title = "Order Ben & Jerry's ice cream + fish food";
  const ticketSource = 'ticket:08ad8960-2920-4761-9cf4-6d126b1119b7';
  const result = [
    'The order task finished with a partial handoff:',
    '',
    '| Item | Status | Note |',
    '|---|---|---|',
    '| Ben & Jerry’s ice cream | Ready for you in Uber Eats | Store/item selection needs confirmation. |',
    '| Fish food | Not added | Walmart was not connected, so nothing unrelated was added. |',
    '',
    'Uber Eats link: [Ben & Jerry’s ice cream search](https://www.ubereats.com/search?q=Ben%20Jerry)',
  ].join('\n');

  it('copies one bounded plain table into a ticket-grounded typed visual', () => {
    expect(visualSpecFromCompletedMarkdownTable(result, title, ticketSource)).toEqual({
      schemaVersion: 1,
      kind: 'table',
      title,
      sourceRefs: [ticketSource],
      columns: ['Item', 'Status', 'Note'],
      rows: [
        ['Ben & Jerry’s ice cream', 'Ready for you in Uber Eats', 'Store/item selection needs confirmation.'],
        ['Fish food', 'Not added', 'Walmart was not connected, so nothing unrelated was added.'],
      ],
    });
  });

  it('copies the visible label from an exact safe HTTPS table link', () => {
    const linkedResult = [
      '| Option | Price | Link |',
      '|---|---:|---|',
      '| Tetra TetraMin Tropical Flakes | $7.97 | [View at Walmart](https://www.walmart.com/ip/10849069) |',
    ].join('\n');

    expect(visualSpecFromCompletedMarkdownTable(linkedResult, title, ticketSource)).toEqual({
      schemaVersion: 1,
      kind: 'table',
      title,
      sourceRefs: [ticketSource],
      columns: ['Option', 'Price', 'Link'],
      rows: [['Tetra TetraMin Tropical Flakes', '$7.97', 'View at Walmart']],
    });
  });

  it('unwraps exact inline code used for deliverable filenames', () => {
    const deliverablesResult = [
      '| File | What it is |',
      '|---|---|',
      '| `eureka_springs_gallery.html` | Interactive gallery |',
    ].join('\n');

    expect(visualSpecFromCompletedMarkdownTable(deliverablesResult, title, ticketSource)).toEqual({
      schemaVersion: 1,
      kind: 'table',
      title,
      sourceRefs: [ticketSource],
      columns: ['File', 'What it is'],
      rows: [['eureka_springs_gallery.html', 'Interactive gallery']],
    });
  });

  it('bounds long tables and deterministically displays the first of multiple tables', () => {
    const nineRows = [
      '| Item | Status |', '|---|---|',
      ...Array.from({ length: 9 }, (_, index) => `| Item ${index + 1} | Ready |`),
    ].join('\n');
    const twoTables = `${result}\n\n| Item | Status |\n|---|---|\n| Cone | Ready |`;

    expect(visualSpecFromCompletedMarkdownTable(nineRows, title, ticketSource)).toEqual({
      schemaVersion: 1,
      kind: 'table',
      title,
      sourceRefs: [ticketSource],
      columns: ['Item', 'Status'],
      rows: Array.from({ length: 8 }, (_, index) => [`Item ${index + 1}`, 'Ready']),
      caption: 'Showing the first table (first 8 of 9 rows); full result remains below',
    });
    expect(visualSpecFromCompletedMarkdownTable(twoTables, title, ticketSource)).toEqual({
      schemaVersion: 1,
      kind: 'table',
      title,
      sourceRefs: [ticketSource],
      columns: ['Item', 'Status', 'Note'],
      rows: [
        ['Ben & Jerry\u2019s ice cream', 'Ready for you in Uber Eats', 'Store/item selection needs confirmation.'],
        ['Fish food', 'Not added', 'Walmart was not connected, so nothing unrelated was added.'],
      ],
      caption: 'Showing the first table; full result remains below',
    });
  });

  it('refuses mixed inline markup, unsafe links, and fenced tables', () => {
    const inlineLink = '| Item | Status |\n|---|---|\n| See [Cone](https://example.test) | Ready |';
    const unsafeLink = '| Item | Status |\n|---|---|\n| [Cone](javascript:alert(1)) | Ready |';
    const fenced = '```md\n| Item | Status |\n|---|---|\n| Cone | Ready |\n```';

    expect(visualSpecFromCompletedMarkdownTable(inlineLink, title, ticketSource)).toBeUndefined();
    expect(visualSpecFromCompletedMarkdownTable(unsafeLink, title, ticketSource)).toBeUndefined();
    expect(visualSpecFromCompletedMarkdownTable(fenced, title, ticketSource)).toBeUndefined();
  });
});

function makeCtx() {
  return {
    messageStore: {
      save: vi.fn().mockResolvedValue(undefined),
    },
    taskStore: {
      incrementMessageCount: vi.fn().mockResolvedValue(undefined),
      incrementTurnCount: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('Jarvis task lifecycle persistence', () => {
  it('increments message count for saved user turns without counting a completed assistant turn', async () => {
    const ctx = makeCtx();

    await persistJarvisTurn(ctx as never, 'jarvis-session-1', 'user', 'hello');

    expect(ctx.messageStore.save).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'jarvis-session-1',
      role: 'user',
      type: 'task',
      text: 'hello',
    }));
    expect(ctx.taskStore.incrementMessageCount).toHaveBeenCalledWith('jarvis-session-1');
    expect(ctx.taskStore.incrementTurnCount).not.toHaveBeenCalled();
  });

  it('increments message and turn counters for saved assistant turns', async () => {
    const ctx = makeCtx();

    await persistJarvisTurn(ctx as never, 'jarvis-session-1', 'assistant', 'done');

    expect(ctx.taskStore.incrementMessageCount).toHaveBeenCalledWith('jarvis-session-1');
    expect(ctx.taskStore.incrementTurnCount).toHaveBeenCalledWith('jarvis-session-1', 1);
  });

  it('updates the durable Jarvis task lifecycle status', async () => {
    const ctx = makeCtx();

    await markJarvisSessionTaskStatus(ctx as never, 'jarvis-session-1', 'processing');
    await markJarvisSessionTaskStatus(ctx as never, 'jarvis-session-1', 'active');

    expect(ctx.taskStore.updateStatus).toHaveBeenNthCalledWith(1, 'jarvis-session-1', 'processing');
    expect(ctx.taskStore.updateStatus).toHaveBeenNthCalledWith(2, 'jarvis-session-1', 'active');
  });

  it('surfaces complete and customer-action results while keeping escalations as errors', () => {
    expect(mapJarvisTaskStatusFromTicketStatus('complete')).toBe('done');
    expect(mapJarvisTaskStatusFromTicketStatus('customer_action')).toBe('done');
    expect(mapJarvisTaskStatusFromTicketStatus('cancelled')).toBe('error');
    expect(mapJarvisTaskStatusFromTicketStatus('escalated')).toBe('error');
    expect(mapJarvisTaskStatusFromTicketStatus('approved')).toBe('running');
  });

  it('persists completed background visual metadata with the task result', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const visual = {
      artifactId: '8f3b2cb0-4bba-45f5-8d73-10732fa13469',
      type: 'image',
      kind: 'weather',
      url: '/api/jarvis/visuals/8f3b2cb0-4bba-45f5-8d73-10732fa13469',
      mimeType: 'image/svg+xml',
    };

    await finishTask(pool as never, 'work-1', true, 'The forecast is ready.', visual as never);

    const [sql, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('visual = $4::jsonb');
    // Trailing null is the `files` slot (captured deliverables). This call passes none, and the
    // distinction matters: null must be written, not omitted, so a retry cannot leave a previous
    // run's downloads attached to a fresh result.
    expect(values).toEqual(['work-1', 'done', 'The forecast is ready.', JSON.stringify(visual), null]);
  });

  it('clears stale visual metadata when a work item is retried', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };

    await saveTaskPending(pool as never, 'work-1', 'user-a', 'session-a', 'Refresh weather', 'complex', 'ticket-a');

    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain('visual = NULL');
  });

  it('returns only a validated owner-route visual from durable task metadata', () => {
    const artifactId = '8f3b2cb0-4bba-45f5-8d73-10732fa13469';
    const visual = {
      artifactId, type: 'image', kind: 'weather',
      url: `/api/jarvis/visuals/${artifactId}`, mimeType: 'image/svg+xml',
      alt: 'Pensacola weather: 84 degrees and partly cloudy', width: 1280, height: 720,
    };

    expect(storedVisual({ visual })).toEqual(visual);
    expect(storedVisual({ visual: { ...visual, url: 'https://attacker.example/image.svg' } })).toBeUndefined();
    expect(storedVisual({ visual: { ...visual, artifactId: 'artifact-1' } })).toBeUndefined();
    expect(storedVisual({ visual: { ...visual, kind: 'arbitrary-html' } })).toBeUndefined();
    expect(storedVisual({ visual: { ...visual, alt: '' } })).toBeUndefined();
    expect(storedVisual({ visual: { ...visual, alt: 'A'.repeat(421) } })).toBeUndefined();
    expect(storedVisual({ visual: { ...visual, width: '1280' } })).toBeUndefined();
    expect(storedVisual({ visual: { ...visual, height: 719.5 } })).toBeUndefined();
    expect(storedVisual({ visual: { ...visual, width: Number.POSITIVE_INFINITY } })).toBeUndefined();
  });

  it('resolves the owner-scoped conversation for durable background result archiving', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ session_id: 'jarvis-session-a' }] }) };

    await expect(findJarvisTaskSessionId({ pool } as never, 'user-a', 'work-1'))
      .resolves.toBe('jarvis-session-a');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('id = $1 AND user_sub = $2'),
      ['work-1', 'user-a'],
    );
  });
});

describe('maskPendingComplexSummaries (complex-task delivery race)', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    id: 't1', title: 'Order Uber', status: 'done', result: null as string | null,
    kind: 'complex', ticketId: 'tix-1', ...over,
  });
  const ctxWithClaim = (rowCount: number | null) => ({
    pool: {
      query: rowCount === null
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: 't1' }] : [] }),
    },
  });

  it('never reports a pending-summary task as done — masks it as summarizing and fires the summary', async () => {
    const ctx = ctxWithClaim(1);
    const fire = vi.fn().mockResolvedValue(undefined);
    const tasks = [task()];

    await maskPendingComplexSummaries(ctx as never, 'user-a', tasks, fire);

    // Reporting 'done' before the summary landed is the bug: the surface announced + marked the
    // task delivered with the placeholder, permanently suppressing the real result.
    expect(tasks[0].status).toBe('summarizing');
    expect(tasks[0].result).toBe('Reading the results…');
    expect(fire).toHaveBeenCalledWith(ctx, 'user-a', 't1', 'tix-1', 'Order Uber');
  });

  it('does not fire the summary again when another poller already holds a fresh claim', async () => {
    const ctx = ctxWithClaim(0);
    const fire = vi.fn().mockResolvedValue(undefined);
    const tasks = [task()];

    await maskPendingComplexSummaries(ctx as never, 'user-a', tasks, fire);

    expect(fire).not.toHaveBeenCalled();
    expect(tasks[0].status).toBe('summarizing');   // still masked while the other claim runs
  });

  it('still masks the task when the claim query fails, without firing', async () => {
    const ctx = ctxWithClaim(null);
    const fire = vi.fn().mockResolvedValue(undefined);
    const tasks = [task()];

    await maskPendingComplexSummaries(ctx as never, 'user-a', tasks, fire);

    expect(fire).not.toHaveBeenCalled();
    expect(tasks[0].status).toBe('summarizing');
  });

  it('leaves finished tasks with a landed summary untouched (deliverable as done)', async () => {
    const ctx = ctxWithClaim(1);
    const fire = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      task({ result: 'Your Uber handoff is ready.' }),
      task({ id: 't2', kind: 'simple', ticketId: null }),
    ];

    await maskPendingComplexSummaries(ctx as never, 'user-a', tasks, fire);

    expect(ctx.pool.query).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    expect(tasks[0].status).toBe('done');
    expect(tasks[0].result).toBe('Your Uber handoff is ready.');
    expect(tasks[1].status).toBe('done');
  });
});

describe('withImageDeliverableContract', () => {
  const handoff = (over: Record<string, unknown> = {}) => ({
    action: 'create' as const,
    title: 'Display images of Eureka Springs, Arkansas',
    description: 'Collect a sourced image gallery of the town.',
    complexity: 'simple' as const,
    platform: false,
    ...over,
  });

  it('appends the contract to an image-shaped, non-provider handoff', () => {
    const out = withImageDeliverableContract(handoff() as never);
    expect(out).toContain('Collect a sourced image gallery of the town.');
    expect(out).toContain('IMAGE DELIVERABLE CONTRACT');
    expect(out).toContain('deliverables/assets/');
    expect(out).toContain('RELATIVE path');
    expect(out).toContain('shell access and outbound network');
  });

  it('matches photo/picture/screenshot phrasing in the title alone', () => {
    for (const title of ['Get photos of the eclipse', 'Show pictures of my dashboard', 'Grab screenshots of the cockpit']) {
      const out = withImageDeliverableContract(handoff({ title, description: 'Do the thing.' }) as never);
      expect(out).toContain('IMAGE DELIVERABLE CONTRACT');
    }
  });

  it('leaves non-image handoffs untouched', () => {
    const plain = handoff({
      title: 'Find polling on candidate approval',
      description: 'Summarize the most recent public polling with sources.',
    });
    expect(withImageDeliverableContract(plain as never)).toBe(plain.description);
  });

  it('never augments provider-bound handoffs, even when they mention images', () => {
    const walmart = handoff({
      title: 'Live Walmart: fish food',
      description: 'Return at most 4 real products with current prices and product-image references.',
      providerIntent: { schemaVersion: 1, kind: 'walmart-catalog', operation: 'product-search', query: 'fish food', limit: 4 },
    });
    expect(withImageDeliverableContract(walmart as never)).toBe(walmart.description);
  });
});
