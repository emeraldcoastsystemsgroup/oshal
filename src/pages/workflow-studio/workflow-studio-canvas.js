/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from workflow-studio.js (1000-line cap decomposition): canvas interaction mixin — node/edge editing, selection, drag, pan/zoom, drag-to-wire, flyouts, and zoom-to-fit
 */

import { clamp, createId, deepClone, MAX_X, MAX_Y, NODE_HEIGHT, NODE_WIDTH } from './workflow-studio-utils.js';

/**
 * @description Canvas interaction methods for WorkflowStudioApp. Assigned onto
 * WorkflowStudioApp.prototype by workflow-studio.js (prototype mixin — every method runs with
 * the app instance as `this`). Covers graph editing (add/remove/select nodes and edges,
 * arm-to-connect, drag-to-wire), node dragging, background panning, cursor-anchored zooming,
 * the left rail flyouts, and zoom-to-fit.
 */
export const workflowStudioCanvasMethods = {
  addNode(nodeType) {
    const definition = this.requireDefinition();
    const catalog = this.state.catalog;
    if (!definition || !catalog) {
      return;
    }

    const entry = catalog.nodeCatalog.find((candidate) => candidate.type === nodeType);
    if (!entry) {
      return;
    }

    const position = this.resolveNewNodePosition();
    const node = {
      id: createId('node'),
      type: entry.type,
      title: entry.defaultTitle,
      description: entry.defaultDescription,
      position,
      config: deepClone(entry.defaultConfig),
    };
    definition.nodes.push(node);
    this.inspectorOpen = true;
    this.state.selectedNodeId = node.id;
    this.state.selectedEdgeId = null;
    this.invalidateReports();
    this.render();
    this.setStatus(`Added ${entry.title}.`, 'success');
  },

  createEdge(sourceId, targetId) {
    const definition = this.requireDefinition();
    if (!definition) {
      return;
    }
    const sourceNode = this.getDefinitionNode(sourceId);

    const duplicate = definition.edges.some((edge) => edge.source === sourceId && edge.target === targetId);
    if (duplicate) {
      this.state.pendingConnectionSourceId = null;
      this.renderSelectionState();
      this.setStatus('That connection already exists.', 'warning');
      return;
    }

    const edge = {
      id: createId('edge'),
      source: sourceId,
      target: targetId,
      label: sourceNode ? this.suggestEdgeLabel(sourceNode, definition) : undefined,
    };
    definition.edges.push(edge);
    this.state.selectedNodeId = null;
    this.state.selectedEdgeId = edge.id;
    this.state.pendingConnectionSourceId = null;
    this.invalidateReports();
    this.render();
    this.setStatus('Connected nodes.', 'success');
  },

  armConnection(nodeId) {
    this.state.pendingConnectionSourceId = this.state.pendingConnectionSourceId === nodeId ? null : nodeId;
    this.selectNode(nodeId, true);
    this.renderSelectionState();
    this.renderCanvas();
    if (this.state.pendingConnectionSourceId) {
      this.setStatus('Select another node to complete the connection.', 'info');
    }
  },

  clearSelection() {
    this.inspectorOpen = false;
    this.state.selectedNodeId = null;
    this.state.selectedEdgeId = null;
    this.state.pendingConnectionSourceId = null;
    this.renderSelectionState();
    this.renderCanvas();
    this.renderInspector();
  },

  removeSelectedItem() {
    const definition = this.requireDefinition();
    if (!definition) {
      return;
    }

    const selectedEdge = this.getSelectedEdge();
    if (selectedEdge) {
      definition.edges = definition.edges.filter((edge) => edge.id !== selectedEdge.id);
      this.state.selectedEdgeId = null;
      this.state.pendingConnectionSourceId = null;
      this.invalidateReports();
      this.render();
      this.setStatus(`Removed edge ${selectedEdge.label || selectedEdge.id}.`, 'warning');
      return;
    }

    const selectedNode = this.getSelectedNode();
    if (!selectedNode) {
      return;
    }

    definition.nodes = definition.nodes.filter((node) => node.id !== selectedNode.id);
    definition.edges = definition.edges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id);
    this.state.selectedNodeId = definition.nodes[0]?.id ?? null;
    this.state.selectedEdgeId = null;
    this.state.pendingConnectionSourceId = null;
    this.invalidateReports();
    this.render();
    this.setStatus(`Removed ${selectedNode.title}.`, 'warning');
  },

  selectNode(nodeId, preserveConnection = false) {
    this.inspectorOpen = true;
    this.state.selectedNodeId = nodeId;
    this.state.selectedEdgeId = null;
    if (!preserveConnection) {
      this.state.pendingConnectionSourceId = null;
    }
    this.renderSelectionState();
    this.renderCanvas();
    this.renderInspector();
  },

  selectEdge(edgeId) {
    this.inspectorOpen = true;
    this.state.selectedEdgeId = edgeId;
    this.state.selectedNodeId = null;
    this.state.pendingConnectionSourceId = null;
    this.renderSelectionState();
    this.renderCanvas();
    this.renderInspector();
  },

  beginDrag(nodeId, event) {
    const node = this.getDefinitionNode(nodeId);
    if (!node) {
      return;
    }

    this.selectNode(nodeId, true);
    this.dragState = {
      nodeId,
      originX: node.position.x,
      originY: node.position.y,
      startX: event.clientX,
      startY: event.clientY,
    };
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  },

  onPointerMove(event) {
    if (!this.dragState) {
      return;
    }

    const node = this.getDefinitionNode(this.dragState.nodeId);
    const nodeElement = this.elements.canvasNodes.querySelector(`[data-node-id="${this.dragState.nodeId}"]`);
    if (!node || !(nodeElement instanceof HTMLElement)) {
      return;
    }

    const nextX = clamp(this.dragState.originX + (event.clientX - this.dragState.startX) / this.scale, 20, MAX_X);
    const nextY = clamp(this.dragState.originY + (event.clientY - this.dragState.startY) / this.scale, 20, MAX_Y);
    node.position.x = nextX;
    node.position.y = nextY;
    nodeElement.style.left = `${nextX}px`;
    nodeElement.style.top = `${nextY}px`;
    this.invalidateReports();
    this.renderEdges();
    this.renderSelectionState();
    this.renderMetrics();
  },

  onPointerUp() {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.dragState = null;
  },

  /**
   * @description Toggle a left flyout (palette / files); opening one closes the other and lights its rail icon.
   * @param {string} flyoutKey - element key in this.elements for the flyout to toggle
   * @param {string} railKey - element key for the rail button that owns it
   * @returns {void}
   */
  toggleFlyout(flyoutKey, railKey) {
    const flyout = this.elements[flyoutKey];
    if (!flyout) return;
    const willOpen = flyout.hidden;
    this.closeFlyouts();
    flyout.hidden = !willOpen;
    this.elements.railAddButton?.classList.toggle('is-active', willOpen && railKey === 'railAddButton');
    this.elements.railFilesButton?.classList.toggle('is-active', willOpen && railKey === 'railFilesButton');
  },

  /** @description Hide both left flyouts and clear the rail active state. */
  closeFlyouts() {
    if (this.elements.paletteFlyout) this.elements.paletteFlyout.hidden = true;
    if (this.elements.filesFlyout) this.elements.filesFlyout.hidden = true;
    this.elements.railAddButton?.classList.remove('is-active');
    this.elements.railFilesButton?.classList.remove('is-active');
  },

  /** @description Apply the current zoom to the world + update the zoom-level label. */
  applyScale() {
    if (this.elements.canvasWorld) this.elements.canvasWorld.style.transform = `scale(${this.scale})`;
    if (this.elements.zoomLevel) this.elements.zoomLevel.textContent = `${Math.round(this.scale * 100)}%`;
  },

  /**
   * @description Set the zoom to `target`, keeping the world point under (pivotX, pivotY) fixed
   * (defaults to the viewport center). Adjusts scroll so zoom feels anchored.
   */
  setScale(target, pivotX, pivotY) {
    const vp = this.elements.canvasViewport;
    const rect = vp.getBoundingClientRect();
    const px = (typeof pivotX === 'number' ? pivotX : rect.left + rect.width / 2) - rect.left;
    const py = (typeof pivotY === 'number' ? pivotY : rect.top + rect.height / 2) - rect.top;
    const worldX = (vp.scrollLeft + px) / this.scale;
    const worldY = (vp.scrollTop + py) / this.scale;
    this.scale = clamp(target, this.minScale, this.maxScale);
    this.applyScale();
    vp.scrollLeft = worldX * this.scale - px;
    vp.scrollTop = worldY * this.scale - py;
  },

  /** @description Multiply the current zoom by `factor` about the viewport center. */
  zoomBy(factor) {
    this.setScale(this.scale * factor);
  },

  onPan(event) {
    if (!this.panState) return;
    const vp = this.elements.canvasViewport;
    vp.scrollLeft = this.panState.sl - (event.clientX - this.panState.x);
    vp.scrollTop = this.panState.st - (event.clientY - this.panState.y);
  },

  onPanEnd() {
    this.panState = null;
    this.elements.canvasViewport.style.cursor = '';
    window.removeEventListener('pointermove', this.onPan);
    window.removeEventListener('pointerup', this.onPanEnd);
  },

  /** @description Convert viewport-relative screen coords to world (unscaled canvas) coords. */
  screenToWorld(clientX, clientY) {
    const vp = this.elements.canvasViewport;
    const rect = vp.getBoundingClientRect();
    return {
      x: (vp.scrollLeft + (clientX - rect.left)) / this.scale,
      y: (vp.scrollTop + (clientY - rect.top)) / this.scale,
    };
  },

  /** @description Start a drag-to-wire from a node's output port. */
  beginWire(sourceId, event) {
    const sourceEl = this.elements.canvasNodes.querySelector(`[data-node-id="${sourceId}"]`);
    if (!sourceEl) {
      return;
    }
    this.wireState = {
      sourceId,
      sx: sourceEl.offsetLeft + sourceEl.offsetWidth,
      sy: sourceEl.offsetTop + (sourceEl.offsetHeight / 2),
    };
    window.addEventListener('pointermove', this.onWireMove);
    window.addEventListener('pointerup', this.onWireEnd);
    this.onWireMove(event);
  },

  onWireMove(event) {
    if (!this.wireState) {
      return;
    }
    const world = this.screenToWorld(event.clientX, event.clientY);
    let temp = this.elements.edgeLayer.querySelector('#wf-temp-edge');
    if (!temp) {
      temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      temp.id = 'wf-temp-edge';
      temp.setAttribute('class', 'edge-line is-temp');
      this.elements.edgeLayer.appendChild(temp);
    }
    const { sx, sy } = this.wireState;
    const midX = (sx + world.x) / 2;
    temp.setAttribute('d', `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${world.y}, ${world.x} ${world.y}`);
  },

  onWireEnd(event) {
    const temp = this.elements.edgeLayer.querySelector('#wf-temp-edge');
    if (temp) {
      temp.remove();
    }
    window.removeEventListener('pointermove', this.onWireMove);
    window.removeEventListener('pointerup', this.onWireEnd);
    const wire = this.wireState;
    this.wireState = null;
    if (!wire) {
      return;
    }
    const dropEl = document.elementFromPoint(event.clientX, event.clientY);
    const targetId = dropEl && dropEl.closest ? dropEl.closest('[data-node-id]')?.getAttribute('data-node-id') : null;
    if (targetId && targetId !== wire.sourceId) {
      this.createEdge(wire.sourceId, targetId);
    }
  },

  /** @description Fit all nodes within the viewport (zoom-to-fit), or reset when empty. */
  centerCanvas() {
    const vp = this.elements.canvasViewport;
    const nodes = this.elements.canvasNodes.querySelectorAll('[data-node-id]');
    if (!nodes.length) {
      this.scale = 1;
      this.applyScale();
      vp.scrollTo({ left: 0, top: 0 });
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.offsetLeft);
      minY = Math.min(minY, n.offsetTop);
      maxX = Math.max(maxX, n.offsetLeft + n.offsetWidth);
      maxY = Math.max(maxY, n.offsetTop + n.offsetHeight);
    });
    const pad = 90;
    const bw = (maxX - minX) + pad * 2;
    const bh = (maxY - minY) + pad * 2;
    this.scale = clamp(Math.min(vp.clientWidth / bw, vp.clientHeight / bh), this.minScale, this.maxScale);
    this.applyScale();
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    vp.scrollLeft = cx * this.scale - vp.clientWidth / 2;
    vp.scrollTop = cy * this.scale - vp.clientHeight / 2;
  },

  resolveNewNodePosition() {
    const viewport = this.elements.canvasViewport;
    const scrollLeft = viewport.scrollLeft;
    const scrollTop = viewport.scrollTop;
    const x = clamp(scrollLeft + (viewport.clientWidth / 2) - (NODE_WIDTH / 2), 40, MAX_X);
    const y = clamp(scrollTop + (viewport.clientHeight / 2) - (NODE_HEIGHT / 2), 40, MAX_Y);
    return { x, y };
  },
};
