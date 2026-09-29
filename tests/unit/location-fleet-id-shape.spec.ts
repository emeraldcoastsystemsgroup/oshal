/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: the location slice restates the camera and drone fleet id shape (LOCATION_FLEET_ID_SHAPE) so it does not import the drone slice (D3). This spec keeps the copy honest: its source and flags must equal CAMERA_ID_RE and DRONE_ID_RE, and a set of ids must be accepted or refused the same way by all three. Changing any one of the three regexes turns it red.
 */

import { describe, expect, it } from 'vitest';
import { CAMERA_ID_RE } from '@/features/camera';
import { DRONE_ID_RE } from '@/features/drone';
import { LOCATION_FLEET_ID_SHAPE } from '@/app/location-devices';

const SAMPLE_IDS = [
  'cam-1', 'drone_02', 'A', 'a'.repeat(32), 'a'.repeat(33), '-cam', '_cam', 'cam 1', 'cam.1', '', 'Hall-Cam',
];

describe('ADR-169 L4 fleet id shape', () => {
  it('equals the camera fleet id regex', () => {
    expect(LOCATION_FLEET_ID_SHAPE.source).toBe(CAMERA_ID_RE.source);
    expect(LOCATION_FLEET_ID_SHAPE.flags).toBe(CAMERA_ID_RE.flags);
  });

  it('equals the drone fleet id regex', () => {
    expect(LOCATION_FLEET_ID_SHAPE.source).toBe(DRONE_ID_RE.source);
    expect(LOCATION_FLEET_ID_SHAPE.flags).toBe(DRONE_ID_RE.flags);
  });

  it('accepts and refuses the same ids as both fleets', () => {
    for (const id of SAMPLE_IDS) {
      const expected = LOCATION_FLEET_ID_SHAPE.test(id);
      expect(CAMERA_ID_RE.test(id), `camera: ${JSON.stringify(id)}`).toBe(expected);
      expect(DRONE_ID_RE.test(id), `drone: ${JSON.stringify(id)}`).toBe(expected);
    }
  });
});
