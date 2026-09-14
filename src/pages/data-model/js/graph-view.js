/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SVG graph view for the data-model explorer: draws nodes (coloured by owner; shared / external / unowned marked) and directed edges (styled per link kind), with drag-to-pan, wheel zoom around the cursor, fit-to-view, keyboard-focusable nodes and neighbour highlighting for the selection. Click selects, double-click (or Enter twice) opens.
 */

import { ownerColor } from './model-index.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @description Create an SVG element with attributes.
 * @param {string} tag - element name
 * @param {object} attrs - attributes
 * @returns {SVGElement} element
 */
function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * @description Arrowhead markers, one per edge kind (colour comes from CSS on the marker path).
 * @param {SVGSVGElement} svg - host svg
 * @param {string[]} kinds - edge kinds
 * @returns {void}
 */
function ensureMarkers(svg, kinds) {
  let defs = svg.querySelector('defs');
  if (!defs) { defs = el('defs'); svg.prepend(defs); }
  for (const kind of kinds) {
    if (defs.querySelector(`#arrow-${kind}`)) continue;
    const marker = el('marker', { id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: `marker marker--${kind}` }));
    defs.append(marker);
  }
}

/**
 * @description Draw one edge, shortened so the arrow stops at the target node's rim.
 * @param {object} e - `{source, target, kind, label}`
 * @param {Map} pos - positions
 * @param {Map} sizes - node radii
 * @returns {SVGElement|null} the line, or null when an end is missing
 */
function edgeElement(e, pos, sizes) {
  const a = pos.get(e.source); const b = pos.get(e.target);
  if (!a || !b) return null;
  const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  const r = (sizes.get(e.target) || 8) + 3;
  const line = el('line', { x1: a.x, y1: a.y, x2: b.x - ((b.x - a.x) / d) * r, y2: b.y - ((b.y - a.y) / d) * r, class: `edge edge--${e.kind}`, 'marker-end': `url(#arrow-${e.kind})` });
  line.dataset.source = e.source; line.dataset.target = e.target;
  const title = el('title'); title.textContent = `${e.source} → ${e.target} (${e.kind}): ${e.label}`;
  line.append(title);
  return line;
}

/**
 * @description Draw one node group (circle + label), wired to the handlers.
 * @param {object} n - graph node
 * @param {{x: number, y: number}} p - position
 * @param {object} handlers - `{onSelect, onOpen}`
 * @returns {SVGGElement} the node group
 */
function nodeElement(n, p, handlers) {
  const cls = ['node', `node--${n.type}`, n.shared ? 'node--shared' : '', n.external ? 'node--external' : '', n.owner ? '' : 'node--unowned'].filter(Boolean).join(' ');
  const g = el('g', { class: cls, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-label': `${n.type} ${n.label}` });
  g.dataset.id = n.id;
  g.append(el('circle', { r: n.size, fill: ownerColor(n.owner) }));
  const text = el('text', { x: n.size + 4, y: 4 }); text.textContent = n.label.length > 34 ? `${n.label.slice(0, 32)}…` : n.label;
  const title = el('title'); title.textContent = n.label;
  g.append(text, title);
  g.addEventListener('click', (ev) => { ev.stopPropagation(); handlers.onSelect(n); });
  g.addEventListener('dblclick', (ev) => { ev.stopPropagation(); handlers.onOpen(n); });
  g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (g.classList.contains('is-selected')) handlers.onOpen(n); else handlers.onSelect(n); } });
  return g;
}

/**
 * @description Wire drag-to-pan and wheel zoom (around the cursor) onto the svg.
 * @param {SVGSVGElement} svg - host element
 * @param {{scale: number, tx: number, ty: number}} view - mutable view transform
 * @param {Function} apply - writes the transform to the DOM
 * @param {object} handlers - `{onBackground}` fires on a click (not a drag) on empty canvas
 * @returns {void}
 */
function attachPanZoom(svg, view, apply, handlers) {
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => { if (ev.target === svg) { drag = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty }; svg.setPointerCapture(ev.pointerId); } });
  svg.addEventListener('pointermove', (ev) => { if (drag) { view.tx = drag.tx + ev.clientX - drag.x; view.ty = drag.ty + ev.clientY - drag.y; apply(); } });
  svg.addEventListener('pointerup', (ev) => { if (drag && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 3 && handlers.onBackground) handlers.onBackground(); drag = null; });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left; const my = ev.clientY - rect.top;
    const next = Math.min(4, Math.max(0.15, view.scale * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
    view.tx = mx - ((mx - view.tx) * next) / view.scale; view.ty = my - ((my - view.ty) * next) / view.scale;
    view.scale = next; apply();
  }, { passive: false });
}

/**
 * @description Scale and centre the view so every drawn node is visible.
 * @param {SVGSVGElement} svg - host element
 * @param {object} view - mutable view transform
 * @param {Map} positions - node positions
 * @param {Function} apply - writes the transform
 * @returns {void}
 */
function fitView(svg, view, positions, apply) {
  if (!positions.size) return;
  const xs = [...positions.values()].map((p) => p.x); const ys = [...positions.values()].map((p) => p.y);
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, Math.max(...xs) - Math.min(...xs) + 160); const h = Math.max(1, Math.max(...ys) - Math.min(...ys) + 80);
  view.scale = Math.min(2, Math.max(0.15, Math.min(rect.width / w, rect.height / h)));
  view.tx = rect.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * view.scale;
  view.ty = rect.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * view.scale;
  apply();
}

/**
 * @description Mark the selected node and its neighbours; dim everything else.
 * @param {SVGGElement} root - graph root group
 * @param {string|null} selectedId - selected node id
 * @returns {void}
 */
function highlightSelection(root, selectedId) {
  const near = new Set(selectedId ? [selectedId] : []);
  root.querySelectorAll('line.edge').forEach((l) => {
    const on = Boolean(selectedId) && (l.dataset.source === selectedId || l.dataset.target === selectedId);
    if (on) { near.add(l.dataset.source); near.add(l.dataset.target); }
    l.classList.toggle('is-near', on);
  });
  root.querySelectorAll('g.node').forEach((g) => {
    g.classList.toggle('is-selected', g.dataset.id === selectedId);
    g.classList.toggle('is-dim', Boolean(selectedId) && !near.has(g.dataset.id));
  });
}

/**
 * @description Draw a graph into the root group at the given positions.
 * @param {SVGSVGElement} svg - host element (for markers)
 * @param {SVGGElement} root - graph root group
 * @param {{nodes: object[], edges: object[]}} graph - graph
 * @param {Map} pos - positions
 * @param {object} handlers - node handlers
 * @returns {void}
 */
function renderGraph(svg, root, graph, pos, handlers) {
  root.replaceChildren();
  ensureMarkers(svg, [...new Set(graph.edges.map((e) => e.kind))]);
  const sizes = new Map(graph.nodes.map((n) => [n.id, n.size]));
  const edgeLayer = el('g', { class: 'edges' }); const nodeLayer = el('g', { class: 'nodes' });
  for (const e of graph.edges) { const line = edgeElement(e, pos, sizes); if (line) edgeLayer.append(line); }
  for (const n of graph.nodes) { const p = pos.get(n.id); if (p) nodeLayer.append(nodeElement(n, p, handlers)); }
  root.append(edgeLayer, nodeLayer);
}

/**
 * @description Create a graph view over an <svg> element.
 * @param {SVGSVGElement} svg - host element
 * @param {{onSelect: Function, onOpen: Function, onBackground?: Function}} handlers - callbacks
 * @returns {{render: Function, fit: Function, highlight: Function}} view API
 */
export function createGraphView(svg, handlers) {
  const view = { scale: 1, tx: 0, ty: 0 };
  const state = { positions: new Map() };
  const root = el('g', { class: 'graph-root' });
  svg.append(root);
  const apply = () => root.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.scale})`);
  attachPanZoom(svg, view, apply, handlers);
  return {
    render: (graph, pos) => { state.positions = pos; renderGraph(svg, root, graph, pos, handlers); },
    fit: () => fitView(svg, view, state.positions, apply),
    highlight: (id) => highlightSelection(root, id),
  };
}
