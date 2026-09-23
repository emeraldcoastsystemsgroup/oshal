/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Keep terminal dead-letter classification aligned across stale-envelope workers and the two long-polling test labs.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUILD_LIKE_TICKET_STATUSES,
  TERMINAL_TICKET_STATUSES,
} from '@/features/process-lab/services/process-lab-types';

function source(path: string): string {
  return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
}

describe('dead-letter terminal classifiers', () => {
  it('stops Process Lab without claiming a refused ticket entered the build pipeline', () => {
    expect(TERMINAL_TICKET_STATUSES.has('dead_letter')).toBe(true);
    expect(BUILD_LIKE_TICKET_STATUSES.has('dead_letter')).toBe(false);
  });

  it.each([
    'src/app/extensions/swarm/index.ts',
    'src/app/bot-node-server.ts',
  ])('%s rejects a stale envelope after dead-letter quarantine', (path) => {
    const body = source(path);
    expect(body).toMatch(/status === 'complete'.{0,100}status === 'escalated'.{0,100}status === 'dead_letter'/);
  });

  it('stops Test Lab golden polling on terminal dead-letter failure', () => {
    const body = source('src/app/routes/test-lab-golden.ts');
    expect(body).toMatch(/const TERMINAL = new Set\(\[[^\]]*'dead_letter'/);
  });
});
