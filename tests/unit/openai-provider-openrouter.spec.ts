import { describe, expect, it, vi } from 'vitest';

// The any-bot runtime is CommonJS and intentionally remains executable without the TS build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenAIProvider = require('../../any-bot/server/services/llm/OpenAIProvider');

function provider(baseUrl?: string): any {
  return new OpenAIProvider({
    apiKey: 'test-key',
    model: 'openai/gpt-oss-20b:free',
    maxTokens: 1024,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

function completion(content: unknown, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [{
      message: { content, ...extras },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
  };
}

describe('OpenAI-compatible provider final-answer contract', () => {
  it('bounds and excludes OpenRouter reasoning while preserving multipart final text', async () => {
    const subject = provider('https://openrouter.ai/api/v1');
    const create = vi.fn().mockResolvedValue(completion([
      { type: 'text', text: 'Weather is ' },
      { type: 'output_text', text: 'clear.' },
    ]));
    subject.client.chat.completions.create = create;

    const result = await subject.generateResponse([{ role: 'user', content: 'Weather?' }]);

    expect(result.content).toBe('Weather is clear.');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { effort: 'low', exclude: true },
    }));
  });

  it('does not send the OpenRouter-only reasoning contract to other compatible endpoints', async () => {
    const subject = provider('https://llm.example.test/v1');
    const create = vi.fn().mockResolvedValue(completion('Ready.'));
    subject.client.chat.completions.create = create;

    await subject.generateResponse([{ role: 'user', content: 'Hello' }]);

    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });

  it('keeps endpoint credentials, paths, and query strings out of provider log labels', () => {
    const subject = provider('https://user:secret@openrouter.ai/api/v1?token=private');
    expect(subject.endpointLabel).toBe('openrouter.ai');
    expect(subject.endpointLabel).not.toContain('secret');
    expect(subject.endpointLabel).not.toContain('token');
  });

  it('fails explicitly instead of presenting private reasoning or a fake No response answer', async () => {
    const subject = provider('https://openrouter.ai/api/v1');
    subject.client.chat.completions.create = vi.fn().mockResolvedValue(completion('', {
      reasoning: 'internal chain of thought',
      reasoning_details: [{ type: 'reasoning.summary', summary: 'private' }],
    }));

    await expect(subject.generateResponse([{ role: 'user', content: 'Hello' }]))
      .rejects.toMatchObject({ code: 'EMPTY_FINAL_ANSWER' });
  });
});
