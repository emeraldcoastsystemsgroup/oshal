/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the storyboard image rail (BACKLOG "Free ComfyUI storyboard provider"). Which rail renders a storyboard still decides whether the stage costs money per image and whether it can serve anybody but the operator, and nothing in the cockpit said which one this deployment would pick. The live step reads the selection and probes the free GPU rail's own health, so an operator can see that the FREE rail is standing by - or exactly which of url / workflow / reachability is missing - without submitting a frame. Read-only: it generates no image, submits no job and spends nothing.
 *
 * @module routes/test-lab-storyboard-scenarios
 */

import { createComfyUiImageProvider } from '@/features/video-generation';
import { demoModeEnabled } from '@/shared/deployment-mode';
import type { Scenario, StepResult } from './test-lab-scenarios';

const APP = 'storyboard';
const LABEL = 'Storyboard image rail';

/** The rails that bill the caller per image; selecting one is a spend decision, not a default. */
const PAID_RAILS = new Set(['codex', 'vertex', 'openrouter']);

/**
 * @description Live step: report which rail this deployment would render storyboard stills on, and
 * whether the free GPU rail is ready. It never generates — a single still on a paid rail costs real
 * money, so the card reads configuration and the ComfyUI box's own `/system_stats` and stops there.
 *
 * States, and why: the selected rail being unusable is a `fail` (the storyboard stage will die at
 * the first frame); a paid rail selected with no free rail configured is `degraded` and says what to
 * set; the free rail selected and reachable, or standing by behind a deliberate paid choice, passes.
 *
 * @param {string} _cookie the initiating user's session cookie; unused, this step calls no route
 * @returns {Promise<StepResult>} the rail verdict, with the free rail's own reason when it is not ready
 */
async function railStep(_cookie: string): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string): StepResult => ({ app: APP, label: LABEL, state, detail });
  const selected = (process.env.STORYBOARD_IMAGE_PROVIDER || '').trim().toLowerCase()
    || (demoModeEnabled() ? 'codex-cli' : 'codex');

  const comfy = createComfyUiImageProvider();
  const health = comfy.healthCheck ? await comfy.healthCheck() : { ok: false, detail: 'the free rail reports no health probe' };

  if (selected === 'comfyui') {
    return health.ok
      ? result('pass', `Storyboard stills render FREE on the GPU box — ${health.detail}. No per-image charge, and any signed-in caller can use it.`)
      : result('fail', `STORYBOARD_IMAGE_PROVIDER=comfyui is selected but the rail is not usable: ${health.detail}. Every storyboard frame will fail at selection until this is fixed.`);
  }

  const paid = PAID_RAILS.has(selected);
  if (health.ok) {
    return result('pass', `Selected rail is '${selected}'${paid ? ' (billed per image)' : ''}; the free GPU rail is ready as well — ${health.detail}. Set STORYBOARD_IMAGE_PROVIDER=comfyui to render at no per-image cost.`);
  }
  return result('degraded', `Selected rail is '${selected}'${paid ? ', which bills per image' : ''}, and the free GPU rail is not available: ${health.detail}. Storyboards still render, they are just not free${selected === 'codex-cli' ? ' — and codex-cli only serves the operator in demo mode, so a signed-in guest gets nothing' : ''}.`);
}

/** The storyboard image-rail Test Lab card: one read-only readback of the selection + the free rail. */
export const STORYBOARD_SCENARIOS: Scenario[] = [{
  id: 'storyboard-image-rail',
  title: 'Storyboard stills — which rail renders them, and whether it is free',
  group: 'tool',
  description: 'Reads which image rail this deployment would render storyboard frames on and probes the free GPU rail (ComfyUI) for readiness, naming exactly what is missing when it is not ready. A paid rail selected by accident is a per-image bill nobody chose, and the demo codex-cli rail serves only the operator — this is the read that tells them apart. Read-only: no frame is generated and nothing is spent.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/storyboard-comfyui-provider.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-codex-cli-provider.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-codex-platform-key.spec.ts' },
    { level: 'unit', path: 'tests/unit/series-storyboard-owner-sub.spec.ts' },
  ],
  steps: [{ id: 'rail', app: APP, label: LABEL, run: railStep }],
}];
