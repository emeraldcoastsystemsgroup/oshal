import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

describe('Docker runtime assets', () => {
  it.each(['Dockerfile', 'Dockerfile.oshal'])('%s copies OSHAL app helper scripts', (dockerfile) => {
    const source = readFileSync(join(ROOT, dockerfile), 'utf8');

    expect(source).toContain('COPY scripts/oshal-*.js ./scripts/');
  });
});
