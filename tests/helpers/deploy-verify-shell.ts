/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from tests/unit/deploy-live-verification.spec.ts when the exit-code-contract cases pushed that file past the 800-code-line decomposition threshold. Both spec files drive the SAME real library in a real Git Bash with the docker binary shadowed, and a second private copy of this harness is how the two would quietly start driving a different shell, a different stub, or a different environment baseline from each other.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The real library under test, and the deploy that sources it. */
export const VERIFY_LIB = path.resolve('scripts/lib/deploy-verify.sh');
export const DEPLOY_SCRIPT = path.resolve('scripts/oshal-deploy.sh');
/** The production Git Bash identity probe, so a WSL/System32 launcher fails closed. */
const BASH_RESOLVER = path.resolve('scripts/lib/windows-git-bash.ps1');
const BASH_TIMEOUT_MS = 20_000;

/**
 * @description Resolve Bash through the production identity probe and fail closed on a
 * WSL/System32 launcher — those run in a different filesystem namespace, so a case that landed on
 * one would be driving a different tree than the one it asserts about.
 * @returns An absolute path to a validated Git Bash (or plain `bash` off Windows).
 */
export function resolveHostBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const resolver = BASH_RESOLVER.replace(/'/g, "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${resolver}'; $selected = Resolve-OshalGitBash; if (-not $selected) { exit 2 }; [Console]::Out.Write($selected)`,
  ], { encoding: 'utf8', timeout: 30_000 });
  const candidate = result.stdout.trim();
  if (result.error || result.status !== 0 || !path.win32.isAbsolute(candidate)
    || /[\\/](?:system32|sysnative|syswow64)[\\/]|wsl\.exe$/i.test(candidate)) {
    throw new Error('A validated Git Bash executable is required for the deploy verification guard.');
  }
  return candidate;
}

/**
 * A bash `docker` FUNCTION, not a PATH entry: it shadows the real binary completely, so no case
 * driving this harness can reach the engine even if the library grows another docker call tomorrow.
 */
export const DOCKER_STUB = `docker() {
  printf '%s\\n' "$*" >> "$DOCKER_STUB_LOG"
  case "$1" in
    cp) return "\${DOCKER_STUB_CP_RC:-0}" ;;
    exec)
      case "$*" in
        *psql*) printf '%s\\n' "\${DOCKER_STUB_GRANT:-t}"; return 0 ;;
        *" jarvis") printf '%s\\n' "\${DOCKER_STUB_JARVIS_OUT:-answered}"; return "\${DOCKER_STUB_JARVIS_RC:-0}" ;;
        *" ticket") printf '%s\\n' "\${DOCKER_STUB_TICKET_OUT:-moved}"; return "\${DOCKER_STUB_TICKET_RC:-0}" ;;
      esac ;;
  esac
  printf 'UNEXPECTED DOCKER CALL\\n' >&2
  return 97
}
`;

/** One run of the real gate: the spawn result, the docker calls it made, and the ledger it used. */
export type PostVerifyRun = SpawnSyncReturns<string> & { calls: string[]; ledger: string };

/**
 * @description A scratch path spelled the way this host's Git Bash accepts it after `source`.
 * @param scratch - The calling spec's scratch directory.
 * @param prefix - A short name so a failure names which file it was.
 * @returns An absolute, forward-slashed path inside that directory.
 */
export function scratchFile(scratch: string, prefix: string): string {
  return path.join(scratch, `${prefix}-${Math.random().toString(36).slice(2)}.log`).replace(/\\/g, '/');
}

/**
 * @description Run the REAL verification library in a real shell with the docker binary shadowed.
 *
 * Every run gets its OWN streak ledger unless the caller deliberately shares one. The unproven
 * escalation is derived from that file, so a single shared default would make cases order-dependent
 * — and would append a line to the operator's real ~/.oshal-deploy on every test run. The three
 * switches the gate reads are pinned to empty for the same reason in reverse: a verdict must never
 * depend on what happens to be exported in the shell that started vitest.
 * @param bash - The validated Git Bash from {@link resolveHostBash}.
 * @param stub - Path to a file containing {@link DOCKER_STUB}, sourced before the library.
 * @param scratch - The calling spec's scratch directory, for the call log and the default ledger.
 * @param env - Per-case environment: stub return codes, and any gate switch under test.
 * @returns The spawn result plus the docker calls made and the ledger path that was used.
 */
export function runPostVerify(bash: string, stub: string, scratch: string,
  env: Record<string, string> = {}): PostVerifyRun {
  const callLog = scratchFile(scratch, 'calls');
  writeFileSync(callLog, '');
  const ledger = env.OSHAL_VERIFY_LEDGER ?? scratchFile(scratch, 'ledger');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c',
    'set -uo pipefail\nsource "$1"\nsource "$2"\noshal_deploy_post_verify\nprintf "RC=%s\\n" "$?"',
    'deploy-verify-test', stub.replace(/\\/g, '/'), VERIFY_LIB.replace(/\\/g, '/')],
  { cwd: process.cwd(), encoding: 'utf8', timeout: BASH_TIMEOUT_MS, env: {
    ...process.env,
    OSHAL_VERIFY_OPERATOR_PAT: '',
    OSHAL_VERIFY_REQUIRE_PROOF: '',
    OSHAL_DEPLOY_SKIP_LIVE_VERIFY: '',
    ...env,
    OSHAL_VERIFY_LEDGER: ledger,
    DOCKER_STUB_LOG: callLog,
  } });
  return { ...result, ledger, calls: readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) };
}
