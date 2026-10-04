/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise shipped status reads and DOM updates so omitted fleet metrics clear stale counts without inventing zero or altering caller work totals.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** @description Evaluate shipped controller/formatter code with only DOM and logging collaborators doubled. */
function statusSurface() {
  const elements = Object.fromEntries(['statusBots', 'statusTickets', 'statusCost', 'statusQueue']
    .map(id => [id, { textContent: '', title: '' }]));
  const getSafe = vi.fn();
  const controller = readFileSync(resolve('src/pages/cockpit/js/cockpit-status-controller.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class CockpitStatusController', 'class CockpitStatusController');
  const formatters = readFileSync(resolve('src/pages/cockpit/js/utils/formatters.js'), 'utf8')
    .replace(/^export function /gm, 'function ');
  const Controller = runInNewContext(`${formatters}\n${controller}\nCockpitStatusController`, {
    createUiLogger: () => ({ debug() {}, info() {}, warn() {} }),
    document: { getElementById: (id: string) => elements[id] ?? null },
  });
  return { controller: new Controller({ api: { getSafe } }), elements, getSafe };
}

describe('cockpit fleet status surface', () => {
  it('clears a previous operator fleet count when the caller-scoped response omits fleet', async () => {
    const surface = statusSurface();
    surface.getSafe.mockResolvedValueOnce({ data: { agents: { total: 89 }, total: 8, queue: 7, estimatedTotalCost: 12 } });
    await surface.controller.loadMetrics();
    expect(surface.elements.statusBots.textContent).toBe('89 bots');
    surface.getSafe.mockResolvedValueOnce({ data: { total: 1, queue: 1, estimatedTotalCost: 1.5 } });
    await surface.controller.loadMetrics();
    expect(surface.getSafe).toHaveBeenLastCalledWith('/api/v1/metrics/summary', null);
    expect(surface.elements.statusBots.textContent).toBe('Bots: unknown');
    expect(surface.elements.statusBots.title).toContain('unavailable');
    expect(surface.elements.statusTickets.textContent).toBe('1 tickets');
    expect(surface.elements.statusQueue.textContent).toBe('Q: 1');
    expect(surface.elements.statusCost.textContent).toBe('$1.50');
  });

  it('shows an actual operator zero and removes the unknown tooltip on recovery', async () => {
    const surface = statusSurface();
    surface.getSafe.mockResolvedValueOnce({ data: { total: 1 } });
    await surface.controller.loadMetrics();
    expect(surface.elements.statusBots.textContent).toBe('Bots: unknown');
    surface.getSafe.mockResolvedValueOnce({ data: { agents: { total: 0 }, total: 0, queue: 0 } });
    await surface.controller.loadMetrics();
    expect(surface.elements.statusBots.textContent).toBe('0 bots');
    expect(surface.elements.statusBots.title).toBe('');
    expect(surface.elements.statusTickets.textContent).toBe('0 tickets');
    expect(surface.elements.statusQueue.textContent).toBe('Q: 0');
  });

  it('clears stale fleet when the summary is unreadable without inventing new work totals', async () => {
    const surface = statusSurface();
    surface.getSafe.mockResolvedValueOnce({ data: { agents: { total: 3 }, total: 2, queue: 1 } });
    await surface.controller.loadMetrics();
    surface.getSafe.mockResolvedValueOnce(null);
    await surface.controller.loadMetrics();
    expect(surface.elements.statusBots.textContent).toBe('Bots: unknown');
    expect(surface.elements.statusTickets.textContent).toBe('2 tickets');
    expect(surface.elements.statusQueue.textContent).toBe('Q: 1');
  });

  it.each([null, {}, { total: null }, { total: 'not-a-count' }, { total: -1 }])(
    'does not present an absent or malformed fleet value as zero (%j)', async (agents) => {
      const surface = statusSurface();
      surface.getSafe.mockResolvedValueOnce({ data: { agents, total: 1, queue: 1 } });
      await surface.controller.loadMetrics();
      expect(surface.elements.statusBots.textContent).toBe('Bots: unknown');
      expect(surface.elements.statusQueue.textContent).toBe('Q: 1');
    },
  );
});
