/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from workflow-studio.js (1000-line cap decomposition): server data/API operations mixin — load/create/duplicate/fork/save/validate/compile/export/publish plus the canvas→WorkflowPublishSpec translator
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Publish now takes its slug from the shared workflowTicketTypeSlug helper instead of an inline regex chain, so the Runs panel can scope to the same ticketType the queue is published under without the two derivations drifting apart.
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import { requestJson, readErrorMessage, workflowTicketTypeSlug } from './workflow-studio-utils.js';

const logger = createUiLogger('workflow-studio');

/**
 * @description Server data/API operation methods for WorkflowStudioApp. Assigned onto
 * WorkflowStudioApp.prototype by workflow-studio.js (prototype mixin — every method runs with
 * the app instance as `this`). Covers studio bootstrap loading, definition CRUD, version
 * history, validation/compile previews, JSON export, and live publish via
 * POST /api/swarm/apps/publish.
 */
export const workflowStudioDataMethods = {
  async refreshStudio() {
    this.setStatus('Loading workflow studio...', 'info');
    try {
      const [catalogPayload, definitionsPayload, agentsPayload, templatesPayload] = await Promise.all([
        requestJson('/api/workflow-studio/catalog'),
        requestJson('/api/workflow-studio/definitions'),
        requestJson('/api/agents').catch(() => ({ agents: [] })),
        requestJson('/api/workflow-studio/templates').catch(() => ({ templates: [] })),
      ]);

      this.state.catalog = catalogPayload.catalog;
      this.state.definitions = Array.isArray(definitionsPayload.definitions) ? definitionsPayload.definitions : [];
      this.state.agents = Array.isArray(agentsPayload.agents) ? agentsPayload.agents : [];
      this.renderTemplates(Array.isArray(templatesPayload.templates) ? templatesPayload.templates : []);

      if (this.state.definitions.length === 0) {
        await this.createWorkflowDefinition(true);
        return;
      }

      const activeDefinitionId = this.state.selectedDefinition?.id ?? this.state.definitions[0].id;
      await this.selectDefinition(activeDefinitionId, true);
      this.setStatus('Workflow studio ready.', 'success');
    } catch (error) {
      logger.error('Failed to refresh workflow studio', { error: serializeUiError(error) });
      this.setStatus(`Failed to load workflow studio: ${readErrorMessage(error)}`, 'error');
    }
  },

  async createWorkflowDefinition(silent = false) {
    try {
      const payload = await requestJson('/api/workflow-studio/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const definition = payload.definition;
      if (!definition) {
        throw new Error('Workflow definition response was empty.');
      }
      await this.reloadDefinitions();
      await this.selectDefinition(definition.id, true);
      if (!silent) {
        this.setStatus(`Created ${definition.name}.`, 'success');
      }
    } catch (error) {
      logger.error('Failed to create workflow definition', { error: serializeUiError(error) });
      this.setStatus(`Failed to create workflow: ${readErrorMessage(error)}`, 'error');
    }
  },

  async reloadDefinitions() {
    const payload = await requestJson('/api/workflow-studio/definitions');
    this.state.definitions = Array.isArray(payload.definitions) ? payload.definitions : [];
    this.renderDefinitions();
    this.renderMetrics();
  },

  async createFromTemplate(templateId) {
    try {
      const payload = await requestJson(`/api/workflow-studio/templates/${encodeURIComponent(templateId)}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const definition = payload.definition;
      if (!definition) {
        throw new Error('Template response was empty.');
      }
      await this.reloadDefinitions();
      await this.selectDefinition(definition.id, true);
      this.setStatus(`Created ${definition.name} from template.`, 'success');
    } catch (error) {
      logger.error('Failed to create from template', { error: serializeUiError(error) });
      this.setStatus(`Failed to create from template: ${readErrorMessage(error)}`, 'error');
    }
  },

  async reloadVersionHistory(definitionId) {
    if (!definitionId) {
      this.state.versionHistory = [];
      this.renderVersionPanel();
      return;
    }

    try {
      const payload = await requestJson(`/api/workflow-studio/definitions/${definitionId}/versions`);
      this.state.versionHistory = Array.isArray(payload.versions) ? payload.versions : [];
    } catch (error) {
      logger.warn('Failed to load workflow version history', { error: serializeUiError(error), definitionId });
      this.state.versionHistory = [];
    }

    this.renderVersionPanel();
  },

  async selectDefinition(definitionId, silent = false) {
    try {
      const [definitionPayload, versionPayload] = await Promise.all([
        requestJson(`/api/workflow-studio/definitions/${definitionId}`),
        requestJson(`/api/workflow-studio/definitions/${definitionId}/versions`).catch(() => ({ versions: [] })),
      ]);
      this.state.selectedDefinition = definitionPayload.definition || null;
      this.state.versionHistory = Array.isArray(versionPayload.versions) ? versionPayload.versions : [];
      this.state.selectedNodeId = this.state.selectedDefinition?.nodes?.[0]?.id ?? null;
      this.state.selectedEdgeId = null;
      this.state.pendingConnectionSourceId = null;
      this.state.validationReport = null;
      this.state.compilePreview = null;
      this.render();
      if (!silent && this.state.selectedDefinition) {
        this.setStatus(`Loaded ${this.state.selectedDefinition.name}.`, 'success');
      }
    } catch (error) {
      logger.error('Failed to select workflow definition', { error: serializeUiError(error), definitionId });
      this.setStatus(`Failed to load workflow: ${readErrorMessage(error)}`, 'error');
    }
  },

  async duplicateActiveDefinition() {
    const definition = this.requireDefinition();
    if (!definition) {
      return;
    }

    try {
      const payload = await requestJson(`/api/workflow-studio/definitions/${definition.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const duplicate = payload.definition;
      if (!duplicate) {
        throw new Error('Duplicate workflow response was empty.');
      }

      await this.reloadDefinitions();
      await this.selectDefinition(duplicate.id, true);
      this.setStatus(`Duplicated ${definition.name} as ${duplicate.name}.`, 'success');
    } catch (error) {
      logger.error('Failed to duplicate workflow definition', { error: serializeUiError(error) });
      this.setStatus(`Failed to duplicate workflow: ${readErrorMessage(error)}`, 'error');
    }
  },

  async forkSelectedVersion(version) {
    const definition = this.requireDefinition();
    if (!definition) {
      return;
    }

    try {
      const payload = await requestJson(`/api/workflow-studio/definitions/${definition.id}/versions/${version}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const fork = payload.definition;
      if (!fork) {
        throw new Error('Fork workflow response was empty.');
      }

      await this.reloadDefinitions();
      await this.selectDefinition(fork.id, true);
      this.setStatus(`Forked ${definition.name} v${version} into ${fork.name}.`, 'success');
    } catch (error) {
      logger.error('Failed to fork workflow definition version', { error: serializeUiError(error), version });
      this.setStatus(`Failed to fork workflow version: ${readErrorMessage(error)}`, 'error');
    }
  },

  async saveActiveDefinition(options = {}) {
    const definition = this.requireDefinition();
    if (!definition) {
      return null;
    }

    try {
      const payload = await requestJson(`/api/workflow-studio/definitions/${definition.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: definition.id,
          name: definition.name,
          description: definition.description,
          nodes: definition.nodes,
          edges: definition.edges,
          metadata: definition.metadata,
        }),
      });
      this.state.selectedDefinition = payload.definition || definition;
      await this.reloadDefinitions();
      await this.reloadVersionHistory(this.state.selectedDefinition?.id);
      this.render();
      if (!options.silent) {
        this.setStatus(`Saved ${this.state.selectedDefinition.name}.`, 'success');
      }
      return this.state.selectedDefinition;
    } catch (error) {
      logger.error('Failed to save active definition', { error: serializeUiError(error) });
      this.setStatus(`Failed to save workflow: ${readErrorMessage(error)}`, 'error');
      return null;
    }
  },

  async validateActiveDefinition() {
    const definition = await this.saveActiveDefinition({ silent: true });
    if (!definition) {
      return;
    }

    try {
      const payload = await requestJson(`/api/workflow-studio/definitions/${definition.id}/validate`, {
        method: 'POST',
      });
      this.state.validationReport = payload.report || null;
      this.renderValidationPanel();
      this.setStatus(`Validated ${definition.name}.`, this.state.validationReport?.valid ? 'success' : 'warning');
    } catch (error) {
      logger.error('Failed to validate workflow definition', { error: serializeUiError(error) });
      this.setStatus(`Failed to validate workflow: ${readErrorMessage(error)}`, 'error');
    }
  },

  async compileActiveDefinition() {
    const definition = await this.saveActiveDefinition({ silent: true });
    if (!definition) {
      return;
    }

    try {
      const payload = await requestJson(`/api/workflow-studio/definitions/${definition.id}/compile`, {
        method: 'POST',
      });
      this.state.compilePreview = payload.preview || null;
      this.state.validationReport = this.state.compilePreview?.validation || this.state.validationReport;
      this.renderValidationPanel();
      this.renderCompilePanel();
      this.renderMetrics();
      this.setStatus(`Built compile preview for ${definition.name}.`, this.state.compilePreview?.status === 'ready' ? 'success' : 'warning');
    } catch (error) {
      logger.error('Failed to compile workflow definition', { error: serializeUiError(error) });
      this.setStatus(`Failed to compile workflow: ${readErrorMessage(error)}`, 'error');
    }
  },

  exportActiveDefinition() {
    const definition = this.requireDefinition();
    if (!definition) {
      return;
    }

    const blob = new Blob([`${JSON.stringify(definition, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${definition.slug || 'workflow-studio'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.setStatus(`Exported ${definition.name}.`, 'success');
  },

  /**
   * Publish the active definition as a LIVE, personal ticket queue via
   * POST /api/swarm/apps/publish. Maps the canvas's bot-bound nodes + approval
   * gates to a WorkflowPublishSpec (single-shot for one bot, staged for a chain),
   * then loads it live (no rebuild). Owner/scope are set server-side from the
   * session. Linear chains publish as single-shot/staged; graphs with branches or
   * parallel splits publish as a full 'graph' spec the engine runs as drawn.
   */
  async publishActiveDefinition() {
    const definition = await this.saveActiveDefinition({ silent: true });
    if (!definition) {
      return;
    }

    let spec;
    try {
      spec = this.buildPublishSpecFromDefinition(definition);
    } catch (error) {
      this.setStatus(`Cannot publish: ${readErrorMessage(error)}`, 'error');
      return;
    }

    // Per-workflow auto-start: when checked, tickets of this workflow run on arrival (no manual gate).
    const autoStart = document.getElementById('autoStartToggle')?.checked === true;
    if (autoStart) spec.autoStart = true;

    try {
      const payload = await requestJson('/api/swarm/apps/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, scope: 'person' }),
      });
      const kind = spec.mode === 'graph'
        ? `${spec.graph.nodes.length}-node graph`
        : spec.mode === 'staged'
          ? `${spec.stages.length}-stage`
          : 'single-shot';
      const runMode = autoStart ? ' — auto-starts on each new ticket' : ' — tickets wait for approval';
      this.setStatus(`Published "${payload.app?.displayName || spec.name}" as a live ${kind} queue${runMode}.`, 'success');
    } catch (error) {
      logger.error('Failed to publish workflow definition', { error: serializeUiError(error) });
      this.setStatus(`Publish failed: ${readErrorMessage(error)}`, 'error');
    }
  },

  /**
   * Translate a canvas definition into a WorkflowPublishSpec. A linear chain compiles to a
   * single-shot/staged spec; a graph with branches, parallel splits, or a fan-in compiles to a
   * full 'graph' spec that the ProcessDefinitionExecutionEngine runs as-drawn (decisions and
   * parallel fan-out included). Throws a human-readable Error when the graph can't be published.
   */
  buildPublishSpecFromDefinition(definition) {
    const nodes = definition.nodes || [];
    const edges = definition.edges || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const outgoing = new Map();
    const indegree = new Map();
    for (const edge of edges) {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source).push(edge);
      indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    }
    const branching =
      nodes.some((n) => (outgoing.get(n.id)?.length || 0) > 1) ||
      nodes.some((n) => (indegree.get(n.id) || 0) > 1) ||
      nodes.some((n) => n.type === 'parallel-split' || n.type === 'parallel-join');

    const start = nodes.find((n) => n.type === 'start') || nodes.find((n) => (indegree.get(n.id) || 0) === 0);
    if (!start) {
      throw new Error('workflow needs a start node');
    }

    // Shared with the Runs panel — this slug is both the queue name and the ticketType every
    // run of this workflow is recorded under, so it must come from one place.
    const slug = workflowTicketTypeSlug(definition);

    const BOT_NODE_TYPES = new Set(['execute-agent', 'route-agent', 'ai-decision']);
    const agentInfo = (id) => {
      const agent = (this.state.agents || []).find((a) => (a.agentId || a.id) === id);
      return agent ? { id: agent.agentId || agent.id, name: agent.name || agent.displayName || null } : null;
    };
    const boundBot = (node) => node.config?.agentId || node.config?.preferredAgentId || node.config?.decisionAgentId;

    // Branch C — full canvas graph. Emit every node/edge (with labels) so the engine runs the
    // branches and parallel fan-out as drawn. Bot nodes carry their resolved agentId + name.
    if (branching) {
      const graphNodes = nodes.map((node) => {
        const config = { ...(node.config || {}) };
        const label = node.title || node.type;
        if (BOT_NODE_TYPES.has(node.type)) {
          const botId = boundBot(node);
          const info = botId ? agentInfo(botId) : null;
          if (!info) {
            throw new Error(`node "${label}" has no bot selected — pick a bot on every agent node`);
          }
          config.agentId = info.id;
          if (info.name) config.agentBinding = info.name;
          if (node.type === 'ai-decision') {
            const labels = (outgoing.get(node.id) || []).map((e) => e.label).filter(Boolean);
            if (labels.length) config.outcomes = labels;
          }
        }
        return { id: node.id, type: node.type, title: node.title || node.type, config };
      });
      const graphEdges = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...(e.label ? { label: e.label } : {}),
      }));
      if (!graphNodes.some((n) => BOT_NODE_TYPES.has(n.type))) {
        throw new Error('add at least one agent node (with a bot selected) before publishing');
      }
      return { name: slug, displayName: definition.name, mode: 'graph', graph: { nodes: graphNodes, edges: graphEdges } };
    }

    // Linear chain — forward walk from start (first outgoing edge at each step) → staged/single-shot.
    const order = [];
    const seen = new Set();
    let cursor = start;
    while (cursor && !seen.has(cursor.id)) {
      order.push(cursor);
      seen.add(cursor.id);
      const next = (outgoing.get(cursor.id) || [])[0];
      cursor = next ? byId.get(next.target) : null;
    }

    const stages = [];
    for (const node of order) {
      if (node.type === 'approval-gate') {
        if (stages.length) stages[stages.length - 1].approvalAfter = true;
        continue;
      }
      if (!BOT_NODE_TYPES.has(node.type)) continue;
      const botId = boundBot(node);
      const label = node.title || node.type;
      if (!botId) {
        throw new Error(`stage "${label}" has no bot selected — pick a bot on every agent node`);
      }
      const info = agentInfo(botId);
      if (!info || !info.name) {
        throw new Error(`bot for "${label}" is not in the live agent roster`);
      }
      stages.push({ bot: info.name, name: node.title || undefined });
    }

    if (stages.length === 0) {
      throw new Error('add at least one agent node (with a bot selected) before publishing');
    }
    if (stages.length === 1) {
      return { name: slug, displayName: definition.name, mode: 'single-shot', workerBot: stages[0].bot };
    }
    return { name: slug, displayName: definition.name, mode: 'staged', stages };
  },
};
