/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Require cockpit app frames to delegate browser full-screen permission.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cockpit packaged-surface full-screen permission', () => {
  it('delegates microphone and full-screen capabilities to the first-party app frame', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/pages/cockpit/js/cockpit-view-controller.js'),
      'utf8',
    );

    expect(source).toContain('allow="microphone; fullscreen"');
  });
});
