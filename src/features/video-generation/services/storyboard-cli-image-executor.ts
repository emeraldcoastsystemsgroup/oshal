/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Injectable executor seam for the codex-cli storyboard image provider (ADR-130). The controller process must NEVER spawn a local CLI (two-runtimes doctrine), so the render is delegated to a bot node over the ADR-036 swarm-execute rail — but this feature module cannot import the app layer, so the app registers the executor here at boot (same pattern as registerSchwabTokenResolver). Fail-soft: nothing registered means the codex-cli provider reads as unavailable and the resolver fails closed with instructions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The request names the image rail its prompt was built for (ADR-130 amendment 2026-10-02, the bot-level rule): 'codex-cli' or 'antigravity-cli'. It does NOT name a harness to run on: the render runs on the render bot's own effective harness, and the app's executor refuses the dispatch when that harness's rail is not the one named here (the bot was switched after the rail was chosen), instead of moving the bot onto the rail's harness. The result also reports the provider the bot ran on and what its ADR-034 reconcile did, so a live check can prove the turn ran on the bot's own setting.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The request separates the server template from the user field (SEC-05 carve for image turns, operator decision 2026-10-02 b): `prompt` is now the server-authored render instruction alone, which names the tool and the inputs and tells the model to read the brief from the UNTRUSTED record as data, and the new `brief` is the user-originated text (a scene description, a region-edit brief, a portrait brief) that must never become policy. The wiring sends them as renderInstruction and text respectively, so the bot files the instruction under TRUSTED CONFIGURATION and keeps the brief in the data-only record.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Throttle image renders (operator decision 2026-10-03): the executor runs one image turn at a time per render bot, so a request may carry `startBy`, the latest moment its turn may begin; a render bot still busy then answers `busy: true` with nothing dispatched, so the caller's deadline also bounds its wait. cliStoryboardRenderBudgetMs reads STORYBOARD_CLI_IMAGE_TIMEOUT_MS (420 s when unset or not a positive number) once for the boot wiring's dispatch budget and for the whole-render deadline of the storyboard frame stage and the Test Lab render card.
 */
/**
 * @description The app-boot-injected executor the `codex-cli` storyboard image provider renders
 * through. The provider prepares a task workspace on the shared volume (anchor photo + prompt)
 * and the executor runs ONE agentic codex task in it on a dedicated bot node, where the SEC-05
 * demo carve (DEMO_MODE + operator sub, enforced at the bot, never here) governs the CLI spawn.
 *
 * @module features/video-generation/services/storyboard-cli-image-executor
 */

import type { CliStoryboardImageRail } from './storyboard-image-default';

/**
 * The source label of the data-only record the brief arrives in: the bot-node handler's untrusted
 * body (prompt-containment.ts appends it as `ticket-or-user-body`). Both CLI rails' instructions
 * name it so the model reads the brief from that record and nowhere else.
 */
export const RENDER_BRIEF_RECORD_SOURCE = 'ticket-or-user-body';

/** The CLI render budget when STORYBOARD_CLI_IMAGE_TIMEOUT_MS is unset: seven minutes, far below the 65-minute dispatch default. */
const DEFAULT_CLI_RENDER_BUDGET_MS = 420_000;

/**
 * @description The CLI render budget, STORYBOARD_CLI_IMAGE_TIMEOUT_MS (420 s when unset or not a
 * positive number): what the boot wiring gives one render dispatch, and the whole-render deadline
 * (queue wait, attempts and the waits between them) the storyboard frame stage and the Test Lab
 * render card hold the antigravity-cli rail to.
 * @param {NodeJS.ProcessEnv} [env] - The environment to read.
 * @returns {number} The budget in milliseconds.
 */
export function cliStoryboardRenderBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.STORYBOARD_CLI_IMAGE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CLI_RENDER_BUDGET_MS;
}

/** @description One render request handed to the boot-registered executor. */
export interface CliStoryboardRenderRequest {
  /**
   * The server-authored render instruction (the tool, its inputs, the output contract). It never
   * contains the brief: it tells the model to read the brief from the UNTRUSTED record as data.
   * The bot files it under TRUSTED CONFIGURATION (the SEC-05 carve for image turns).
   */
  prompt: string;
  /** The user-originated brief (scene, region edit, portrait): the untrusted body, never policy. */
  brief: string;
  /** Task id — also the workspace folder id (already canonical: lowercase, [a-z0-9_-]). */
  taskId: string;
  /** Workspace folder id under the shared workspace root; the bot's CLI runs with this as cwd. */
  workspaceFolderId: string;
  /** The REAL calling user's sub. The bot-side SEC-05 gates decide whether a CLI may spawn for it. */
  userSub: string;
  /**
   * The image rail the prompt was built for. The render runs on the render bot's own effective
   * harness; the executor refuses when that harness's rail is not this one, and never switches it.
   */
  rail: CliStoryboardImageRail;
  /**
   * The latest moment (epoch ms) this render's image turn may begin. The executor runs one image
   * turn at a time per render bot; when the bot is still busy with another one then, nothing is
   * dispatched and the result says `busy`. Omitted: the render waits its turn however long it takes.
   */
  startBy?: number;
}

/** @description What the executor reports back. Files travel via the shared volume, never here. */
export interface CliStoryboardRenderResult {
  /** True when the bot task completed without a provider-failure banner. */
  success: boolean;
  /** True when the render bot was still busy with another image turn at `startBy`: nothing was dispatched. */
  busy?: boolean;
  /** The task's final text (diagnostics only — the image is read from the workspace). */
  responseText: string;
  /** The model the bot actually ran, when reported. */
  model?: string;
  /** The provider the bot reports the turn ran on, when reported. */
  provider?: string;
  /** What the bot's ADR-034 reconcile did with the carried record ('match' = its own setting, untouched). */
  providerConfigAction?: 'absent' | 'match' | 'corrected';
  /** Error detail when success is false. */
  error?: string;
}

/** @description The executor contract the app layer registers at boot. */
export type CliStoryboardImageExecutor = (
  request: CliStoryboardRenderRequest,
) => Promise<CliStoryboardRenderResult>;

let cliStoryboardImageExecutor: CliStoryboardImageExecutor | null = null;

/**
 * @description Called once at app boot (wireCliStoryboardImageExecutor) so this feature never
 * imports the app layer or constructs a BotNodeClient itself (keeps the FSD layering top-down).
 * Passing null clears the registration (test isolation).
 * @param {CliStoryboardImageExecutor | null} executor the bot-node render executor, or null to clear
 * @returns {void}
 */
export function registerCliStoryboardImageExecutor(executor: CliStoryboardImageExecutor | null): void {
  cliStoryboardImageExecutor = executor;
}

/**
 * @description The boot-registered executor, or null when the app has not wired one (then the
 * codex-cli provider is unavailable and selection fails closed with instructions).
 * @returns {CliStoryboardImageExecutor | null} the executor, or null
 */
export function resolveCliStoryboardImageExecutor(): CliStoryboardImageExecutor | null {
  return cliStoryboardImageExecutor;
}
