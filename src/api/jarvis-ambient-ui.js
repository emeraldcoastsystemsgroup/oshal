/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Carved out of jarvis-ambient.js (over the 1000-code-line cap): the settings-panel HTML template, panel/form rendering, transcript viewer, modal focus/inert handling, and state copy now live here as AmbientClient prototype methods (JarvisAmbientUi.clientMethods, mixed in by jarvis-ambient.js). Pure decomposition — every method body is verbatim from the AmbientClient class; behavior is unchanged. Loads after jarvis-ambient-core.js and before jarvis-ambient.js.
 */

(function attachJarvisAmbientUi(root) {
  'use strict';

  /*
   * Presentation half of the ambient client: the under-orb control + settings
   * panel markup, form rendering/reading, transcript history viewer, and the
   * state-copy updates. These are AmbientClient methods (they run with `this`
   * bound to the client instance); jarvis-ambient.js Object.assigns them onto
   * AmbientClient.prototype, so the split is invisible at runtime.
   */

  const {
    STATE_COPY, defaultSettings, sanitizeName, normalizeSettings, todayLocal, trapFocus,
  } = root.JarvisAmbientCore;

  function htmlTemplate() {
    return `
      <div class="jarvis-ambient__bar" role="group" aria-label="Ambient listening controls">
        <button class="jarvis-ambient__state" type="button" data-ja-toggle aria-pressed="false" aria-label="Turn always listening on or off">
          <span class="jarvis-ambient__dot" aria-hidden="true"></span>
          <span><strong data-ja-state>Always listening: OFF</strong><small data-ja-detail>Tap to enable wake word and transcript memory</small></span>
        </button>
        <button class="jarvis-ambient__settings-button" type="button" data-ja-open aria-label="Ambient listening settings"><span aria-hidden="true">&#9881;</span><span class="jarvis-ambient__sr-only">Settings</span></button>
      </div>
      <div class="jarvis-ambient__backdrop" data-ja-backdrop hidden>
        <section class="jarvis-ambient__panel" role="dialog" aria-modal="true" aria-labelledby="ja-title">
          <header class="jarvis-ambient__header">
            <div><p class="jarvis-ambient__eyebrow">Private ambient awareness</p><h2 id="ja-title">Always ready, on your terms</h2></div>
            <button class="jarvis-ambient__close" type="button" data-ja-close aria-label="Close settings">&times;</button>
          </header>
          <div class="jarvis-ambient__privacy"><strong>Raw audio is never stored.</strong><span>When speaker recognition is enabled, short chunks are processed ephemerally by OSHAL's local engine. Chunks with no voice are discarded after OSHAL processing and are not sent to configured Google Cloud Speech-to-Text. If Google Cloud Speech-to-Text is configured, voiced chunks are sent there for timestamped transcription under Google Cloud's privacy terms. Browser speech recognition may separately be processed by your browser's speech service. Transcript text and the encrypted voice profiles you choose to remember are kept. When per-person insights are on, OSHAL also derives and keeps its own read of each consented voice — topics, tone, and follow-up asks — as deletable inferences beside the words actually said, never presented as fact; declining a heard person stops that and purges what was already inferred about them.</span></div>
          <form data-ja-form>
            <label class="jarvis-ambient__switch-row"><span><strong>Ambient listening</strong><small>Listen and save transcript text while this page is visible.</small></span><input type="checkbox" name="enabled" data-ja-enabled><i aria-hidden="true"></i></label>
            <div class="jarvis-ambient__grid">
              <label><span>Assistant name</span><input name="assistantName" maxlength="40" autocomplete="off" required></label>
              <label><span>Recognition language</span><select name="locale"><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="es-US">Spanish (US)</option><option value="fr-FR">French</option><option value="de-DE">German</option></select></label>
              <label class="jarvis-ambient__wide"><span>Wake phrases <small>one per line</small></span><textarea name="wakePhrases" rows="3" maxlength="500" required></textarea></label>
              <label><span>Keep transcript text</span><select name="retentionDays"><option value="1">Until tomorrow</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></label>
              <label><span>Daily review time</span><input name="dailyReviewTime" type="time"></label>
            </div>
            <label class="jarvis-ambient__check"><input type="checkbox" name="speakerDiarizationEnabled"><span>Separate speakers with the local voice engine</span></label>
            <label class="jarvis-ambient__check"><input type="checkbox" name="rememberSpeakers"><span>Remember encrypted voice profiles across conversations</span></label>
            <label class="jarvis-ambient__check"><input type="checkbox" name="dailyReviewEnabled"><span>Prepare an end-of-day transcript summary</span></label>
            <label class="jarvis-ambient__check"><input type="checkbox" name="suggestFollowUps"><span>Suggest reminders or follow-ups; always ask before creating them</span></label>
            <p class="jarvis-ambient__limitation" data-ja-limitation></p>
            <p class="jarvis-ambient__notice" data-ja-notice aria-live="polite"></p>
            <div class="jarvis-ambient__actions"><button type="button" class="jarvis-ambient__secondary" data-ja-close>Cancel</button><button type="submit" class="jarvis-ambient__primary">Save settings</button></div>
          </form>
          <div class="jarvis-ambient__speaker-tools">
            <div><strong>Voice &amp; Speakers</strong><small>Enroll your voice, name unidentified people, or assign a private organization member.</small></div>
            <button type="button" data-ja-speakers-open>Manage voices</button>
          </div>
          <div data-ja-speakers></div>
          <div class="jarvis-ambient__history">
            <div><strong>Transcript &amp; review</strong><small>Revisit what was said or ask for the action-item scan now.</small></div>
            <div class="jarvis-ambient__history-controls"><input type="date" data-ja-date><button type="button" data-ja-transcript>Read transcript</button><button type="button" data-ja-review>Review now</button></div>
            <div class="jarvis-ambient__transcript" data-ja-transcript-output hidden></div>
          </div>
          <footer><span data-ja-sync>Nothing waiting to sync</span><span>Listening pauses when this tab is hidden.</span></footer>
        </section>
      </div>`;
  }

  const clientMethods = {
    cacheElements() {
      const find = (selector) => this.element.querySelector(selector);
      this.ui = {
        state: find('[data-ja-state]'), detail: find('[data-ja-detail]'), toggle: find('[data-ja-toggle]'),
        backdrop: find('[data-ja-backdrop]'), form: find('[data-ja-form]'), enabled: find('[data-ja-enabled]'),
        notice: find('[data-ja-notice]'), limitation: find('[data-ja-limitation]'), sync: find('[data-ja-sync]'),
        date: find('[data-ja-date]'), transcriptOutput: find('[data-ja-transcript-output]'), speakers: find('[data-ja-speakers]'),
      };
      this.ui.date.value = todayLocal();
    },

    bindUi() {
      this.on(this.element.querySelector('[data-ja-open]'), 'click', () => this.openSettings());
      this.element.querySelectorAll('[data-ja-close]').forEach((node) => this.on(node, 'click', () => this.closeSettings()));
      this.on(this.ui.backdrop, 'click', (event) => { if (event.target === this.ui.backdrop) this.closeSettings(); });
      this.on(this.ui.toggle, 'click', () => void this.toggleEnabled());
      this.on(this.ui.form, 'submit', (event) => { event.preventDefault(); void this.saveForm(); });
      this.on(this.ui.form.elements.assistantName, 'change', () => this.refreshDefaultPhrases());
      this.on(this.ui.form.elements.speakerDiarizationEnabled, 'change', () => {
        const enabled = this.ui.form.elements.speakerDiarizationEnabled.checked;
        this.ui.form.elements.rememberSpeakers.disabled = !enabled || this.speakerPersistenceAvailable === false;
        if (!enabled || this.speakerPersistenceAvailable === false) this.ui.form.elements.rememberSpeakers.checked = false;
      });
      this.on(this.element.querySelector('[data-ja-transcript]'), 'click', () => void this.openTranscript());
      this.on(this.element.querySelector('[data-ja-review]'), 'click', () => void this.requestReview());
      this.on(this.element.querySelector('[data-ja-speakers-open]'), 'click', () => {
        this.emit('jarvis:speakers-open-requested', { settings: { ...this.settings } });
      });
    },

    openSettings() {
      this.settingsReturnFocus = document.activeElement;
      this.renderSettings();
      this.ui.backdrop.hidden = false;
      document.body.classList.add('jarvis-ambient-open');
      this.element.querySelector('[data-ja-close]').focus();
    },

    closeSettings() {
      if (this.ui.backdrop.hidden || this.speakerDialogOpen) return;
      this.ui.backdrop.hidden = true;
      document.body.classList.remove('jarvis-ambient-open');
      const target = this.settingsReturnFocus && document.contains(this.settingsReturnFocus)
        ? this.settingsReturnFocus : this.element.querySelector('[data-ja-open]');
      this.settingsReturnFocus = null;
      target?.focus?.();
    },

    renderSettings() {
      const fields = this.ui.form.elements;
      fields.enabled.checked = this.settings.enabled;
      fields.assistantName.value = this.settings.assistantName;
      fields.wakePhrases.value = this.settings.wakePhrases.join('\n');
      fields.locale.value = this.settings.locale;
      fields.retentionDays.value = String(this.settings.retentionDays);
      fields.dailyReviewEnabled.checked = this.settings.dailyReviewEnabled;
      fields.dailyReviewTime.value = this.settings.dailyReviewTime;
      fields.suggestFollowUps.checked = this.settings.suggestFollowUps;
      fields.speakerDiarizationEnabled.checked = this.settings.speakerDiarizationEnabled;
      fields.rememberSpeakers.checked = this.settings.rememberSpeakers;
      fields.rememberSpeakers.disabled = !this.settings.speakerDiarizationEnabled
        || this.speakerPersistenceAvailable === false;
      this.ui.enabled.disabled = !this.supported;
      this.renderLimitation();
      this.updateSyncCopy();
    },

    renderLimitation() {
      const framed = (() => { try { return root.self !== root.top; } catch (_error) { return true; } })();
      if (!this.supported) this.ui.limitation.textContent = 'This browser does not expose continuous speech recognition. Use current Chrome or Edge.';
      else if (framed) this.ui.limitation.textContent = 'Browsers may block continuous recognition inside an embedded panel. If permission fails, open Jarvis full-page.';
      else this.ui.limitation.textContent = 'Browser policy pauses recognition in hidden tabs and may occasionally restart the speech service.';
    },

    refreshDefaultPhrases() {
      const fields = this.ui.form.elements;
      const oldDefaults = defaultSettings(this.settings.assistantName).wakePhrases.join('\n').toLowerCase();
      if (String(fields.wakePhrases.value).trim().toLowerCase() !== oldDefaults) return;
      fields.wakePhrases.value = defaultSettings(fields.assistantName.value).wakePhrases.join('\n');
    },

    settingsFromForm() {
      const fields = this.ui.form.elements;
      const assistantName = sanitizeName(fields.assistantName.value);
      const oldDefaults = defaultSettings(this.settings.assistantName).wakePhrases.join('\n').toLowerCase();
      const enteredPhrases = String(fields.wakePhrases.value).trim();
      const wakePhrases = enteredPhrases.toLowerCase() === oldDefaults
        ? defaultSettings(assistantName).wakePhrases : enteredPhrases.split(/\r?\n/);
      return normalizeSettings({
        enabled: fields.enabled.checked,
        assistantName,
        wakePhrases,
        locale: fields.locale.value,
        retentionDays: Number(fields.retentionDays.value),
        dailyReviewEnabled: fields.dailyReviewEnabled.checked,
        dailyReviewTime: fields.dailyReviewTime.value,
        suggestFollowUps: fields.suggestFollowUps.checked,
        speakerDiarizationEnabled: fields.speakerDiarizationEnabled.checked,
        rememberSpeakers: fields.speakerDiarizationEnabled.checked && fields.rememberSpeakers.checked,
      }, this.settings);
    },

    async openTranscript() {
      const date = this.ui.date.value || todayLocal();
      const detail = { date, handled: false };
      const event = this.emit('jarvis:ambient-open-transcript', detail, true);
      if (event && event.defaultPrevented) return;
      this.showTranscriptMessage('Loading transcript…');
      try {
        const data = await this.fetchJson(`${this.apiBase}/days/${encodeURIComponent(date)}`);
        this.renderTranscript(data);
      } catch (error) {
        this.reportError(error, 'Could not load that transcript', false);
        this.showTranscriptMessage('The transcript could not be loaded.');
      }
    },

    renderTranscript(data) {
      const entries = Array.isArray(data) ? data : (data.segments || data.entries || data.items || []);
      this.ui.transcriptOutput.replaceChildren();
      this.ui.transcriptOutput.hidden = false;
      const summary = data.summary || (data.review && data.review.summary);
      if (summary) this.appendTranscriptLine('Daily summary', summary, true);
      for (const entry of entries.slice(0, 250)) {
        const stamp = entry.capturedAt || entry.createdAt || entry.timestamp;
        const time = stamp ? new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Transcript';
        const speaker = String(entry.speakerLabel || (entry.speaker && entry.speaker.label) || '').trim();
        const label = speaker ? `${speaker} · ${time}` : time;
        this.appendTranscriptLine(label, entry.text || entry.transcript || '', false);
      }
      if (!entries.length && !summary) this.showTranscriptMessage('No transcript text was saved for this date.');
    },

    appendTranscriptLine(label, text, summary) {
      const line = document.createElement('article');
      if (summary) line.className = 'jarvis-ambient__summary';
      const heading = document.createElement('strong'); heading.textContent = label;
      const copy = document.createElement('p'); copy.textContent = String(text || '');
      line.append(heading, copy); this.ui.transcriptOutput.appendChild(line);
    },

    showTranscriptMessage(message) {
      this.ui.transcriptOutput.hidden = false;
      this.ui.transcriptOutput.replaceChildren();
      const copy = document.createElement('p'); copy.textContent = message;
      this.ui.transcriptOutput.appendChild(copy);
    },

    async requestReview() {
      const date = this.ui.date.value || todayLocal();
      const event = this.emit('jarvis:ambient-review-requested', { date }, true);
      if (event && event.defaultPrevented) return;
      this.setNotice('Starting the transcript review…');
      try {
        const data = await this.fetchJson(`${this.apiBase}/days/${encodeURIComponent(date)}/review`, { method: 'POST' });
        this.setNotice(data.message || 'Review queued. Jarvis will surface suggestions when they are ready.');
      } catch (error) {
        this.reportError(error, 'Could not start the transcript review', false);
      }
    },

    setSpeakerDialogOpen(open) {
      this.speakerDialogOpen = Boolean(open);
      const panel = this.ui?.backdrop?.querySelector('.jarvis-ambient__panel');
      if (!panel) return;
      if (this.speakerDialogOpen) {
        panel.setAttribute('aria-hidden', 'true');
        panel.setAttribute('inert', '');
        panel.inert = true;
      } else {
        panel.removeAttribute('aria-hidden');
        panel.removeAttribute('inert');
        panel.inert = false;
        root.setTimeout(() => this.element.querySelector('[data-ja-speakers-open]')?.focus(), 0);
      }
    },

    handleSettingsKeydown(event) {
      if (!this.ui || this.ui.backdrop.hidden || this.speakerDialogOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeSettings();
        return;
      }
      if (event.key === 'Tab') trapFocus(event, this.ui.backdrop.querySelector('.jarvis-ambient__panel'));
    },

    setState(state, detail) {
      const copy = STATE_COPY[state] || STATE_COPY.error;
      const headline = state === 'armed' ? `${this.settings.assistantName} is awake` : copy[0];
      this.state = state;
      this.element.dataset.state = state;
      const canvasWrap = this.element.closest('.canvas-wrap');
      if (canvasWrap) canvasWrap.dataset.ambientState = state;
      this.ui.state.textContent = headline;
      this.ui.detail.textContent = detail || copy[1];
      this.ui.toggle.setAttribute('aria-pressed', String(this.settings.enabled));
      this.ui.toggle.setAttribute('aria-label', `${this.ui.state.textContent}. ${this.ui.detail.textContent}`);
      this.emit('jarvis:ambient-state-changed', {
        state, enabled: this.settings.enabled, assistantName: this.settings.assistantName,
        detail: this.ui.detail.textContent,
      });
    },

    updateSyncCopy() {
      if (!this.ui) return;
      if (this.pending.length) this.ui.sync.textContent = `${this.pending.length} segment${this.pending.length === 1 ? '' : 's'} waiting to sync`;
      else if (this.savedCount) this.ui.sync.textContent = `${this.savedCount} segment${this.savedCount === 1 ? '' : 's'} saved this session`;
      else this.ui.sync.textContent = 'Nothing waiting to sync';
    },

    setNotice(message) {
      this.ui.notice.textContent = message;
    },
  };

  /**
   * @description Presentation mixin for the ambient client: the settings-panel markup factory
   * plus the AmbientClient prototype methods that render the panel, transcript history, and
   * state copy. jarvis-ambient.js merges clientMethods onto AmbientClient.prototype at load.
   */
  root.JarvisAmbientUi = Object.freeze({ htmlTemplate, clientMethods: Object.freeze(clientMethods) });
}(typeof window !== 'undefined' ? window : globalThis));
