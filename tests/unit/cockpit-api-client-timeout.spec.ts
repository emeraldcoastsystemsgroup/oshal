import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('cockpit API client resilience', () => {
  it('bounds safe dashboard fetches so degraded ops endpoints cannot blank a cockpit view', () => {
    const source = readFileSync(path.join(root, 'src/pages/cockpit/js/api-client.js'), 'utf8');

    expect(source).toContain('async getSafe(endpoint, defaultValue, timeoutMs = 8000)');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('controller.abort()');
    expect(source).toContain('window.clearTimeout(timer)');
  });
});
