import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('cockpit operations theme polish', () => {
  it('keeps Operations legible in daylight by overriding dark-only alpha text with cockpit tokens', () => {
    const css = readFileSync(path.join(root, 'src/pages/cockpit/css/operations.css'), 'utf8');

    expect(css).toContain('Theme-aware polish layer');
    expect(css).toContain('--ops-surface');
    expect(css).toContain('--ops-text');
    expect(css).toContain('--ops-muted');
    expect(css).toContain('var(--text-primary');
    expect(css).toContain('var(--text-secondary');
    expect(css).toContain('.ops-ring-svg text');
    expect(css).toContain('.ops-table th');
    expect(css).toContain('.ops-kpi-label');
  });
});
