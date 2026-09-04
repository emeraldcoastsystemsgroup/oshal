/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Jarvis catch-up summary (operator, 2026-09-04: sixteen finished Kalshi rows were announced one at a time on every open). Evaluates the surface's own catch-up block and deliverFresh from jarvis.html in a VM: a batch folds into ONE sentence of counts by source, largest first; a single result that lands while the page is open is still announced by name; nothing unfinished is ever counted; and the poll loop itself no longer announces per task.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'src/api/jarvis.html'), 'utf8');

interface Group { source: string; done: number; failed: number }
interface Summary { total: number; failed: number; groups: Group[]; text: string }
interface Task { id: string; title: string; status: string }

/** The pure block between the markers — the exact bytes the browser runs. */
function catchupBlock(): string {
  const start = html.indexOf('/* @jarvis-catchup-begin */');
  const end = html.indexOf('/* @jarvis-catchup-end */');
  expect(start, 'catch-up block start marker missing from jarvis.html').toBeGreaterThanOrEqual(0);
  expect(end, 'catch-up block end marker missing from jarvis.html').toBeGreaterThan(start);
  return html.slice(start, end);
}

/** deliverFresh as written in the surface (the branch between name-announce and summary). */
function deliverFreshSource(): string {
  const m = html.match(/function deliverFresh\(fresh, away\) \{[\s\S]*?\n\}\n/);
  expect(m, 'deliverFresh missing from jarvis.html').not.toBeNull();
  return m![0];
}

interface CatchupApi {
  summarizeCatchup(tasks: unknown[], opts?: { away?: boolean }): Summary | null;
  catchupSource(title: string): string;
}

function loadCatchup(): CatchupApi {
  const sandbox: Record<string, unknown> = {};
  runInNewContext(
    `${catchupBlock()}\nthis.summarizeCatchup = summarizeCatchup; this.catchupSource = catchupSource;`,
    sandbox,
  );
  return sandbox as unknown as CatchupApi;
}

interface DeliverHarness {
  deliverFresh(fresh: Task[], away: boolean): void;
  calls: { ready: Array<{ jobId: string; label: string }>; catchup: Summary[]; delivered: string[] };
}

function loadDeliver(): DeliverHarness {
  const calls: DeliverHarness['calls'] = { ready: [], catchup: [], delivered: [] };
  const sandbox: Record<string, unknown> = {
    announceReady: (job: { jobId: string; label: string }) => calls.ready.push(job),
    announceCatchup: (s: Summary) => calls.catchup.push(s),
    markDelivered: (id: string) => calls.delivered.push(id),
  };
  runInNewContext(`${catchupBlock()}\n${deliverFreshSource()}\nthis.deliverFresh = deliverFresh;`, sandbox);
  return { deliverFresh: sandbox.deliverFresh as DeliverHarness['deliverFresh'], calls };
}

const kalshi = (n: number, status = 'done'): Task[] => Array.from({ length: n }, (_, i) => ({
  id: `kalshi-scan-${i}`, title: `Kalshi: ${i % 2 ? 4 : 1} new playable hand${i % 2 ? 's' : ''} (some market)`, status,
}));
const plain = (n: number, status = 'done'): Task[] => Array.from({ length: n }, (_, i) => ({
  id: `jarvis-${status}-${i}`, title: `summarize my week ${i}`, status,
}));

describe('Jarvis catch-up summary: one sentence of counts, never one announcement per task', () => {
  const api = loadCatchup();

  it('folds what landed while away into counts by source, largest group first', () => {
    const s = api.summarizeCatchup([...kalshi(16), ...plain(2), ...plain(1, 'error')], { away: true });
    expect(s).not.toBeNull();
    expect(s!.text).toBe('While you were away: 16 new updates from Kalshi, 2 tasks finished and 1 task failed.');
    expect(s!.total).toBe(19);
    expect(s!.failed).toBe(1);
    expect(s!.groups[0]).toEqual({ source: 'Kalshi', done: 16, failed: 0 });
  });

  it('phrases a single fresh result in the singular with the "just in" lead', () => {
    expect(api.summarizeCatchup(kalshi(1))!.text).toBe('Just in: 1 new update from Kalshi.');
  });

  it('orders several sources by size and names each one', () => {
    const trading = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, title: 'Trading: 2 new alerts', status: 'done' }));
    expect(api.summarizeCatchup([...trading, ...kalshi(5)])!.text)
      .toBe('Just in: 5 new updates from Kalshi and 3 new updates from Trading.');
  });

  it('counts failures under their source and never counts unfinished work', () => {
    const s = api.summarizeCatchup([...kalshi(2, 'error'), ...plain(3, 'pending'), ...plain(1, 'queued'), ...plain(1, 'running')]);
    expect(s!.text).toBe('Just in: 2 Kalshi updates failed.');
    expect(s!.total).toBe(2);
    expect(api.summarizeCatchup([...plain(3, 'pending'), ...plain(2, 'summarizing')])).toBeNull();
    expect(api.summarizeCatchup([])).toBeNull();
  });

  it('reads the source off a "Source: …" title prefix and nothing else', () => {
    expect(api.catchupSource('Kalshi: 1 new playable hand (Will the temp in Miami be above 82.99°?)')).toBe('Kalshi');
    expect(api.catchupSource('Trading: 2 new alerts')).toBe('Trading');
    expect(api.catchupSource('what is the weather tomorrow')).toBe('');
    expect(api.catchupSource('https://example.com: a link')).toBe('');
    expect(api.catchupSource('Kalshi:no space after the colon')).toBe('');
    expect(api.catchupSource('')).toBe('');
  });
});

describe('deliverFresh: name a single live result, summarize everything else', () => {
  it('announces exactly one result by name when it lands while the page is open', () => {
    const h = loadDeliver();
    h.deliverFresh(kalshi(1), false);
    expect(h.calls.ready).toEqual([{ jobId: 'kalshi-scan-0', label: kalshi(1)[0].title }]);
    expect(h.calls.catchup).toHaveLength(0);
    expect(h.calls.delivered).toEqual(['kalshi-scan-0']);
  });

  it('summarizes even a single result when it was missed (page just opened)', () => {
    const h = loadDeliver();
    h.deliverFresh(kalshi(1), true);
    expect(h.calls.ready).toHaveLength(0);
    expect(h.calls.catchup.map((s) => s.text)).toEqual(['While you were away: 1 new update from Kalshi.']);
  });

  it('summarizes a batch that lands at once and marks every task delivered', () => {
    const h = loadDeliver();
    const batch = [...kalshi(10), ...plain(1)];
    h.deliverFresh(batch, false);
    expect(h.calls.ready).toHaveLength(0);
    expect(h.calls.catchup).toHaveLength(1);
    expect(h.calls.catchup[0].text).toBe('Just in: 10 new updates from Kalshi and 1 task finished.');
    expect(h.calls.delivered).toEqual(batch.map((t) => t.id));
  });

  it('reports a lone failure instead of silently marking it delivered', () => {
    const h = loadDeliver();
    h.deliverFresh(plain(1, 'error'), false);
    expect(h.calls.ready).toHaveLength(0);
    expect(h.calls.catchup.map((s) => s.text)).toEqual(['Just in: 1 task failed.']);
    expect(h.calls.delivered).toHaveLength(1);
  });
});

describe('the poll loop delivers through deliverFresh and primes after the first pass', () => {
  const start = html.indexOf('async function pollShelf()');
  const end = html.indexOf('function startShelfPoller()');
  const poll = html.slice(start, end);

  it('collects finished tasks and hands the batch to deliverFresh with the away flag', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(poll).toContain('deliverFresh(fresh, !shelfPrimed)');
    expect(poll).toContain('shelfPrimed = true');
  });

  it('no longer announces or marks delivered per task inside the loop', () => {
    expect(poll).not.toContain('announceReady(');
    expect(poll).not.toContain('markDelivered(t.id)');
  });

  it('a "yes" right after the summary reads the backlog, mirroring the single-result offer', () => {
    expect(html).toContain('let pendingCatchupOffer = false;');
    expect(html).toContain('offeredCatchupForTurn && !offeredResultIdForTurn && saidYes');
    expect(html).toMatch(/pendingCatchupOffer = true;\s*\n\s*speak\(/);
  });
});
