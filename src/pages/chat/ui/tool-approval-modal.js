/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool approval modal
 */

/**
 * @description Tool Approval Modal — SSE-driven approval UI for tools with auth_mode='ask'.
 * Listens for approval request events from the server, displays a modal with tool details,
 * and sends the user's approval/denial decision back to the server.
 *
 * Usage: Include this script in a chat HTML page. It auto-initializes on DOMContentLoaded.
 */
const ToolApprovalModal = (function () {
  'use strict';

  /** @description SSE event types to listen for */
  const EVENTS = {
    REQUEST: 'tool:approval:request',
    RESPONSE: 'tool:approval:response',
    TIMEOUT: 'tool:approval:timeout',
  };

  /** @description API endpoint for submitting approval decisions */
  const APPROVAL_API = '/api/tools/approval';

  /** @description Active approval state */
  let activeRequest = null;
  let countdownInterval = null;
  let modalElement = null;

  /**
   * @description Initializes the modal — injects HTML, binds events, listens for SSE.
   */
  function init() {
    injectModalHTML();
    bindEventListeners();
    listenForSSEEvents();
    console.log('[ToolApprovalModal] Initialized');
  }

  /**
   * @description Injects the modal HTML into the page body.
   */
  function injectModalHTML() {
    const container = document.createElement('div');
    container.innerHTML = buildModalTemplate();
    document.body.appendChild(container.firstElementChild);
    modalElement = document.getElementById('tool-approval-overlay');
  }

  /**
   * @description Builds the modal HTML template string.
   * @returns The modal HTML string
   */
  function buildModalTemplate() {
    return `
      <div id="tool-approval-overlay" class="tool-approval-overlay" style="display:none">
        <div class="tool-approval-modal">
          <div class="tool-approval-modal__header">
            <h3 class="tool-approval-modal__title">⚡ Tool Approval Required</h3>
            <div class="tool-approval-modal__countdown" id="approval-countdown"></div>
          </div>
          <div class="tool-approval-modal__body">
            <div class="tool-approval-modal__info">
              <div class="tool-approval-modal__field">
                <span class="tool-approval-modal__label">Tool</span>
                <span class="tool-approval-modal__value" id="approval-tool-name"></span>
              </div>
              <div class="tool-approval-modal__field">
                <span class="tool-approval-modal__label">Description</span>
                <span class="tool-approval-modal__value" id="approval-tool-desc"></span>
              </div>
              <div class="tool-approval-modal__field">
                <span class="tool-approval-modal__label">Category</span>
                <span class="tool-approval-modal__value" id="approval-tool-category"></span>
              </div>
            </div>
            <div class="tool-approval-modal__input-section">
              <span class="tool-approval-modal__label">Input Arguments</span>
              <pre class="tool-approval-modal__input-json" id="approval-tool-input"></pre>
            </div>
          </div>
          <div class="tool-approval-modal__footer">
            <button class="tool-approval-btn tool-approval-btn--deny" id="approval-deny-btn">
              ✕ Deny
            </button>
            <button class="tool-approval-btn tool-approval-btn--approve" id="approval-approve-btn">
              ✓ Approve
            </button>
          </div>
        </div>
      </div>`;
  }

  /**
   * @description Binds click handlers for approve/deny buttons.
   */
  function bindEventListeners() {
    document.getElementById('approval-approve-btn')
      .addEventListener('click', function () { handleDecision(true); });
    document.getElementById('approval-deny-btn')
      .addEventListener('click', function () { handleDecision(false); });
  }

  /**
   * @description Hooks into the existing SSE EventSource on the page.
   * Looks for a global `eventSource` or creates a listener on the page's stream.
   */
  function listenForSSEEvents() {
    document.addEventListener('sse:tool:approval:request', function (e) {
      showApproval(e.detail);
    });

    document.addEventListener('sse:tool:approval:timeout', function (e) {
      if (activeRequest && activeRequest.requestId === e.detail.requestId) {
        hideModal();
        showNotification('Tool approval timed out', 'warning');
      }
    });

    document.addEventListener('sse:tool:approval:response', function (e) {
      if (activeRequest && activeRequest.requestId === e.detail.requestId) {
        hideModal();
      }
    });
  }

  /**
   * @description Shows the approval modal with the request details.
   * @param request - The approval request data from SSE
   */
  function showApproval(request) {
    activeRequest = request;

    document.getElementById('approval-tool-name').textContent =
      request.context?.displayName || request.toolName;
    document.getElementById('approval-tool-desc').textContent =
      request.context?.description || 'No description available';
    document.getElementById('approval-tool-category').textContent =
      request.context?.category || 'Unknown';
    document.getElementById('approval-tool-input').textContent =
      JSON.stringify(request.toolInput, null, 2);

    startCountdown(request.timeoutMs);
    modalElement.style.display = 'flex';
  }

  /**
   * @description Starts the countdown timer display.
   * @param timeoutMs - Total timeout in milliseconds
   */
  function startCountdown(timeoutMs) {
    clearInterval(countdownInterval);
    let remaining = Math.ceil(timeoutMs / 1000);
    var el = document.getElementById('approval-countdown');

    updateCountdownDisplay(el, remaining);

    countdownInterval = setInterval(function () {
      remaining--;
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        hideModal();
        return;
      }
      updateCountdownDisplay(el, remaining);
    }, 1000);
  }

  /**
   * @description Updates the countdown display element.
   * @param el - The countdown DOM element
   * @param seconds - Remaining seconds
   */
  function updateCountdownDisplay(el, seconds) {
    el.textContent = seconds + 's';
    el.style.color = seconds <= 10 ? 'var(--accent-red, #f44747)' : 'var(--text-secondary, #858585)';
  }

  /**
   * @description Handles the user's approval or denial decision.
   * @param approved - Whether the user approved the tool execution
   */
  function handleDecision(approved) {
    if (!activeRequest) {
      return;
    }

    var requestId = activeRequest.requestId;
    hideModal();

    submitDecision(requestId, approved);
  }

  /**
   * @description Submits the approval decision to the server.
   * @param requestId - The approval request ID
   * @param approved - Whether the execution is approved
   */
  function submitDecision(requestId, approved) {
    var body = JSON.stringify({
      requestId: requestId,
      approved: approved,
      decidedBy: 'user',
    });

    fetch(APPROVAL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('Approval submission failed: ' + res.status);
        }
        var status = approved ? 'approved' : 'denied';
        showNotification('Tool ' + status, approved ? 'success' : 'info');
      })
      .catch(function (err) {
        console.error('[ToolApprovalModal] Error submitting decision:', err);
        showNotification('Failed to submit approval decision', 'error');
      });
  }

  /**
   * @description Hides the modal and clears active state.
   */
  function hideModal() {
    clearInterval(countdownInterval);
    activeRequest = null;
    if (modalElement) {
      modalElement.style.display = 'none';
    }
  }

  /**
   * @description Shows a brief notification toast (if Shared.toast exists).
   * @param message - Notification message
   * @param type - Notification type (success, error, warning, info)
   */
  function showNotification(message, type) {
    if (typeof Shared !== 'undefined' && Shared.toast) {
      Shared.toast(message, type);
    } else {
      console.log('[ToolApprovalModal] ' + type + ': ' + message);
    }
  }

  // Public API
  return {
    init: init,
    showApproval: showApproval,
    hideModal: hideModal,
  };
})();

// Auto-initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ToolApprovalModal.init);
} else {
  ToolApprovalModal.init();
}