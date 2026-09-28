/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L1 locationSafeError: an error whose message carries a provider URL with coordinates, a multi-line message, a message rewritten after the stack was captured (the original header still in the stack), a frame-shaped line smuggled into the message, a query or fragment on a frame path, and a network URL inside a frame all reduce to class name + code + scrubbed frames. Then the end-to-end property: the projection logged through a real pino logger built from the SHIPPED redact config serialises no coordinate, no URL and no message text, while the frames still point at the failing code. Thrown non-errors, odd names and codes are covered too. Synthetic coordinates only.
 */

import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_OPTIONS, locationSafeError } from '@/shared/logger';

const LAT = '-12.34567';
const LON = '-31.98765';
const PROVIDER_URL = `https://geo.example/reverse?lat=${LAT}&lon=${LON}&format=json`;

/** A real pino logger over the shipped redact config, writing into a buffer. */
function capturingLogger(): { log: pino.Logger; output: () => string } {
  let buffer = '';
  const destination = { write(chunk: string): void { buffer += chunk; } };
  const log = pino({ level: 'debug', redact: LOG_REDACT_OPTIONS, base: undefined }, destination as pino.DestinationStream);
  return { log, output: () => buffer };
}

/** A failure raised the way a fetch wrapper would: the request URL in the message. */
function providerFailure(): Error {
  const error = new TypeError(`GET ${PROVIDER_URL} failed: 503`);
  (error as Error & { code?: string }).code = 'ECONNRESET';
  return error;
}

describe('locationSafeError: the message never survives', () => {
  it('keeps the class name, the code and frames, and drops the message that carries the URL', () => {
    const safe = locationSafeError(providerFailure());
    expect(safe.name).toBe('TypeError');
    expect(safe.code).toBe('ECONNRESET');
    expect(safe.frames.length).toBeGreaterThan(0);
    expect(safe.frames.every((f) => f.startsWith('at '))).toBe(true);
    expect(safe.frames.join('\n')).toContain('location-safe-error.spec.ts');
    const serialised = JSON.stringify(safe);
    for (const leak of [LAT, LON, 'geo.example', 'reverse?', 'failed: 503']) expect(serialised).not.toContain(leak);
  });

  it('drops every line of a multi-line message, including a frame-shaped line smuggled into it', () => {
    const error = new Error(`upstream said:\n    at lookup (${PROVIDER_URL}:1:1)\nnear ${LAT},${LON}`);
    const serialised = JSON.stringify(locationSafeError(error));
    for (const leak of [LAT, LON, 'geo.example', 'upstream said']) expect(serialised).not.toContain(leak);
  });

  it('drops the original header when the message was rewritten after the stack was captured', () => {
    const error = new Error(`GET ${PROVIDER_URL} failed near ${LAT},${LON}`);
    expect(error.stack).toContain(LAT); // V8 formats the stack lazily: read it before the rewrite
    error.message = 'lookup failed';
    const safe = locationSafeError(error);
    expect(safe.frames.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(safe);
    for (const leak of [LAT, LON, 'geo.example']) expect(serialised).not.toContain(leak);
  });

});

describe('locationSafeError: frames, logging and odd values', () => {
  it('scrubs queries, script fragments and network URLs from frames but keeps private member names', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      '    at Foo.#resolve (file:///app/dist/location/evaluator.js?lat=-12.5:10:5)',
      `    at fetchPlace (${PROVIDER_URL}:1:1)`,
      '    at run (/app/src/features/location/run.ts#frag:3:7)',
      '    at new Promise (<anonymous>)',
      '    not a frame at all',
    ].join('\n');
    expect(locationSafeError(error).frames).toEqual([
      'at Foo.#resolve (file:///app/dist/location/evaluator.js:10:5)',
      'at fetchPlace (<url>)',
      'at run (/app/src/features/location/run.ts:3:7)',
      'at new Promise (<anonymous>)',
    ]);
  });

  it('logs through the shipped pino config with no coordinate, URL or message text in the line', () => {
    const { log, output } = capturingLogger();
    try { throw providerFailure(); } catch (error) {
      log.error({ err: locationSafeError(error), ruleId: 'rule-1' }, 'reverse lookup failed');
    }
    const line = output();
    expect(line).toContain('"name":"TypeError"');
    expect(line).toContain('"code":"ECONNRESET"');
    expect(line).toContain('"ruleId":"rule-1"');
    for (const leak of [LAT, LON, 'geo.example', 'https://']) expect(line).not.toContain(leak);
  });

  it('handles thrown non-errors, odd names and odd codes without echoing them', () => {
    expect(locationSafeError(`failed near ${LAT},${LON}`)).toEqual({ name: 'NonError', frames: [] });
    expect(locationSafeError(undefined)).toEqual({ name: 'NonError', frames: [] });
    expect(locationSafeError({ code: 23505, where: LAT })).toEqual({ name: 'NonError', code: '23505', frames: [] });
    const odd = new Error('x');
    odd.name = `Lookup ${LAT}`;
    (odd as Error & { code?: string }).code = `${PROVIDER_URL}`;
    const safe = locationSafeError(odd);
    expect(safe.name).toBe('Error');
    expect(safe.code).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain(LAT);
  });
});
