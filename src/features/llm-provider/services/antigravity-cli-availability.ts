/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Can this node run `agy` AT ALL - asked without spawning anything, so a settings surface can decide whether to OFFER the Antigravity brain before a turn is dispatched rather than after one dies. Two facts answer it and both are measured, not assumed: the binary has to be present (the vendor installer's TARGET_DIR is %LOCALAPPDATA%\agy\bin and it does NOT add that directory to PATH, so a `which agy` miss proves nothing), and the node has to be able to relocate it (the CLI ships no musl build and its glibc PIE fails under gcompat - AntigravityCliHarnessAdapter measured that in a throwaway container and has carried the sentence ever since). The musl probe moved here from that adapter so the harness and the surface answer from ONE place; the adapter delegates to it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A private real-glibc runtime can now satisfy the libc probe on Alpine without weakening musl globally.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Account readiness now measures the imported headless token file used by agy itself. The operator node exports the vendor JSON from its native credential store through the authenticated login-push rail; no manual proof flag or Linux keyring is involved.
 *
 * @module llm-provider/services/antigravity-cli-availability
 */

import fs from 'fs';
import path from 'path';
import { antigravityPushedLoginPresent } from './antigravity-auth-adoption-service';

/** Environment slice this module reads. Passed explicitly so nothing reaches for a real process. */
export type AntigravityEnv = Record<string, string | undefined>;

/** The installer drops the binary as `agy`, not `antigravity`. */
export const ANTIGRAVITY_BINARY_NAME = 'agy';

/**
 * @description Whether the headless token file imported from an authenticated operator node is
 * present and has the durable vendor credential shape consumed by agy file-storage mode.
 */
export function antigravityNodeCredentialReady(env: AntigravityEnv = process.env): boolean {
  return antigravityPushedLoginPresent({ env });
}

/** Why this node cannot serve an Antigravity turn, or null when nothing is blocking it. */
export type AntigravityBlockReason = 'musl-node' | 'binary-absent';

/**
 * @description Whether this node's libc can load the Antigravity binary at all.
 *
 * MEASURED, not inferred. The vendor installer asks for `manifests/linux_amd64_musl.json`, which
 * returns 404, and the glibc artifact it would otherwise fetch is a dynamically-linked PIE against
 * `/lib64/ld-linux-x86-64.so.2` that fails to relocate on a musl image even with `gcompat`
 * installed (`__open`, `__lseek`, `__read`, `pvalloc`: symbol not found), proven in a throwaway
 * container. The production image now handles that exact case with a private real-glibc runtime;
 * a stock musl node without that runtime remains blocked.
 *
 * Stated as its own function so a surface can say the real cause instead of showing an ENOENT on a
 * file that is plainly there — the exact confusion the cline 3.x glibc build already cost once.
 * @returns A human-readable blocking reason, or null when the libc is not the problem
 */
export function antigravityMuslBlockingReason(env: AntigravityEnv = process.env): string | null {
  if (process.platform !== 'linux') return null;
  const musl = fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1');
  if (!musl) return null;
  // The production image keeps a real glibc loader and its libraries private to agy. This is not
  // gcompat and does not place libc aliases in musl's global search path; the launcher opts in
  // explicitly. A complete private runtime therefore removes the musl block for this process only.
  const runtimeDir = (env.ANTIGRAVITY_GLIBC_RUNTIME_DIR || '/opt/agy-runtime').trim();
  if (fs.existsSync(path.join(runtimeDir, 'ld-linux.so')) && fs.existsSync(path.join(runtimeDir, 'agy'))) return null;
  return 'Antigravity CLI ships no musl build (manifests/linux_amd64_musl.json is 404) and its glibc '
    + 'binary does not relocate under gcompat. Install the checksum-pinned private glibc runtime, '
    + 'run this harness on a glibc-based node, or select another provider.';
}

/**
 * @description Absolute path of the Antigravity CLI binary on this machine, or null.
 *
 * `ANTIGRAVITY_CLI_PATH` wins and is the only supported way to name a non-standard install; the
 * platform candidates below are a convenience and never the contract. Resolution is by PATH-free
 * existence check on purpose: the vendor installer's TARGET_DIR is `%LOCALAPPDATA%\\agy\\bin` and
 * it does not put that directory on PATH, so a machine that plainly has the binary answers "no" to
 * a `which agy` — which is how an earlier probe concluded it was not installed when it was.
 * @param env - Environment to read (defaults to process.env)
 * @returns The absolute path when a binary is actually present, otherwise null
 */
export function resolveAntigravityCliBinary(env: AntigravityEnv = process.env): string | null {
  const configured = (env.ANTIGRAVITY_CLI_PATH || '').trim();
  if (configured) return fs.existsSync(configured) ? configured : null;
  for (const candidate of defaultBinaryCandidates(env)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The vendor installer's TARGET_DIR per platform. Convenience only — see resolveAntigravityCliBinary. */
function defaultBinaryCandidates(env: AntigravityEnv): string[] {
  const localAppData = (env.LOCALAPPDATA || '').trim();
  const home = (env.HOME || env.USERPROFILE || '').trim();
  const candidates: string[] = [];
  if (localAppData) candidates.push(path.join(localAppData, 'agy', 'bin', 'agy.exe'));
  if (home) {
    candidates.push(path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'));
    candidates.push(path.join(home, '.local', 'share', 'agy', 'bin', ANTIGRAVITY_BINARY_NAME));
    candidates.push(path.join(home, '.agy', 'bin', ANTIGRAVITY_BINARY_NAME));
  }
  candidates.push('/usr/local/bin/agy');
  return candidates;
}

/** What a surface needs to decide whether to offer the Antigravity brain, and what to say if not. */
export interface AntigravityNodeReadiness {
  /** True only when the binary is present AND this node's libc can load it. */
  runnable: boolean;
  reason: AntigravityBlockReason | null;
  /** The blocking cause in a sentence an operator can act on; empty when runnable. */
  detail: string;
}

/**
 * @description Whether THIS process's node could run the Antigravity CLI, without running it.
 *
 * Deliberately a question about the MACHINE, not about authorization and not about whether the
 * platform has a runtime wired for the harness. A caller that is deciding whether to offer a brain
 * option has to satisfy all three separately — see `botNodeCanRunProvider` for the runtime half and
 * the ADR-127 carve for the authorization half.
 * @param env - Environment to read (defaults to process.env)
 * @returns Runnability plus the cause when it is false
 */
export function antigravityNodeReadiness(env: AntigravityEnv = process.env): AntigravityNodeReadiness {
  const musl = antigravityMuslBlockingReason(env);
  if (musl) return { runnable: false, reason: 'musl-node', detail: musl };
  if (!resolveAntigravityCliBinary(env)) {
    return {
      runnable: false,
      reason: 'binary-absent',
      detail: 'The Antigravity CLI is not installed on this node. Install it, or set '
        + 'ANTIGRAVITY_CLI_PATH to the binary (the installer does not add its directory to PATH).',
    };
  }
  return { runnable: true, reason: null, detail: '' };
}
