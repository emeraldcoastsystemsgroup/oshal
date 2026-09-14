/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic force-directed layout (Fruchterman-Reingold with cooling and gentle gravity) for the data-model explorer. Seeded from a circle in node order, so the same graph always lands in the same place - navigation stays stable and the unit spec can assert on it. No DOM, no dependencies.
 */

/**
 * @description Initial positions: nodes evenly spaced on a circle, in input order.
 * @param {object[]} nodes - graph nodes (`id`)
 * @param {number} width - canvas width
 * @param {number} height - canvas height
 * @returns {Map<string, {x: number, y: number}>} positions
 */
function seedPositions(nodes, width, height) {
  const pos = new Map();
  const r = Math.min(width, height) * 0.38;
  nodes.forEach((n, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, nodes.length);
    pos.set(n.id, { x: width / 2 + r * Math.cos(a), y: height / 2 + r * Math.sin(a) });
  });
  return pos;
}

/**
 * @description One iteration's displacement: pairwise repulsion, edge attraction, centre gravity.
 * @param {string[]} ids - node ids
 * @param {object[]} edges - `{source, target}`
 * @param {Map} pos - current positions
 * @param {number} k - ideal edge length
 * @param {{x: number, y: number}} centre - canvas centre
 * @returns {Map<string, {dx: number, dy: number}>} displacements
 */
function displacements(ids, edges, pos, k, centre) {
  const disp = new Map(ids.map((id) => [id, { dx: 0, dy: 0 }]));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = pos.get(ids[i]); const b = pos.get(ids[j]);
      let dx = a.x - b.x; let dy = a.y - b.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (k * k) / d;
      dx = (dx / d) * f; dy = (dy / d) * f;
      disp.get(ids[i]).dx += dx; disp.get(ids[i]).dy += dy;
      disp.get(ids[j]).dx -= dx; disp.get(ids[j]).dy -= dy;
    }
  }
  for (const e of edges) {
    const a = pos.get(e.source); const b = pos.get(e.target);
    if (!a || !b || a === b) continue;
    const dx = a.x - b.x; const dy = a.y - b.y;
    const d = Math.max(0.01, Math.hypot(dx, dy));
    const f = (d * d) / k;
    disp.get(e.source).dx -= (dx / d) * f; disp.get(e.source).dy -= (dy / d) * f;
    disp.get(e.target).dx += (dx / d) * f; disp.get(e.target).dy += (dy / d) * f;
  }
  for (const id of ids) {
    const p = pos.get(id);
    disp.get(id).dx += (centre.x - p.x) * 0.02 * k / 10;
    disp.get(id).dy += (centre.y - p.y) * 0.02 * k / 10;
  }
  return disp;
}

/**
 * @description Lay out a graph.
 * @param {object[]} nodes - `{id}`
 * @param {object[]} edges - `{source, target}`
 * @param {{width?: number, height?: number, iterations?: number}} [opts] - canvas and effort
 * @returns {Map<string, {x: number, y: number}>} final positions, clamped inside the canvas
 */
export function layoutGraph(nodes, edges, opts = {}) {
  const width = opts.width || 1000;
  const height = opts.height || 700;
  const iterations = opts.iterations || (nodes.length > 150 ? 180 : 300);
  const pos = seedPositions(nodes, width, height);
  if (nodes.length < 2) return pos;
  const ids = nodes.map((n) => n.id);
  const k = Math.sqrt((width * height) / nodes.length) * 0.75;
  const centre = { x: width / 2, y: height / 2 };
  let temperature = width / 8;
  for (let it = 0; it < iterations; it += 1) {
    const disp = displacements(ids, edges, pos, k, centre);
    for (const id of ids) {
      const d = disp.get(id); const p = pos.get(id);
      const len = Math.max(0.01, Math.hypot(d.dx, d.dy));
      p.x = Math.min(width - 20, Math.max(20, p.x + (d.dx / len) * Math.min(len, temperature)));
      p.y = Math.min(height - 20, Math.max(20, p.y + (d.dy / len) * Math.min(len, temperature)));
    }
    temperature *= 0.97;
  }
  return pos;
}
