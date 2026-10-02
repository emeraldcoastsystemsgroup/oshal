/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Injectable executor seam for the codex-cli storyboard image provider (ADR-130). The controller process must NEVER spawn a local CLI (two-runtimes doctrine), so the render is delegated to a bot node over the ADR-036 swarm-execute rail — but this feature module cannot import the app layer, so the app registers the executor here at boot (same pattern as registerSchwabTokenResolver). Fail-soft: nothing registered means the codex-cli provider reads as unavailable and the resolver fails closed with instructions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The request names the harness the render runs on (ADR-130 amendment 2026-10-02): 'openai-codex' for the codex-cli rail, 'antigravity-cli' for the antigravity-cli rail. The app's executor stamps it as the dispatch's ADR-034 carried record instead of a fixed codex id, so the render bot reconciles onto the rail the provider was chosen for.
 */
/**
 * @description The app-boot-injected executor the `codex-cli` storyboard image provider renders
 * through. The provider prepares a task workspace on the shared volume (anchor photo + prompt)
 * and the executor runs ONE agentic codex task in it on a dedicated bot node, where the SEC-05
 * demo carve (DEMO_MODE + operator sub, enforced at the bot, never here) governs the CLI spawn.
 *
 * @module features/video-generation/services/storyboard-cli-image-executor
 */

/** @description The bot-node harness a CLI render runs on: one per CLI image rail. */
export type CliStoryboardRenderHarness = 'openai-codex' | 'antigravity-cli';

/** @description Every harness a CLI render may name; the executor refuses anything else. */
export const CLI_STORYBOARD_RENDER_HARNESSES: readonly CliStoryboardRenderHarness[] = Object.freeze(['openai-codex', 'antigravity-cli'] as const);

/** @description One render request handed to the boot-registered executor. */
export interface CliStoryboardRenderRequest {
  /** The full task prompt (render brief + output-file contract). */
  prompt: string;
  /** Task id — also the workspace folder id (already canonical: lowercase, [a-z0-9_-]). */
  taskId: string;
  /** Workspace folder id under the shared workspace root; the bot's CLI runs with this as cwd. */
  workspaceFolderId: string;
  /** The REAL calling user's sub. The bot-side SEC-05 gates decide whether a CLI may spawn for it. */
  userSub: string;
  /** The harness the render must run on; the executor carries it as the dispatch's provider record. */
  harness: CliStoryboardRenderHarness;
}

/** @description What the executor reports back. Files travel via the shared volume, never here. */
export interface CliStoryboardRenderResult {
  /** True when the bot task completed without a provider-failure banner. */
  success: boolean;
  /** The task's final text (diagnostics only — the image is read from the workspace). */
  responseText: string;
  /** The model the bot actually ran, when reported. */
  model?: string;
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
