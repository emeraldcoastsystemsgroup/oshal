/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Replaced dead-route engineering iframe loads with explicit migration-state panels so cockpit no longer shows blank 404 engineering screens
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Restored a live task-explorer engineering screen inside cockpit while keeping unmounted routes as migration-state panels
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Promoted the native /config admin screen to a live engineering subscreen and generalized live iframe titles
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Promoted the native health and Redis diagnostics engineering screens to live cockpit subscreens backed by current OSHAL APIs
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Compatibility-first restoration: all engineering screens now load operational pages via legacy compat routes, API stubs, and a queue-dashboard replacement
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Promoted Health dashboard to native OSHAL route and replaced stub wording with live-backed compatibility language
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Promoted Redis diagnostics to native OSHAL route backed by real runtime APIs
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Promoted Queue Admin to native OSHAL route with real process-flow telemetry
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Promoted Mesh dashboard to native OSHAL route with real channel lifecycle and ticket-linkage telemetry
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Promoted Ops dashboard to native OSHAL route with real runtime, queue, and attention telemetry
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added native RAG Center engineering screen for live knowledge inventory and retrieval testing
 */

import { createUiLogger } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-advanced-view');


/**
 * @typedef {'native' | 'legacy-compat' | 'compat-replacement'} EngineeringSurfaceMode
 */

const ENGINEERING_PAGES = [
  {
    id: 'health-dashboard',
    icon: 'ph ph-heartbeat',
    label: 'Health',
    route: '/health-dashboard/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native health dashboard with real runtime telemetry for API health, agents, swarm runs, scheduler readiness, and operational logs.',
    nextStep: 'Expand native health telemetry depth and phase out remaining legacy health dependencies.',
    iframeTitle: 'Health Dashboard',
    live: true,
  },
  {
    id: 'task-explorer',
    icon: 'ph ph-list-dashes',
    label: 'Tasks',
    route: '/task-explorer/',
    status: 'Native',
    mode: 'native',
    summary: 'The first native engineering-screen migration is mounted in OSHAL and loads as a real working screen inside cockpit.',
    nextStep: 'Keep extending workspace and operator depth from this native baseline.',
    iframeTitle: 'Task Explorer',
    live: true,
  },
  {
    id: 'queue-dashboard',
    icon: 'ph ph-package',
    label: 'Queues',
    route: '/queue-dashboard/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native queue dashboard showing scheduler status, schedules, work items, and runs from current swarm APIs. No legacy dependencies.',
    nextStep: 'Expand with real-time queue depth metrics and operator queue-drain controls.',
    iframeTitle: 'Queue Dashboard',
    live: true,
  },
  {
    id: 'queue-manager-admin',
    icon: 'ph ph-wrench',
    label: 'Queue Admin',
    route: '/queue-manager-admin/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native queue manager admin screen with real process-flow telemetry across tickets, dispatches, agents, and swarm runs.',
    nextStep: 'Expand native queue-admin controls with per-agent replay, retry, and escalation actions.',
    iframeTitle: 'Queue Manager Admin',
    live: true,
  },
  {
    id: 'redis-visibility',
    icon: 'ph ph-database',
    label: 'Redis',
    route: '/redis-visibility/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native Redis diagnostics screen with real scheduler, work-item, and swarm-run telemetry.',
    nextStep: 'Expand native Redis diagnostics depth for queue latency and stream-level visibility.',
    iframeTitle: 'Redis Diagnostics',
    live: true,
  },
  {
    id: 'config',
    icon: 'ph ph-gear',
    label: 'Agent Config',
    route: '/config/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native config admin screen backed by shared config and agent-scoped admin contracts.',
    nextStep: 'Deepen into a fuller admin surface with per-agent tool config clearly separated.',
    iframeTitle: 'Config Admin',
    live: true,
  },
  {
    id: 'mesh-dashboard',
    icon: 'ph ph-graph',
    label: 'Mesh',
    route: '/mesh-dashboard/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native mesh dashboard showing real channel lifecycle, ticket linkage coverage, and participant workload telemetry.',
    nextStep: 'Add mesh actions for opening channels and resolving uncovered started tickets directly from this native surface.',
    iframeTitle: 'Mesh Dashboard',
    live: true,
  },
  {
    id: 'ops-dashboard',
    icon: 'ph ph-monitor',
    label: 'Ops',
    route: '/ops-dashboard/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native ops dashboard with real runtime health, dispatch coverage, queue flow, and attention telemetry.',
    nextStep: 'Expand native ops controls for direct intervention workflows (requeue, reassign, and escalation routing).',
    iframeTitle: 'Ops Dashboard',
    live: true,
  },
  {
    id: 'rag-center',
    icon: 'ph ph-brain',
    label: 'RAG Center',
    route: '/rag-center/',
    status: 'Native',
    mode: 'native',
    summary: 'The OSHAL native RAG Center with live knowledge-memory inventory, collection rollups, and retrieval query testing against current runtime APIs.',
    nextStep: 'Expand from inventory and query validation into richer ingest analytics, hit-history tracking, and deeper vector inspection as backend telemetry matures.',
    iframeTitle: 'RAG Center',
    live: true,
  },
];

/**
 * @description Cockpit engineering view that now renders operational engineering screens
 * for all Engineering buttons — native pages, legacy-compat pages served through OSHAL,
 * and compatibility replacement pages.
 */
export class AdvancedView {
  constructor(container) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.currentPage = 'task-explorer';
    this.pages = ENGINEERING_PAGES;
    logger.info('Created cockpit advanced view', {
      hasContainer: Boolean(this.container),
      currentPage: this.currentPage,
      pageCount: this.pages.length,
    });
  }

  /**
   * @description Render the engineering ribbon and the selected screen status panel.
   *
   * @returns Promise that resolves after initial DOM render
   */
  async render() {
    if (!this.container) {
      return;
    }

    logger.info('Rendering cockpit advanced view', {
      currentPage: this.currentPage,
    });

    this.container.innerHTML = `<div class="advanced-view">
      <div class="adv-sub-ribbon" id="advSubRibbon">
        ${this.pages.map(p => `
          <button class="adv-sub-btn${p.id === this.currentPage ? ' active' : ''}" data-page="${p.id}" title="${p.label}">
            <i class="${p.icon}"></i>
          </button>`).join('')}
      </div>
      <div class="adv-iframe-container" id="advIframe">
        <div id="advPanel" class="adv-panel"></div>
      </div>
    </div>`;

    this.renderCurrentPanel();
    this.bindRibbonButtons();
  }

  /**
   * @description Render the selected engineering screen inside cockpit.
   */
  renderCurrentPanel() {
    const page = this.pages.find(item => item.id === this.currentPage);
    const panel = this.container?.querySelector('#advPanel');
    if (!page || !panel) {
      return;
    }

    logger.debug('Rendering cockpit engineering panel', {
      pageId: page.id,
      route: page.route,
      mode: page.mode,
    });
    panel.innerHTML = this.renderOperationalPanelMarkup(page);
  }

  /**
   * @description Bind ribbon clicks so each engineering item swaps panel content.
   */
  bindRibbonButtons() {
    this.container.querySelectorAll('.adv-sub-btn').forEach((button) => {
      button.addEventListener('click', () => {
        logger.info('Switching cockpit engineering panel', {
          from: this.currentPage,
          to: button.dataset.page,
        });
        this.currentPage = button.dataset.page;
        this.setActiveButton(button);
        this.renderCurrentPanel();
      });
    });
  }

  /**
   * @description Update ribbon active state after the selected engineering page changes.
   *
   * @param activeButton - Button representing the selected engineering page
   */
  setActiveButton(activeButton) {
    this.container.querySelectorAll('.adv-sub-btn').forEach((button) => {
      button.classList.toggle('active', button === activeButton);
    });
  }

  /**
   * @description Render an operational engineering panel with iframe for native,
   * legacy-compat, and replacement screens.
   *
   * @param page - Engineering page configuration
   * @returns HTML markup for an operational engineering iframe panel
   */
  renderOperationalPanelMarkup(page) {
    const modeLabel = page.mode === 'native' ? 'Native'
      : page.mode === 'legacy-compat' ? 'Legacy Compat'
      : page.mode === 'compat-replacement' ? 'Replacement'
      : page.status;

    return `
      ${this.renderHeroCard(page)}
      <div class="adv-meta-grid">
        ${this.renderMetaCard('Route', `<code>${page.route}</code>`)}
        ${this.renderMetaCard('Source', modeLabel)}
        ${this.renderMetaCard('Next Step', page.nextStep)}
      </div>
      <section class="adv-iframe-section">
        <iframe title="${page.iframeTitle || page.label}" src="${page.route}"></iframe>
      </section>`;
  }

  /**
   * @description Render the shared hero card for an engineering screen.
   *
   * @param page - Engineering page configuration
   * @returns HTML markup for the hero card
   */
  renderHeroCard(page) {
    return `
      <section class="adv-hero-card">
        <div class="adv-hero-header">
          <div>
            <p class="adv-hero-eyebrow">Engineering Screen</p>
            <h2 class="adv-hero-title">${page.label}</h2>
          </div>
          <span class="adv-hero-status-chip">${page.status}</span>
        </div>
        <p class="adv-hero-summary">${page.summary}</p>
      </section>`;
  }

  /**
   * @description Render one metadata card for the engineering panel grid.
   *
   * @param label - Card label
   * @param value - Card HTML value
   * @returns HTML markup for one metadata card
   */
  renderMetaCard(label, value) {
    return `
      <article class="adv-meta-card">
        <div class="adv-meta-label">${label}</div>
        <div class="adv-meta-value">${value}</div>
      </article>`;
  }

  /**
   * @description Clear the engineering panel content during cockpit view teardown.
   */
  destroy() {
    if (this.container) this.container.innerHTML = '';
  }
}
