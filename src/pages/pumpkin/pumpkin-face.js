/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: procedural jack-o'-lantern canvas renderer. Draws a glowing carved face (eyes/brows/mouth+teeth) from a PumpkinPreset, animates idle bob/sway/blink/gaze/candle-flicker, eases toward an expression, and opens the mouth to an externally-supplied speech level (the lip-sync signal). No image assets — every look is code-drawn so presets are infinitely configurable.
 */

/* global window */
(function () {
  'use strict';

  /** Ease a current value toward a target by a per-frame rate (frame-rate-aware). */
  function approach(cur, target, rate, dt) {
    const k = 1 - Math.pow(1 - rate, dt * 60);
    return cur + (target - cur) * k;
  }

  /** Deterministic-ish flicker from summed sines — no Math.random so it reads as a candle, not noise. */
  function flickerAt(t) {
    return (
      0.6 +
      0.25 * Math.sin(t * 11.0) +
      0.1 * Math.sin(t * 23.3 + 1.7) +
      0.05 * Math.sin(t * 41.1 + 0.3)
    );
  }

  /** Per-expression modifiers layered onto the base face pose. */
  const EXPRESSIONS = {
    neutral:   { brow: 0.0,  squint: 0.0,  mouthCurve: 0.0,  eyeScale: 1.0,  glow: 1.0,  openBias: 0.0 },
    happy:     { brow: 0.3,  squint: 0.15, mouthCurve: 0.6,  eyeScale: 1.0,  glow: 1.1,  openBias: 0.05 },
    mischief:  { brow: -0.2, squint: 0.35, mouthCurve: 0.4,  eyeScale: 0.95, glow: 1.05, openBias: 0.0 },
    spooky:    { brow: -0.4, squint: 0.25, mouthCurve: -0.2, eyeScale: 0.9,  glow: 0.85, openBias: 0.05 },
    angry:     { brow: -0.8, squint: 0.3,  mouthCurve: -0.5, eyeScale: 0.9,  glow: 1.2,  openBias: 0.1 },
    laugh:     { brow: 0.4,  squint: 0.5,  mouthCurve: 0.8,  eyeScale: 0.85, glow: 1.15, openBias: 0.25 },
    surprised: { brow: 0.7,  squint: -0.3, mouthCurve: 0.1,  eyeScale: 1.25, glow: 1.1,  openBias: 0.3 },
  };

  /**
   * A living jack-o'-lantern face on a canvas. Drive it: setPreset(), setExpression(name,intensity),
   * setSpeaking(bool), setLevel(0..1) each audio frame, then render(dt) every animation frame.
   */
  class PumpkinFace {
    constructor(canvas, preset) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.preset = preset;
      this.t = 0;
      // Animation state (current vs target where eased).
      this.mouth = 0; this.mouthTarget = 0;
      this.level = 0;            // external speech level (0..1)
      this.speaking = false;
      this.blink = 0;            // 0 open .. 1 closed
      this.nextBlink = 1.5;
      this.gazeX = 0; this.gazeY = 0; this.gazeTX = 0; this.gazeTY = 0;
      this.nextGaze = 2;
      this.expr = 'neutral'; this.exprAmt = 0;
      this.exprCur = Object.assign({}, EXPRESSIONS.neutral);
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    setPreset(preset) { if (preset) this.preset = preset; }

    setExpression(name, intensity) {
      if (EXPRESSIONS[name]) { this.expr = name; this.exprAmt = Math.max(0, Math.min(1, intensity == null ? 0.6 : intensity)); }
    }

    setSpeaking(on) {
      this.speaking = !!on;
      if (!on) { this.mouthTarget = 0; this.level = 0; }
    }

    /** Feed the current speech amplitude (0..1); the mouth opens to it while speaking. */
    setLevel(v) { this.level = Math.max(0, Math.min(1, v || 0)); }

    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.w = w; this.h = h;
    }

    /** Advance timers (blink schedule, gaze darts, expression + mouth easing). */
    _tick(dt) {
      this.t += dt;
      const m = this.preset.motion;
      // Blink
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) { this._blinking = 0.18; this.nextBlink = 60 / Math.max(1, m.blinkPerMin) * (0.6 + 0.8 * ((Math.sin(this.t * 7.3) + 1) / 2)); }
      if (this._blinking > 0) { this._blinking -= dt; this.blink = Math.sin((1 - Math.max(0, this._blinking) / 0.18) * Math.PI); }
      else this.blink = approach(this.blink, 0, 0.4, dt);
      // Gaze darts
      this.nextGaze -= dt;
      if (this.nextGaze <= 0) {
        const g = m.gaze;
        this.gazeTX = (Math.sin(this.t * 3.1) ) * g; this.gazeTY = (Math.sin(this.t * 2.3 + 1)) * g * 0.5;
        this.nextGaze = 1.2 + 2.5 * ((Math.sin(this.t * 5.1) + 1) / 2);
      }
      this.gazeX = approach(this.gazeX, this.gazeTX, 0.08, dt);
      this.gazeY = approach(this.gazeY, this.gazeTY, 0.08, dt);
      // Expression easing (blend current modifier set toward the active one)
      const target = EXPRESSIONS[this.expr] || EXPRESSIONS.neutral;
      for (const k in this.exprCur) this.exprCur[k] = approach(this.exprCur[k], (EXPRESSIONS.neutral[k] + (target[k] - EXPRESSIONS.neutral[k]) * this.exprAmt), 0.12, dt);
      // Mouth: open to speech level while speaking (+ expression bias), else rest.
      const react = this.preset.motion.mouthReactivity;
      this.mouthTarget = this.speaking ? Math.min(1, this.level * react + this.exprCur.openBias) : this.exprCur.openBias * 0.3;
      this.mouth = approach(this.mouth, this.mouthTarget, this.speaking ? 0.6 : 0.2, dt);
    }

    render(dt) {
      this._tick(Math.min(0.05, dt));
      const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
      const p = this.preset, c = p.colors;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      // Background
      ctx.fillStyle = c.background;
      ctx.fillRect(0, 0, this.w, this.h);
      // Frame vignette / ambient
      this._ambient(ctx, c);
      // Face space: fit a 1000-unit square centered, with idle bob + sway.
      const S = Math.min(this.w, this.h) * 0.86 / 1000;
      const bob = Math.sin(this.t * p.motion.bobSpeed * Math.PI * 2) * p.motion.idleBob;
      const sway = Math.sin(this.t * p.motion.bobSpeed * Math.PI * 1.3) * (p.motion.sway * Math.PI / 180);
      ctx.save();
      ctx.translate(this.w / 2, this.h / 2 + bob);
      ctx.rotate(sway);
      ctx.scale(S, S);
      const flick = 1 - p.motion.flicker + p.motion.flicker * flickerAt(this.t);
      const glowMul = p.glow.intensity * this.exprCur.glow * flick;
      this._bodyGlow(ctx, c, glowMul);
      this._features(ctx, p, c, glowMul);
      ctx.restore();
    }

    _ambient(ctx, c) {
      const g = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.2, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, c.ambient);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    _bodyGlow(ctx, c, glowMul) {
      if (!c.bodyGlow || c.bodyGlow === 'transparent') return;
      const g = ctx.createRadialGradient(0, 40, 60, 0, 40, 620);
      g.addColorStop(0, c.bodyGlow);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = Math.min(1, glowMul);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 40, 560, 500, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /** Set the glowing-cutout fill: a hot core → feature edge, with bloom. */
    _lit(ctx, c, glowMul, cx, cy, r) {
      const g = ctx.createRadialGradient(cx, cy - r * 0.2, 2, cx, cy, r * 1.4);
      g.addColorStop(0, c.featureHot);
      g.addColorStop(0.55, c.feature);
      g.addColorStop(1, c.feature);
      ctx.fillStyle = g;
      ctx.shadowColor = c.feature;
      ctx.shadowBlur = this.preset.glow.blur * glowMul;
    }

    _features(ctx, p, c, glowMul) {
      const f = p.face;
      const dx = 150 + f.eyeSpacing * 180;
      const eyeY = -170;
      const eyeR = 55 + f.eyeSize * 70;
      // Eyes (mirror the gaze offset)
      this._eye(ctx, p, c, glowMul, -dx, eyeY, eyeR, -1);
      this._eye(ctx, p, c, glowMul, dx, eyeY, eyeR, 1);
      // Nose (small triangle)
      this._lit(ctx, c, glowMul, 0, -20, 40);
      ctx.beginPath();
      ctx.moveTo(0, -70); ctx.lineTo(-46, 10); ctx.lineTo(46, 10); ctx.closePath(); ctx.fill();
      // Mouth
      this._mouth(ctx, p, c, glowMul);
      ctx.shadowBlur = 0;
    }

    _eye(ctx, p, c, glowMul, cx, cy, r, side) {
      const f = p.face, e = this.exprCur;
      const open = Math.max(0.06, 1 - this.blink) * (1 + e.eyeScale * 0.0) * (1 - e.squint * 0.5);
      const gx = this.gazeX * 30, gy = this.gazeY * 20;
      ctx.save();
      ctx.translate(cx + gx, cy + gy);
      ctx.scale(1, open);
      this._lit(ctx, c, glowMul, 0, 0, r);
      ctx.beginPath();
      this._eyePath(ctx, f.eyeShape, r, side);
      ctx.fill();
      ctx.restore();
      // Brow: a dark bar that occludes the top of the eye (subtracts light for anger).
      this._brow(ctx, c, cx + gx, cy, r, side, f.browAngle + e.brow);
    }

    _eyePath(ctx, shape, r, side) {
      if (shape === 'round') { ctx.arc(0, 0, r, 0, Math.PI * 2); return; }
      if (shape === 'square') { ctx.rect(-r, -r * 0.8, r * 2, r * 1.6); return; }
      if (shape === 'diamond') { ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath(); return; }
      if (shape === 'angry') { // slanted triangle, inner-top low
        ctx.moveTo(-r, -r * 0.2 * side); ctx.lineTo(r, -r * 1.0 * side); ctx.lineTo(r, r * 0.6); ctx.lineTo(-r, r * 0.6); ctx.closePath(); return;
      }
      // triangle (classic): apex up
      ctx.moveTo(0, -r); ctx.lineTo(r, r * 0.7); ctx.lineTo(-r, r * 0.7); ctx.closePath();
    }

    _brow(ctx, c, cx, cy, r, side, angle) {
      if (angle >= 0.15) return; // only lower/angled brows carve in
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.fillStyle = c.background;
      ctx.translate(cx, cy - r * 1.05);
      ctx.rotate((-angle) * 0.5 * side);
      ctx.fillRect(-r * 1.3, -r * 0.9, r * 2.6, r * 0.95);
      ctx.restore();
    }

    _mouth(ctx, p, c, glowMul) {
      const f = p.face, e = this.exprCur;
      const w = 220 + f.mouthWidth * 260;
      const cy = 200;
      const open = this.mouth;                     // 0..1
      const h = 40 + open * 190;                    // mouth height
      const curve = e.mouthCurve * 60;              // smile/frown at corners
      this._lit(ctx, c, glowMul, 0, cy, w * 0.5);
      ctx.beginPath();
      if (f.mouthShape === 'oval') {
        ctx.ellipse(0, cy, w * 0.5, h * 0.6, 0, 0, Math.PI * 2);
      } else {
        this._mouthPath(ctx, f.mouthShape, w, cy, h, curve, f.toothCount);
      }
      ctx.fill();
    }

    _mouthPath(ctx, shape, w, cy, h, curve, teeth) {
      const half = w / 2;
      const topY = cy - curve - h * 0.15;
      const botY = cy + h;
      ctx.moveTo(-half, topY);
      // Top edge with teeth (downward triangles) when jagged/snaggle.
      const n = (shape === 'grin') ? 0 : Math.max(0, teeth);
      for (let i = 0; i < n; i++) {
        const x0 = -half + (w * i) / n;
        const x1 = -half + (w * (i + 0.5)) / n;
        const x2 = -half + (w * (i + 1)) / n;
        const depth = (shape === 'snaggle' && i % 2 === 0) ? h * 0.55 : h * 0.32;
        ctx.lineTo(x0, topY);
        ctx.lineTo(x1, topY + depth);
        ctx.lineTo(x2, topY);
      }
      ctx.lineTo(half, topY);
      // Corners curve up/down for expression, bottom edge with fewer up-teeth.
      ctx.quadraticCurveTo(half + 20, cy, half, botY - Math.abs(curve) * 0.5);
      const bn = Math.max(0, Math.floor(n / 2));
      for (let i = 0; i < bn; i++) {
        const x0 = half - (w * i) / bn;
        const x1 = half - (w * (i + 0.5)) / bn;
        const x2 = half - (w * (i + 1)) / bn;
        ctx.lineTo(x0, botY);
        ctx.lineTo(x1, botY - h * 0.3);
        ctx.lineTo(x2, botY);
      }
      ctx.lineTo(-half, botY);
      ctx.quadraticCurveTo(-half - 20, cy, -half, topY);
      ctx.closePath();
    }
  }

  window.PumpkinFace = PumpkinFace;
})();
