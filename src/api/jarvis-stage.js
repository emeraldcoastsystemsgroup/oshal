/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the reusable Jarvis response-stage controller that morphs ambient particles into any supplied image artifact, then reverses the transition after narration.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Idle + gather clouds center on the ORB's real position via optional centerProvider (was hardcoded viewport-center/0.44h, which the right rail pushed the cloud right of + below the eye).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Idle cloud now re-centers on orb DRIFT each frame (mirrors the node field's hub-drift relayout). Fixes the case where the orb wasn't measured yet at mount so the cloud stuck at the fallback offset and never corrected.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Let configurable assistant identity flow into accessible ready/speaking stage copy.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Await decoding on the displayed artifact element before reveal so complex SVG tables and metric cards cannot be partially composited.
 */

(function installJarvisResponseStage(global) {
  'use strict';

  const DEFAULTS = Object.freeze({
    particleCount: 760,
    gatherMs: 650,
    revealMs: 850,
    archiveMs: 760,
  });

  /** @description Wait for an animation interval while allowing reduced-motion users to skip it. */
  function wait(ms, reduced) {
    return new Promise((resolve) => setTimeout(resolve, reduced ? Math.min(ms, 35) : ms));
  }

  /** @description Clamp a numeric value to the inclusive range. */
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  /** @description Read one theme color with a stable midnight fallback. */
  function themeColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  /** @description Parse a CSS hex color into RGB channels used by the particle interpolator. */
  function hexRgb(value, fallback) {
    const match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
    if (!match) return fallback;
    const number = Number.parseInt(match[1], 16);
    return { r: number >> 16, g: (number >> 8) & 255, b: number & 255 };
  }

  /** @description Generate a centered pseudo-Gaussian number without external dependencies. */
  function gaussian() {
    return (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
  }

  /** @description Load a same-origin or explicitly supplied image artifact before pixel sampling. */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }

  /**
   * @description Drives the central Jarvis materialization stage. It is deliberately domain-blind:
   * weather, charts, diagrams, photographs, and document previews are all sampled as image pixels.
   */
  class JarvisResponseStageController {
    constructor(options) {
      this.root = options.root;
      this.canvas = options.canvas;
      this.image = options.image;
      this.caption = options.caption;
      this.status = options.status;
      this.discussionTarget = options.discussionTarget || null;
      // Returns the orb's center in stage-local coordinates so the ambient cloud
      // radiates from the eye (not the viewport center, which the rail offsets).
      this.centerProvider = typeof options.centerProvider === 'function' ? options.centerProvider : null;
      this.assistantName = String(options.assistantName || 'Jarvis');
      this.context = this.canvas.getContext('2d');
      this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.config = { ...DEFAULTS, ...(options.config || {}) };
      this.particles = [];
      this.mode = 'idle';
      this.idleCenter = null;   // orb center used for the last idle layout (drift check)
      this.frame = 0;
      this.width = 0;
      this.height = 0;
      this.token = 0;
      this.onResize = () => this.resize();
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.root);
      this.resize();
      this.animate();
    }

    /** @description Materialize one arbitrary visual artifact and resolve after it becomes readable. */
    async materialize(input) {
      const token = ++this.token;
      const source = await this.resolveImage(input);
      if (token !== this.token) return false;
      if (!source) {
        this.image.classList.remove('visible');
        this.image.removeAttribute('src');
        this.image.alt = '';
        this.setCaption('');
        this.setMode('idle');
        this.root.dispatchEvent(new CustomEvent('jarvis:visual-unavailable', { bubbles: true }));
        return false;
      }
      this.setCaption(input.spokenText || input.answer || '');
      this.setMode('gathering');
      await wait(this.config.gatherMs, this.reduced);
      if (token !== this.token) return false;
      this.image.src = source.url;
      try { await this.image.decode?.(); } catch (_) { /* onload already proved the artifact is usable; reveal can still proceed. */ }
      if (token !== this.token) return false;
      this.image.alt = source.alt;
      try { this.sampleImage(source.image); } catch (_) { /* The actual image can still reveal if pixel sampling is CORS-blocked. */ }
      this.setMode('materializing');
      await wait(this.config.revealMs, this.reduced);
      if (token !== this.token) return false;
      this.setMode('speaking');
      this.image.classList.add('visible');
      // Promote only after reveal. Chromium can retain stale compositor tiles for a decoded SVG
      // that shares a continuously animated canvas unless the displayed element gets a fresh layer.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (token !== this.token) return false;
      this.image.style.zIndex = '9999';
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (token !== this.token) return false;
      return true;
    }

    /** @description Reverse the current image into the archive target and restore the ambient cloud. */
    async archive() {
      const token = ++this.token;
      this.setArchiveTargets();
      this.setMode('archiving');
      this.image.classList.remove('visible');
      this.image.style.removeProperty('z-index');
      await wait(this.config.archiveMs, this.reduced);
      if (token !== this.token) return false;
      this.image.removeAttribute('src');
      this.image.alt = '';
      this.setCaption('');
      this.setMode('idle');
      return true;
    }

    /** @description Immediately cancel a response transition and restore the idle stage. */
    reset() {
      this.token += 1;
      this.image.classList.remove('visible');
      this.image.style.removeProperty('z-index');
      this.image.removeAttribute('src');
      this.image.alt = '';
      this.setCaption('');
      this.setMode('idle');
    }

    /** @description Update accessible stage copy when the user renames the assistant. */
    setAssistantName(name) {
      this.assistantName = String(name || 'Jarvis').trim() || 'Jarvis';
      if (this.status) this.status.textContent = this.statusText(this.mode);
    }

    /** @description Release observers and animation resources when the containing surface unmounts. */
    destroy() {
      this.token += 1;
      this.resizeObserver.disconnect();
      cancelAnimationFrame(this.frame);
    }

    /** @description Resolve only a real supplied artifact; ordinary text remains an orb response. */
    async resolveImage(input) {
      const visual = input.visual || input.visualArtifact || input.presentation?.visual || {};
      const url = visual.url || visual.imageUrl || visual.uri;
      const alt = visual.alt || input.title || 'Jarvis visual response';
      if (!url) return null;
      try { return { image: await loadImage(url), url, alt }; }
      catch (_) { return null; }
    }

    /** @description Update the visible caption without interpreting model-authored markup. */
    setCaption(text) {
      if (this.caption) this.caption.textContent = String(text || '');
    }

    /** @description Set the stage and particle mode together so CSS and canvas stay synchronized. */
    setMode(mode) {
      this.mode = mode;
      this.root.dataset.state = mode;
      this.root.setAttribute('aria-busy', String(mode !== 'idle'));
      if (this.status) this.status.textContent = this.statusText(mode);
      if (mode === 'idle') this.setIdleTargets();
      if (mode === 'gathering') this.setGatherTargets();
    }

    /** @description Return short accessible state text for assistive technology. */
    statusText(mode) {
      if (mode === 'gathering') return 'Preparing the visual answer';
      if (mode === 'materializing') return 'Materializing the visual answer';
      if (mode === 'speaking') return `${this.assistantName} is speaking`;
      if (mode === 'archiving') return 'Saving the answer to the discussion';
      return `${this.assistantName} is ready`;
    }

    /** @description Resize the high-DPI canvas and regenerate scale-dependent targets. */
    resize() {
      const bounds = this.root.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      this.width = Math.max(1, bounds.width);
      this.height = Math.max(1, bounds.height);
      this.canvas.width = Math.round(this.width * ratio);
      this.canvas.height = Math.round(this.height * ratio);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.ensureParticles();
      if (this.mode === 'idle') this.setIdleTargets();
    }

    /** @description Allocate the stable particle pool once and reuse it for every answer. */
    ensureParticles() {
      const count = this.reduced ? Math.min(190, this.config.particleCount) : this.config.particleCount;
      const accent = hexRgb(themeColor('--accent', '#7c7cff'), { r: 124, g: 124, b: 255 });
      while (this.particles.length < count) {
        this.particles.push({
          x: this.width / 2,
          y: this.height / 2,
          tx: this.width / 2,
          ty: this.height / 2,
          r: accent.r,
          g: accent.g,
          b: accent.b,
          tr: accent.r,
          tg: accent.g,
          tb: accent.b,
          size: 0.65 + Math.random() * 1.6,
          alpha: 0.25 + Math.random() * 0.65,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }

    /** @description Orb center in stage-local coords (provider), else the legacy fallback. */
    stageCenter() {
      if (this.centerProvider) {
        const c = this.centerProvider();
        if (c && isFinite(c.x) && isFinite(c.y)) return c;
      }
      return { x: this.width / 2, y: this.height * 0.44 };
    }

    /** @description Scatter particles into the calm Jarvis cloud around the center orb. */
    setIdleTargets() {
      const center = this.stageCenter();
      this.idleCenter = center;   // remember it so animate() can re-center on orb drift
      const { x: centerX, y: centerY } = center;
      const radiusX = Math.min(this.width * 0.34, 430);
      const radiusY = Math.min(this.height * 0.25, 190);
      this.particles.forEach((particle, index) => {
        const angle = index * 0.67;
        const radius = 0.18 + ((index * 37) % 100) / 118;
        particle.tx = centerX + Math.cos(angle) * radiusX * radius + gaussian() * 32;
        particle.ty = centerY + Math.sin(angle) * radiusY * radius + gaussian() * 20;
      });
    }

    /** @description Pull the same particle pool into a compact spiral while the artifact loads. */
    setGatherTargets() {
      const { x: centerX, y: centerY } = this.stageCenter();
      this.particles.forEach((particle, index) => {
        const angle = index * 0.37;
        const radius = 18 + (index % 115) * 1.05;
        particle.tx = centerX + Math.cos(angle) * radius;
        particle.ty = centerY + Math.sin(angle) * radius * 0.56;
      });
    }

    /** @description Sample arbitrary image pixels and assign them as particle positions and colors. */
    sampleImage(image) {
      const sample = this.drawSampleCanvas(image);
      const targets = this.readSampleTargets(sample);
      if (!targets.length) return;
      this.particles.forEach((particle, index) => {
        const target = targets[index % targets.length];
        particle.tx = target.x;
        particle.ty = target.y;
        particle.tr = target.r;
        particle.tg = target.g;
        particle.tb = target.b;
      });
    }

    /** @description Draw the artifact into a bounded offscreen canvas matching the visible stage. */
    drawSampleCanvas(image) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(this.width));
      canvas.height = Math.max(1, Math.round(this.height));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const maxWidth = this.width * 0.78;
      const maxHeight = this.height * 0.62;
      const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const x = (this.width - width) / 2;
      const y = (this.height - height) / 2 - this.height * 0.025;
      context.drawImage(image, x, y, width, height);
      return canvas;
    }

    /** @description Read a bounded random sample of visible pixels for the particle morph. */
    readSampleTargets(canvas) {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const stride = Math.max(4, Math.floor(Math.sqrt((canvas.width * canvas.height) / (this.particles.length * 5))));
      const targets = [];
      for (let y = 0; y < canvas.height; y += stride) {
        for (let x = 0; x < canvas.width; x += stride) {
          const offset = (y * canvas.width + x) * 4;
          if (data[offset + 3] < 70) continue;
          if ((x + y) % (stride * 3) !== 0 && targets.length > this.particles.length * 2) continue;
          targets.push({ x, y, r: data[offset], g: data[offset + 1], b: data[offset + 2] });
        }
      }
      return targets.sort(() => Math.random() - 0.5).slice(0, this.particles.length * 3);
    }

    /** @description Aim particles at the Discussion affordance before restoring the idle cloud. */
    setArchiveTargets() {
      const rootBounds = this.root.getBoundingClientRect();
      const targetBounds = this.discussionTarget?.getBoundingClientRect();
      const x = targetBounds ? targetBounds.left + targetBounds.width / 2 - rootBounds.left : this.width - 34;
      const y = targetBounds ? targetBounds.top + targetBounds.height / 2 - rootBounds.top : 28;
      this.particles.forEach((particle) => {
        particle.tx = x + gaussian() * 13;
        particle.ty = y + gaussian() * 10;
      });
    }

    /** @description Run the persistent particle interpolation loop. */
    animate() {
      const context = this.context;
      context.clearRect(0, 0, this.width, this.height);
      // Keep the idle cloud locked to the orb: if the orb moved since the idle
      // targets were laid out (late web-font reflow, scroll, resize), re-center —
      // mirrors the node field's hub-drift relayout so the two never diverge.
      if (this.mode === 'idle' && this.idleCenter) {
        const c = this.stageCenter();
        if (Math.hypot(c.x - this.idleCenter.x, c.y - this.idleCenter.y) > 2) this.setIdleTargets();
      }
      const easing = this.mode === 'archiving' ? 0.12 : this.mode === 'gathering' ? 0.085 : 0.052;
      for (const particle of this.particles) this.drawParticle(particle, easing);
      this.frame = requestAnimationFrame(() => this.animate());
    }

    /** @description Interpolate and draw one reusable image/cloud particle. */
    drawParticle(particle, easing) {
      particle.x += (particle.tx - particle.x) * easing;
      particle.y += (particle.ty - particle.y) * easing;
      particle.r += (particle.tr - particle.r) * 0.06;
      particle.g += (particle.tg - particle.g) * 0.06;
      particle.b += (particle.tb - particle.b) * 0.06;
      this.context.beginPath();
      this.context.fillStyle = `rgba(${particle.r | 0},${particle.g | 0},${particle.b | 0},${particle.alpha})`;
      this.context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      this.context.fill();
    }
  }

  global.JarvisResponseStage = Object.freeze({
    /** @description Mount a domain-agnostic response-stage controller onto supplied DOM elements. */
    mount(options) {
      return new JarvisResponseStageController(options);
    },
  });
}(window));
