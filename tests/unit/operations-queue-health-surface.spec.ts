import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cockpit Operations queue health surface', () => {
  it('loads queue health and renders operator-visible blockers/actions', () => {
    const root = process.cwd();
    const view = readFileSync(
      path.join(root, 'src/pages/cockpit/js/views/OperationsView.js'),
      'utf8',
    );
    const css = readFileSync(
      path.join(root, 'src/pages/cockpit/css/operations.css'),
      'utf8',
    );
    const ribbon = readFileSync(
      path.join(root, 'src/pages/cockpit/js/components/RibbonNav.js'),
      'utf8',
    );

    expect(view).toContain('/api/v1/metrics/queue-health?scope=all');
    expect(view).toContain('_renderQueueHealth');
    expect(view).toContain('recentBlockers');
    expect(view).toContain('Provider Stalls');
    expect(view).toContain('providerRuntimeStalled');
    expect(view).toContain('Unassigned Esc');
    expect(view).toContain('unassignedEscalated');
    expect(view).toContain('ops-queue-actions');
    expect(css).toContain('.ops-queue-card--blocked');
    expect(css).toContain('.ops-queue-blocker');
    expect(ribbon).toContain("PINNED_PLATFORM_VIEW_IDS = ['operations', 'connectors']");
    expect(ribbon).toContain('this.views.push({ ...view, section:');
  });
});
