/** Focused contract tests for strict, fact-locked visual responses. */

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  parseVisualResponseSpec,
  groundProviderBoundVisualSpec,
  VisualResponseService,
  renderVisualResponse,
  type FactLockedAnswerPacket,
  type VisualResponseProvenance,
  type VisualResponseSpec,
  type NwsWeatherProviderRecord,
  VISUAL_RESPONSE_KINDS,
} from '../../src/features/visual-response';
import { createJarvisVisualRoutes, createOptionalJarvisVisual } from '../../src/app/routes/jarvis-visual-response';
import { persistJarvisTurn } from '../../src/app/routes/jarvis-routes';

function weatherSpec(overrides: Partial<Extract<VisualResponseSpec, { kind: 'weather' }>> = {}): Extract<VisualResponseSpec, { kind: 'weather' }> {
  return {
    schemaVersion: 1,
    kind: 'weather',
    title: 'Weather today',
    sourceRefs: ['weather'],
    location: 'Chicago, IL',
    units: 'imperial',
    asOf: '2026-07-09T18:00:00-05:00',
    current: {
      temperature: 84,
      condition: 'Scattered thunderstorms',
      high: 87,
      low: 68,
      humidityPercent: 61,
      wind: 'SW 12 mph',
      precipitationPercent: 60,
    },
    periods: [
      { label: 'Now', temperature: 84, condition: 'Storms', precipitationPercent: 60 },
      { label: 'Tonight', temperature: 68, condition: 'Partly cloudy', precipitationPercent: 20 },
    ],
    ...overrides,
  };
}

function packet(overrides: Partial<FactLockedAnswerPacket> = {}): FactLockedAnswerPacket {
  const providerRecord: NwsWeatherProviderRecord = {
    schemaVersion: 1,
    kind: 'nws-weather',
    provider: 'nws',
    sourceRef: 'weather',
    retrievedAt: '2026-07-09T18:00:00-05:00',
    record: {
      location: 'Chicago, IL',
      timestamp: '2026-07-09T18:00:00-05:00',
      current: {
        tempF: 84,
        tempC: 29,
        condition: 'Scattered thunderstorms',
        humidityPercent: 61,
        precipitationPercent: 60,
        windSpeedMph: 12,
        windDirection: 'SW',
      },
      periods: [
        { label: 'Now', tempF: 84, tempC: 29, condition: 'Storms', precipitationPercent: 60 },
        { label: 'Tonight', tempF: 68, tempC: 20, condition: 'Partly cloudy', precipitationPercent: 20 },
      ],
    },
  };
  return {
    factLocked: true,
    sourceSurface: 'jarvis',
    sourceSessionId: 'session-123',
    sourceJobId: 'job-123',
    request: 'What is the weather today?',
    answer: 'It is 84°F with a 60% chance of rain after 3 PM.',
    sources: [{ type: 'tool', id: 'weather', label: 'Weather service' }],
    providerRecords: [providerRecord],
    visualSpec: weatherSpec(),
    ...overrides,
  };
}

describe('visual response runtime schema', () => {
  it('normalizes omitted version and source refs', () => {
    const parsed = parseVisualResponseSpec({
      kind: 'summary', title: 'Decision', bullets: ['Approve the launch'],
    });
    expect(parsed).toMatchObject({ schemaVersion: 1, sourceRefs: [], kind: 'summary' });
  });

  it('rejects malformed row and series dimensions', () => {
    expect(parseVisualResponseSpec({
      kind: 'table', title: 'Bad table', columns: ['A', 'B'], rows: [['only one']],
    })).toBeNull();
    expect(parseVisualResponseSpec({
      kind: 'chart', title: 'Bad chart', chartType: 'bar', categories: ['A', 'B'],
      series: [{ name: 'Total', values: [1] }],
    })).toBeNull();
  });

  it('requires provider source references for weather and priority email directives', () => {
    expect(parseVisualResponseSpec({
      kind: 'weather', title: 'No evidence', location: 'Chicago, IL', units: 'imperial',
      current: { temperature: 72, condition: 'Clear' }, sourceRefs: [],
    })).toBeNull();
    expect(parseVisualResponseSpec({
      kind: 'priority-email', title: 'No evidence', sourceRefs: [],
      items: [{ sourceRef: 'gmail:message:1', sender: 'A', subject: 'B' }],
    })).toBeNull();
  });

  it('bounds timelines and validates diagram identity, endpoints, uniqueness, and acyclicity', () => {
    expect(parseVisualResponseSpec({
      kind: 'timeline', title: 'Release plan',
      items: [{ label: 'Today', title: 'Plan' }, { label: 'Tomorrow', title: 'Build' }],
    })).toMatchObject({ kind: 'timeline', sourceRefs: [] });
    expect(parseVisualResponseSpec({
      kind: 'timeline', title: 'Too short', items: [{ label: 'Only', title: 'One' }],
    })).toBeNull();

    const validDiagram = {
      kind: 'diagram', title: 'Request flow', layout: 'flow',
      nodes: [{ id: 'user', label: 'User' }, { id: 'jarvis', label: 'Jarvis' }, { id: 'worker', label: 'Worker' }],
      edges: [
        { from: 'user', to: 'jarvis', label: 'asks' },
        { from: 'jarvis', to: 'worker', label: 'dispatches' },
      ],
    };
    expect(parseVisualResponseSpec(validDiagram)).toMatchObject({ kind: 'diagram', sourceRefs: [] });
    expect(parseVisualResponseSpec({
      ...validDiagram,
      nodes: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }],
      edges: [{ from: 'same', to: 'same', label: 'loops' }],
    })).toBeNull();
    expect(parseVisualResponseSpec({
      ...validDiagram,
      edges: [{ from: 'user', to: 'missing', label: 'loses' }],
    })).toBeNull();
    expect(parseVisualResponseSpec({
      ...validDiagram,
      edges: [
        { from: 'user', to: 'jarvis', label: 'asks' },
        { from: 'user', to: 'jarvis', label: 'requests' },
      ],
    })).toBeNull();
    expect(parseVisualResponseSpec({
      ...validDiagram,
      edges: [
        { from: 'user', to: 'jarvis', label: 'asks' },
        { from: 'jarvis', to: 'worker', label: 'dispatches' },
        { from: 'worker', to: 'user', label: 'returns' },
      ],
    })).toBeNull();
  });
});

describe('strict deterministic SVG renderer', () => {
  it('renders typed weather facts on a transparent stage without adding a popup background', () => {
    const rendered = renderVisualResponse(packet());
    const svg = rendered.content.toString('utf8');

    expect(rendered.mimeType).toBe('image/svg+xml');
    expect(rendered.kind).toBe('weather');
    expect(rendered.width).toBe(1280);
    expect(rendered.height).toBe(720);
    expect(rendered.answerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rendered.visualSpecSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(svg).toContain('84°F');
    expect(svg).toContain('Scattered thunderstorms');
    expect(svg).toContain('HIGH / LOW');
    expect(svg).toContain('87° / 68°');
    expect(svg).toContain('data-weather-glyph="storm"');
    expect(svg).toContain('Weather service');
    expect(svg).toContain('Sources');
    expect(svg).not.toContain('Fact-locked');
    expect(svg).not.toMatch(/<rect[^>]+width="1280"[^>]+height="720"/);
  });

  it('rejects a missing visual spec rather than manufacturing a generic text image', () => {
    expect(() => renderVisualResponse(packet({ visualSpec: undefined })))
      .toThrow('valid visualSpec');
  });

  it('escapes priority-email content so stored SVG cannot execute injected markup', () => {
    const rendered = renderVisualResponse(packet({
      visualSpec: {
        schemaVersion: 1,
        kind: 'priority-email',
        title: 'Important email',
        sourceRefs: ['mail'],
        items: [{
          sourceRef: 'gmail:message:1',
          sender: '<script>alert(1)</script>',
          subject: 'Quarterly review & approval',
          unread: true,
          importance: 'important',
          reason: 'Marked important',
          suggestedAction: 'Reply today',
        }],
      },
      sources: [{ type: 'connector', id: 'mail', label: 'Connected mailbox' }],
    }));
    const svg = rendered.content.toString('utf8');

    expect(rendered.kind).toBe('priority-email');
    expect(rendered.alt).toContain('Quarterly review & approval');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('Quarterly review &amp; approval');
    expect(svg).toContain('Suggested: Reply today');
  });

  it.each([
    ['table', {
      schemaVersion: 1, kind: 'table', title: 'Options', sourceRefs: [],
      columns: ['Option', 'Cost'], rows: [['Alpha', '$10'], ['Beta', '$20']],
    }],
    ['chart', {
      schemaVersion: 1, kind: 'chart', title: 'Monthly trend', sourceRefs: [], chartType: 'line',
      categories: ['May', 'June', 'July'], series: [{ name: 'Cases', values: [4, 7, 5] }],
    }],
    ['summary', {
      schemaVersion: 1, kind: 'summary', title: 'Launch readiness', sourceRefs: [],
      metrics: [{ label: 'Checks', value: '18/18' }], bullets: ['No release blockers'],
    }],
    ['timeline', {
      schemaVersion: 1, kind: 'timeline', title: 'Release plan', sourceRefs: [],
      items: [
        { label: 'Today', title: 'Define scope', detail: 'Agree on the boundary' },
        { label: 'Tomorrow', title: 'Implement', detail: 'Build the approved slice' },
      ],
    }],
    ['diagram', {
      schemaVersion: 1, kind: 'diagram', title: 'Request flow', sourceRefs: [], layout: 'hierarchy',
      nodes: [
        { id: 'user', label: 'User', detail: 'Makes a request' },
        { id: 'jarvis', label: 'Jarvis', detail: 'Routes the work' },
        { id: 'worker', label: 'Worker', detail: 'Produces the result' },
      ],
      edges: [
        { from: 'user', to: 'jarvis', label: 'asks' },
        { from: 'jarvis', to: 'worker', label: 'dispatches' },
      ],
    }],
  ] as const)('renders the explicit %s mode', (kind, visualSpec) => {
    const rendered = renderVisualResponse(packet({ visualSpec: visualSpec as VisualResponseSpec }));
    expect(rendered.kind).toBe(kind);
    expect(rendered.content.toString('utf8')).toContain(visualSpec.title);
  });

  it('keeps new structural visuals inert, escaped, and decision-relevant in alt text', () => {
    const timeline = renderVisualResponse(packet({ visualSpec: {
      schemaVersion: 1, kind: 'timeline', title: 'Release <plan>', sourceRefs: [],
      items: [
        { label: 'Today', title: 'Define & approve', detail: '<script>alert(1)</script>' },
        { label: 'Tomorrow', title: 'Implement' },
      ],
    } }));
    expect(timeline.alt).toContain('Today: Define & approve');
    expect(timeline.content.toString('utf8')).toContain('&lt;script&gt;');
    expect(timeline.content.toString('utf8')).not.toContain('<script>');

    const diagram = renderVisualResponse(packet({ visualSpec: {
      schemaVersion: 1, kind: 'diagram', title: 'Safe flow', sourceRefs: [], layout: 'flow',
      nodes: [{ id: 'a', label: 'Intake' }, { id: 'b', label: 'Worker' }],
      edges: [{ from: 'a', to: 'b', label: 'dispatches & waits' }],
    } }));
    expect(diagram.alt).toContain('Intake dispatches & waits Worker');
    expect(diagram.content.toString('utf8')).toContain('dispatches &amp; waits');
    expect(diagram.content.toString('utf8')).toContain('marker-end="url(#arrow)"');
  });

  it('bounds every persisted accessible description to the client replay contract', () => {
    const rendered = renderVisualResponse(packet({ visualSpec: {
      schemaVersion: 1, kind: 'priority-email', title: 'P'.repeat(120), sourceRefs: ['gmail:summary:1'],
      items: [
        { sourceRef: 'gmail:message:1', sender: 'A'.repeat(120), subject: 'B'.repeat(180) },
        { sourceRef: 'gmail:message:2', sender: 'C'.repeat(120), subject: 'D'.repeat(180) },
      ],
    } }));

    expect(rendered.alt.length).toBeLessThanOrEqual(420);
    expect(rendered.alt).toContain('priority emails');
  });

  it('keeps a maximum-length title out of the caption and content planes', () => {
    const title = 'T'.repeat(120);
    const rendered = renderVisualResponse(packet({ visualSpec: {
      schemaVersion: 1, kind: 'timeline', title, caption: 'Readable caption', sourceRefs: [],
      items: [{ label: 'One', title: 'Start' }, { label: 'Two', title: 'Finish' }],
    } }));
    const svg = rendered.content.toString('utf8');

    expect(rendered.alt).toContain(title);
    expect(svg).toContain(`${'T'.repeat(61)}…`);
    expect(svg).not.toContain(`<text x="72" y="149"`);
  });

  it('hashes semantically identical specs independently of object key order', () => {
    const first = renderVisualResponse(packet());
    const spec = weatherSpec();
    const reordered = {
      periods: spec.periods,
      current: spec.current,
      units: spec.units,
      location: spec.location,
      sourceRefs: spec.sourceRefs,
      title: spec.title,
      kind: spec.kind,
      schemaVersion: spec.schemaVersion,
      asOf: spec.asOf,
    } as VisualResponseSpec;
    const second = renderVisualResponse(packet({ visualSpec: reordered }));
    expect(second.visualSpecSha256).toBe(first.visualSpecSha256);
    expect(second.content.equals(first.content)).toBe(true);
  });
});

describe('visual response persistence', () => {
  it('persists bytes and returns authenticated metadata with typed provenance', async () => {
    const createdAt = new Date('2026-07-09T22:35:51.000Z');
    const pool = { query: vi.fn(async (sqlValue: string) => String(sqlValue).includes('SELECT artifact_id')
      ? { rows: [], rowCount: 0 }
      : {
          rows: [{ artifact_id: '8f3b2cb0-4bba-45f5-8d73-10732fa13469', created_at: createdAt }],
          rowCount: 1,
        }) };
    const service = new VisualResponseService(pool as never);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    const artifact = await service.createArtifact('user-a', packet());

    expect(artifact.url).toBe('/api/jarvis/visuals/8f3b2cb0-4bba-45f5-8d73-10732fa13469');
    expect(artifact.kind).toBe('weather');
    expect(artifact.alt).toContain('Chicago');
    expect(artifact.provenance.factLocked).toBe(true);
    expect(artifact.provenance.visualKind).toBe('weather');
    expect(artifact.provenance.visualSpecSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.provenance.sources[0].id).toBe('weather');
    const insertCall = pool.query.mock.calls.find(([sqlValue]) => String(sqlValue).includes('INSERT INTO visual_response_artifacts'))!;
    const params = insertCall[1] as unknown[];
    expect(params[1]).toBe('user-a');
    expect(params[9]).toBeInstanceOf(Buffer);
    expect(String(params[11])).not.toContain('It is 84');
  });

  it('rejects source references not present in the fact-locked packet', async () => {
    const pool = { query: vi.fn() };
    const service = new VisualResponseService(pool as never);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    await expect(service.createArtifact('user-a', packet({
      visualSpec: {
        schemaVersion: 1, kind: 'table', title: 'Bound table', sourceRefs: ['missing'],
        columns: ['A', 'B'], rows: [['1', '2']],
      },
      providerRecords: [],
      sources: [],
    })))
      .rejects.toThrow('unavailable source');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a provider visual when no matching provider record is present', async () => {
    const pool = { query: vi.fn() };
    const service = new VisualResponseService(pool as never);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    await expect(service.createArtifact('user-a', packet({ providerRecords: [] })))
      .rejects.toThrow('matching provider record');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('reuses the immutable artifact when a retry renders the same bytes', async () => {
    const sourcePacket = packet();
    const grounded = groundProviderBoundVisualSpec(sourcePacket.visualSpec, sourcePacket.providerRecords);
    const rendered = renderVisualResponse({ ...sourcePacket, visualSpec: grounded!.visualSpec });
    const contentSha256 = createHash('sha256').update(rendered.content).digest('hex');
    const provenance: VisualResponseProvenance = {
      factLocked: true,
      renderer: rendered.renderer,
      answerSha256: rendered.answerSha256,
      visualSpecSha256: rendered.visualSpecSha256,
      visualKind: rendered.kind,
      sourceSurface: 'jarvis',
      sourceSessionId: 'session-123',
      sourceJobId: 'job-123',
      sources: [{ type: 'tool', id: 'weather', label: 'Weather service' }],
      generatedAt: '2026-07-09T22:35:51.000Z',
    };
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        artifact_id: '8f3b2cb0-4bba-45f5-8d73-10732fa13469',
        mime_type: 'image/svg+xml', width: 1280, height: 720,
        alt_text: rendered.alt, content: rendered.content, content_sha256: contentSha256,
        provenance, created_at: '2026-07-09T22:35:51.000Z',
      }] }),
    };
    const service = new VisualResponseService(pool as never);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    const artifact = await service.createArtifact('user-a', packet());

    expect(artifact.artifactId).toBe('8f3b2cb0-4bba-45f5-8d73-10732fa13469');
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('refuses to mutate an archived URL when the same source job renders different bytes', async () => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        artifact_id: '8f3b2cb0-4bba-45f5-8d73-10732fa13469', mime_type: 'image/svg+xml',
        width: 1280, height: 720, alt_text: 'Old visual', content: Buffer.from('<svg/>'),
        content_sha256: 'different', provenance: {}, created_at: '2026-07-09T22:35:51.000Z',
      }] }),
    };
    const service = new VisualResponseService(pool as never);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    await expect(service.createArtifact('user-a', packet()))
      .rejects.toThrow('immutability conflict');
  });

  it('scopes artifact reads to both artifact id and authenticated owner', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const service = new VisualResponseService(pool as never);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    const result = await service.getArtifact('user-b', '8f3b2cb0-4bba-45f5-8d73-10732fa13469');

    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('artifact_id = $1 AND user_sub = $2'), [
      '8f3b2cb0-4bba-45f5-8d73-10732fa13469', 'user-b',
    ]);
  });

  it.each(VISUAL_RESPONSE_KINDS)('preserves the %s kind when an artifact is loaded for replay', async (kind) => {
    const artifactId = '8f3b2cb0-4bba-45f5-8d73-10732fa13469';
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      artifact_id: artifactId,
      mime_type: 'image/svg+xml', width: 1280, height: 720,
      alt_text: `${kind} accessible answer`, content: Buffer.from('<svg/>'), content_sha256: 'abc123',
      provenance: {
        factLocked: true, renderer: 'test', answerSha256: 'answer', visualSpecSha256: 'spec',
        visualKind: kind, sourceSurface: 'jarvis', sourceSessionId: 'session', sourceJobId: 'job',
        sources: [], generatedAt: '2026-07-11T00:00:00.000Z',
      },
      created_at: '2026-07-11T00:00:00.000Z',
    }] }) };
    const service = new VisualResponseService(pool as never);
    vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);

    const artifact = await service.getArtifact('user-a', artifactId);

    expect(artifact?.metadata.kind).toBe(kind);
    expect(artifact?.metadata.provenance.visualKind).toBe(kind);
  });
});

describe('Jarvis optional visual integration', () => {
  it('does not call the service when the answer has no visual spec', async () => {
    const service = { createArtifact: vi.fn() };

    const visual = await createOptionalJarvisVisual(service as never, 'user-a', packet({ visualSpec: undefined }));

    expect(visual).toBeUndefined();
    expect(service.createArtifact).not.toHaveBeenCalled();
  });

  it('does not call the service for an invalid runtime directive', async () => {
    const service = { createArtifact: vi.fn() };
    const invalidPacket = { ...packet(), visualSpec: { kind: 'summary', title: 'Empty' } } as unknown as FactLockedAnswerPacket;

    const visual = await createOptionalJarvisVisual(service as never, 'user-a', invalidPacket);

    expect(visual).toBeUndefined();
    expect(service.createArtifact).not.toHaveBeenCalled();
  });

  it('returns undefined on renderer failure so the existing text answer remains usable', async () => {
    const service = { createArtifact: vi.fn().mockRejectedValue(new Error('database unavailable')) };

    const visual = await createOptionalJarvisVisual(service as never, 'user-a', packet());

    expect(visual).toBeUndefined();
    expect(service.createArtifact).toHaveBeenCalledWith('user-a', expect.objectContaining({
      factLocked: true,
      visualSpec: expect.objectContaining({ kind: 'weather' }),
    }));
  });

  it('archives the visual reference beside the authoritative discussion text', async () => {
    const ctx = {
      messageStore: { save: vi.fn().mockResolvedValue(undefined) },
      taskStore: {
        incrementMessageCount: vi.fn().mockResolvedValue(undefined),
        incrementTurnCount: vi.fn().mockResolvedValue(undefined),
      },
    };
    const visual = {
      artifactId: '8f3b2cb0-4bba-45f5-8d73-10732fa13469', type: 'image', kind: 'weather',
      url: '/api/jarvis/visuals/8f3b2cb0-4bba-45f5-8d73-10732fa13469',
    };

    await persistJarvisTurn(ctx as never, 'session-123', 'assistant', 'The durable answer.', { visual });

    expect(ctx.messageStore.save).toHaveBeenCalledWith(expect.objectContaining({
      text: 'The durable answer.', metadata: { visual },
    }));
  });
});

describe('authenticated Jarvis visual response route', () => {
  it('allows only embedded data images inside a sandboxed SVG response', async () => {
    const artifactId = '8f3b2cb0-4bba-45f5-8d73-10732fa13469';
    const content = Buffer.from([
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">',
      '<image href="data:image/png;base64,iVBORw0KGgo=" width="320" height="240"/>',
      '</svg>',
    ].join(''));
    const service = {
      getArtifact: vi.fn().mockResolvedValue({
        metadata: { mimeType: 'image/svg+xml' },
        content,
        contentSha256: createHash('sha256').update(content).digest('hex'),
      }),
    };
    const app = express();
    app.use((req, _res, next) => {
      (req as typeof req & { oidc: { user: { sub: string } } }).oidc = { user: { sub: 'owner-a' } };
      next();
    });
    app.use('/api/jarvis/visuals', createJarvisVisualRoutes(service as never));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jarvis/visuals/${artifactId}`);
      const policy = response.headers.get('content-security-policy');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
      expect(policy).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      expect(policy).not.toMatch(/img-src[^;]*https?:/i);
      expect(service.getArtifact).toHaveBeenCalledWith('owner-a', artifactId);
      expect(await response.text()).toContain('href="data:image/png;base64,');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
