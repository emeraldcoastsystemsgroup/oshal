/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the talk-to-build chat panel for Workflow Studio (ADR-039). Type or speak a description; it calls POST /api/workflow-studio/assist (the reason-only builder bot), then drives the canvas (window.workflowStudioApp.selectDefinition) so the graph redraws as you talk. Voice = Web Speech API + /api/voice (the static-page standard).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fire the surface dock from talk-to-build: the builder's reply now runs through the shared surface-bridge producer (relayReply) before display, so any oshal:surface fence the V3 persona emits posts its validated bot→surface ops to THIS studio's own dock and the fence is stripped from the bubble (no raw-fence leak). Producer runs in postTarget:'self' mode with an explicit app='workflow-studio' — the talk-to-build panel is co-resident with the surface-bridge-client in the SAME app-surface iframe, and the cockpit shell relay refuses a to_surface from a non-chat-rail frame, so the panel drives its own dock by posting to its own window. The workflow-graph canvas path is unchanged.
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import { createSurfaceProducer } from '/shared/ui/js/surface-bridge-producer.js';

const logger = createUiLogger('workflow-studio-chat');

/**
 * @description The talk-to-build chat panel: turns a spoken/typed description into a live canvas by
 * round-tripping the reason-only workflow-assistant bot and re-selecting the saved definition.
 */
class WorkflowStudioChat {
  constructor() {
    this.log = document.getElementById('wfChatLog');
    this.input = document.getElementById('wfChatInput');
    this.sendButton = document.getElementById('wfChatSend');
    this.micButton = document.getElementById('wfChatMic');
    this.status = document.getElementById('wfChatStatus');
    this.busy = false;
    this.recognition = null;
    this.recognizing = false;
    // Same-iframe surface-bridge producer: the talk-to-build panel and the surface-bridge-client
    // (workflow-studio-bridge.js) share this app-surface iframe, so bridge ops are posted to THIS
    // window (postTarget:'self') for the co-resident client to render — the shell relay only accepts
    // a to_surface from the chat rail. app is explicit because the surface knows its own identity.
    this.surfaceProducer = createSurfaceProducer({ win: window, postTarget: 'self', app: 'workflow-studio' });
  }

  /** @description Wire the panel's controls and seed a greeting. */
  init() {
    if (!this.input || !this.sendButton) return;
    this.sendButton.addEventListener('click', () => this.send());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    if (this.micButton) this.micButton.addEventListener('click', () => this.toggleMic());
    document.querySelectorAll('[data-wf-prompt]').forEach((button) => {
      button.addEventListener('click', () => {
        const prompt = button.getAttribute('data-wf-prompt') || '';
        this.input.value = prompt;
        this.input.focus();
      });
    });
    // Floating bot: click the icon to open the panel; minimize collapses back to the icon.
    const fab = document.getElementById('wfChatFab');
    const panel = document.getElementById('wfChatPanel');
    const minBtn = document.getElementById('wfChatMin');
    const openPanel = () => { if (panel) panel.hidden = false; if (fab) fab.hidden = true; setTimeout(() => this.input?.focus(), 30); };
    const closePanel = () => { if (panel) panel.hidden = true; if (fab) fab.hidden = false; };
    if (fab) fab.addEventListener('click', openPanel);
    if (minBtn) minBtn.addEventListener('click', closePanel);
    this.appendMessage('bot', 'Describe the workflow you want — e.g. "intake a support ticket, have the RCA bot draft a root-cause analysis, then an approval gate before delivery." I\'ll draw it as you talk.');
  }

  /** @description The studio app instance (bootstrapped by workflow-studio.js), or null if not ready. */
  app() {
    return window.workflowStudioApp ?? null;
  }

  /** @description The definition the canvas currently shows, so refinements edit it in place. */
  currentDefinitionId() {
    return this.app()?.state?.selectedDefinition?.id ?? null;
  }

  /**
   * @description Send the current description to the builder bot, then redraw the canvas from the
   * saved definition (or surface the bot's clarifying question).
   */
  async send() {
    const text = (this.input.value || '').trim();
    if (!text || this.busy) return;
    this.input.value = '';
    this.appendMessage('you', text);
    this.setBusy(true, 'Designing…');
    try {
      const payload = await this.postAssist(text);
      // relayReply posts any oshal:surface ops the builder emitted to this studio's own dock and
      // returns the fence-stripped text for the bubble (no raw-fence leak). The workflow-graph fence
      // was already stripped server-side; the canvas redraw below is unaffected.
      const message = this.surfaceProducer.relayReply(String(payload.message || '').trim()) || 'Updated the workflow.';
      this.appendMessage('bot', message);
      this.speak(message);
      if (!payload.needsInput && payload.definitionId && this.app()) {
        await this.app().selectDefinition(payload.definitionId);
      }
    } catch (error) {
      logger.error('Workflow assist failed', { error: serializeUiError(error) });
      this.appendMessage('error', `Couldn't build that: ${error?.message || error}`);
    } finally {
      this.setBusy(false, '');
    }
  }

  /**
   * @description POST the description + current definition id to the assist route.
   * @param {string} description - the operator's request this turn
   * @returns {Promise<object>} the assist response
   */
  async postAssist(description) {
    const response = await fetch('/api/workflow-studio/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, definitionId: this.currentDefinitionId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  /**
   * @description Append a message bubble to the chat log.
   * @param {'you'|'bot'|'error'} role - the speaker
   * @param {string} text - the message
   */
  appendMessage(role, text) {
    if (!this.log) return;
    const bubble = document.createElement('div');
    bubble.className = `wf-chat-msg wf-chat-${role}`;
    bubble.textContent = text;
    this.log.appendChild(bubble);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /**
   * @description Toggle busy state on the controls + status line.
   * @param {boolean} busy - whether a request is in flight
   * @param {string} status - status text to show
   */
  setBusy(busy, status) {
    this.busy = busy;
    if (this.sendButton) this.sendButton.disabled = busy;
    if (this.input) this.input.disabled = busy;
    if (this.status) this.status.textContent = status;
  }

  /** @description Start/stop dictation using the browser Web Speech API (the static-page standard). */
  toggleMic() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      this.appendMessage('error', 'Speech recognition is not available in this browser.');
      return;
    }
    if (this.recognizing && this.recognition) {
      this.recognition.stop();
      return;
    }
    this.recognition = new Recognition();
    this.recognition.interimResults = true;
    this.recognition.continuous = false;
    this.recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((r) => r[0].transcript).join('');
      this.input.value = transcript;
    };
    this.recognition.onend = () => this.setMic(false);
    this.recognition.onerror = () => this.setMic(false);
    this.recognition.start();
    this.setMic(true);
  }

  /**
   * @description Reflect mic state in the button.
   * @param {boolean} on - whether dictation is active
   */
  setMic(on) {
    this.recognizing = on;
    if (this.micButton) this.micButton.classList.toggle('recording', on);
  }

  /**
   * @description Speak the bot's reply. Prefer a server-synthesized voice; fall back to the browser.
   * @param {string} text - the text to speak
   */
  async speak(text) {
    const clip = String(text || '').slice(0, 600);
    if (!clip) return;
    try {
      const res = await fetch('/api/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clip }),
      });
      const body = await res.json().catch(() => ({}));
      // The voice route wraps its payload as { success, data: { providerId, audioData } }; tolerate
      // a flat shape too. gemini-tts returns WAV (RIFF) bytes, so play as audio/wav, not mpeg.
      const payload = body?.data ?? body;
      if (payload?.audioData && !payload.fallback) {
        await new Audio(`data:audio/wav;base64,${payload.audioData}`).play().catch(() => this.browserSpeak(clip));
        return;
      }
    } catch {
      /* fall through to the browser voice */
    }
    this.browserSpeak(clip);
  }

  /**
   * @description Browser SpeechSynthesis fallback.
   * @param {string} text - the text to speak
   */
  browserSpeak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

const chat = new WorkflowStudioChat();
chat.init();
