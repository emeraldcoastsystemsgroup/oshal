/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-173 S1 (capability providers resolve per user). A read-only card over GET /api/capability-providers as the signed-in operator: each of text to speech, speech to text, image and video must name its swarm default and where it came from (the operator's row, or the config or selector seed, or why there is none), and every provider must carry a cost class and an availability answer that names the missing piece whenever it is not offered. It writes nothing; the live move of the swarm STT default is the explicit-only live-acceptance card capability-stt. A non-operator is degraded, not failed.
 */

import { CAPABILITIES, CAPABILITY_COST_CLASSES } from '@/shared/capability-providers';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const APP = 'capability-providers';
const LABEL = 'Swarm defaults, who pays, and what is offered';

/** One provider as the listing reports it. */
interface ListedProvider { providerId?: unknown; costClass?: unknown; available?: unknown; missing?: unknown; detail?: unknown }
/** One capability section as the listing reports it. */
interface ListedSection { capability?: unknown; swarmDefault?: { providerId?: unknown; source?: unknown; reason?: unknown }; providers?: ListedProvider[] }

/**
 * @description What is wrong with one provider entry, if anything.
 * @param capability - Its capability.
 * @param provider - The entry.
 * @returns A problem sentence, or null.
 */
function providerProblem(capability: string, provider: ListedProvider): string | null {
  const id = String(provider.providerId ?? '?');
  const declared = (CAPABILITY_COST_CLASSES as readonly unknown[]).includes(provider.costClass);
  if (!declared && provider.missing !== 'no-cost-class') return `${capability}/${id} has no cost class and is not marked as such`;
  if (typeof provider.available !== 'boolean') return `${capability}/${id} has no availability answer`;
  if (!provider.available && (!provider.missing || !String(provider.detail ?? '').trim())) return `${capability}/${id} is not offered but names no missing piece`;
  return null;
}

/**
 * @description What is wrong with the whole listing, and the one-line summary of the defaults.
 * @param sections - The capability sections.
 * @returns The problems and the summary.
 */
function judgeListing(sections: ListedSection[]): { problems: string[]; summary: string } {
  const problems: string[] = [];
  const names = sections.map((s) => String(s.capability));
  if (names.join(',') !== CAPABILITIES.join(',')) problems.push(`capabilities listed: ${names.join(', ') || 'none'}`);
  const summary = sections.map((s) => {
    const d = s.swarmDefault ?? {};
    if (typeof d.source !== 'string' || !d.source) problems.push(`${String(s.capability)} names no swarm-default source`);
    for (const p of s.providers ?? []) { const problem = providerProblem(String(s.capability), p); if (problem) problems.push(problem); }
    return `${String(s.capability)}: ${d.providerId ? String(d.providerId) : 'none'} (${String(d.source ?? '?')})`;
  }).join(' · ');
  return { problems, summary };
}

/**
 * @description The read-only step: read the operator listing as the signed-in caller and judge it.
 * @param cookie - The initiating user's session cookie.
 * @param _prior - Earlier step outputs (unused).
 * @param runtime - The server-derived run context (its loopback base URL).
 * @returns The step result.
 */
async function listingStep(cookie: string, _prior: Record<string, unknown>, runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: APP, label: LABEL, state, detail, ...(status ? { status } : {}) });
  const base = runtime?.apiBaseUrl ?? `http://127.0.0.1:${process.env.PORT || '5000'}`;
  const response = await fetch(`${base}/api/capability-providers`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) return result('degraded', 'Sign in as the operator: the capability listing is operator-only.', response.status);
  if (response.status !== 200) return result('fail', `GET /api/capability-providers answered HTTP ${response.status}.`, response.status);
  const body = await response.json() as { capabilities?: ListedSection[] };
  const { problems, summary } = judgeListing(Array.isArray(body.capabilities) ? body.capabilities : []);
  if (problems.length) return result('fail', problems.join('; '));
  return result('pass', `${summary}. Every provider names who pays and, when not offered, what is missing. Read-only; nothing was written.`);
}

export const CAPABILITY_PROVIDER_SCENARIOS: Scenario[] = [{
  id: 'capability-providers-swarm-defaults',
  title: 'Capability providers — swarm defaults, who pays, what is offered',
  group: 'tool',
  description: 'ADR-173 S1. Reads the operator capability listing as you (operator only) and checks that text to speech, speech to text, image and video each name their swarm default and where it came from (the operator\'s row, or the config or selector it falls back to), and that every provider says who pays (free, swarm-paid, user-paid) and, when it is not offered, what is missing. Read-only. The live move of the swarm STT default to local-stt is the explicit-only card "Live acceptance: Speech to text".',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/capability-resolution.spec.ts' },
    { level: 'unit', path: 'tests/unit/capability-options-agree.spec.ts' },
    { level: 'integration', path: 'tests/unit/capability-swarm-rows-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/capability-row-snapshot.spec.ts' },
    { level: 'integration', path: 'tests/unit/capability-provider-routes.spec.ts' },
    { level: 'unit', path: 'tests/unit/capability-principal-guard.spec.ts' },
    { level: 'unit', path: 'tests/unit/voice-stt-failover.spec.ts' },
    { level: 'unit', path: 'tests/unit/voice-tts-voice-rule.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-capability-provider-scenarios.spec.ts' },
  ],
  steps: [{ id: 'listing', app: APP, label: LABEL, run: listingStep }],
}];
