/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the click-coordinate scaling fix: resolveInputAction must rescale screenshot-space x AND y to physical pixels through the capture metrics (downscaled + DPI-scaled displays), pass through 1.0-scale displays unchanged, honour coordinateSpace:'physical', and no-op safely with no metrics or no coordinates. Would go red if controlInput ever went back to sending raw screenshot coordinates to the cursor APIs.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveInputAction,
  type CaptureMetrics,
  type InputAction,
} from '../../packages/oshal-chat/src/main/system-tools';

/** 2x-DPI display captured at 3200x1800 physical, downscaled to a 1600x900 screenshot. */
const DOWNSCALED_2X: CaptureMetrics = {
  width: 1600,
  height: 900,
  physicalWidth: 3200,
  physicalHeight: 1800,
  scaleFactor: 2,
};

/** Unscaled 1:1 display — screenshot and physical spaces are identical. */
const UNSCALED: CaptureMetrics = {
  width: 1920,
  height: 1080,
  physicalWidth: 1920,
  physicalHeight: 1080,
  scaleFactor: 1,
};

/** Non-uniform mapping (defensive: x and y must use their OWN axis ratio). */
const NON_UNIFORM: CaptureMetrics = {
  width: 1000,
  height: 600,
  physicalWidth: 1500,
  physicalHeight: 1200,
  scaleFactor: 1.5,
};

describe('oshal-chat resolveInputAction (screenshot → physical rescale)', () => {
  it('rescales a screenshot-space click to physical pixels on a downscaled 2x display', () => {
    const resolved = resolveInputAction({ kind: 'click', x: 800, y: 450 }, DOWNSCALED_2X);
    expect(resolved.x).toBe(1600);
    expect(resolved.y).toBe(900);
    expect(resolved.coordinateSpace).toBe('physical');
  });

  it('rescales y through the HEIGHT ratio, not the width ratio', () => {
    const resolved = resolveInputAction({ kind: 'move', x: 100, y: 100 }, NON_UNIFORM);
    expect(resolved.x).toBe(150); // 100 * 1500/1000
    expect(resolved.y).toBe(200); // 100 * 1200/600 — width ratio would (wrongly) give 150
  });

  it('rounds rescaled coordinates to whole pixels', () => {
    const resolved = resolveInputAction({ kind: 'click', x: 333, y: 111 }, DOWNSCALED_2X);
    expect(resolved.x).toBe(666);
    expect(resolved.y).toBe(222);
    const odd = resolveInputAction({ kind: 'click', x: 3, y: 1 }, NON_UNIFORM);
    expect(odd.x).toBe(Math.round(3 * 1.5)); // 4.5 → 5
    expect(odd.y).toBe(2);
  });

  it('leaves coordinates unchanged on an unscaled 1.0 display', () => {
    const resolved = resolveInputAction({ kind: 'doubleclick', x: 640, y: 480 }, UNSCALED);
    expect(resolved.x).toBe(640);
    expect(resolved.y).toBe(480);
  });

  it('passes coordinateSpace:"physical" through untouched even when metrics exist', () => {
    const action: InputAction = { kind: 'click', x: 800, y: 450, coordinateSpace: 'physical' };
    const resolved = resolveInputAction(action, DOWNSCALED_2X);
    expect(resolved.x).toBe(800);
    expect(resolved.y).toBe(450);
    expect(resolved).toBe(action); // no rewrite at all
  });

  it('passes through unchanged when no capture metrics are available yet', () => {
    const action: InputAction = { kind: 'click', x: 500, y: 500 };
    const resolved = resolveInputAction(action, null);
    expect(resolved.x).toBe(500);
    expect(resolved.y).toBe(500);
  });

  it('ignores degenerate metrics (zero screenshot dimensions) instead of dividing by zero', () => {
    const resolved = resolveInputAction(
      { kind: 'click', x: 10, y: 10 },
      { width: 0, height: 0, physicalWidth: 1920, physicalHeight: 1080, scaleFactor: 1 },
    );
    expect(resolved.x).toBe(10);
    expect(resolved.y).toBe(10);
  });

  it('leaves coordinate-free actions (type/launch) untouched', () => {
    const typeAction: InputAction = { kind: 'type', text: 'hello' };
    expect(resolveInputAction(typeAction, DOWNSCALED_2X)).toBe(typeAction);
    const launchAction: InputAction = { kind: 'launch', app: 'notepad' };
    expect(resolveInputAction(launchAction, DOWNSCALED_2X)).toBe(launchAction);
  });

  it('rescales a click that carries only x (y defaults later) without inventing a y', () => {
    const resolved = resolveInputAction({ kind: 'click', x: 800 }, DOWNSCALED_2X);
    expect(resolved.x).toBe(1600);
    expect(resolved.y).toBeUndefined();
  });
});
