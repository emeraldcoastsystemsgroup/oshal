/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit workspace-focus orchestration from app.js so heavy header tool launches no longer bloat the shell controller
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the Presentron workspace-focus label branch; RAG (Swarm Knowledge) is the only header workspace action
 */

import {
  clampWorkspaceFocusWidth,
  getWorkspaceFocusToggleLabel,
  getWorkspaceFocusToggleTitle,
  persistWorkspaceFocusCustomWidthPreference,
  persistWorkspaceFocusWidePreference,
  readWorkspaceFocusCustomWidthPreference,
  readWorkspaceFocusWidePreference,
} from './cockpit-persistence.js';
import { createUiLogger } from '../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-workspace-focus-controller');

/**
 * @description Manage cockpit workspace-focus mode for heavyweight header tool launches like RAG and Presentron.
 */
export class CockpitWorkspaceFocusController {
  /**
   * @description Create a workspace-focus controller with the toast callback used for operator feedback.
   *
   * @param {{ showToast: (message: string, type?: string) => void }} options - Controller callbacks.
   * @returns {void}
   */
  constructor(options) {
    this.showToast = options.showToast;
    this.action = '';
    this.isWide = readWorkspaceFocusWidePreference();
    this.customWidth = readWorkspaceFocusCustomWidthPreference();
    logger.info('Created cockpit workspace focus controller', {
      isWide: this.isWide,
      customWidth: this.customWidth,
    });
  }

  /**
   * @description Read the active workspace-focus action.
   *
   * @returns {string} Active action id or empty string.
   */
  getAction() {
    return this.action;
  }

  /**
   * @description Read whether workspace focus is using the wide preset.
   *
   * @returns {boolean} True when the wide preset is active.
   */
  getIsWide() {
    return this.isWide;
  }

  /**
   * @description Read the current custom workspace-focus width.
   *
   * @returns {number | null} Saved custom width in pixels or null.
   */
  getCustomWidth() {
    return this.customWidth;
  }

  /**
   * @description Open one heavy workspace action from the header using cockpit focus mode.
   *
   * @param {'rag'} action - Workspace action to foreground.
   * @param {{ toggleChatPanel: (show: boolean) => void, openWorkspaceAction: (action: string) => void }} callbacks - App-level callbacks.
   * @returns {void}
   */
  openHeaderWorkspace(action, callbacks) {
    const normalizedAction = typeof action === 'string' ? action.trim() : '';
    if (!normalizedAction) {
      return;
    }

    logger.info('Opening cockpit workspace focus action', {
      action: normalizedAction,
    });
    this.action = normalizedAction;
    callbacks.toggleChatPanel(true);
    this.enter(normalizedAction);
    callbacks.openWorkspaceAction?.(normalizedAction);
  }

  /**
   * @description Enter cockpit workspace-focus mode for one tool action.
   *
   * @param {string} action - Workspace action being foregrounded.
   * @returns {void}
   */
  enter(action) {
    logger.info('Entering cockpit workspace focus mode', {
      action,
      isWide: this.isWide,
      customWidth: this.customWidth,
    });
    const shell = document.querySelector('.cockpit-body');
    const chatPanel = document.getElementById('chatPanel');
    const label = document.getElementById('chatWorkspaceFocusLabel');
    const exitButton = document.getElementById('exitWorkspaceFocusBtn');
    const widthButton = document.getElementById('toggleWorkspaceFocusWidthBtn');
    const resizeHandle = document.getElementById('workspaceFocusResizeHandle');
    const collapseButton = document.getElementById('toggleChat');
    const nextLabel = 'Workspace focus: Swarm Knowledge';

    shell?.classList.add('workspace-focus-mode');
    chatPanel?.classList.add('workspace-focus-active');
    label?.classList.remove('hidden');
    exitButton?.classList.remove('hidden');
    widthButton?.classList.remove('hidden');
    resizeHandle?.classList.remove('hidden');
    if (label instanceof HTMLElement) {
      label.textContent = nextLabel;
    }
    this.applyWidthPreference();
    if (collapseButton instanceof HTMLButtonElement) {
      collapseButton.disabled = true;
      collapseButton.title = 'Use Return to leave workspace focus';
    }
  }

  /**
   * @description Exit cockpit workspace-focus mode and restore the normal shell.
   *
   * @returns {void}
   */
  exit() {
    logger.info('Exiting cockpit workspace focus mode', {
      action: this.action || null,
    });
    this.action = '';
    const shell = document.querySelector('.cockpit-body');
    const chatPanel = document.getElementById('chatPanel');
    const label = document.getElementById('chatWorkspaceFocusLabel');
    const exitButton = document.getElementById('exitWorkspaceFocusBtn');
    const widthButton = document.getElementById('toggleWorkspaceFocusWidthBtn');
    const resizeHandle = document.getElementById('workspaceFocusResizeHandle');
    const collapseButton = document.getElementById('toggleChat');

    shell?.classList.remove('workspace-focus-mode');
    chatPanel?.classList.remove('workspace-focus-active');
    shell?.classList.remove('workspace-focus-wide');
    label?.classList.add('hidden');
    exitButton?.classList.add('hidden');
    widthButton?.classList.add('hidden');
    resizeHandle?.classList.add('hidden');
    if (chatPanel instanceof HTMLElement) {
      chatPanel.style.removeProperty('width');
    }
    if (collapseButton instanceof HTMLButtonElement) {
      collapseButton.disabled = false;
      collapseButton.title = 'Collapse';
    }
  }

  /**
   * @description Persist the wide preset preference and apply it immediately.
   *
   * @param {boolean} isWide - Whether the wide preset should be active.
   * @returns {void}
   */
  setWidePreference(isWide) {
    this.isWide = isWide === true;
    persistWorkspaceFocusWidePreference(this.isWide);
    this.applyWidthPreference();
  }

  /**
   * @description Toggle the width of workspace-focus mode between preset stages or clear the custom width.
   *
   * @returns {void}
   */
  toggleWidth() {
    if (this.customWidth !== null) {
      logger.info('Resetting custom cockpit workspace focus width');
      this.clearCustomWidth(true);
      return;
    }

    this.isWide = !this.isWide;
    persistWorkspaceFocusWidePreference(this.isWide);
    this.applyWidthPreference();
    logger.info('Toggled cockpit workspace focus width preset', {
      isWide: this.isWide,
    });
    this.showToast(
      this.isWide ? 'Workspace focus: wider stage' : 'Workspace focus: standard stage',
      'info',
    );
  }

  /**
   * @description Apply the persisted workspace-focus width preference to the cockpit shell and button label.
   *
   * @returns {void}
   */
  applyWidthPreference() {
    const shell = document.querySelector('.cockpit-body');
    const chatPanel = document.getElementById('chatPanel');
    const widthButton = document.getElementById('toggleWorkspaceFocusWidthBtn');

    shell?.classList.toggle('workspace-focus-wide', this.customWidth === null && this.isWide);
    if (chatPanel instanceof HTMLElement) {
      this.applyChatPanelWidth(chatPanel);
    }
    if (widthButton instanceof HTMLButtonElement) {
      widthButton.textContent = getWorkspaceFocusToggleLabel(this.isWide, this.customWidth);
      widthButton.title = getWorkspaceFocusToggleTitle(this.isWide, this.customWidth);
      widthButton.setAttribute('aria-label', widthButton.title);
    }
    logger.debug('Applied cockpit workspace focus width preference', {
      isWide: this.isWide,
      customWidth: this.customWidth,
    });
  }

  /**
   * @description Clear any saved drag-resized width and fall back to the preset stage.
   *
   * @param {boolean} showToast - Whether to confirm the reset with a toast.
   * @returns {void}
   */
  clearCustomWidth(showToast = false) {
    this.customWidth = null;
    persistWorkspaceFocusCustomWidthPreference(null);
    this.applyWidthPreference();
    logger.info('Cleared custom cockpit workspace focus width', {
      showToast,
    });
    if (showToast) {
      this.showToast('Workspace focus width reset', 'info');
    }
  }

  /**
   * @description Persist a drag-sized workspace-focus width and apply it immediately.
   *
   * @param {number | null} width - Resolved width in pixels or null to clear custom sizing.
   * @returns {void}
   */
  setCustomWidth(width) {
    if (typeof width === 'number' && Number.isFinite(width)) {
      this.customWidth = Math.round(width);
      persistWorkspaceFocusCustomWidthPreference(this.customWidth);
    } else {
      this.customWidth = null;
      persistWorkspaceFocusCustomWidthPreference(null);
    }
    this.applyWidthPreference();
    logger.debug('Updated custom cockpit workspace focus width', {
      customWidth: this.customWidth,
    });
  }

  /**
   * @description Start drag resizing for the workspace-focus stage from the chat-panel edge handle.
   *
   * @param {MouseEvent} event - Initial mouse-down event on the resize edge.
   * @returns {void}
   */
  startResize(event) {
    if (!this.action) {
      return;
    }

    const chatPanel = document.getElementById('chatPanel');
    const handle = document.getElementById('workspaceFocusResizeHandle');
    if (!(chatPanel instanceof HTMLElement) || !(handle instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    logger.debug('Starting cockpit workspace focus resize', {
      action: this.action,
    });
    const state = {
      startX: event.clientX,
      startWidth: chatPanel.getBoundingClientRect().width,
      nextWidth: chatPanel.getBoundingClientRect().width,
      rafId: 0,
    };
    let onMove = null;
    let onUp = null;

    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    onMove = (moveEvent) => {
      if (state.rafId) {
        return;
      }

      state.rafId = window.requestAnimationFrame(() => {
        const deltaX = moveEvent.clientX - state.startX;
        state.nextWidth = clampWorkspaceFocusWidth(state.startWidth - deltaX, window.innerWidth);
        this.setCustomWidth(state.nextWidth);
        state.rafId = 0;
      });
    };
    onUp = () => {
      if (state.rafId) {
        window.cancelAnimationFrame(state.rafId);
      }
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (Math.abs(state.nextWidth - state.startWidth) > 16) {
        logger.info('Saved cockpit workspace focus width', {
          action: this.action,
          width: state.nextWidth,
        });
        this.showToast('Workspace focus width saved', 'info');
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Apply the current preset/custom width to the chat panel element.
  applyChatPanelWidth(chatPanel) {
    if (this.customWidth !== null) {
      chatPanel.style.setProperty('width', `${this.customWidth}px`, 'important');
      return;
    }

    if (this.isWide) {
      chatPanel.style.setProperty('width', `${Math.max(520, window.innerWidth - 40)}px`, 'important');
      return;
    }

    chatPanel.style.setProperty('width', `${getStandardWorkspaceFocusWidth(window.innerWidth)}px`, 'important');
  }
}

// Derive the default standard-stage width for cockpit workspace focus.
function getStandardWorkspaceFocusWidth(viewportWidth) {
  const maxWidth = Math.max(840, viewportWidth - 120);
  const preferredWidth = Math.round(viewportWidth * 0.68);
  return Math.min(Math.max(840, preferredWidth), maxWidth);
}
