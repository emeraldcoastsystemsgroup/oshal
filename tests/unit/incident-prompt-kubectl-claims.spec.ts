/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the incident investigator prompt (remote-cluster work package item 9). The prompt told every incident bot "kubectl WORKS in this container" and listed three node hostnames from one specific cluster. That was false on any box without a mounted kubeconfig, and it contradicted the hedged Kubernetes heading nine lines above it. The next line called a reported connection failure hallucination, so a bot that truthfully said the cluster was unreachable was told it was lying. This spec renders the REAL prompt through getPhasePrompt, with the same arguments the dispatcher uses for an incident child ticket, and fails if an unconditional live-kubectl claim, a hardcoded node hostname, or a hallucination charge attached to a refused connection comes back.
 */

import { describe, expect, it } from 'vitest';
import { getPhasePrompt } from '../../src/features/swarm-orchestration/services/phase-dispatch-prompts';

/** Phase 2 at depth >= 1 with an incident label is the incident child-execution prompt. */
const PROMPT = getPhasePrompt(2, 'incident-remediation', 1, 1, ['incident']);
const LINES = PROMPT.split('\n');

describe('incident investigator prompt: Kubernetes claims are conditional (work package item 9)', () => {
  it('renders the incident investigator prompt, so the checks below are not vacuous', () => {
    expect(PROMPT).toContain('== YOUR ROLE: INCIDENT INVESTIGATOR ==');
    expect(PROMPT).toMatch(/execute_command kubectl get nodes/);
    expect(getPhasePrompt(2, 'x', 1, 1, ['rca-requested'])).toBe(PROMPT);
  });

  it('no line claims kubectl works or is live unless it names the kubeconfig condition', () => {
    const unconditional = LINES.filter(
      (l) => /\bkubectl\b/i.test(l) && /\bWORKS\b|\bLIVE access\b|\bis LIVE\b/i.test(l) && !/kubeconfig/i.test(l),
    );
    expect(unconditional).toEqual([]);
    expect(PROMPT).not.toMatch(/kubectl WORKS/i);
  });

  it('keeps the correct hedge on the Kubernetes heading', () => {
    expect(PROMPT).toContain('kubectl is LIVE when a kubeconfig is mounted');
  });

  it('names no cluster nodes: node names come from command output, not from the prompt', () => {
    expect(PROMPT).not.toMatch(/\bip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\b/);
    expect(PROMPT).not.toMatch(/Real nodes:/i);
  });

  it('treats a real connection failure as evidence to report, not as hallucination', () => {
    const punishing = LINES.filter((l) => /refused/i.test(l) && /hallucinat/i.test(l));
    expect(punishing).toEqual([]);
    expect(PROMPT).toMatch(/failure is evidence/i);
    expect(PROMPT).toMatch(/paste it into the RCA/i);
  });
});
