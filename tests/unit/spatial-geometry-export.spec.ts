/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 geometry export guard — pins splatBounds, the accuracy-critical math behind GET /scans/:id/dimensions (the "is my 3D model to-scale?" answer). A packed .splat whose gaussian positions span a known box must report that box's min/max, per-axis size, and count EXACTLY (a LiDAR import's units are metres, so the size IS the room's real footprint); an empty buffer is null, and non-finite coordinates are ignored rather than poisoning the bounds. Guards the geometry-export increment that turns Spaces from a viewer into a build-on-able model.
 */
import { describe, it, expect } from 'vitest';
import { packSplat, splatBounds, type Gaussian } from '../../src/features/spatial-mapping/services/splat-format';

/** A gaussian at a position, with throwaway scale/color (bounds only reads position). */
function at(x: number, y: number, z: number): Gaussian {
  return { pos: [x, y, z], scale: [0.01, 0.01, 0.01], color: [128, 128, 128, 255] };
}

describe('splatBounds — to-scale dimensions from a packed .splat', () => {
  it('reports the exact bounding box, per-axis size, and count of the positions', () => {
    // A 4m x 2.5m x 3m room footprint (metres, as a LiDAR import would be).
    const buf = packSplat([
      at(-2, 0, -1.5),
      at(2, 2.5, 1.5),
      at(0, 1, 0),
    ]);
    const b = splatBounds(buf)!;
    expect(b).not.toBeNull();
    expect(b.min).toEqual([-2, 0, -1.5]);
    expect(b.max).toEqual([2, 2.5, 1.5]);
    // width (X) 4, height (Y) 2.5, depth (Z) 3
    expect(b.size[0]).toBeCloseTo(4, 5);
    expect(b.size[1]).toBeCloseTo(2.5, 5);
    expect(b.size[2]).toBeCloseTo(3, 5);
    expect(b.count).toBe(3);
  });

  it('returns null for an empty buffer (no geometry)', () => {
    expect(splatBounds(Buffer.alloc(0))).toBeNull();
  });

  it('ignores non-finite coordinates instead of poisoning the bounds', () => {
    const buf = packSplat([at(-1, -1, -1), at(1, 1, 1), at(NaN, Infinity, -Infinity)]);
    const b = splatBounds(buf)!;
    expect(b.count).toBe(3);
    expect(b.min).toEqual([-1, -1, -1]);
    expect(b.max).toEqual([1, 1, 1]);
  });

  it('is exact for a single point (a degenerate zero-size box, not a crash)', () => {
    const b = splatBounds(packSplat([at(5, 6, 7)]))!;
    expect(b.min).toEqual([5, 6, 7]);
    expect(b.max).toEqual([5, 6, 7]);
    expect(b.size).toEqual([0, 0, 0]);
    expect(b.count).toBe(1);
  });
});
