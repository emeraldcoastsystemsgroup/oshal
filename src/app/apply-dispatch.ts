/**
 * Job-Apply — ticket-gated desktop dispatch. The browser submission runs on the operator's desktop
 * worker node via `codex.exec` + the node's local browser controls, reached ONLY through the
 * queue/worker path — like lora-train-dispatch (the ticket-gated queue/worker dispatch privilege
 * rule, grounded in ADR-085's queue/worker rail; the old "ADR-070" label here was a mislabel —
 * ADR-070 is multi-provider video generation — see ADR-101's numbering note), never a direct endpoint
 * call. This module resolves the desktop worker, STAGES the packet (resume + cover + profile) into
 * the task's shared workspace folder so a NON-co-located remote box can pull it into codex's working
 * directory (the workspace-sync rail — a truly-remote node has no `oshal-local-api` container to
 * `docker cp` from), builds the apply prompt, and enqueues it as an `mcp.call-tool` → `codex.exec`
 * task at `danger-full-access` (OS input needs it). The trusted remote daemon, not the model, POSTs
 * one strict JSON outcome to /api/apply/ingest with an expiring task-bound capability. Callback URL,
 * capability, identity, and ticket coordinates remain top-level envelope metadata outside tool args.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial job-apply desktop dispatch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Remote-box resume delivery: a
 *   worker that is NOT co-located with the api container (e.g. the render-node-1 render node) has
 *   no oshal-local-api container to `docker cp` the resume from, so the old prompt left it with no
 *   resume + no form values and it flailed / fabricated success from DB rows. dispatchApply is now
 *   async and STAGES the packet into the task's shared workspace folder (read straight off the api's
 *   own disk), sets workspacePath so the node auto-syncs it into codex's cwd, and the prompt now
 *   references the synced ./Resume_ATS.pdf + ./profile.json, VERIFIES the resume is present before
 *   touching a form (else deferred), and calls back over the box's registered control-plane URL.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The generic pick+envelope+enqueue
 *   moved to browser-task-dispatch (shared with linkedin-profile); dispatchApply now stages the résumé
 *   packet + builds the apply prompt, then hands the GENERIC rail its career identity + prompt. No
 *   career vocabulary remains in the shared path. Behaviour-preserving: same envelope, same résumé gate.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | buildApplyPrompt REMOVED from core
 *   — the ATS/résumé prompt is the career-hunter app's domain content and now lives in the package
 *   (career-hunter/lib/apply-prompt.js), loaded at dispatch via resolveApplyPromptBuilder
 *   (apply-prompt-bridge). dispatchApply DEFERS if the app isn't installed (never invents a prompt).
 *   Only the transport (packet staging + the generic rail) stays core.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Apply-prompt rules (operator
 *   directives, cut the yield-killing over-blocks seen in the 2026-07-21 batch): remote-first/
 *   open-to-travel location handling (only defer on a hard named-city relocation requirement, not
 *   onsite-preferred); on an ATS spam/bot rejection, retry once with slow human-paced OS input rather
 *   than giving up (Ashby flagged fast-injection submissions); and GROUND (don't defer on) voluntary
 *   self-ID -> "Decline to self-identify", start date -> "Flexible ~2 weeks", non-compete/worked-here -> "No".
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Prompt now tells the worker to
 *   NARRATE: POST a captioned progress beat (+ the screenshot it just took) to /api/apply/shot at
 *   each milestone, so the cockpit apply queue can show a run as it happens. The worker was already
 *   screenshot-driven; the frames just died on its own disk with a path echoed into the final note.
 *   Explicitly marked telemetry — a failed beat must never abort a real application.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Comment-only: corrected the
 *   "ADR-070 privilege rule" mislabel in the header (ADR-070 is multi-provider video generation;
 *   the queue/worker privilege rule is grounded in ADR-085 — flagged by ADR-101's numbering note).
 *   No code change.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Await the durable PostgreSQL browser-task enqueue before reporting a job-application dispatch as accepted.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Stage bounded regular files plus separate
 *   job.json/profile.json data, validate public HTTP(S) targets, use collision-resistant task ids,
 *   and remove sensitive staging on failed or terminal runs. Raw applicant/job values and callback
 *   credentials no longer enter the model-visible prompt.
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | Require strict server-derived final-submit state
 *   on every dispatch input and carry it unchanged to the installed Career prompt builder.
 *
 * @module app/apply-dispatch
 */

import { randomUUID } from 'crypto';
import { constants, promises as fsp } from 'fs';
import { basename, resolve as pathResolve } from 'path';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { taskWorkspaceFolder } from '@/app/routes/remote-client-routes';
import { dispatchBrowserTask, type DispatchResult } from '@/app/browser-task-dispatch';
import { resolveApplyPromptBuilder } from '@/app/apply-prompt-bridge';
import { assertPublicHttpUrl } from '@/shared/security/ssrf-guard';
import { issueApplyCapability, revokeApplyCapability } from '@/app/apply-task-capability';

// The generic browser-task rail moved to browser-task-dispatch. Re-exported so existing importers
// (apply-submit's DispatchResult, tests) keep resolving the same names from here.
export { pickApplyClient } from '@/app/browser-task-dispatch';
export type { DispatchResult };

const logger = createChildLogger({ module: 'apply-dispatch' });

/** career-hunter is the ticket's worker bot; the dispatched task is attributed to it. */
const CAREER_HUNTER_AGENT_ID = 'cb000000-0000-0000-0000-000000000001';
/** Pin the codex model the desktop worker uses to DRIVE the application (best-LLM-for-the-job:
 *  form-filling is the hardest agentic step). Empty = the node's own default (gpt-5.5). Set
 *  APPLY_CODEX_MODEL to the top available codex model to put it on this. */
const APPLY_CODEX_MODEL = (process.env.APPLY_CODEX_MODEL || '').trim();
const MAX_PACKET_FILE_BYTES = 20 * 1024 * 1024;
const MAX_AUTOFILL_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;

export interface ApplyDispatchInput {
  ticketId: string;
  /** True only when ticketId names a real durable ticket that terminal ingest must settle. */
  settleTicket: boolean;
  /** Strict controller decision for this task; absent/string/model-derived values are never accepted. */
  finalSubmitAuthorized: boolean;
  userSub: string;
  postingId: number;
  job: { title?: string; company?: string; url?: string; location?: string };
  profile: unknown;
  packet: { resumePdf?: string | null; coverPdf?: string | null; workdayAutofill?: string | null };
  /** Optional exact worker to run on. Defaults to APPLY_EDGE_CLIENT_ID / hostname match. */
  targetRemoteClientId?: string;
}

/** Controller dependencies kept outside app-domain data and model-visible prompt construction. */
export interface ApplyDispatchDependencies { pool: Pool; }

/** @description Copy one bounded regular source file into a new private task workspace. */
async function stageRegularFile(src: string | null | undefined, dest: string, maxBytes: number): Promise<boolean> {
  if (!src) return false;
  try {
    const info = await fsp.lstat(src);
    if (!info.isFile() || info.size > maxBytes) return false;
    await fsp.copyFile(src, dest, constants.COPYFILE_EXCL);
    await fsp.chmod(dest, 0o600);
    return true;
  } catch (err) {
    logger.warn({ err, src, dest }, 'apply packet stage: bounded regular-file copy failed');
    return false;
  }
}

/** @description Write one bounded JSON data file without overwriting an existing path. */
async function stageJson(dest: string, value: unknown): Promise<boolean> {
  try {
    const raw = JSON.stringify(value ?? {}, null, 2);
    if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) return false;
    await fsp.writeFile(dest, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    logger.warn({ err, dest }, 'apply packet stage: bounded JSON write failed');
    return false;
  }
}

/** @description Validate and bound untrusted job reference data before staging it for the worker. */
async function validatedJob(job: ApplyDispatchInput['job']): Promise<ApplyDispatchInput['job'] | null> {
  const rawUrl = String(job.url || '').trim();
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return null;
    await assertPublicHttpUrl(parsed.toString());
    const text = (value: unknown): string => String(value || '').slice(0, 1000);
    return { title: text(job.title), company: text(job.company), location: text(job.location), url: parsed.toString() };
  } catch (err) {
    logger.warn({ err }, 'apply dispatch rejected unsafe job URL');
    return null;
  }
}

/** @description Build the post-selection issuer that keeps callback coordinates outside tool args. */
function prepareApplyCompletion(
  deps: ApplyDispatchDependencies,
  input: ApplyDispatchInput,
  taskId: string,
  job: ApplyDispatchInput['job'],
) {
  return async ({ controllerUrl, client }: { controllerUrl: string; client: { clientId: string } }) => {
    const targetHost = new URL(String(job.url)).hostname.toLowerCase();
    const issued = await issueApplyCapability(deps.pool, {
      taskId, userSub: input.userSub, ticketId: input.ticketId, settleTicket: input.settleTicket,
      postingId: input.postingId,
      clientId: client.clientId, targetHost,
    });
    return {
      completionCallback: {
        kind: 'trusted-http-json-v1' as const,
        url: `${controllerUrl}/api/apply/ingest`,
        capability: issued.token,
        context: { workflow: 'apply', generation: issued.generation },
      },
      onEnqueueFailure: () => revokeApplyCapability(deps.pool, taskId),
    };
  };
}

/**
 * @description Stage the packet into the task's shared workspace folder so the remote node syncs it
 * into codex's working directory. The controller reads the PDFs straight off its OWN disk (the
 * career-hunter store is mounted into the api container) — no docker-cp, which only works when the
 * worker is co-located with the api container. Never throws; returns the staged relative filenames.
 * @param folderId - The task's workspace folder id (the taskId).
 * @param packet - Absolute source paths on the controller's disk.
 * @param profile - Canonical form values, written as profile.json for the node to read.
 * @param job - Validated public job reference data, written separately as untrusted job.json data.
 * @returns The staged relative filenames (includes 'Resume_ATS.pdf' on success), or null if unstageable.
 */
async function stagePacketToWorkspace(
  folderId: string,
  packet: ApplyDispatchInput['packet'],
  profile: unknown,
  job: ApplyDispatchInput['job'],
): Promise<string[] | null> {
  const folder = taskWorkspaceFolder(folderId);
  if (!folder) { logger.error({ folderId }, 'apply packet stage: unsafe workspace folder id'); return null; }
  try {
    await fsp.mkdir(folder, { recursive: true });
  } catch (err) {
    logger.error({ err, folder }, 'apply packet stage: mkdir failed');
    return null;
  }
  const staged: string[] = [];
  if (await stageRegularFile(packet.resumePdf, pathResolve(folder, 'Resume_ATS.pdf'), MAX_PACKET_FILE_BYTES)) staged.push('Resume_ATS.pdf');
  if (await stageRegularFile(packet.coverPdf, pathResolve(folder, 'CoverLetter.pdf'), MAX_PACKET_FILE_BYTES)) staged.push('CoverLetter.pdf');
  if (await stageRegularFile(packet.workdayAutofill, pathResolve(folder, 'Resume_Workday_Autofill.txt'), MAX_AUTOFILL_BYTES)) staged.push('Resume_Workday_Autofill.txt');
  if (await stageJson(pathResolve(folder, 'profile.json'), profile)) staged.push('profile.json');
  if (await stageJson(pathResolve(folder, 'job.json'), job)) staged.push('job.json');
  return staged;
}

/**
 * @description Remove the exact random Apply task workspace after failure or terminal completion.
 * Basename and prefix checks are a second guard around taskWorkspaceFolder before recursive delete.
 */
export async function removeApplyWorkspace(taskId: string): Promise<void> {
  const folder = taskWorkspaceFolder(taskId);
  if (!folder || basename(folder) !== taskId || !/^apply-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return;
  try { await fsp.rm(folder, { recursive: true, force: true }); }
  catch (err) { logger.warn({ err, taskId }, 'apply workspace cleanup failed'); }
}

// The job-application prompt (ATS rules, résumé vocabulary, self-ID grounding) is the career-hunter
// app's DOMAIN content — it now lives in the package (career-hunter/lib/apply-prompt.js) and is loaded
// at dispatch time via resolveApplyPromptBuilder (apply-prompt-bridge). Its résumé-verify +
// anti-fabrication guards travel with it (career-hunter/lib/apply-prompt.test.mjs). Core supplies only
// the transport (worker pick + envelope) — no application vocabulary remains here.

/**
 * @description Enqueue the browser submission to the desktop worker as a gated codex.exec task.
 * Stages the packet into the task's shared workspace folder FIRST (so a non-co-located box can pull
 * the resume), then enqueues with `workspacePath` set. Never throws — a missing/offline box or an
 * unstageable resume returns `{ ok:false, error }` so the caller surfaces a clean message. Results
 * flow back asynchronously through the trusted, model-hidden /api/apply/ingest callback.
 */
export async function dispatchApply(input: ApplyDispatchInput, deps: ApplyDispatchDependencies): Promise<DispatchResult> {
  const taskId = `apply-${randomUUID()}`;
  const job = await validatedJob(input.job);
  if (!job) return { ok: false, error: 'The job URL must be a resolvable public HTTP(S) address.' };

  // Career-specific step: stage the résumé packet and REFUSE without a résumé — this must never run a
  // form with no résumé. The generic rail knows nothing about packets; the résumé gate stays here.
  const staged = await stagePacketToWorkspace(taskId, input.packet, input.profile, job);
  if (!staged || !['Resume_ATS.pdf', 'profile.json', 'job.json'].every((name) => staged.includes(name))) {
    logger.error({ taskId, postingId: input.postingId, resumePdf: input.packet.resumePdf }, 'apply dispatch aborted — resume packet not stageable');
    await removeApplyWorkspace(taskId);
    return { ok: false, error: 'Could not stage the resume into the shared workspace — the resume PDF was not found on the controller. Generate the packet first.' };
  }

  // The apply prompt is the career-hunter package's domain content — resolve it, and DEFER (never
  // invent a prompt) if the app is not installed.
  const buildApplyPrompt = resolveApplyPromptBuilder();
  if (!buildApplyPrompt) {
    logger.error({ taskId, postingId: input.postingId }, 'apply dispatch aborted — career-hunter apply-prompt module not installed');
    await removeApplyWorkspace(taskId);
    return { ok: false, error: 'The career-hunter apply module is not installed — cannot build the application prompt.' };
  }

  // Hand the generic rail the career identity, data-free prompt, staged workspace, and post-selection
  // capability issuer. The rail keeps callback metadata beside (never inside) model tool arguments.
  const result = await dispatchBrowserTask({
    taskId,
    correlationId: input.ticketId || taskId,
    fromAgentId: CAREER_HUNTER_AGENT_ID,
    userSub: input.userSub,               // so the leaf-node cost lands attributed to this owner
    prompt: ({ controllerUrl }) => buildApplyPrompt({ ...input, job }, { controllerUrl, hasCover: staged.includes('CoverLetter.pdf') }),
    model: APPLY_CODEX_MODEL || undefined,
    workspacePath: taskId,
    prepareCompletionCallback: prepareApplyCompletion(deps, input, taskId, job),
    preferredClientId: input.targetRemoteClientId,
  });
  if (result.ok) {
    logger.info(
      { clientId: result.clientId, taskId: result.taskId, postingId: input.postingId, ticketId: input.ticketId, staged },
      'apply dispatched to desktop worker (packet staged to workspace)',
    );
  }
  if (!result.ok) await removeApplyWorkspace(taskId);
  return result;
}
