/**
 * Apply-prompt bridge — resolves the job-application browser prompt from the INSTALLED career-hunter
 * package at runtime, instead of compiling it into the swarm controller.
 *
 * The prompt (ATS rules, résumé vocabulary, self-ID grounding) is the career app's DOMAIN content;
 * per ADR-036 it lives with the app (career-hunter/lib/apply-prompt.js in the store package), not in
 * core. The generic browser-task rail supplies only the transport (pick worker + envelope); this
 * bridge hands it the app's prompt-builder, resolved from the package the same way career-brief-bridge
 * resolves the career digest module. When the package is absent the caller gets null and defers the
 * submission — it never fabricates a prompt.
 *
 * Resolution order (first hit wins): an explicit module path (APPLY_PROMPT_MODULE, for tests) → the
 * installed package in the workspace volume → a dev sibling checkout (OSHAL_STORE_DIR). Node's own
 * module cache means a re-staged package at the same path is picked up on the next api restart, which
 * is exactly when a package re-stage lands.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial bridge: resolve
 *   buildApplyPrompt from the installed career-hunter package (volume / dev sibling / explicit
 *   override), degrade to null when absent so dispatchApply defers rather than dispatching a
 *   fabricated prompt. Mirrors the career-brief-bridge runtime-resolution pattern (ADR-085 Wave 3).
 *
 * @module app/apply-prompt-bridge
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'apply-prompt-bridge' });

/** The prompt-builder the career-hunter package exports. Typed loosely so core compiles with zero
 *  imports from the (possibly absent) package — the caller passes its ApplyDispatchInput structurally. */
export type ApplyPromptBuilder = (input: unknown, opts: { controllerUrl: string; hasCover: boolean }) => string;

/** Candidate module locations, most-specific first. */
function candidatePaths(): string[] {
  const paths: string[] = [];
  const explicit = (process.env.APPLY_PROMPT_MODULE || '').trim();
  if (explicit) paths.push(explicit);
  const workspaceRoot = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';
  paths.push(path.join(workspaceRoot, 'deployed-apps', 'career-hunter', 'lib', 'apply-prompt.js'));
  const storeDir = (process.env.OSHAL_STORE_DIR || '').trim(); // running from source (dev/local gate)
  if (storeDir) paths.push(path.join(storeDir, 'career-hunter', 'lib', 'apply-prompt.js'));
  return paths;
}

/**
 * @description Resolve the installed career-hunter package's `buildApplyPrompt`. Returns null when the
 * package is not installed — callers defer the submission (they must NOT invent a prompt).
 * @returns The prompt builder, or null when career-hunter's apply module is absent.
 */
export function resolveApplyPromptBuilder(): ApplyPromptBuilder | null {
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require(p) as { buildApplyPrompt?: ApplyPromptBuilder };
      if (typeof m.buildApplyPrompt === 'function') return m.buildApplyPrompt;
      logger.warn({ p }, 'apply-prompt module found but missing buildApplyPrompt export — skipping');
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, p }, 'apply-prompt module resolution failed at candidate');
    }
  }
  logger.error({ tried: candidatePaths() }, 'career-hunter apply-prompt module not resolvable — submissions will defer');
  return null;
}
