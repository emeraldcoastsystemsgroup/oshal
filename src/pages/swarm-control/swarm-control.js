/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial swarm control page logic — bot selector, chat, settings, propagate
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added enable/disable toggle for selected bot via PATCH /api/agents/:agentId/status
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added selected-bot telemetry rendering for model, token, request, and estimated-cost rollups
 */

(function swarmControlInit() {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────
  const botSelector = document.getElementById('botSelector');
  const toggleStatusBtn = document.getElementById('toggleStatusBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const propagateBtn = document.getElementById('propagateBtn');
  const propagateStatus = document.getElementById('propagateStatus');
  const propagateMessage = document.getElementById('propagateMessage');
  const chatMessages = document.getElementById('chatMessages');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const authBadge = document.getElementById('botAuthStatus');
  const telemetryBotName = document.getElementById('telemetryBotName');
  const telemetryUpdatedAt = document.getElementById('telemetryUpdatedAt');
  const telemetryStatus = document.getElementById('telemetryStatus');
  const telemetryModel = document.getElementById('telemetryModel');
  const telemetryTokens = document.getElementById('telemetryTokens');
  const telemetryCost = document.getElementById('telemetryCost');
  const telemetryRequests = document.getElementById('telemetryRequests');
  const telemetryModelChips = document.getElementById('telemetryModelChips');

  let bots = [];
  let activeBotPort = null;
  let activeBotName = null;
  let activeBotAgentId = null;
  let activeBotDbStatus = 'active';
  let taskId = crypto.randomUUID();

  // ── Bootstrap ─────────────────────────────────────────────────────────
  loadBotRegistry();

  botSelector.addEventListener('change', onBotSelected);
  toggleStatusBtn.addEventListener('click', onToggleStatusClicked);
  settingsBtn.addEventListener('click', onSettingsClicked);
  propagateBtn.addEventListener('click', onPropagateClicked);
  chatForm.addEventListener('submit', onChatSubmit);
  chatInput.addEventListener('keydown', function handleEnterKey(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // ── Bot registry ──────────────────────────────────────────────────────
  async function loadBotRegistry(preferredAgentId) {
    try {
      const response = await fetch('/api/swarm/bots/registry');
      const data = await response.json();
      bots = Array.isArray(data.bots) ? data.bots : (Array.isArray(data) ? data : []);

      botSelector.innerHTML = '<option value="" disabled selected>Select a bot...</option>';
      bots.forEach(function renderBotOption(bot) {
        const option = document.createElement('option');
        option.value = String(bot.port);
        option.textContent = bot.name + ' (:' + bot.port + ')';
        option.dataset.name = bot.name;
        option.dataset.agentId = bot.agentId || '';
        option.dataset.dbStatus = bot.dbStatus || 'active';
        option.dataset.container = bot.container || '';
        if (bot.dbStatus === 'inactive') {
          option.textContent += ' [DISABLED]';
        }
        botSelector.appendChild(option);
      });

      if (preferredAgentId) {
        const preferredOption = Array.from(botSelector.options).find((option) => option.dataset.agentId === preferredAgentId);
        if (preferredOption) {
          preferredOption.selected = true;
          applySelectedBot(preferredOption, false);
        }
      }
    } catch (error) {
      botSelector.innerHTML = '<option value="" disabled selected>Failed to load bots</option>';
    }
  }

  // ── Bot selection ─────────────────────────────────────────────────────
  function onBotSelected() {
    const selected = botSelector.selectedOptions[0];
    if (!selected || !selected.value) return;
    applySelectedBot(selected, true);
  }

  function applySelectedBot(selected, resetConversation) {
    activeBotPort = parseInt(selected.value, 10);
    activeBotName = selected.dataset.name || 'bot';
    activeBotAgentId = selected.dataset.agentId || null;
    activeBotDbStatus = selected.dataset.dbStatus || 'active';
    if (resetConversation) {
      taskId = crypto.randomUUID();
    }

    toggleStatusBtn.disabled = !activeBotAgentId;
    toggleStatusBtn.textContent = activeBotDbStatus === 'active' ? 'Disable Bot' : 'Enable Bot';
    settingsBtn.disabled = false;
    chatInput.disabled = false;
    sendBtn.disabled = false;

    if (resetConversation) {
      chatMessages.innerHTML = '<div class="chat-empty">Connected to <strong>' + escapeHtml(activeBotName) + '</strong> on port ' + activeBotPort + '. Start chatting.</div>';
    }
    renderTelemetrySummary(findActiveBotRecord());
    checkBotAuth();
  }

  // ── Auth status ───────────────────────────────────────────────────────
  async function checkBotAuth() {
    if (!activeBotPort) return;
    authBadge.textContent = '...';
    authBadge.className = 'auth-badge auth-unknown';

    try {
      const response = await fetch('http://localhost:' + activeBotPort + '/api/claude-code/auth/status');
      const data = await response.json();
      if (data.authenticated) {
        authBadge.textContent = 'Auth OK';
        authBadge.className = 'auth-badge auth-ok';
      } else {
        authBadge.textContent = 'Not signed in';
        authBadge.className = 'auth-badge auth-none';
      }
    } catch {
      authBadge.textContent = 'Unreachable';
      authBadge.className = 'auth-badge auth-none';
    }
  }

  // ── Toggle bot status ─────────────────────────────────────────────────
  async function onToggleStatusClicked() {
    if (!activeBotAgentId) return;
    var newStatus = activeBotDbStatus === 'active' ? 'inactive' : 'active';
    toggleStatusBtn.disabled = true;
    toggleStatusBtn.textContent = 'Updating...';

    try {
      var response = await fetch('/api/agents/' + activeBotAgentId + '/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      var data = await response.json();
      if (data.success) {
        activeBotDbStatus = newStatus;
        toggleStatusBtn.textContent = newStatus === 'active' ? 'Disable Bot' : 'Enable Bot';
        appendMessage('System', 'Bot ' + activeBotName + ' is now ' + newStatus, 'bot');
        await loadBotRegistry(activeBotAgentId);
      } else {
        appendMessage('System', 'Failed to toggle: ' + (data.error || 'unknown error'), 'bot');
      }
    } catch (error) {
      appendMessage('System', 'Toggle failed: ' + (error.message || String(error)), 'bot');
    } finally {
      toggleStatusBtn.disabled = false;
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────
  function onSettingsClicked() {
    if (!activeBotPort) return;
    window.open('http://localhost:' + activeBotPort + '/chat', 'bot-settings-' + activeBotPort, 'width=900,height=700');
  }

  // ── Propagate auth ────────────────────────────────────────────────────
  async function onPropagateClicked() {
    propagateStatus.style.display = '';
    propagateStatus.className = 'propagate-status status-working';
    propagateMessage.textContent = 'Propagating Claude Code auth to all bots...';
    propagateBtn.disabled = true;

    try {
      const response = await fetch('/api/swarm/config/propagate/claude-code-auth', { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        propagateStatus.className = 'propagate-status status-ok';
        propagateMessage.textContent = 'Propagated to ' + data.propagated + '/' + data.total + ' bots from ' + data.source + '.';
      } else if (data.propagated > 0) {
        propagateStatus.className = 'propagate-status status-partial';
        propagateMessage.textContent = 'Propagated to ' + data.propagated + '/' + data.total + ' bots. ' + data.failed + ' failed.';
      } else {
        propagateStatus.className = 'propagate-status status-error';
        propagateMessage.textContent = data.error || ('Failed: 0/' + data.total + ' bots received credentials.');
      }
    } catch (error) {
      propagateStatus.className = 'propagate-status status-error';
      propagateMessage.textContent = 'Propagation failed: ' + (error.message || String(error));
    } finally {
      propagateBtn.disabled = false;
      checkBotAuth();
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────
  async function onChatSubmit(event) {
    event.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !activeBotPort) return;

    appendMessage('You', text, 'user');
    chatInput.value = '';
    sendBtn.disabled = true;

    try {
      const response = await fetch('http://localhost:' + activeBotPort + '/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: taskId, text: text }),
      });
      const data = await response.json();
      if (data.response) {
        appendMessage(activeBotName, data.response, 'bot');
      } else if (data.success) {
        appendMessage(activeBotName, '(message accepted, taskId: ' + (data.taskId || taskId) + ')', 'bot');
      } else {
        appendMessage('System', 'Error: ' + (data.error || 'Unknown error'), 'bot');
      }
    } catch (error) {
      appendMessage('System', 'Failed to reach bot: ' + (error.message || String(error)), 'bot');
    } finally {
      await loadBotRegistry(activeBotAgentId);
      sendBtn.disabled = false;
      chatInput.focus();
    }
  }

  function findActiveBotRecord() {
    return bots.find(function matchBot(bot) {
      return (activeBotAgentId && bot.agentId === activeBotAgentId)
        || (activeBotPort && Number(bot.port) === Number(activeBotPort));
    }) || null;
  }

  function renderTelemetrySummary(bot) {
    const telemetry = bot && bot.telemetry ? bot.telemetry : {};
    const usageByModel = telemetry.usageByModel && typeof telemetry.usageByModel === 'object' ? telemetry.usageByModel : {};
    telemetryBotName.textContent = bot ? (bot.name || activeBotName || 'Selected bot') : 'Awaiting selection';
    telemetryUpdatedAt.textContent = telemetry.updatedAt
      ? ('Updated ' + new Date(telemetry.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))
      : 'No telemetry yet';
    telemetryStatus.textContent = bot ? ((bot.dbStatus || 'active') + (bot.online ? ' / online' : ' / offline')) : '—';
    telemetryModel.textContent = telemetry.latestModel || '—';
    telemetryTokens.textContent = formatNumber(telemetry.totalTokens);
    telemetryCost.textContent = formatCurrency(telemetry.totalCost);
    telemetryRequests.textContent = formatNumber(telemetry.totalRequests);
    telemetryModelChips.innerHTML = buildModelChips(usageByModel);
  }

  function buildModelChips(usageByModel) {
    const ranked = Object.entries(usageByModel)
      .sort(function sortByTokens(left, right) {
        return numberValue(right[1] && right[1].totalTokens) - numberValue(left[1] && left[1].totalTokens);
      })
      .slice(0, 4);
    if (!ranked.length) {
      return '<span class="model-chip">No model telemetry yet</span>';
    }
    return ranked.map(function renderChip(entry) {
      const modelId = entry[0];
      const stats = entry[1] || {};
      return '<span class="model-chip">' + escapeHtml(modelId)
        + ' · ' + escapeHtml(formatNumber(stats.totalTokens)) + ' tok'
        + ' · ' + escapeHtml(formatCurrency(stats.totalCost)) + '</span>';
    }).join('');
  }

  function formatCurrency(amount) {
    return '$' + numberValue(amount).toFixed(6);
  }

  function formatNumber(value) {
    return numberValue(value).toLocaleString();
  }

  function numberValue(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function appendMessage(sender, text, role) {
    const empty = chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = 'chat-msg ' + role;
    msg.innerHTML = '<div class="msg-sender">' + escapeHtml(sender) + '</div><div class="msg-body">' + escapeHtml(text) + '</div>';
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
