/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for VisionDescribeService against a mocked global fetch + mocked swarm credentials: happy path (multimodal body shape, usage.include, description + vendor cost parsed), fail-closed with no OpenRouter credential (no fetch), input validation (non-data-URL, empty list, >4 images), and a non-OK API response surfaced as a clean error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Silence + capture the service logger.
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

// Deterministic swarm credential — toggle `has` per test to exercise the fail-closed path.
const creds = vi.hoisted(() => ({ has: vi.fn(() => true), get: vi.fn(() => 'sk-openrouter-test') }));
vi.mock('@/features/llm-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/llm-provider')>();
  return { ...actual, hasSwarmApiKey: creds.has, getSwarmApiKey: creds.get };
});

import { VisionDescribeService } from '@/features/vision-describe';

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function okResponse(content: string, usage?: Record<string, number>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: usage ?? { prompt_tokens: 90, completion_tokens: 18, cost: 0.0013 } }),
    text: async () => '',
  };
}

describe('VisionDescribeService', () => {
  beforeEach(() => {
    creds.has.mockReturnValue(true);
    creds.get.mockReturnValue('sk-openrouter-test');
    global.fetch = vi.fn().mockResolvedValue(okResponse('A red bicycle leaning on a brick wall.')) as unknown as typeof fetch;
  });
  afterEach(() => { vi.restoreAllMocks(); creds.has.mockReset(); creds.get.mockReset(); });

  it('describes an image and returns description + model + vendor cost', async () => {
    const svc = new VisionDescribeService(null);
    const out = await svc.describe({ images: [{ dataUrl: IMG }], question: 'what is this?', ownerSub: 'sub-1', taskId: 'jarvis-sub-1' });
    expect(out.description).toBe('A red bicycle leaning on a brick wall.');
    expect(out.imageCount).toBe(1);
    expect(out.cost).toBeCloseTo(0.0013, 6);
    expect(out.model).toBeTruthy();

    // The request must be a real multimodal payload: an instruction text part + the image_url part.
    const init = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as {
      messages: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
      usage?: { include?: boolean };
    };
    const parts = body.messages[0].content;
    expect(body.usage?.include).toBe(true);
    expect(parts.some((p) => p.type === 'text' && /what is this\?/i.test(p.text || ''))).toBe(true);
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === IMG)).toBe(true);
  });

  it('is unavailable and fails closed when no OpenRouter credential exists (no network call)', async () => {
    creds.has.mockReturnValue(false);
    const svc = new VisionDescribeService(null);
    expect(svc.isAvailable()).toBe(false);
    await expect(svc.describe({ images: [{ dataUrl: IMG }], ownerSub: 'sub-1' })).rejects.toThrow(/OpenRouter credential/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-data-URL image without calling the API', async () => {
    const svc = new VisionDescribeService(null);
    await expect(svc.describe({ images: [{ dataUrl: 'https://example.com/x.png' }], ownerSub: 'sub-1' })).rejects.toThrow(/image data URL/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty image list', async () => {
    const svc = new VisionDescribeService(null);
    await expect(svc.describe({ images: [], ownerSub: 'sub-1' })).rejects.toThrow(/at least one image/i);
  });

  it('rejects more than four images', async () => {
    const svc = new VisionDescribeService(null);
    const five = Array.from({ length: 5 }, () => ({ dataUrl: IMG }));
    await expect(svc.describe({ images: five, ownerSub: 'sub-1' })).rejects.toThrow(/at most 4/i);
  });

  it('surfaces a non-OK OpenRouter response as a clean error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) }) as unknown as typeof fetch;
    const svc = new VisionDescribeService(null);
    await expect(svc.describe({ images: [{ dataUrl: IMG }], ownerSub: 'sub-1' })).rejects.toThrow(/HTTP 429/);
  });
});
