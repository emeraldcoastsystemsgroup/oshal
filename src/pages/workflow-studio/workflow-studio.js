/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added workflow-studio browser logic for WYSIWYG graph editing, persistence, validation, and compile preview
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed for the 1000-code-line cap: data/API ops, canvas interaction, and rendering moved to workflow-studio-data.js / workflow-studio-canvas.js / workflow-studio-render.js prototype mixins; shared helpers + constants to workflow-studio-utils.js. This entry module keeps the class core (state, element refs, event wiring, state accessors) and the window.workflowStudioApp bootstrap — zero behavior change
 */

import { createUiLogger } from '../shared/ui-debug.js';
import { workflowStudioCanvasMethods } from './workflow-studio-canvas.js';
import { workflowStudioDataMethods } from './workflow-studio-data.js';
import { workflowStudioRenderMethods } from './workflow-studio-render.js';

const logger = createUiLogger('workflow-studio');

/**
 * @description The Workflow Studio browser app: owns the studio state (definitions, catalog,
 * selection, validation/compile reports), the DOM element registry, and all event wiring for
 * the WYSIWYG canvas. Behavior is composed from three prototype mixins assigned below —
 * workflowStudioDataMethods (server data/API operations), workflowStudioCanvasMethods
 * (canvas interaction), and workflowStudioRenderMethods (DOM rendering). The bootstrapped
 * instance is exposed as window.workflowStudioApp for the chat + runs side panels.
 */
class WorkflowStudioApp {
  constructor() {
    this.state = {
      agents: [],
      catalog: null,
      compilePreview: null,
      definitions: [],
      pendingConnectionSourceId: null,
      selectedDefinition: null,
      selectedEdgeId: null,
      selectedNodeId: null,
      validationReport: null,
      versionHistory: [],
    };
    this.dragState = null;
    this.scale = 1;
    this.minScale = 0.3;
    this.maxScale = 2.2;
    this.elements = {
      canvasEmpty: document.getElementById('canvasEmpty'),
      canvasHeading: document.getElementById('canvasHeading'),
      canvasNodes: document.getElementById('canvasNodes'),
      canvasViewport: document.getElementById('canvasViewport'),
      centerCanvasButton: document.getElementById('centerCanvasButton'),
      railAddButton: document.getElementById('railAddButton'),
      railFilesButton: document.getElementById('railFilesButton'),
      paletteFlyout: document.getElementById('paletteFlyout'),
      filesFlyout: document.getElementById('filesFlyout'),
      inspectorPanel: document.getElementById('inspectorPanel'),
      moreMenuButton: document.getElementById('moreMenuButton'),
      moreMenu: document.getElementById('moreMenu'),
      clearSelectionButton: document.getElementById('clearSelectionButton'),
      compilePanel: document.getElementById('compilePanel'),
      compileWorkflowButton: document.getElementById('compileWorkflowButton'),
      definitionList: document.getElementById('definitionList'),
      duplicateWorkflowButton: document.getElementById('duplicateWorkflowButton'),
      edgeLayer: document.getElementById('edgeLayer'),
      canvasWorld: document.getElementById('canvasWorld'),
      zoomInButton: document.getElementById('zoomInButton'),
      zoomOutButton: document.getElementById('zoomOutButton'),
      zoomLevelButton: document.getElementById('zoomLevelButton'),
      zoomLevel: document.getElementById('zoomLevel'),
      exportWorkflowButton: document.getElementById('exportWorkflowButton'),
      inspectorForm: document.getElementById('inspectorForm'),
      metricBindings: document.getElementById('metricBindings'),
      metricDefinitions: document.getElementById('metricDefinitions'),
      metricEdges: document.getElementById('metricEdges'),
      metricNodes: document.getElementById('metricNodes'),
      newWorkflowButton: document.getElementById('newWorkflowButton'),
      templateList: document.getElementById('templateList'),
      publishWorkflowButton: document.getElementById('publishWorkflowButton'),
      paletteGrid: document.getElementById('paletteGrid'),
      removeSelectedButton: document.getElementById('removeSelectedButton'),
      saveWorkflowButton: document.getElementById('saveWorkflowButton'),
      selectionState: document.getElementById('selectionState'),
      statusBanner: document.getElementById('statusBanner'),
      validateWorkflowButton: document.getElementById('validateWorkflowButton'),
      validationPanel: document.getElementById('validationPanel'),
      versionPanel: document.getElementById('versionPanel'),
    };

    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPan = this.onPan.bind(this);
    this.onPanEnd = this.onPanEnd.bind(this);
    this.onWireMove = this.onWireMove.bind(this);
    this.onWireEnd = this.onWireEnd.bind(this);
    this.panState = null;
    this.wireState = null;
  }

  async init() {
    logger.info('Initializing workflow studio');
    this.bindEvents();
    await this.refreshStudio();
  }

  bindEvents() {
    this.elements.newWorkflowButton.addEventListener('click', async () => {
      await this.createWorkflowDefinition();
    });

    this.elements.duplicateWorkflowButton.addEventListener('click', async () => {
      await this.duplicateActiveDefinition();
    });

    this.elements.saveWorkflowButton.addEventListener('click', async () => {
      await this.saveActiveDefinition();
    });

    this.elements.validateWorkflowButton.addEventListener('click', async () => {
      await this.validateActiveDefinition();
    });

    this.elements.compileWorkflowButton.addEventListener('click', async () => {
      await this.compileActiveDefinition();
    });

    this.elements.publishWorkflowButton.addEventListener('click', async () => {
      await this.publishActiveDefinition();
    });

    this.elements.exportWorkflowButton.addEventListener('click', () => {
      this.exportActiveDefinition();
    });

    this.elements.centerCanvasButton.addEventListener('click', () => {
      this.centerCanvas();
    });

    // Slim icon rail → left flyouts (add-node palette, saved workflows). Each toggles; opening one closes the other.
    this.elements.railAddButton?.addEventListener('click', () => this.toggleFlyout('paletteFlyout', 'railAddButton'));
    this.elements.railFilesButton?.addEventListener('click', () => this.toggleFlyout('filesFlyout', 'railFilesButton'));
    document.querySelectorAll('[data-close-flyout]').forEach((button) => {
      button.addEventListener('click', () => this.closeFlyouts());
    });

    // More-actions menu (New / Duplicate / Export) in the top bar.
    this.elements.moreMenuButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = this.elements.moreMenu;
      if (menu) menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', () => {
      if (this.elements.moreMenu) this.elements.moreMenu.hidden = true;
    });

    // Zoom controls + ctrl/⌘-wheel zoom + drag-the-background to pan (n8n-style).
    this.elements.zoomInButton?.addEventListener('click', () => this.zoomBy(1.2));
    this.elements.zoomOutButton?.addEventListener('click', () => this.zoomBy(1 / 1.2));
    this.elements.zoomLevelButton?.addEventListener('click', () => this.setScale(1));
    this.elements.canvasViewport.addEventListener('wheel', (event) => {
      // Plain mouse-wheel zooms toward the cursor (n8n behaviour); shift+wheel pans horizontally natively.
      if (event.shiftKey) return;
      event.preventDefault();
      this.setScale(this.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX, event.clientY);
    }, { passive: false });
    this.elements.canvasViewport.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || target.closest('[data-node-id], button, input, textarea, select, .canvas-zoom')) {
        return; // node drag / control clicks handle themselves
      }
      this.panState = { x: event.clientX, y: event.clientY, sl: this.elements.canvasViewport.scrollLeft, st: this.elements.canvasViewport.scrollTop };
      this.elements.canvasViewport.style.cursor = 'grabbing';
      window.addEventListener('pointermove', this.onPan);
      window.addEventListener('pointerup', this.onPanEnd);
    });

    this.elements.clearSelectionButton.addEventListener('click', () => {
      this.clearSelection();
    });

    this.elements.removeSelectedButton.addEventListener('click', () => {
      this.removeSelectedItem();
    });

    this.elements.definitionList.addEventListener('click', async (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest('[data-definition-id]') : null;
      if (!button) {
        return;
      }
      const definitionId = button.getAttribute('data-definition-id');
      if (!definitionId) {
        return;
      }
      await this.selectDefinition(definitionId);
    });

    this.elements.versionPanel.addEventListener('click', async (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest('[data-version-action]') : null;
      if (!button) {
        return;
      }

      const action = button.getAttribute('data-version-action');
      const version = Number(button.getAttribute('data-version'));
      if (action !== 'fork' || !Number.isInteger(version) || version <= 0) {
        return;
      }

      await this.forkSelectedVersion(version);
    });

    this.elements.paletteGrid.addEventListener('click', (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest('[data-node-type]') : null;
      if (!button) {
        return;
      }
      const nodeType = button.getAttribute('data-node-type');
      if (!nodeType) {
        return;
      }
      this.addNode(nodeType);
    });

    this.elements.canvasNodes.addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) {
        return;
      }

      const outputButton = target.closest('[data-action="arm-output"]');
      if (outputButton) {
        const nodeElement = target.closest('[data-node-id]');
        const nodeId = nodeElement?.getAttribute('data-node-id');
        if (nodeId) {
          this.armConnection(nodeId);
        }
        event.stopPropagation();
        return;
      }

      const nodeElement = target.closest('[data-node-id]');
      const nodeId = nodeElement?.getAttribute('data-node-id');
      if (!nodeId) {
        return;
      }

      if (this.state.pendingConnectionSourceId && this.state.pendingConnectionSourceId !== nodeId) {
        this.createEdge(this.state.pendingConnectionSourceId, nodeId);
        return;
      }

      this.selectNode(nodeId);
    });

    this.elements.edgeLayer.addEventListener('click', (event) => {
      const edgeElement = event.target instanceof Element ? event.target.closest('[data-edge-id]') : null;
      if (!edgeElement) {
        if (event.target === this.elements.edgeLayer) {
          this.clearSelection();
        }
        return;
      }

      const edgeId = edgeElement.getAttribute('data-edge-id');
      if (!edgeId) {
        return;
      }

      this.selectEdge(edgeId);
      event.stopPropagation();
    });

    this.elements.canvasNodes.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) {
        return;
      }
      // Drag from a node's output port to a target node to wire them (n8n-style).
      const port = target.closest('[data-action="arm-output"]');
      if (port) {
        const sourceId = port.closest('[data-node-id]')?.getAttribute('data-node-id');
        if (sourceId) {
          this.beginWire(sourceId, event);
        }
        return;
      }
      if (target.closest('button, input, textarea, select')) {
        return;
      }

      const nodeElement = target.closest('[data-node-id]');
      const nodeId = nodeElement?.getAttribute('data-node-id');
      if (!nodeId) {
        return;
      }

      this.beginDrag(nodeId, event);
    });

    this.elements.canvasViewport.addEventListener('click', (event) => {
      if (event.target !== this.elements.canvasViewport && event.target !== this.elements.edgeLayer) {
        return;
      }
      this.clearSelection();
    });

    this.elements.inspectorForm.addEventListener('input', (event) => {
      this.handleInspectorChange(event);
    });

    this.elements.inspectorForm.addEventListener('change', (event) => {
      this.handleInspectorChange(event);
    });
  }

  invalidateReports() {
    this.state.validationReport = null;
    this.state.compilePreview = null;
    this.renderValidationPanel();
    this.renderCompilePanel();
  }

  getSelectedNode() {
    return this.getDefinitionNode(this.state.selectedNodeId);
  }

  getSelectedEdge() {
    return this.getDefinitionEdge(this.state.selectedEdgeId);
  }

  getDefinitionNode(nodeId) {
    const definition = this.state.selectedDefinition;
    if (!definition || !nodeId) {
      return null;
    }
    return definition.nodes.find((node) => node.id === nodeId) || null;
  }

  getDefinitionEdge(edgeId) {
    const definition = this.state.selectedDefinition;
    if (!definition || !edgeId) {
      return null;
    }
    return definition.edges.find((edge) => edge.id === edgeId) || null;
  }

  requireDefinition() {
    if (!this.state.selectedDefinition) {
      this.setStatus('Select or create a workflow definition first.', 'warning');
      return null;
    }
    return this.state.selectedDefinition;
  }

  setStatus(message, tone = 'info') {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

// Compose the app from its mixins (data/API ops, canvas interaction, rendering) BEFORE the
// instance below is constructed — the constructor binds pointer handlers off the prototype.
Object.assign(
  WorkflowStudioApp.prototype,
  workflowStudioDataMethods,
  workflowStudioCanvasMethods,
  workflowStudioRenderMethods,
);

const app = new WorkflowStudioApp();
// Expose the app so the talk-to-build chat panel (workflow-studio-chat.js) can redraw the canvas
// after the builder bot saves a definition. See ADR-039.
window.workflowStudioApp = app;
void app.init();
