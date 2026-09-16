/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A failing fixture start must not print the password it just minted. execFileSync reports a failure as `Command failed: <the whole argv>`, and the fixture's argv carries `--env POSTGRES_PASSWORD=<uuid>` — so appending `error.message` to the setup-failure throw published the credential on every Docker failure, in the shared helper ~19 suites use. This drives the REAL start() path with the real argv and only the child-process seam doubled, reproducing Node's documented message shape from the arguments the fixture actually passed, then asserts the value is gone and the cause is still readable.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[][]);
// Only the child-process seam is doubled. The message is built the way Node builds it — the
// documented `Command failed: <command> <args...>` — from the argv start() really passed, so the
// string under test is the string the real failure produces.
vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === 'run') throw new Error(`Command failed: ${[file, ...args].join(' ')}\ndocker: unreachable.`);
    return '';
  },
}));

afterEach(() => { calls.length = 0; vi.clearAllMocks(); });

describe('the disposable PostgreSQL fixture never echoes the password it minted', () => {
  it('redacts POSTGRES_PASSWORD out of the setup failure, and keeps the cause readable', async () => {
    const { DisposablePostgres } = await import('../helpers/disposable-postgres');
    const fixture = new DisposablePostgres({ purpose: 'redaction-guard' });
    const failure = await fixture.start().then(() => null, (error: unknown) => error as Error);

    expect(failure, 'start() must reject when docker cannot run the image').toBeInstanceOf(Error);
    // The argv really did carry a secret — otherwise this spec proves nothing.
    const run = calls.find(call => call[1] === 'run');
    const minted = run?.join(' ').match(/POSTGRES_PASSWORD=(\S+)/)?.[1];
    expect(minted, 'the fixture no longer passes POSTGRES_PASSWORD; this guard needs rewriting').toBeTruthy();

    expect(failure!.message).not.toContain(minted!);
    expect(failure!.message).toContain('POSTGRES_PASSWORD=***');
    // The diagnostic that made this worth printing in the first place survives redaction.
    expect(failure!.message).toContain('docker: unreachable.');
    expect(failure!.message).toContain('redaction-guard');
  });
});
