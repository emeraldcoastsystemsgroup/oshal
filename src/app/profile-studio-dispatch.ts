/**
 * Profile Studio — desktop dispatch for LinkedIn profile updates. LinkedIn has NO profile-edit
 * API, so an APPROVED per-user plan (headline / about / skills / custom URL / background image /
 * featured resume) is applied by the linkedin-profile-operator identity driving the operator's
 * REAL, logged-in Chrome on the desktop worker via `codex.exec` + the apply-operator
 * `browser_control` MCP — the same rail, worker box, and privilege path as apply-dispatch
 * (ADR-070 rule: reached ONLY through the queue/worker path, never a direct endpoint call).
 * The box POSTs the outcome back to /api/profile-studio/ingest with the service secret, which
 * resolves the plan to applied/failed.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial dispatch: builds the
 *   browser-control prompt from the approved plan (assets docker-cp'd out of the api container),
 *   enqueues to the same desktop worker apply-dispatch uses, never throws (offline box returns
 *   { ok:false, error } for a clean surface message).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | PROFILE PHOTO step — the plan's
 *   photoPath (uploaded or picked from Portrait Studio) is fetched and applied via the avatar's
 *   edit/add-photo flow, same verify-then-move-on discipline.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Dispatch now rides the shared
 *   browser-task-dispatch rail (dispatchBrowserTask) instead of hand-rolling the pick+envelope+enqueue;
 *   supplies its OWN linkedin-profile-operator id + prompt. Behaviour-preserving.
 *
 * @module app/profile-studio-dispatch
 */

import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { dispatchBrowserTask, type DispatchResult } from '@/app/browser-task-dispatch';
import type { LinkedInProfilePlan } from '@/features/profile-studio';

const logger = createChildLogger({ module: 'profile-studio-dispatch' });

/** The linkedin-profile-operator identity — the dispatched task is attributed to it. */
const PROFILE_OPERATOR_AGENT_ID = 'cb000000-0000-0000-0000-000000000004';
/** Where the box POSTs its result back (same controller URL contract as apply-dispatch). */
const CONTROLLER_URL = (process.env.APPLY_CONTROLLER_URL || process.env.LORA_CONTROLLER_URL || 'http://localhost:35457').replace(/\/+$/, '');
/** The api container name on the box, for docker-cp'ing the plan assets. */
const API_CONTAINER = process.env.APPLY_API_CONTAINER || 'oshal-local-api';

/** The dispatch outcome — the shared rail's DispatchResult (kept aliased for existing callers). */
export type ProfileDispatchResult = DispatchResult;

/**
 * @description The prompt the box's codex runs — drives the operator's real logged-in Chrome
 * through the LinkedIn profile edit flows for exactly the fields present in the plan, with the
 * never-notify-network / never-post guardrails, then calls back with the outcome.
 * @param plan - The approved plan (the only source of truth for what to change).
 * @returns The full prompt text.
 */
export function buildProfilePrompt(plan: LinkedInProfilePlan): string {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  const bgExt = plan.backgroundImagePath ? path.extname(plan.backgroundImagePath) || '.png' : '';
  const photoExt = plan.photoPath ? path.extname(plan.photoPath) || '.png' : '';
  const cp = (src: string | null, dest: string) =>
    src ? `  docker cp ${API_CONTAINER}:${src} "$env:TEMP\\linkedin-profile\\${dest}"` : '';
  const fields = [
    plan.photoPath ? `- PROFILE PHOTO: upload photo${photoExt} via the avatar's edit/add-photo control (Save; keep LinkedIn's default crop unless it cuts the face)` : '',
    plan.headline ? `- HEADLINE (replace whole field, paste from clipboard): ${JSON.stringify(plan.headline)}` : '',
    plan.about ? `- ABOUT (select all in the About editor, paste replacement): ${JSON.stringify(plan.about)}` : '',
    plan.skills.length ? `- SKILLS (add each one that is not already on the profile, skip existing): ${JSON.stringify(plan.skills)}` : '',
    plan.customUrl ? `- CUSTOM URL (Edit public profile & URL, right rail): set the slug to ${JSON.stringify(plan.customUrl)}` : '',
    plan.backgroundImagePath ? `- BACKGROUND PHOTO: upload background${bgExt} via the banner's camera/edit control (Apply/Save)` : '',
    plan.resumePath ? '- FEATURED RESUME: Add profile section -> Featured -> Media -> upload Featured_Resume.pdf, title it "Resume"' : '',
  ].filter(Boolean);
  return [
    'You are linkedin-profile-operator on the operator\'s own desktop. Update the operator\'s OWN',
    'LinkedIn profile by driving the REAL, logged-in Chrome with your browser_control tools',
    '(preflight, nav, shot, click, type_text, paste, upload, pick_place). Screenshot-driven:',
    'capture, read, act, re-capture. Long text goes in by clipboard paste, never by type.',
    '',
    'ASSETS — fetch to a local temp dir FIRST (they live in the swarm api container on THIS box):',
    'New-Item -ItemType Directory -Force -Path "$env:TEMP\\linkedin-profile" | Out-Null',
    cp(plan.photoPath, `photo${photoExt}`),
    cp(plan.backgroundImagePath, `background${bgExt}`),
    cp(plan.resumePath, 'Featured_Resume.pdf'),
    '',
    'START: nav to https://www.linkedin.com/in/me/ and screenshot. If a login page, checkpoint,',
    'CAPTCHA, or verification prompt appears: STOP immediately and report failed — NEVER enter',
    'credentials or codes.',
    '',
    'APPLY EXACTLY THESE PLANNED CHANGES — nothing else on the profile, one section at a time,',
    'save each section and re-screenshot to verify the committed value before the next:',
    ...fields,
    '',
    'HARD RULES:',
    '- NEVER create a feed post and NEVER "share profile changes with your network": if any save',
    '  dialog offers a notify-network / share toggle, it must be OFF before saving.',
    '- Touch ONLY the sections named above; do not "improve" anything else.',
    '- Pace calmly like a human editing their profile; no bursts.',
    '- If a planned change cannot be completed or verified, finish the others and report failed',
    '  with a per-field note of what applied and what blocked.',
    '',
    'WHEN DONE — POST your outcome so the plan resolves (result = applied only if EVERY planned',
    'field is verified on the profile; otherwise failed with the per-field note):',
    `Invoke-RestMethod -Method Post -Uri "${CONTROLLER_URL}/api/profile-studio/ingest" -Headers @{ 'x-service-secret' = '${secret}' } -ContentType 'application/json' -Body (@{ userSub = '${plan.userSub}'; result = 'applied'; note = 'per-field outcome' } | ConvertTo-Json)`,
  ].filter((l) => l !== '').join('\n');
}

/**
 * @description Enqueue the profile update to the desktop worker as a gated codex.exec task.
 * Never throws — a missing/offline box returns `{ ok:false, error }` so the surface shows a
 * clean "desktop not connected" message. The outcome flows back via /api/profile-studio/ingest.
 * @param plan - The approved plan to apply.
 * @returns The dispatch outcome (clientId + taskId when enqueued).
 */
export function dispatchProfileUpdate(plan: LinkedInProfilePlan): ProfileDispatchResult {
  const result = dispatchBrowserTask({
    taskId: `liprofile-${plan.id}-${Date.now()}`,
    fromAgentId: PROFILE_OPERATOR_AGENT_ID,
    userSub: plan.userSub,                // so the leaf-node cost lands attributed to this owner
    prompt: buildProfilePrompt(plan),
  });
  if (result.ok) logger.info({ clientId: result.clientId, taskId: result.taskId, planId: plan.id }, 'profile update dispatched to desktop worker');
  return result;
}
