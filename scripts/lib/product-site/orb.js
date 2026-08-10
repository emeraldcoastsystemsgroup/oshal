/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The catalog as one living object: a 3D sphere of every application, each node coloured by its shelf so the whole thing reads as a colour wheel of what the platform does. Built as progressive enhancement — the section ships a real, legible static fallback (the shelf legend + a link to every app), and only upgrades to the rotating orb when JavaScript runs and the viewer has not asked for reduced motion. Every node is a real <a> to its app page, so the orb is a navigable directory, not decoration. Self-contained: the node list is a JSON data island in the page, the engine is inline, nothing is fetched.
 */

const { esc } = require('./theme');

/**
 * The colour wheel: one hue per catalog shelf. Evenly spread around the wheel so the sphere reads
 * as a spectrum. `platform` (the assistant) is the bright near-white core.
 */
const SHELF_HUE = {
  'ai-productivity': '#22D3EE',
  'ai-knowledge': '#34D399',
  'ai-finance': '#FBBF24',
  'ai-creative': '#F472B6',
  'ai-home': '#A78BFA',
  'ai-engineering': '#60A5FA',
  platform: '#F8FAFC',
};

/**
 * @description Renders the hero orb section for the catalog hub. `model` is the built catalog; the
 * apps carry `title`, `suite`, and a resolvable app-page path. Returns a self-contained section
 * (data island + static fallback + inline engine).
 */
function renderOrb(model) {
  const { counts, shelves } = model;
  // The node list the engine spins. Ordered so the sphere interleaves shelves rather than clumping.
  const nodes = model.apps.map((a) => ({
    t: a.title,
    s: a.suite,
    u: `/product/apps/${a.name}/`,
    c: SHELF_HUE[a.suite] || '#94A3B8',
  }));

  // The static fallback + always-present legend: the six shelves as swatches with their counts,
  // each linking to its shelf page. This is what a no-JS / reduced-motion / crawler visitor sees.
  const legend = shelves.map((sh) => `<a class="orb-key" href="/product/${esc(sh.slug)}/">
      <span class="dot" style="--h:${SHELF_HUE[sh.id] || '#94A3B8'}"></span>
      ${esc(sh.label)} <b>${sh.apps.length}</b></a>`).join('');

  return `
<section class="orb-hero"><div class="wrap">
  <div class="orb-copy">
    <p class="eyebrow"><b>●</b> ${counts.apps} applications · ${counts.shelves} shelves · one platform</p>
    <h1 class="orb-h1">The whole platform, <span class="accent">in one hand.</span></h1>
    <p class="lede">Every application is a node. Every colour is a shelf. Spin it — each one is a real
      surface you can open, and the code behind all of them is the same platform underneath.</p>
    <div class="orb-legend">${legend}</div>
  </div>
  <div class="orb-stage" id="orb-stage" aria-hidden="false">
    <div class="orb-glow"></div>
    <div class="orb-ring"></div>
    <div class="orb" id="orb"></div>
    <noscript><p class="orb-fallback">The colour wheel above links every shelf; the full catalog is below.</p></noscript>
  </div>
</div>
<script id="orb-data" type="application/json">${JSON.stringify(nodes)}</script>
<script>
(function () {
  'use strict';
  var stage = document.getElementById('orb-stage');
  var orb = document.getElementById('orb');
  var raw = document.getElementById('orb-data');
  if (!stage || !orb || !raw) return;
  var nodes; try { nodes = JSON.parse(raw.textContent); } catch (e) { return; }
  if (!nodes.length) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Build a node element per app, placed on a Fibonacci sphere for even coverage.
  var N = nodes.length, els = [];
  var golden = Math.PI * (3 - Math.sqrt(5));
  for (var i = 0; i < N; i++) {
    var y = 1 - (i / (N - 1)) * 2;            // 1 .. -1
    var r = Math.sqrt(Math.max(0, 1 - y * y));
    var th = golden * i;
    var n = nodes[i];
    var a = document.createElement('a');
    a.className = 'orb-node';
    a.href = n.u;
    a.textContent = n.t;
    a.style.setProperty('--c', n.c);
    a.setAttribute('data-shelf', n.s);
    orb.appendChild(a);
    els.push({ el: a, x: Math.cos(th) * r, y: y, z: Math.sin(th) * r });
  }

  var rotY = 0.5, rotX = -0.35, velY = reduce ? 0 : 0.0016, velX = 0;
  var dragging = false, lastX = 0, lastY = 0, size = 0, radius = 0;

  function measure() {
    var rect = stage.getBoundingClientRect();
    size = Math.min(rect.width, rect.height);
    radius = size * 0.40;
  }

  function frame() {
    rotY += velY; rotX += velX;
    // gentle spring back toward a pleasing tilt; damp the drag velocity
    if (!dragging) { velX *= 0.94; rotX += (-0.35 - rotX) * 0.02; }
    var cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    var cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    for (var i = 0; i < els.length; i++) {
      var p = els[i];
      // rotate around Y then X
      var x1 = p.x * cosY - p.z * sinY;
      var z1 = p.x * sinY + p.z * cosY;
      var y1 = p.y * cosX - z1 * sinX;
      var z2 = p.y * sinX + z1 * cosX;
      var depth = (z2 + 1.6) / 2.6;                  // 0 (back) .. ~1 (front)
      var scale = 0.55 + depth * 0.75;
      var tx = x1 * radius, ty = y1 * radius;
      var s = p.el.style;
      s.transform = 'translate(-50%,-50%) translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0) scale(' + scale.toFixed(3) + ')';
      s.opacity = (0.28 + depth * 0.72).toFixed(3);
      s.zIndex = String(1000 + Math.round(z2 * 1000));
      s.filter = z2 < -0.1 ? 'blur(' + Math.min(2.2, (-z2) * 2.4).toFixed(1) + 'px)' : 'none';
      p.el.classList.toggle('back', z2 < -0.35);
    }
    if (!reduce || dragging || Math.abs(velX) > 0.0002) requestAnimationFrame(frame);
  }

  function onDown(e) {
    dragging = true; velX = 0;
    var pt = e.touches ? e.touches[0] : e;
    lastX = pt.clientX; lastY = pt.clientY;
    stage.classList.add('grabbing');
  }
  function onMove(e) {
    if (!dragging) return;
    var pt = e.touches ? e.touches[0] : e;
    velY = (pt.clientX - lastX) * 0.00035 + (reduce ? 0 : 0.0016);
    velX = (pt.clientY - lastY) * -0.0004;
    rotY += (pt.clientX - lastX) * 0.006;
    rotX += (pt.clientY - lastY) * -0.006;
    rotX = Math.max(-1.2, Math.min(1.2, rotX));
    lastX = pt.clientX; lastY = pt.clientY;
    if (e.cancelable) e.preventDefault();
    if (reduce) requestAnimationFrame(frame);
  }
  function onUp() {
    dragging = false;
    stage.classList.remove('grabbing');
    if (reduce) { velY = 0; }
  }

  measure();
  window.addEventListener('resize', measure);
  stage.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  stage.addEventListener('touchstart', onDown, { passive: true });
  stage.addEventListener('touchmove', onMove, { passive: false });
  stage.addEventListener('touchend', onUp);
  stage.classList.add('orb-live');
  requestAnimationFrame(frame);
})();
</script>
</section>`;
}

module.exports = { renderOrb, SHELF_HUE };
