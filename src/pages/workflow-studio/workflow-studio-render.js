/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from workflow-studio.js (1000-line cap decomposition): rendering mixin — definition list, palette, canvas nodes/edges, inspector (+ change handling), selection state, validation/compile/version panels, metrics, and field-option/edge-label resolution
 */

import {
  buildFieldGroup,
  escapeHtml,
  formatRelativeTimestamp,
  NODE_ICONS,
  readInspectorValue,
} from './workflow-studio-utils.js';

/**
 * @description Rendering methods for WorkflowStudioApp. Assigned onto
 * WorkflowStudioApp.prototype by workflow-studio.js (prototype mixin — every method runs with
 * the app instance as `this`). Owns every DOM redraw: definition/template lists, node palette,
 * canvas node cards + SVG edges, the inspector form (and its input handling), the selection
 * status line, validation/compile/version panels, and the metric tiles.
 */
export const workflowStudioRenderMethods = {
  handleInspectorChange(event) {
    const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement
      ? event.target
      : null;
    if (!target) {
      return;
    }

    const fieldKey = target.getAttribute('data-field-key');
    const fieldInput = target.getAttribute('data-field-input');
    if (!fieldKey || !fieldInput) {
      return;
    }

    const selectedEdge = this.getSelectedEdge();
    if (selectedEdge) {
      const value = readInspectorValue(target, fieldInput);
      selectedEdge[fieldKey] = typeof value === 'string' && value.trim().length === 0 ? undefined : value;
      this.invalidateReports();
      this.renderEdges();
      this.renderSelectionState();
      return;
    }

    const node = this.getSelectedNode();
    if (!node) {
      return;
    }

    if (fieldKey === 'title') {
      node.title = target.value;
      this.syncNodeCard(node);
    } else if (fieldKey === 'description') {
      node.description = target.value;
      this.syncNodeCard(node);
    } else {
      node.config[fieldKey] = readInspectorValue(target, fieldInput);
    }

    this.invalidateReports();
    this.renderDefinitions();
    this.renderSelectionState();
    this.renderMetrics();
  },

  render() {
    this.renderDefinitions();
    this.renderPalette();
    this.renderCanvas();
    this.renderInspector();
    this.renderValidationPanel();
    this.renderCompilePanel();
    this.renderVersionPanel();
    this.renderMetrics();
  },

  renderTemplates(templates) {
    const container = this.elements.templateList;
    if (!container) {
      return;
    }
    if (!Array.isArray(templates) || templates.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = templates.map((template) => `
      <article class="definition-card">
        <h3>${escapeHtml(template.name || template.id)}</h3>
        <p>${escapeHtml(template.description || '')}</p>
        <button type="button" data-template-id="${escapeHtml(template.id)}">Use template</button>
      </article>
    `).join('');
    container.querySelectorAll('button[data-template-id]').forEach((button) => {
      button.addEventListener('click', () => this.createFromTemplate(button.getAttribute('data-template-id')));
    });
  },

  renderDefinitions() {
    if (!this.state.definitions.length) {
      this.elements.definitionList.innerHTML = '<p class="selection-state">No workflow definitions are available yet.</p>';
      return;
    }

    this.elements.definitionList.innerHTML = this.state.definitions.map((definition) => `
      <article class="definition-card ${definition.id === this.state.selectedDefinition?.id ? 'is-active' : ''}">
        <h3>${escapeHtml(definition.name)}</h3>
        <p>${escapeHtml(definition.description || 'No description yet.')}</p>
        <div class="definition-meta">
          <span class="chip">${definition.nodeCount} nodes</span>
          <span class="chip">${definition.edgeCount} edges</span>
          <span class="chip">v${definition.version}</span>
        </div>
        <button type="button" data-definition-id="${definition.id}">Open</button>
      </article>
    `).join('');
  },

  renderPalette() {
    const catalog = this.state.catalog;
    if (!catalog) {
      this.elements.paletteGrid.innerHTML = '<p class="selection-state">Loading node catalog...</p>';
      return;
    }

    this.elements.paletteGrid.innerHTML = catalog.nodeCatalog.map((entry) => `
      <article class="palette-card">
        <h3>${escapeHtml(entry.title)}</h3>
        <p>${escapeHtml(entry.description)}</p>
        <div class="palette-meta">
          <span class="chip">${escapeHtml(entry.runtimeBinding)}</span>
        </div>
        <button type="button" data-node-type="${entry.type}">Add ${escapeHtml(entry.title)}</button>
      </article>
    `).join('');
  },

  renderCanvas() {
    const definition = this.state.selectedDefinition;
    if (!definition) {
      this.elements.canvasHeading.textContent = 'Workflow Studio Canvas';
      this.elements.canvasNodes.innerHTML = '';
      this.elements.edgeLayer.innerHTML = '';
      this.elements.canvasEmpty.classList.remove('is-hidden');
      return;
    }

    this.elements.canvasHeading.textContent = definition.name;
    this.elements.canvasNodes.innerHTML = definition.nodes.map((node) => {
      const catalogEntry = this.state.catalog?.nodeCatalog.find((entry) => entry.type === node.type);
      const isSelected = node.id === this.state.selectedNodeId;
      const isArmed = node.id === this.state.pendingConnectionSourceId;
      const icon = NODE_ICONS[node.type] || '●';
      // The bot/connector doing the work at this stage (n8n surfaces the integration on the node).
      const bot = node.config?.agentBinding || node.config?.agentId || node.config?.preferredAgentId || node.config?.decisionAgentId || '';
      return `
        <article
          class="workflow-node ${isSelected ? 'is-selected' : ''}"
          data-node-id="${node.id}"
          data-theme="${catalogEntry?.theme || 'graphite'}"
          style="left:${node.position.x}px; top:${node.position.y}px;"
        >
          <div class="node-head">
            <span class="node-icon" aria-hidden="true">${icon}</span>
            <div class="node-headtext">
              <span class="node-type">${escapeHtml(node.type)}</span>
              <h3>${escapeHtml(node.title)}</h3>
            </div>
          </div>
          ${bot ? `<div class="node-bot" title="Runs on ${escapeHtml(String(bot))}"><span class="node-bot-av">${escapeHtml(String(bot).slice(0, 1).toUpperCase())}</span><span class="node-bot-name">${escapeHtml(String(bot))}</span></div>` : ''}
          <button type="button" class="port-button ${isArmed ? 'is-armed' : ''}" data-action="arm-output" title="Wire this node's output">⟶</button>
        </article>
      `;
    }).join('');

    this.elements.canvasEmpty.classList.toggle('is-hidden', definition.nodes.length > 0);
    this.renderEdges();
    this.renderSelectionState();
  },

  renderEdges() {
    const definition = this.state.selectedDefinition;
    if (!definition) {
      this.elements.edgeLayer.innerHTML = '';
      return;
    }

    // World coordinates (offsetLeft/Top within #canvasNodes) — independent of zoom + scroll, so
    // edges live in the same scaled "world" as the nodes and transform together with it.
    const lines = definition.edges.map((edge) => {
      const sourceElement = this.elements.canvasNodes.querySelector(`[data-node-id="${edge.source}"]`);
      const targetElement = this.elements.canvasNodes.querySelector(`[data-node-id="${edge.target}"]`);
      if (!(sourceElement instanceof HTMLElement) || !(targetElement instanceof HTMLElement)) {
        return '';
      }

      const x1 = sourceElement.offsetLeft + sourceElement.offsetWidth;
      const y1 = sourceElement.offsetTop + (sourceElement.offsetHeight / 2);
      const x2 = targetElement.offsetLeft;
      const y2 = targetElement.offsetTop + (targetElement.offsetHeight / 2);
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const isSelected = edge.id === this.state.selectedEdgeId;

      return `
        <g class="edge-group ${isSelected ? 'is-selected' : ''}" data-edge-id="${edge.id}">
          <path class="edge-line" d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}"></path>
          ${edge.label ? `<text class="edge-label" x="${midX}" y="${midY - 8}">${escapeHtml(edge.label)}</text>` : ''}
        </g>
      `;
    }).join('');

    // Arrowhead marker (re-added each render since innerHTML is replaced). CSS sets marker-end
    // on .edge-line so connections read as a directed flow (n8n-style).
    const defs = '<defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#818cf8"></path></marker></defs>';
    this.elements.edgeLayer.innerHTML = defs + lines;
  },

  renderInspector() {
    const selectedEdge = this.getSelectedEdge();
    if (selectedEdge) {
      const sourceNode = this.getDefinitionNode(selectedEdge.source);
      const targetNode = this.getDefinitionNode(selectedEdge.target);
      this.elements.inspectorForm.innerHTML = `
        <div class="inspector-note">
          <strong>${escapeHtml(sourceNode?.title || selectedEdge.source)} -> ${escapeHtml(targetNode?.title || selectedEdge.target)}</strong>
          <p>Branch connections carry the decision label and optional runtime condition text.</p>
        </div>
        ${buildFieldGroup({ key: 'label', label: 'Branch Label', input: 'text', placeholder: 'approved' }, selectedEdge.label || '', [])}
        ${buildFieldGroup({ key: 'condition', label: 'Condition', input: 'textarea', placeholder: 'score >= 0.8' }, selectedEdge.condition || '', [])}
      `;
      return;
    }

    const node = this.getSelectedNode();
    const catalog = this.state.catalog;
    if (!node || !catalog) {
      this.elements.inspectorForm.innerHTML = '<p class="selection-state">Select a node or edge to edit its details.</p>';
      return;
    }

    const entry = catalog.nodeCatalog.find((candidate) => candidate.type === node.type);
    if (!entry) {
      this.elements.inspectorForm.innerHTML = '';
      return;
    }

    const dynamicFields = entry.fields
      .map((field) => buildFieldGroup(field, node.config[field.key], this.resolveFieldOptions(field)))
      .join('');
    this.elements.inspectorForm.innerHTML = `
      ${buildFieldGroup({ key: 'title', label: 'Title', input: 'text' }, node.title, [])}
      ${buildFieldGroup({ key: 'description', label: 'Description', input: 'textarea' }, node.description, [])}
      ${dynamicFields}
    `;
  },

  /**
   * @description Show the right inspector overlay only after an explicit node/edge click (n8n on-click details),
   * never on the programmatic first-node selection that happens when a workflow loads.
   */
  updateInspectorVisibility() {
    const panel = this.elements.inspectorPanel;
    if (!panel) return;
    panel.hidden = !(this.inspectorOpen && (this.state.selectedNodeId || this.state.selectedEdgeId));
  },

  renderSelectionState() {
    this.updateInspectorVisibility();
    const pendingNode = this.state.pendingConnectionSourceId
      ? this.getDefinitionNode(this.state.pendingConnectionSourceId)
      : null;
    const edge = this.getSelectedEdge();
    if (edge) {
      const sourceNode = this.getDefinitionNode(edge.source);
      const targetNode = this.getDefinitionNode(edge.target);
      this.elements.selectionState.textContent = `Edge selected: ${sourceNode?.title || edge.source} -> ${targetNode?.title || edge.target}${edge.label ? ` [${edge.label}]` : ''}.`;
      return;
    }

    const node = this.getSelectedNode();
    if (!node) {
      this.elements.selectionState.textContent = pendingNode
        ? `Connection armed from ${pendingNode.title}. Choose a target node.`
        : 'No selection.';
      return;
    }

    const suffix = pendingNode
      ? ` Connection armed from ${pendingNode.title}; click a target node to connect.`
      : '';
    this.elements.selectionState.textContent = `${node.title} selected at (${Math.round(node.position.x)}, ${Math.round(node.position.y)}).${suffix}`;
  },

  renderValidationPanel() {
    const report = this.state.validationReport;
    if (!report) {
      this.elements.validationPanel.className = 'report-panel report-empty';
      this.elements.validationPanel.innerHTML = 'Save or validate the current definition to inspect wiring and runtime-shape issues.';
      return;
    }

    const issuesMarkup = report.issues.length > 0
      ? report.issues.map((issue) => `
        <article class="report-card" data-level="${issue.level}">
          <strong>[${issue.level.toUpperCase()}] ${escapeHtml(issue.code)}</strong>
          <p>${escapeHtml(issue.message)}</p>
        </article>
      `).join('')
      : '<article class="report-card" data-level="info"><strong>Clean Canvas</strong><p>No validation issues were found.</p></article>';

    this.elements.validationPanel.className = 'report-panel';
    this.elements.validationPanel.innerHTML = `
      <article class="report-card" data-level="${report.valid ? 'info' : 'warning'}">
        <strong>${report.valid ? 'Ready' : 'Needs Attention'}</strong>
        <p>${report.nodeCount} nodes, ${report.edgeCount} edges, ${report.issues.length} issue(s).</p>
      </article>
      ${issuesMarkup}
    `;
  },

  renderCompilePanel() {
    const preview = this.state.compilePreview;
    if (!preview) {
      this.elements.compilePanel.className = 'report-panel report-empty';
      this.elements.compilePanel.innerHTML = 'Run a compile preview to see how the canvas maps onto the current swarm runtime.';
      return;
    }

    this.elements.compilePanel.className = 'report-panel';
    this.elements.compilePanel.innerHTML = `
      <article class="report-card" data-level="${preview.status === 'ready' ? 'info' : 'warning'}">
        <strong>${preview.definitionName}</strong>
        <p>${preview.stepBindings.length} step binding(s), ${preview.runtimeBindings.length} runtime surface(s), mode: ${preview.integrationMode}.</p>
      </article>
      <div class="binding-list">
        ${preview.stepBindings.map((binding) => `
          <article class="binding-card">
            <strong>${escapeHtml(binding.title)} <span class="chip">${escapeHtml(binding.runtimeBinding)}</span></strong>
            <p>${binding.configSummary.map((line) => escapeHtml(line)).join('<br>')}</p>
            <div class="definition-meta">
              ${binding.downstreamNodes.map((target) => `<span class="node-chip">${escapeHtml(target)}</span>`).join('')}
            </div>
            <div class="definition-meta">
              ${binding.compilerNotes.map((note) => `<span class="chip">${escapeHtml(note)}</span>`).join('')}
            </div>
          </article>
        `).join('')}
      </div>
      <div class="rule-list">
        ${preview.nonInterferenceRules.map((rule) => `
          <article class="report-card" data-level="info">
            <p>${escapeHtml(rule)}</p>
          </article>
        `).join('')}
      </div>
    `;
  },

  renderVersionPanel() {
    const definition = this.state.selectedDefinition;
    if (!definition) {
      this.elements.versionPanel.className = 'report-panel report-empty';
      this.elements.versionPanel.innerHTML = 'Select a workflow to inspect saved versions and fork older snapshots as new drafts.';
      return;
    }

    const versions = Array.isArray(this.state.versionHistory) ? this.state.versionHistory : [];
    if (versions.length === 0) {
      this.elements.versionPanel.className = 'report-panel report-empty';
      this.elements.versionPanel.innerHTML = 'No saved versions have been recorded yet.';
      return;
    }

    this.elements.versionPanel.className = 'report-panel';
    this.elements.versionPanel.innerHTML = versions.map((version) => `
      <article class="report-card version-card" data-level="${version.version === definition.version ? 'info' : 'warning'}">
        <strong>${escapeHtml(version.name)} <span class="chip">v${version.version}</span></strong>
        <p>${version.nodeCount} nodes, ${version.edgeCount} edges, saved ${formatRelativeTimestamp(version.updatedAt)}.</p>
        <div class="version-actions">
          <button type="button" data-version-action="fork" data-version="${version.version}">Fork As Draft</button>
        </div>
      </article>
    `).join('');
  },

  renderMetrics() {
    const definition = this.state.selectedDefinition;
    const bindingCount = definition
      ? new Set(
        definition.nodes.map((node) => {
          const entry = this.state.catalog?.nodeCatalog.find((candidate) => candidate.type === node.type);
          return entry?.runtimeBinding || node.type;
        }),
      ).size
      : 0;

    this.elements.metricDefinitions.textContent = String(this.state.definitions.length);
    this.elements.metricNodes.textContent = String(definition?.nodes.length ?? 0);
    this.elements.metricEdges.textContent = String(definition?.edges.length ?? 0);
    this.elements.metricBindings.textContent = String(bindingCount);
  },

  resolveFieldOptions(field) {
    if (field.optionsSource === 'agents') {
      const liveAgents = this.state.agents
        .map((agent) => ({
          value: String(agent.agentId || agent.agent_id || ''),
          label: `${String(agent.name || 'Unknown')} (${String(agent.status || 'unknown')})`,
        }))
        .filter((agent) => agent.value.length > 0)
        .sort((left, right) => left.label.localeCompare(right.label));

      return field.required
        ? liveAgents
        : [{ value: '', label: 'Auto / Not fixed' }, ...liveAgents];
    }

    if (field.optionsSource === 'capabilities') {
      const options = Array.from(new Set(
        this.state.agents.flatMap((agent) => Array.isArray(agent.baseCapabilities) ? agent.baseCapabilities : []),
      )).sort((left, right) => String(left).localeCompare(String(right)));
      return options.map((option) => ({ value: String(option), label: String(option) }));
    }

    if (field.optionsSource === 'routing-keywords') {
      const options = Array.from(new Set(
        this.state.agents.flatMap((agent) => Array.isArray(agent.routingKeywords) ? agent.routingKeywords : []),
      )).sort((left, right) => String(left).localeCompare(String(right)));
      return options.map((option) => ({ value: String(option), label: String(option) }));
    }

    return (field.options || []).map((option) => ({ value: option, label: option }));
  },

  suggestEdgeLabel(sourceNode, definition) {
    const existingOutgoing = definition.edges.filter((edge) => edge.source === sourceNode.id).length;
    const outcomes = Array.isArray(sourceNode.config.outcomes) ? sourceNode.config.outcomes : [];
    const branchLabels = Array.isArray(sourceNode.config.branchLabels) ? sourceNode.config.branchLabels : [];

    if (sourceNode.type === 'ai-decision') {
      return String(outcomes[existingOutgoing] || outcomes[outcomes.length - 1] || `decision-${existingOutgoing + 1}`);
    }

    if (sourceNode.type === 'logic-gate') {
      const trueLabel = String(sourceNode.config.trueLabel || 'true');
      const falseLabel = String(sourceNode.config.falseLabel || 'false');
      if (existingOutgoing === 0) {
        return trueLabel;
      }
      if (existingOutgoing === 1) {
        return falseLabel;
      }
      return `branch-${existingOutgoing + 1}`;
    }

    if (sourceNode.type === 'parallel-split') {
      return String(branchLabels[existingOutgoing] || `branch-${existingOutgoing + 1}`);
    }

    return undefined;
  },

  syncNodeCard(node) {
    const nodeElement = this.elements.canvasNodes.querySelector(`[data-node-id="${node.id}"]`);
    if (!(nodeElement instanceof HTMLElement)) {
      return;
    }

    const titleElement = nodeElement.querySelector('h3');
    const descriptionElement = nodeElement.querySelector('p');
    if (titleElement) {
      titleElement.textContent = node.title;
    }
    if (descriptionElement) {
      descriptionElement.textContent = node.description || 'No description yet.';
    }
  },
};
