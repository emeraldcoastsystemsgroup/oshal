/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the post-deploy verifier against MSYS argument conversion. On a Git-Bash host every absolute POSIX path handed to docker.exe is rewritten to a Windows path, so `docker exec <api> node /tmp/probe.js` becomes `node C:/Users/.../probe.js`, node resolves that against /app and the probe dies MODULE_NOT_FOUND before it reaches the product. That is exactly what happened on 2026-09-15: the gate that had just merged reported 2 of 3 checks failed on a stack where Jarvis was fine. The staging helper was already guarded and even carried a comment about it; the RUN helper was not, and the path was invisible to a "/tmp/" grep because it sits behind $dest. This spec asserts every docker exec/cp in the verifier that carries a container path is MSYS-guarded, including behind a variable and including inside the remedy strings an operator copy-pastes.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VERIFIER = resolve(__dirname, '../../scripts/lib/deploy-verify.sh');
const source = readFileSync(VERIFIER, 'utf8');

/** A docker invocation is at risk when it hands docker.exe an absolute container path. */
const CARRIES_CONTAINER_PATH = /(^|[\s":])\/(tmp|app)\/|\$\{?dest\}?/;
const GUARDED = /MSYS_NO_PATHCONV=1/;
/**
 * Assignments to a `*_ERROR` variable are diagnostic text reported to the caller, never executed
 * and never copy-pasted, so they carry no MSYS risk. This is the ONLY exclusion: remedy strings
 * are deliberately still policed, because a human runs those by hand on the same host.
 */
const IS_DIAGNOSTIC = /_ERROR="/;

/** Every line that invokes `docker exec` or `docker cp`, with its 1-based number. */
function dockerLines(): Array<{ n: number; text: string }> {
  return source
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => /docker\s+(exec|cp)\b/.test(text));
}

describe('deploy-verify.sh survives MSYS path conversion', () => {
  it('finds the docker invocations it is meant to police', () => {
    // A rename or rewrite that removes them all must fail loudly rather than vacuously pass.
    expect(dockerLines().length).toBeGreaterThanOrEqual(4);
  });

  it('guards every docker call that carries a container path', () => {
    const unguarded = dockerLines()
      .filter(({ text }) => !IS_DIAGNOSTIC.test(text))
      .filter(({ text }) => CARRIES_CONTAINER_PATH.test(text))
      .filter(({ text }) => !GUARDED.test(text))
      .map(({ n, text }) => `${n}: ${text.trim()}`);

    expect(unguarded, 'these hand docker.exe an absolute container path with no MSYS_NO_PATHCONV=1;'
      + ' on a Git-Bash host the path is rewritten and the call fails before reaching the product')
      .toEqual([]);
  });

  it('guards the probe RUNNER specifically, where the path hides behind $dest', () => {
    // The regression that actually shipped. A grep for "/tmp/" cannot see this line, so it is
    // asserted by name rather than left to the sweep above.
    const runner = dockerLines().find(({ text }) => /docker\s+exec\b[^\n]*node\b/.test(text));
    expect(runner, 'the probe runner line was not found').toBeDefined();
    expect(GUARDED.test(runner!.text), `line ${runner!.n} runs the probe unguarded`).toBe(true);
  });

  it('guards the remedy an operator is told to copy-paste', () => {
    // The printed remedy is executed by a human on the same host. An unguarded one sends them
    // into the identical failure while they are already debugging an outage.
    const remedies = dockerLines().filter(({ text }) => /^\s*"/.test(text));
    expect(remedies.length).toBeGreaterThan(0);
    for (const { n, text } of remedies) {
      if (!CARRIES_CONTAINER_PATH.test(text)) continue;
      expect(GUARDED.test(text), `remedy on line ${n} is unguarded: ${text.trim()}`).toBe(true);
    }
  });
});
