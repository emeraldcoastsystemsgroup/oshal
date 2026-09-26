/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the experience-shells Lab step classifies a missing page as a deployment gap, a refused page or feed as degraded, a broken page or failed feed as fail, and a healthy pass as pass; and that its registration references suites that exist.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { EXPERIENCE_ENTRY_PAGES, EXPERIENCE_JOINED_READS, EXPERIENCE_SCENARIOS, classifyExperienceProbe, experienceShellsStep } from '@/app/routes/test-lab-experience-scenarios';

const marker = (path: string) => EXPERIENCE_ENTRY_PAGES.find(([p]) => p === path)![1];
const page = (path: string, status = 200, body = `<html>${marker(path)}</html>`, contentType = 'text/html; charset=utf-8') => ({ path, status, contentType, body, marker: () => marker(path) });
const healthyPages = () => EXPERIENCE_ENTRY_PAGES.map(([p]) => page(p));
const healthyReads = () => EXPERIENCE_JOINED_READS.map(path => ({ path, status: 200 }));

describe('experience shells Lab step', () => {
  it('passes only when every page serves its shell and every joined feed answers', () => {
    const result = classifyExperienceProbe(healthyPages(), healthyReads());
    expect(result.state).toBe('pass'); expect(result.detail).toContain('9 experience pages');
  });
  it('names a 404 page as a deployment gap, not a failure of the shells', () => {
    const pages = healthyPages(); pages[1] = page('/studio', 404, 'not found', 'text/plain');
    const result = classifyExperienceProbe(pages, healthyReads());
    expect(result).toMatchObject({ state: 'gap', status: 404 }); expect(result.detail).toContain('/studio');
  });
  it('degrades on a refused page or feed instead of passing or failing', () => {
    const pages = healthyPages(); pages[0] = page('/portal', 401, '', 'application/json');
    expect(classifyExperienceProbe(pages, healthyReads())).toMatchObject({ state: 'degraded', status: 401 });
    const reads = healthyReads(); reads[1] = { path: '/api/swarm/apps/home-plan', status: 403 };
    const result = classifyExperienceProbe(healthyPages(), reads);
    expect(result).toMatchObject({ state: 'degraded', status: 403 }); expect(result.detail).toContain('home-plan');
  });
  it('fails when a page serves without its shell root or a feed errors', () => {
    const pages = healthyPages(); pages[8] = page('/nexus', 200, '<html>something else</html>');
    expect(classifyExperienceProbe(pages, healthyReads()).state).toBe('fail');
    const reads = healthyReads(); reads[3] = { path: '/api/jarvis/tasks', status: 500 };
    expect(classifyExperienceProbe(healthyPages(), reads)).toMatchObject({ state: 'fail', status: 500 });
  });
  it('reads with the initiating cookie only and treats network errors as failed reads', async () => {
    const seen: Array<{ url: string; cookie: string | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), cookie: (init?.headers as Record<string, string> | undefined)?.cookie });
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      if (path === '/api/tickets?limit=1') throw new Error('connection refused');
      const isPage = EXPERIENCE_ENTRY_PAGES.some(([p]) => p === path);
      return new Response(isPage ? `<html>${marker(path)}</html>` : '{}', { status: 200, headers: { 'content-type': isPage ? 'text/html' : 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await experienceShellsStep('session=synthetic', fetchImpl);
    expect(result.state).toBe('fail'); expect(result.detail).toContain('/api/tickets?limit=1 (HTTP 0)');
    expect(seen).toHaveLength(EXPERIENCE_ENTRY_PAGES.length + EXPERIENCE_JOINED_READS.length);
    expect(seen.every(s => s.cookie === 'session=synthetic')).toBe(true);
  });
  it('registers regression suites that exist on disk', () => {
    const scenario = EXPERIENCE_SCENARIOS[0];
    expect(scenario.id).toBe('experience-shells');
    for (const test of scenario.regressionTests || []) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps).toHaveLength(1);
  });
});
