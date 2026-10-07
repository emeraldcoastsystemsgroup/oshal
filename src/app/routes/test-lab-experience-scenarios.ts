/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register the ADR-164 experience shells in the AI Test Lab: a read-only step that opens every experience entry page with the initiating operator's cookie and reads the caller-scoped feeds those pages join, classifying a missing page as a deployment gap and a refused feed as degraded rather than a pass.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Type-only repair so the committed-HEAD typecheck passes (it failed on origin/main b2c0d916 and blocked every push containing main): classifyExperienceProbe now takes the page type that carries its root marker (what experienceShellsStep and the spec already pass) instead of PageProbe, which has no marker (TS2339), and the request headers are an explicit Record<string, string> instead of a {cookie} | {} union fetch rejects (TS2769 x2). No behaviour change; tests/unit/test-lab-experience-scenarios.spec.ts is unchanged and green.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Scenario text names the classroom homebase hosting the Little Monsters tools in place (ribbon profile); the browser suite it references now covers hosted tools and the two-phase paint.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Register the gap-closure specs (full-swarm hosting and declared facts, dependency-tier parity, central assistant, homebase) and the audience-view kit spec as regression tests of the experience scenario
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Register the composed front-pages spec (declared module order per preset, package summary cards from each application's own probe, D10 silence for an application outside the plan) as a regression test of the experience scenario
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Register the full-swarm build specs (pure readers; work panels with workflow, Approve and Cancel, the Routines panel, the day focus, visual cards, package facts, membership and the caller's own place, the portal sections and the six-width layout check) as regression tests of the experience scenario, and name them in its description
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Register the Home build specs (opt-in check-ins over ADR-169, the household, the learner and the classroom, Routines, search, tabs, the agenda, the dialogs and the choices; the data seam) and the central-assistant build specs (the availability route over real HTTP, the data kit, and the Chromium build: Calendar and Travel in context, readback states and meter, the best-match line, the comparison across free weekends, the fit of typed dates, the page's ledger rows, six widths) plus the Duffel normaliser's unit spec.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Register the kernel applications' audience-view specs (Security Center, Workflow Studio, DevOps + Vault, Bot Forge, OSHAL Engineering's configuration page, Intelligent Processing, Person model): each serves the real page at its real route with the real kit and proves the company and family cards from the page's own reads, the refusals, the in-frame action, and the full page starting unchanged without an audience or with one it does not provide.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Simple chat (docs/architecture/simple-chat.md): /simple joins the entry pages the live step reads (its root marker is sc-root), and the kit, /simple and OSHAL Node Simple chat specs are registered as regression tests.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Shell lock (ADR-164 amendment): the pure redirect decision, the cockpit document and experience pages behind a real listener, and the ribbon's door decision are registered as regression tests of the experience scenario.
 * 11 | maintainer@emeraldcoastsystemsgroup.com | Register fail-closed experience declaration validation as local unit coverage; package hosting and installed acceptance remain pending.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | Require named app.open entry bindings and verify authorized experience hosting through the existing loader, policy and Test Lab.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | Support reviewed experience role lifecycle with explicit selections, durable provenance and existing authority checks.
 * 14 | maintainer@emeraldcoastsystemsgroup.com | Probe the seven actual package entries after legacy aliases move to checked open operations and register alias regressions.
 * 15 | maintainer@emeraldcoastsystemsgroup.com | Shell-lock fix (server): register the profile refusal for a non-operator held to a focused landing (ui-profile-focused-refusal, real route + real ribbon init), its real-store companion on PostgreSQL under the enforcing role (ui-profile-rls-hidden-experience-postgres), the previously unregistered ribbon-profile-refusal and rail-tile-discoverability guards, and the #1041 picker spec.
 * 16 | maintainer@emeraldcoastsystemsgroup.com | Shell-lock fix (client): register the Chromium proof of the locked cockpit (cockpit-shell-lock-browser: refusal with a ticket link, a locked allowed application, an unreadable plain document, and the unchanged unlocked doors).
 * 17 | maintainer@emeraldcoastsystemsgroup.com | Register principal-scoped navigation, unsent drafts, selected-member context and authoritative auth-state issuer regressions for the seven experience applications.
 * 18 | maintainer@emeraldcoastsystemsgroup.com | Cover declaration-only assistant status and explicit unavailable data in the shared adapter and spoken briefing suites.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** Every entry page the experience chooser links to, with the root marker its shell renders into. */
export const EXPERIENCE_ENTRY_PAGES: ReadonlyArray<readonly [string, string]> = [
  ['/portal', 'portal-root'], ['/api/studio-experience/app', 'id="app"'], ['/api/jarvis-experience/app', 'id="app"'], ['/api/orbit-experience/app', 'id="app"'], ['/api/commons-experience/app', 'id="app"'],
  ['/api/home-experience/app', 'homebase-root'], ['/api/classroom-experience/app', 'homebase-root'], ['/api/business-experience/app', 'homebase-root'], ['/nexus', 'nexus-root'],
  ['/simple', 'sc-root'],
];
/** The caller-scoped reads every shell joins before it renders anything. */
export const EXPERIENCE_JOINED_READS = ['/api/auth/user', '/api/swarm/apps/home-plan', '/api/ui/workspaces', '/api/jarvis/tasks', '/api/tickets?limit=1'];

export interface PageProbe { path: string; status: number; contentType: string; body: string }
export interface ReadProbe { path: string; status: number }
/** A fetched page plus the root marker its shell must render. */
export type PageWithMarker = PageProbe & { marker: (p: PageProbe) => string };

/** @description Classify one pass over the entry pages and joined reads without any write. */
export function classifyExperienceProbe(pages: PageWithMarker[], reads: ReadProbe[]): StepResult {
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

/** @description Read every entry page and joined feed with the initiating operator's cookie. Nothing is written. */
export async function experienceShellsStep(cookie: string, fetchImpl: typeof fetch = fetch): Promise<StepResult> {
  const base = `http://127.0.0.1:${process.env.PORT || '5000'}`;
  const headers: Record<string, string> = cookie ? { cookie } : {};
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

/** @description Probe current management-visible templates and receipt metadata without creating grants or previews. */
export async function experienceCompositeRolesStep(cookie: string, fetchImpl: typeof fetch = fetch): Promise<StepResult> {
  const response = await fetchImpl(`http://127.0.0.1:${process.env.PORT || '5000'}/api/authorization/composites`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000), redirect: 'manual' });
  const label = 'Installed experience role templates';
  if (response.status !== 200) return { app: 'authorization', label, status: response.status,
    state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail', detail: `Composite role catalog returned HTTP ${response.status}. No changes attempted.` };
  const data = await response.json() as Record<string, unknown>;
  const valid = Number.isSafeInteger(data.revision) && Number(data.revision) >= 0 && Array.isArray(data.experiences) && Array.isArray(data.assignments);
  return { app: 'authorization', label, state: valid ? 'pass' : 'fail', detail: valid
    ? `${(data.experiences as unknown[]).length} current management-visible experience packages. Metadata read only; installed lifecycle acceptance is a separate explicit proof.`
    : 'Composite catalog response is missing policy revision or lifecycle metadata.' };
}
export const EXPERIENCE_SCENARIOS: Scenario[] = [{
  id: 'experience-shells', title: 'Experience shells over the live swarm', group: 'tool',
  description: 'Open the experience entry pages (Studio, Jarvis, Orbit, Commons, the Home, Little Monsters and Business homebases, the central assistant, and Simple chat) with the initiating session and read the caller-scoped feeds they join. Local suites prove the adapter joins and the Chromium behaviour over an isolated synthetic swarm: catalog and work rendering, pins, the Jarvis ask flow with thread roll and refusal, room threads, homebase modules and honest setup/denial states. The classroom homebase also lists the Little Monsters tools the caller is admitted to (the ribbon profile) and opens them in place. Adapters distinguish declaration-only assistants from measured presence, honor explicitly unavailable personal sources, and prevent spoken briefings from claiming online counts or empty workloads after failed reads. The full-swarm layouts add work panels over the ticket routes (recorded workflow, Approve, Cancel), the Routines panel over the caller’s schedules, a device-local day focus, visual cards, package facts, household or team membership with the caller’s own place, and the portal’s gallery sections.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/experience-package-contract.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-package-discovery.spec.ts' },
    { level: 'integration', path: 'tests/unit/experience-package-aliases.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-composite-template.spec.ts' },
    { level: 'unit', path: 'tests/unit/composite-role-lifecycle.spec.ts' },
    { level: 'integration', path: 'tests/unit/experience-composite-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/experience-composite-postgres.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-composite-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-live-data.spec.ts' },
    { level: 'integration', path: 'tests/unit/auth-state-principal-issuer.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-homebase-navigation-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-member-context-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-experience-scenarios.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-shell-lock.spec.ts' },
    { level: 'integration', path: 'tests/unit/cockpit-shell-lock-routes.spec.ts' },
    { level: 'unit', path: 'tests/unit/ribbon-shell-lock.spec.ts' },
    { level: 'integration', path: 'tests/unit/ui-profile-focused-refusal.spec.ts' },
    { level: 'integration', path: 'tests/unit/ui-profile-rls-hidden-experience-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/ribbon-profile-refusal.spec.ts' },
    { level: 'integration', path: 'tests/unit/rail-tile-discoverability.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-package-picker.spec.ts' },
    { level: 'browser', path: 'tests/unit/cockpit-shell-lock-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-layouts-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/app-view-kit-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-full-swarm-gaps.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-dependency-tiers.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-nexus-gaps.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-homebase-gaps.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-front-pages.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-portal-data.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-portal-build.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-homebase-build.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-homebase-build-pages.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-homebase-data.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-availability-routes.spec.ts' },
    { level: 'unit', path: 'tests/unit/experience-nexus-data.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-nexus-build.spec.ts' },
    { level: 'unit', path: 'tests/unit/duffel-normalize-offer.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-kernel-security-center-view.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-kernel-workflow-studio-view.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-kernel-devops-view.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-kernel-codex-packer-view.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-kernel-oshal-engineering-view.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-kernel-intelligent-processing-view.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-kernel-person-model-view.spec.ts' },
    { level: 'unit', path: 'tests/unit/simple-chat-kit.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-simple-chat-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/oshal-node-simple-chat-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/oshal-node-simple-chat-config.spec.ts' },
  ],
  steps: [{ id: 'pages', app: 'cockpit', label: 'Experience pages and their joined reads', run: (cookie) => experienceShellsStep(cookie) }],
}, {
  id: 'experience-composite-roles', title: 'Application composite roles and lifecycle', group: 'tool',
  description: 'Read the current caller-visible application template catalog. Isolated policy, HTTP, browser and PostgreSQL suites verify complete required component coverage, native application bundles, fresh-user assignment, current authority, identity, expiry, denial, sensitive approval, source-safe revocation, reviewed upgrade, restart receipts and atomic rollback. This probe never changes installed assignments.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/application-composite-registration.spec.ts' },
    { level: 'integration', path: 'tests/unit/composite-role-completeness.spec.ts' },
    { level: 'unit', path: 'tests/unit/composite-role-lifecycle.spec.ts' },
    { level: 'integration', path: 'tests/unit/experience-composite-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/experience-composite-routes.spec.ts' },
    { level: 'browser', path: 'tests/unit/experience-composite-browser.spec.ts' },
  ],
  steps: [{ id: 'catalog', app: 'authorization', label: 'Installed experience role templates', run: cookie => experienceCompositeRolesStep(cookie) }],
}];
