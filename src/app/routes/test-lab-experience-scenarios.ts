/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register the ADR-164 experience shells in the AI Test Lab: a read-only step that opens every experience entry page with the initiating operator's cookie and reads the caller-scoped feeds those pages join, classifying a missing page as a deployment gap and a refused feed as degraded rather than a pass.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** Every entry page the experience chooser links to, with the root marker its shell renders into. */
export const EXPERIENCE_ENTRY_PAGES: ReadonlyArray<readonly [string, string]> = [
  ['/portal', 'portal-root'], ['/studio', 'id="app"'], ['/jarvis', 'id="app"'], ['/orbit', 'id="app"'], ['/commons', 'id="app"'],
  ['/homebase?preset=family', 'homebase-root'], ['/homebase?preset=classroom', 'homebase-root'], ['/homebase?preset=company', 'homebase-root'], ['/nexus', 'nexus-root'],
];
/** The caller-scoped reads every shell joins before it renders anything. */
export const EXPERIENCE_JOINED_READS = ['/api/auth/user', '/api/swarm/apps/home-plan', '/api/ui/workspaces', '/api/jarvis/tasks', '/api/tickets?limit=1'];

export interface PageProbe { path: string; status: number; contentType: string; body: string }
export interface ReadProbe { path: string; status: number }

/** @description Classify one pass over the entry pages and joined reads without any write. */
export function classifyExperienceProbe(pages: PageProbe[], reads: ReadProbe[]): StepResult {
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: 'cockpit', label: 'Experience pages and their joined reads', state, detail, ...(status ? { status } : {}) });
  const missing = pages.filter(p => p.status === 404);
  if (missing.length) return result('gap', `${missing.map(p => p.path).join(', ')} answered 404: the running image predates the experience shells (needs a core deploy that includes src/experience).`, 404);
  const refusedPages = pages.filter(p => [401, 403].includes(p.status));
  if (refusedPages.length) return result('degraded', `${refusedPages.map(p => p.path).join(', ')} refused this session (HTTP ${refusedPages[0].status}).`, refusedPages[0].status);
  const broken = pages.filter(p => p.status !== 200 || !p.contentType.includes('text/html') || !p.body.includes(p.marker(p)));
  if (broken.length) return result('fail', `${broken.map(p => `${p.path} (HTTP ${p.status})`).join(', ')} did not serve the experience page.`, broken[0].status);
  const refusedReads = reads.filter(r => [401, 403].includes(r.status));
  if (refusedReads.length) return result('degraded', `Pages serve, but ${refusedReads.map(r => r.path).join(', ')} refused this session, so the shells would render their unavailable state.`, refusedReads[0].status);
  const failedReads = reads.filter(r => r.status !== 200);
  if (failedReads.length) return result('fail', `${failedReads.map(r => `${r.path} (HTTP ${r.status})`).join(', ')} failed; the shells cannot render live data from them.`, failedReads[0].status);
  return result('pass', `${pages.length} experience pages serve behind the session and all ${reads.length} caller-scoped feeds they join answered 200. Rendering, pins, the ask flow and the homebase modules are proven by the registered browser suite.`);
}

type PageWithMarker = PageProbe & { marker: (p: PageProbe) => string };

/** @description Read every entry page and joined feed with the initiating operator's cookie. Nothing is written. */
export async function experienceShellsStep(cookie: string, fetchImpl: typeof fetch = fetch): Promise<StepResult> {
  const base = `http://127.0.0.1:${process.env.PORT || '5000'}`;
  const headers = cookie ? { cookie } : {};
  const pages: PageWithMarker[] = [];
  for (const [path, marker] of EXPERIENCE_ENTRY_PAGES) {
    try {
      const response = await fetchImpl(base + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      pages.push({ path, status: response.status, contentType: String(response.headers.get('content-type') || ''), body: (await response.text()).slice(0, 20000), marker: () => marker });
    } catch (error) {
      pages.push({ path, status: 0, contentType: '', body: String((error as Error).message || error), marker: () => marker });
    }
  }
  const reads: ReadProbe[] = [];
  for (const path of EXPERIENCE_JOINED_READS) {
    try { const response = await fetchImpl(base + path, { headers, signal: AbortSignal.timeout(30000) }); await response.arrayBuffer(); reads.push({ path, status: response.status }); }
    catch { reads.push({ path, status: 0 }); }
  }
  return classifyExperienceProbe(pages, reads);
}

export const EXPERIENCE_SCENARIOS: Scenario[] = [{
  id: 'experience-shells', title: 'Experience shells over the live swarm', group: 'tool',
  description: 'Open the eight experience entry pages (Studio, Jarvis, Orbit, Commons, the Home, Little Monsters and Business homebases, the central assistant) with the initiating session and read the caller-scoped feeds they join. Local suites prove the adapter joins and the Chromium behaviour over an isolated synthetic swarm: catalog and work rendering, pins, the Jarvis ask flow with thread roll and refusal, room threads, homebase modules and honest setup/denial states.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/experience-live-data.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-experience-scenarios.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-layouts-browser.spec.ts' },
  ],
  steps: [{ id: 'pages', app: 'cockpit', label: 'Experience pages and their joined reads', run: (cookie) => experienceShellsStep(cookie) }],
}];
