/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the reusable Voice & Speakers profile manager with safe private/public capability states, enrollment and recording events, stable unidentified profiles, and accessible assignment lifecycle controls.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added truthful processing outcomes, explicit-recording and enrollment gates, verified organization identities, owner-private copy, and the 7 MiB browser cap.
 */

(function installJarvisSpeakers(global) {
  'use strict';

  const DEFAULT_API_BASE = '/api/jarvis/ambient';
  const MAX_AUDIO_BYTES = 7 * 1024 * 1024;
  const AUDIO_EXTENSIONS = ['wav', 'webm', 'ogg', 'mp3'];
  const AUDIO_ACCEPT = 'audio/wav,audio/x-wav,audio/webm,audio/ogg,audio/mpeg,.wav,.webm,.ogg,.mp3';

  function make(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function append(parent, ...children) {
    for (const child of children) if (child) parent.appendChild(child);
    return parent;
  }

  function button(label, className, action) {
    const node = make('button', className, label);
    node.type = 'button';
    if (action) node.dataset.action = action;
    return node;
  }

  function records(value) {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  }

  function textValue(...values) {
    const found = values.find((value) => typeof value === 'string' && value.trim());
    return found ? found.trim() : '';
  }

  function numberValue(...values) {
    const found = values.find((value) => Number.isFinite(Number(value)));
    return found === undefined ? 0 : Number(found);
  }

  function booleanValue(fallback, ...values) {
    const found = values.find((value) => typeof value === 'boolean');
    return found === undefined ? fallback : found;
  }

  function normalizeMember(value) {
    return {
      userSub: textValue(value.userSub, value.memberSub, value.user_sub),
      displayName: textValue(value.displayName, value.name, value.email, 'Tenant member'),
      identityAvailable: booleanValue(false, value.identityAvailable, value.identity_available),
      role: textValue(value.role, 'member'),
    };
  }

  function memberAssignable(member, currentUser) {
    if (!member.identityAvailable) return false;
    if (currentUser.userSub && member.userSub === currentUser.userSub) return false;
    return member.displayName.toLowerCase() !== 'you';
  }

  function normalizeOrganization(value) {
    return {
      tenantId: textValue(value.tenantId, value.tenant_id, value.id),
      name: textValue(value.name, value.displayName, 'Private organization'),
      kind: textValue(value.kind, 'org'),
    };
  }

  function normalizeCurrentUser(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      userSub: textValue(source.userSub, source.memberSub, source.sub),
      displayName: textValue(source.displayName, source.name, 'Me'),
      profileId: textValue(source.profileId, source.speakerProfileId) || null,
    };
  }

  function normalizeContext(payload) {
    const source = payload && typeof payload === 'object' ? (payload.context || payload) : {};
    const reason = textValue(source.reason, source.unavailableReason);
    const guest = booleanValue(reason === 'public_tenant', source.guest, source.isGuest);
    const profilesAvailable = booleanValue(reason !== 'public_tenant', source.voiceProfilesAvailable, source.persistenceAvailable);
    const directoryAvailable = booleanValue(false, source.tenantMemberAssignmentAvailable, source.available);
    const currentUser = normalizeCurrentUser(source.currentUser);
    const members = records(source.members).map(normalizeMember);
    return {
      voiceProfilesAvailable: profilesAvailable && !guest,
      guest,
      currentUser,
      tenantMemberAssignmentAvailable: profilesAvailable && !guest && directoryAvailable
        && members.some((member) => memberAssignable(member, currentUser)),
      selectedTenantId: textValue(source.selectedTenantId, source.tenantId) || null,
      organizations: records(source.organizations).map(normalizeOrganization),
      members,
      unavailableMemberCount: Math.max(0, Math.floor(numberValue(
        source.unavailableMemberCount, source.unavailable_member_count,
      ))),
      reason,
    };
  }

  function normalizeExcerpt(value) {
    if (typeof value === 'string') return { text: value, capturedAt: null };
    return {
      text: textValue(value.text, value.transcript, value.excerpt),
      capturedAt: textValue(value.capturedAt, value.timestamp) || null,
    };
  }

  function anonymousLabel(source, ordinal) {
    const supplied = textValue(source.displayLabel, source.label, source.stableLabel, source.speakerLabel);
    return supplied || `Unidentified Person ${ordinal || '?'}`;
  }

  function normalizeProfile(value) {
    const assignment = value.assignment && typeof value.assignment === 'object' ? value.assignment : {};
    const rawKind = textValue(value.labelKind, value.assignmentKind, assignment.kind, 'anonymous').replace('-', '_');
    const labelKind = rawKind === 'unassigned' ? 'anonymous' : rawKind;
    const ordinal = numberValue(value.anonymousOrdinal, value.ordinal);
    return {
      profileId: textValue(value.profileId, value.speakerProfileId, value.id),
      labelKind,
      displayLabel: labelKind === 'anonymous' ? anonymousLabel(value, ordinal) : textValue(value.displayLabel, value.label, value.customName, assignment.customName, value.name, anonymousLabel(value, ordinal)),
      anonymousOrdinal: ordinal,
      customName: textValue(value.customName, assignment.customName),
      tenantId: textValue(value.tenantId, assignment.tenantId) || null,
      linkedMemberSub: textValue(value.linkedMemberSub, value.memberSub, assignment.memberSub) || null,
      sampleCount: numberValue(value.sampleCount),
      segmentCount: numberValue(value.segmentCount, value.utteranceCount),
      firstSeenAt: textValue(value.firstSeenAt, value.firstHeardAt) || null,
      lastSeenAt: textValue(value.lastSeenAt, value.lastHeardAt) || null,
      status: textValue(value.status, 'active'),
      excerpts: (Array.isArray(value.excerpts || value.recentExcerpts) ? (value.excerpts || value.recentExcerpts) : [])
        .map(normalizeExcerpt).filter((item) => item.text),
    };
  }

  function normalizeProfiles(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return records(source.speakers || source.profiles || source.items)
      .map(normalizeProfile)
      .filter((profile) => profile.profileId && profile.status === 'active');
  }

  function formatMoment(value) {
    if (!value) return 'Not yet heard';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Recently heard';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function initials(value) {
    const parts = String(value || '?').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  }

  function safeContext() {
    return normalizeContext({ voiceProfilesAvailable: false, guest: true, reason: 'Speaker profiles are unavailable.' });
  }

  function unavailableCopy(reason) {
    if (reason === 'public_tenant') {
      return 'Guest and public sessions may process a recording, but cannot save names, assignments, or reusable voice profiles.';
    }
    return reason || 'Speaker profiles are unavailable. Recordings can still be processed without remembering identities.';
  }

  class SpeakerPanel {
    constructor(options) {
      this.options = options || {};
      this.apiBase = String(this.options.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
      const requestedTarget = this.options.mountTarget || this.options.container;
      this.mountTarget = typeof requestedTarget === 'string'
        ? (document.querySelector(requestedTarget) || document.body)
        : (requestedTarget || document.body);
      this.context = safeContext();
      this.profiles = [];
      this.settings = { ...(this.options.settings || {}) };
      this.listeners = [];
      this.element = null;
      this.actionLayer = null;
      this.actionReturnFocus = null;
      this.lastFocus = null;
      this.destroyed = false;
      this.lastOutcomeStatus = null;
    }

    /** @description Mount the hidden speaker manager without making network requests until opened. @returns {SpeakerPanel} This lifecycle controller. */
    mount() {
      if (this.element) return this;
      this.element = make('div', 'jarvis-speakers');
      this.element.hidden = true;
      this.buildShell();
      this.mountTarget.appendChild(this.element);
      this.bindEvents();
      this.render();
      return this;
    }

    buildShell() {
      const backdrop = make('div', 'jarvis-speakers__backdrop');
      backdrop.dataset.jsBackdrop = '';
      const panel = make('section', 'jarvis-speakers__panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-labelledby', 'jarvis-speakers-title');
      panel.tabIndex = -1;
      append(panel, this.buildHeader(), this.buildBody(), this.buildFooter());
      backdrop.appendChild(panel);
      this.element.appendChild(backdrop);
      this.ui = { backdrop, panel };
    }

    buildHeader() {
      const header = make('header', 'jarvis-speakers__header');
      const copy = make('div');
      const eyebrow = make('p', 'jarvis-speakers__eyebrow', 'Private voice awareness');
      const title = make('h2', '', 'Voice & Speakers');
      title.id = 'jarvis-speakers-title';
      const description = make('p', 'jarvis-speakers__subtitle', 'Review who Jarvis heard and decide which voice profiles should be remembered.');
      const close = button('×', 'jarvis-speakers__close', 'close');
      close.setAttribute('aria-label', 'Close Voice & Speakers');
      append(copy, eyebrow, title, description);
      return append(header, copy, close);
    }

    buildBody() {
      const body = make('div', 'jarvis-speakers__body');
      const status = make('p', 'jarvis-speakers__status');
      status.dataset.jsStatus = '';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const capability = make('section'); capability.dataset.jsCapability = '';
      const myVoice = make('section'); myVoice.dataset.jsMyVoice = '';
      const audioTools = make('section'); audioTools.dataset.jsAudioTools = '';
      const profiles = make('section'); profiles.dataset.jsProfiles = '';
      append(body, capability, myVoice, audioTools, profiles, status);
      this.bodyUi = { capability, myVoice, audioTools, profiles, status };
      return body;
    }

    buildFooter() {
      const footer = make('footer', 'jarvis-speakers__footer');
      append(footer,
        make('span', '', 'Voice matching organizes transcripts; it is not proof of identity.'),
        button('Done', 'jarvis-speakers__button jarvis-speakers__button--primary', 'close'));
      return footer;
    }

    bindEvents() {
      this.on(this.element, 'click', (event) => this.handleClick(event));
      this.on(this.element, 'change', (event) => this.handleChange(event));
      this.on(document, 'keydown', (event) => this.handleKeydown(event));
      this.on(document, 'jarvis:ambient-ready', (event) => this.handleSettings(event));
      this.on(document, 'jarvis:ambient-settings-changed', (event) => this.handleSettings(event));
      this.on(document, 'jarvis:speakers-refresh-requested', () => void this.refresh());
      this.on(document, 'jarvis:speakers-enrollment-started', () => this.setStatus('Recording your voice for 8 seconds…'));
      this.on(document, 'jarvis:speakers-recording-started', (event) => {
        const seconds = numberValue(event?.detail?.durationSeconds, 30);
        this.setStatus(`Recording for up to ${seconds} seconds…`);
      });
      this.on(document, 'jarvis:speakers-upload-started', () => {
        this.lastOutcomeStatus = null;
        this.setStatus('Processing the recording…');
      });
      this.on(document, 'jarvis:speakers-upload-completed', (event) => this.handleUploadCompleted(event));
      this.on(document, 'jarvis:speakers-upload-error', (event) => {
        this.setStatus(textValue(event?.detail?.message, 'The recording could not be processed.'), true);
      });
    }

    on(target, type, listener) {
      target.addEventListener(type, listener);
      this.listeners.push(() => target.removeEventListener(type, listener));
    }

    /** @description Open the accessible profile manager and refresh its server-derived capability state. @returns {Promise<SpeakerPanel>} This lifecycle controller after refresh. */
    async open() {
      if (!this.element) this.mount();
      this.lastFocus = document.activeElement;
      this.element.hidden = false;
      document.body.classList.add('jarvis-speakers-open');
      this.ui.panel.focus?.();
      this.emit('jarvis:speakers-opened', {});
      await this.refresh();
      if (!this.destroyed && !this.element.hidden) this.element.querySelector('[data-action="close"]')?.focus();
      return this;
    }

    /** @description Close dialogs, restore prior focus, and leave the mounted manager ready to reopen. @returns {void} */
    close() {
      if (!this.element || this.element.hidden) return;
      this.closeActionLayer();
      this.element.hidden = true;
      document.body.classList.remove('jarvis-speakers-open');
      if (this.lastFocus && typeof this.lastFocus.focus === 'function') this.lastFocus.focus();
      this.emit('jarvis:speakers-closed', {});
    }

    /** @description Refresh speaker context and profiles independently so a partial outage fails closed. @returns {Promise<void>} */
    async refresh() {
      if (this.destroyed) return;
      this.setStatus('Refreshing voice profiles…');
      const requests = await Promise.allSettled([
        this.fetchJson(`${this.apiBase}/speaker-context`),
        this.fetchJson(`${this.apiBase}/speakers`),
      ]);
      this.context = requests[0].status === 'fulfilled' ? normalizeContext(requests[0].value) : safeContext();
      this.profiles = requests[1].status === 'fulfilled' ? normalizeProfiles(requests[1].value) : [];
      this.render();
      const failures = requests.filter((result) => result.status === 'rejected').length;
      if (failures) this.setStatus('Some voice-profile information is temporarily unavailable.', true);
      else if (this.lastOutcomeStatus) this.setStatus(this.lastOutcomeStatus.message, this.lastOutcomeStatus.error);
      else this.setStatus('Voice profiles are up to date.');
      this.emit('jarvis:speakers-refreshed', { context: this.context, speakers: this.profiles.slice() });
    }

    render() {
      if (!this.bodyUi) return;
      this.renderCapability();
      this.renderMyVoice();
      this.renderAudioTools();
      this.renderProfiles();
    }

    renderCapability() {
      const host = this.bodyUi.capability;
      host.replaceChildren();
      host.className = `jarvis-speakers__disclosure ${this.context.voiceProfilesAvailable ? 'is-private' : 'is-limited'}`;
      const title = this.context.voiceProfilesAvailable ? 'Speaker profiles are private and available' : 'Profiles are not remembered in this session';
      const detail = this.capabilityDetail();
      append(host, make('strong', '', title), make('p', '', detail));
      const state = make('div', 'jarvis-speakers__state-row');
      append(state, this.statePill('Identification', this.settings.speakerDiarizationEnabled), this.statePill('Remember voices', this.settings.rememberSpeakers));
      host.appendChild(state);
      const organizationPicker = this.buildOrganizationPicker();
      if (organizationPicker) host.appendChild(organizationPicker);
    }

    capabilityDetail() {
      if (!this.context.voiceProfilesAvailable) {
        return unavailableCopy(this.context.reason);
      }
      if (!this.context.tenantMemberAssignmentAvailable) {
        if (this.context.unavailableMemberCount > 0 || this.context.members.some((member) => !member.identityAvailable)) {
          return 'Voice profiles stay private to you. An organization member needs to sign in before their name is available for assignment; private custom names still work now.';
        }
        return 'Voice profiles are saved for you. Organization-directory assignment is unavailable in the current scope; custom names remain private.';
      }
      const organization = this.context.organizations.find((item) => item.tenantId === this.context.selectedTenantId);
      return `Voice profiles stay private to you. You may use the ${organization?.name || 'private organization'} directory to label a voice; the organization does not own or share your profile.`;
    }

    statePill(label, enabled) {
      const known = typeof enabled === 'boolean';
      const state = known ? (enabled ? 'On' : 'Off') : 'Managed in listening settings';
      const pill = make('span', `jarvis-speakers__pill ${enabled ? 'is-on' : ''}`);
      append(pill, make('b', '', label), document.createTextNode(` · ${state}`));
      return pill;
    }

    buildOrganizationPicker() {
      if (!this.context.voiceProfilesAvailable || this.context.organizations.length < 2) return null;
      const wrapper = make('label', 'jarvis-speakers__organization-picker');
      wrapper.appendChild(make('span', '', 'Organization directory'));
      const select = make('select'); select.dataset.jsOrganization = '';
      const placeholder = make('option', '', 'Choose an organization'); placeholder.value = '';
      select.appendChild(placeholder);
      for (const organization of this.context.organizations) {
        const option = make('option', '', organization.name); option.value = organization.tenantId;
        select.appendChild(option);
      }
      select.value = this.context.selectedTenantId || '';
      wrapper.appendChild(select);
      return wrapper;
    }

    renderMyVoice() {
      const host = this.bodyUi.myVoice;
      host.replaceChildren(); host.className = 'jarvis-speakers__card jarvis-speakers__my-voice';
      const profile = this.myVoiceProfile();
      const copy = make('div', 'jarvis-speakers__card-copy');
      append(copy, make('span', 'jarvis-speakers__kicker', 'My Voice'), make('h3', '', this.context.currentUser.displayName));
      const description = profile
        ? `Enrolled · last refreshed ${formatMoment(profile.lastSeenAt)}`
        : 'Not enrolled. A short guided recording lets Jarvis recognize you in later transcripts.';
      copy.appendChild(make('p', '', description));
      const action = button(profile ? 'Refresh my voice' : 'Enroll my voice', 'jarvis-speakers__button jarvis-speakers__button--primary', 'enroll');
      const enrollmentBlock = this.enrollmentBlockMessage();
      action.disabled = Boolean(enrollmentBlock);
      if (action.disabled) action.title = enrollmentBlock;
      append(host, make('div', 'jarvis-speakers__avatar', initials(this.context.currentUser.displayName)), copy, action);
      if (enrollmentBlock) host.appendChild(make('p', 'jarvis-speakers__prerequisite', enrollmentBlock));
    }

    myVoiceProfile() {
      const id = this.context.currentUser.profileId;
      return this.profiles.find((profile) => profile.labelKind === 'self' || (id && profile.profileId === id)) || null;
    }

    enrollmentBlockMessage() {
      if (!this.context.voiceProfilesAvailable) return 'Voice enrollment is unavailable in guest and public sessions.';
      if (!this.settings.rememberSpeakers) {
        return 'Turn on “Remember encrypted voice profiles” in listening settings before enrolling.';
      }
      return '';
    }

    renderAudioTools() {
      const host = this.bodyUi.audioTools;
      host.replaceChildren(); host.className = 'jarvis-speakers__card jarvis-speakers__audio-tools';
      const copy = make('div', 'jarvis-speakers__card-copy');
      append(copy, make('span', 'jarvis-speakers__kicker', 'One recording, separated by speaker'), make('h3', '', 'Process a conversation'));
      copy.appendChild(make('p', '', 'Record once or import a recording as an explicit request. The local engine separates speakers. If Google Cloud Speech-to-Text is configured, the recording may be sent there for timestamped transcription. Raw audio is never kept.'));
      const controls = make('div', 'jarvis-speakers__audio-controls');
      controls.appendChild(button('Record 30 seconds', 'jarvis-speakers__button', 'capture'));
      controls.appendChild(this.buildFileControl());
      append(host, copy, controls);
    }

    buildFileControl() {
      const wrapper = make('div', 'jarvis-speakers__file-control');
      const label = make('label', 'jarvis-speakers__file-label', 'Import recording');
      label.setAttribute('for', 'jarvis-speakers-file');
      const input = make('input'); input.type = 'file'; input.id = 'jarvis-speakers-file';
      input.accept = AUDIO_ACCEPT; input.dataset.jsFile = '';
      input.setAttribute('aria-describedby', 'jarvis-speakers-file-help');
      const help = make('small', '', 'WAV, WebM, OGG, or MP3. Maximum 55 seconds and 7 MiB. Imported audio is processed ephemerally and never kept; it may be sent to configured Google Cloud Speech-to-Text.');
      help.id = 'jarvis-speakers-file-help';
      append(label, input); append(wrapper, label, help);
      return wrapper;
    }

    renderProfiles() {
      const host = this.bodyUi.profiles;
      host.replaceChildren(); host.className = 'jarvis-speakers__profiles';
      const unidentified = this.profiles.filter((profile) => profile.labelKind === 'anonymous');
      const known = this.profiles.filter((profile) => profile.labelKind !== 'anonymous');
      host.appendChild(this.buildProfileGroup('Needs review', 'Stable labels remain attached each time that voice returns.', unidentified, 'No unidentified voices need review.'));
      host.appendChild(this.buildProfileGroup('Known speakers', 'Assignments can be changed without deleting transcript text.', known, 'No voices have been assigned yet.'));
    }

    buildProfileGroup(title, description, profiles, emptyCopy) {
      const section = make('section', 'jarvis-speakers__profile-group');
      const heading = make('div', 'jarvis-speakers__section-heading');
      const titleNode = make('h3', '', title); titleNode.appendChild(make('span', '', String(profiles.length)));
      append(heading, titleNode, make('p', '', description)); section.appendChild(heading);
      const list = make('div', 'jarvis-speakers__profile-list');
      if (!profiles.length) list.appendChild(make('p', 'jarvis-speakers__empty', emptyCopy));
      for (const profile of profiles) list.appendChild(this.buildProfileCard(profile));
      section.appendChild(list); return section;
    }

    buildProfileCard(profile) {
      const card = make('article', 'jarvis-speakers__profile-card');
      card.dataset.profileId = profile.profileId;
      const top = make('div', 'jarvis-speakers__profile-top');
      const copy = make('div', 'jarvis-speakers__profile-copy');
      append(copy, make('h4', '', profile.displayLabel), this.buildProfileMeta(profile));
      append(top, make('div', 'jarvis-speakers__avatar jarvis-speakers__avatar--small', initials(profile.displayLabel)), copy, this.kindBadge(profile));
      append(card, top, this.buildExcerpts(profile));
      if (this.context.voiceProfilesAvailable) card.appendChild(this.buildProfileActions(profile));
      else card.appendChild(make('p', 'jarvis-speakers__read-only', 'Profile changes are unavailable in this session.'));
      return card;
    }

    buildProfileMeta(profile) {
      const meta = make('p', 'jarvis-speakers__meta');
      const count = profile.segmentCount > 0
        ? `${profile.segmentCount} segment${profile.segmentCount === 1 ? '' : 's'}`
        : `${profile.sampleCount} voice sample${profile.sampleCount === 1 ? '' : 's'}`;
      meta.textContent = `${count} · Last heard ${formatMoment(profile.lastSeenAt)}`;
      return meta;
    }

    kindBadge(profile) {
      const labels = { anonymous: 'Unidentified', self: 'Me', custom: 'Private name', tenant_member: 'Organization member' };
      return make('span', `jarvis-speakers__badge is-${profile.labelKind}`, labels[profile.labelKind] || 'Assigned');
    }

    buildExcerpts(profile) {
      const block = make('div', 'jarvis-speakers__excerpts');
      block.appendChild(make('p', 'jarvis-speakers__no-audio', 'No audio playback · identify this voice from transcript context.'));
      if (!profile.excerpts.length) {
        block.appendChild(make('blockquote', '', 'No retained transcript excerpt is available.'));
        return block;
      }
      for (const excerpt of profile.excerpts.slice(0, 3)) {
        const quote = make('blockquote', '', excerpt.text);
        if (excerpt.capturedAt) quote.appendChild(make('cite', '', formatMoment(excerpt.capturedAt)));
        block.appendChild(quote);
      }
      return block;
    }

    buildProfileActions(profile) {
      const actions = make('div', 'jarvis-speakers__profile-actions');
      actions.appendChild(button(profile.labelKind === 'anonymous' ? 'Assign' : 'Change assignment', 'jarvis-speakers__button jarvis-speakers__button--primary', 'assign'));
      const merge = button('Merge', 'jarvis-speakers__button', 'merge');
      merge.disabled = this.profiles.length < 2; actions.appendChild(merge);
      if (profile.labelKind !== 'anonymous') actions.appendChild(button('Unassign', 'jarvis-speakers__button', 'unassign'));
      actions.appendChild(button('Forget voice', 'jarvis-speakers__button jarvis-speakers__button--danger', 'forget'));
      return actions;
    }

    handleClick(event) {
      if (event.target === this.ui.backdrop) { this.close(); return; }
      if (event.target === this.actionLayer) { this.closeActionLayer(); return; }
      const actionNode = event.target.closest?.('[data-action]');
      if (!actionNode || !this.element.contains(actionNode)) return;
      const action = actionNode.dataset.action;
      if (action === 'close') { this.close(); return; }
      if (action === 'action-close') { this.closeActionLayer(); return; }
      if (action === 'enroll') { this.requestEnrollment(); return; }
      if (action === 'capture') { this.emit('jarvis:speakers-capture-requested', { purpose: 'recording_capture' }); return; }
      const profile = this.profileFromAction(actionNode);
      if (profile) this.handleProfileAction(action, profile);
    }

    profileFromAction(node) {
      const card = node.closest('[data-profile-id]');
      return this.profiles.find((profile) => profile.profileId === card?.dataset.profileId) || null;
    }

    handleProfileAction(action, profile) {
      if (action === 'assign') this.openAssignment(profile);
      else if (action === 'merge') this.openMerge(profile);
      else if (action === 'unassign') this.openConfirmation(profile, 'unassign');
      else if (action === 'forget') this.openConfirmation(profile, 'forget');
    }

    handleChange(event) {
      const input = event.target;
      if (input.matches?.('[data-js-file]')) this.handleFile(input);
      if (input.matches?.('[data-js-organization]')) void this.selectOrganization(input.value);
      if (input.name === 'assignment-kind') this.syncAssignmentFields(input.form);
    }

    async selectOrganization(tenantId) {
      if (!tenantId || !this.context.organizations.some((item) => item.tenantId === tenantId)) return;
      this.setStatus('Loading the organization directory...');
      const previousSettings = { ...this.settings };
      const previousContext = this.context;
      try {
        const payload = await this.fetchJson(`${this.apiBase}/speaker-context?tenantId=${encodeURIComponent(tenantId)}`);
        this.context = normalizeContext(payload);
        this.settings = { ...this.settings, speakerTenantId: tenantId };
        this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
        const saved = await this.fetchJson(`${this.apiBase}/settings`, {
          method: 'PUT', body: { speakerTenantId: tenantId },
        });
        const settings = saved.settings && typeof saved.settings === 'object' ? saved.settings : {};
        this.settings = { ...this.settings, ...settings, speakerTenantId: tenantId };
        this.render();
        this.setStatus('Organization directory selected.');
        this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
      } catch (error) {
        this.settings = previousSettings;
        this.context = previousContext;
        this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
        this.render();
        this.setStatus(error instanceof Error ? error.message : 'The organization directory could not be loaded.', true);
      }
    }

    handleFile(input) {
      const file = input.files?.[0];
      if (!file) return;
      const error = validateAudioFile(file);
      if (error) this.setStatus(error, true);
      else {
        this.setStatus(`Ready to process ${file.name}.`);
        this.emit('jarvis:speakers-file-selected', { file, purpose: 'recording_import' });
      }
      input.value = '';
    }

    handleSettings(event) {
      const detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
      const settings = detail.settings && typeof detail.settings === 'object' ? detail.settings : detail;
      this.settings = { ...this.settings, ...settings };
      this.renderCapability();
      this.renderMyVoice();
    }

    handleUploadCompleted(event) {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      const result = detail.result && typeof detail.result === 'object' ? detail.result : {};
      if (detail.purpose === 'ambient' && this.element?.hidden) return;
      if (detail.purpose === 'self_enrollment') {
        this.setOutcomeStatus('Your private voice profile was enrolled.');
        return;
      }
      const segments = records(result.segments);
      const processing = result.processing && typeof result.processing === 'object' ? result.processing : {};
      const attributed = segments.some((segment) => {
        const label = textValue(segment.speakerLabel, segment.speaker?.label);
        return Boolean(segment.speakerProfileId || (label && !/unavailable/i.test(label)));
      });
      if (attributed && processing.diarization !== 'unavailable') {
        this.setOutcomeStatus('Recording processed with speaker-attributed transcript text.');
      } else if (segments.length || numberValue(result.accepted) + numberValue(result.duplicates) > 0) {
        this.setOutcomeStatus('Transcript text was saved, but speaker attribution was unavailable.', true);
      } else if (detail.transcriptOutcome === 'fallback_required' && detail.genericFallbackAvailable) {
        this.setOutcomeStatus('No attributed transcript was returned. Any browser-recognized text will be saved without speaker names.', true);
      } else if (processing.transcription === 'unavailable') {
        this.setOutcomeStatus('No transcript was returned. Configure a timestamp-capable speech service or try a supported recording format.', true);
      } else {
        this.setOutcomeStatus('No speech was detected, so no transcript text was saved.');
      }
    }

    setOutcomeStatus(message, error) {
      this.lastOutcomeStatus = { message, error: Boolean(error) };
      this.setStatus(message, error);
    }

    requestEnrollment() {
      const blocked = this.enrollmentBlockMessage();
      if (blocked) { this.setStatus(blocked, true); return; }
      this.emit('jarvis:speakers-enroll-requested', { purpose: 'self_enrollment' });
    }

    openAssignment(profile) {
      const form = make('form', 'jarvis-speakers__action-form');
      const choices = make('fieldset'); choices.appendChild(make('legend', '', 'Who is this?'));
      const selected = this.assignmentSelection(profile);
      choices.appendChild(this.radioChoice('self', `Me — ${this.context.currentUser.displayName}`, selected === 'self'));
      choices.appendChild(this.radioChoice('custom', 'A private name', selected === 'custom'));
      if (this.context.tenantMemberAssignmentAvailable) choices.appendChild(this.radioChoice('tenant_member', 'A private-organization member', selected === 'tenant_member'));
      append(form, choices, this.customNameField(profile), this.memberField(profile), this.actionButtons('Save assignment'));
      form.addEventListener('submit', (event) => { event.preventDefault(); void this.saveAssignment(profile, form); });
      this.openActionLayer(`Assign ${profile.displayLabel}`, 'Names organize your private transcripts and do not verify identity. Changes update the label shown on retained history.', form);
      this.syncAssignmentFields(form);
    }

    assignmentSelection(profile) {
      if (['self', 'custom', 'tenant_member'].includes(profile.labelKind)) return profile.labelKind;
      return 'self';
    }

    radioChoice(value, label, checked) {
      const row = make('label', 'jarvis-speakers__radio');
      const input = make('input'); input.type = 'radio'; input.name = 'assignment-kind'; input.value = value; input.checked = checked;
      append(row, input, make('span', '', label)); return row;
    }

    customNameField(profile) {
      const label = make('label', 'jarvis-speakers__field'); label.dataset.assignmentField = 'custom';
      append(label, make('span', '', 'Name'));
      const input = make('input'); input.name = 'customName'; input.maxLength = 80; input.autocomplete = 'off'; input.value = profile.customName || (profile.labelKind === 'custom' ? profile.displayLabel : '');
      label.appendChild(input); return label;
    }

    memberField(profile) {
      const label = make('label', 'jarvis-speakers__field'); label.dataset.assignmentField = 'tenant_member';
      append(label, make('span', '', 'Organization member'));
      const select = make('select'); select.name = 'memberSub';
      const assignable = this.context.members.filter((member) => memberAssignable(member, this.context.currentUser));
      for (const member of assignable) {
        const option = make('option', '', `${member.displayName} · ${member.role}`);
        option.value = member.userSub; option.selected = member.userSub === profile.linkedMemberSub; select.appendChild(option);
      }
      label.appendChild(select);
      const unavailable = Math.max(
        this.context.unavailableMemberCount,
        this.context.members.filter((member) => !member.identityAvailable).length,
      );
      if (unavailable) {
        const noun = unavailable === 1 ? 'member needs' : 'members need';
        label.appendChild(make('small', 'jarvis-speakers__identity-note', `${unavailable} organization ${noun} to sign in before their name is available.`));
      }
      return label;
    }

    actionButtons(primaryLabel) {
      const actions = make('div', 'jarvis-speakers__action-buttons');
      const cancel = button('Cancel', 'jarvis-speakers__button', 'action-close');
      const submit = make('button', 'jarvis-speakers__button jarvis-speakers__button--primary', primaryLabel); submit.type = 'submit';
      return append(actions, cancel, submit);
    }

    syncAssignmentFields(form) {
      if (!form) return;
      const selected = form.elements['assignment-kind']?.value || 'self';
      for (const field of form.querySelectorAll('[data-assignment-field]')) {
        const active = field.dataset.assignmentField === selected;
        field.hidden = !active;
        for (const input of field.querySelectorAll('input,select')) input.disabled = !active;
      }
    }

    async saveAssignment(profile, form) {
      const data = new FormData(form);
      const kind = String(data.get('assignment-kind') || 'self');
      const body = this.assignmentBody(kind, data);
      if (!body) return;
      await this.mutate(`${this.apiBase}/speakers/${encodeURIComponent(profile.profileId)}/assignment`, { method: 'PUT', body }, 'Assignment saved.');
    }

    assignmentBody(kind, data) {
      if (kind === 'self') return { kind: 'self' };
      if (kind === 'custom') {
        const displayName = String(data.get('customName') || '').trim();
        if (!displayName) { this.setActionNotice('Enter a name before saving.', true); return null; }
        return { kind: 'custom', customName: displayName };
      }
      const memberSub = String(data.get('memberSub') || '');
      const member = this.context.members.find((item) => item.userSub === memberSub);
      if (!memberSub || !this.context.selectedTenantId || !memberAssignable(member || {}, this.context.currentUser)) {
        this.setActionNotice('Choose an organization member whose verified name is available before saving.', true); return null;
      }
      return { kind: 'tenant_member', tenantId: this.context.selectedTenantId, memberSub };
    }

    openMerge(profile) {
      const form = make('form', 'jarvis-speakers__action-form');
      const label = make('label', 'jarvis-speakers__field'); append(label, make('span', '', 'Merge into'));
      const select = make('select'); select.name = 'targetProfileId';
      for (const target of this.profiles.filter((item) => item.profileId !== profile.profileId)) {
        const option = make('option', '', target.displayLabel); option.value = target.profileId; select.appendChild(option);
      }
      label.appendChild(select); append(form, label, make('p', 'jarvis-speakers__warning', 'The target label wins and retained transcript segments move to it.'), this.actionButtons('Merge voices'));
      form.addEventListener('submit', (event) => { event.preventDefault(); void this.mergeProfile(profile, select.value); });
      this.openActionLayer(`Merge ${profile.displayLabel}`, 'Use this only when two cards are the same real speaker.', form);
    }

    async mergeProfile(profile, targetProfileId) {
      if (!targetProfileId) { this.setActionNotice('Choose a target voice.', true); return; }
      await this.mutate(`${this.apiBase}/speakers/${encodeURIComponent(targetProfileId)}/merge`, { method: 'POST', body: { sourceProfileId: profile.profileId } }, 'Voice profiles merged.');
    }

    openConfirmation(profile, mode) {
      const wrapper = make('div', 'jarvis-speakers__confirmation');
      const forget = mode === 'forget';
      const copy = forget
        ? 'This removes the remembered voice profile. Transcript text remains, but future speech will not match this profile.'
        : 'This removes the name while preserving the stable unidentified voice profile and transcript text.';
      const actions = make('div', 'jarvis-speakers__action-buttons');
      const cancel = button('Cancel', 'jarvis-speakers__button', 'action-close');
      const confirm = button(forget ? 'Forget voice' : 'Unassign', `jarvis-speakers__button ${forget ? 'jarvis-speakers__button--danger' : 'jarvis-speakers__button--primary'}`);
      confirm.addEventListener('click', () => void (forget ? this.forgetProfile(profile) : this.unassignProfile(profile)));
      append(actions, cancel, confirm); append(wrapper, make('p', '', copy), actions);
      this.openActionLayer(forget ? `Forget ${profile.displayLabel}?` : `Unassign ${profile.displayLabel}?`, 'Review the effect before continuing.', wrapper);
    }

    async unassignProfile(profile) {
      await this.mutate(`${this.apiBase}/speakers/${encodeURIComponent(profile.profileId)}/assignment`, { method: 'PUT', body: { kind: 'unassigned' } }, 'Voice name removed.');
    }

    async forgetProfile(profile) {
      await this.mutate(`${this.apiBase}/speakers/${encodeURIComponent(profile.profileId)}`, { method: 'DELETE' }, 'Voice profile forgotten.');
    }

    openActionLayer(title, description, content) {
      const returnFocus = document.activeElement;
      this.closeActionLayer();
      const layer = make('div', 'jarvis-speakers__action-backdrop');
      const dialog = make('section', 'jarvis-speakers__action-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      const titleNode = make('h3', '', title); titleNode.id = 'jarvis-speakers-action-title'; dialog.setAttribute('aria-labelledby', titleNode.id);
      const close = button('×', 'jarvis-speakers__close', 'action-close'); close.setAttribute('aria-label', 'Close action dialog');
      const header = make('header'); append(header, titleNode, close);
      const notice = make('p', 'jarvis-speakers__action-notice', description); notice.dataset.jsActionNotice = '';
      append(dialog, header, notice, content); layer.appendChild(dialog); this.element.appendChild(layer);
      this.actionLayer = layer; this.actionReturnFocus = returnFocus;
      this.ui.panel.setAttribute('aria-hidden', 'true');
      this.ui.panel.inert = true;
      dialog.querySelector('input,select,button')?.focus();
    }

    closeActionLayer() {
      const returnFocus = this.actionReturnFocus;
      if (this.actionLayer) this.actionLayer.remove();
      this.actionLayer = null; this.actionReturnFocus = null;
      if (this.ui?.panel) {
        this.ui.panel.inert = false;
        this.ui.panel.removeAttribute('aria-hidden');
      }
      if (returnFocus && document.contains(returnFocus) && typeof returnFocus.focus === 'function') returnFocus.focus();
    }

    setActionNotice(message, error) {
      const notice = this.actionLayer?.querySelector('[data-js-action-notice]');
      if (!notice) return;
      notice.textContent = message; notice.classList.toggle('is-error', Boolean(error));
    }

    async mutate(url, options, successMessage) {
      this.setActionNotice('Saving…');
      try {
        await this.fetchJson(url, options);
        this.closeActionLayer(); this.setStatus(successMessage);
        await this.refresh(); this.emit('jarvis:speakers-changed', {});
      } catch (error) {
        this.setActionNotice(error instanceof Error ? error.message : 'The speaker profile could not be updated.', true);
        this.emit('jarvis:speakers-error', { error });
      }
    }

    async fetchJson(url, options) {
      const config = options || {};
      const headers = { Accept: 'application/json', ...(config.headers || {}) };
      if (config.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await global.fetch(url, {
        method: config.method || 'GET', credentials: 'include', headers,
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(textValue(detail.message, detail.error, `Request failed (${response.status})`));
      }
      return response.status === 204 ? {} : response.json();
    }

    setStatus(message, error) {
      if (!this.bodyUi?.status) return;
      this.bodyUi.status.textContent = message || '';
      this.bodyUi.status.classList.toggle('is-error', Boolean(error));
    }

    emit(type, detail) {
      const event = new CustomEvent(type, { bubbles: true, cancelable: true, detail });
      document.dispatchEvent(event); return event;
    }

    handleKeydown(event) {
      if (!this.element || this.element.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); this.actionLayer ? this.closeActionLayer() : this.close(); return; }
      if (event.key === 'Tab') trapFocus(event, this.actionLayer?.querySelector('[role="dialog"]') || this.ui.panel);
    }

    /** @description Remove all DOM and document listeners owned by this instance. @returns {void} */
    destroy() {
      this.close(); this.destroyed = true;
      for (const remove of this.listeners.splice(0)) remove();
      this.element?.remove(); this.element = null;
    }
  }

  function validateAudioFile(file) {
    if (file.size > MAX_AUDIO_BYTES) return 'Choose a recording no larger than 7 MiB.';
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    const validMime = /^audio\/(wav|x-wav|webm|ogg|mpeg|mp3)$/i.test(file.type || '');
    if (!validMime && !AUDIO_EXTENSIONS.includes(extension)) return 'Choose a WAV, WebM, OGG, or MP3 recording.';
    return '';
  }

  function trapFocus(event, container) {
    if (!container) return;
    const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusable = [...container.querySelectorAll(selector)].filter((node) => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  let activePanel = null;

  /** @description Mount one reusable Voice & Speakers manager. @param {object} options Mount target, API base, and current ambient settings. @returns {SpeakerPanel} Lifecycle controller. */
  function mount(options) {
    if (activePanel) activePanel.destroy();
    activePanel = new SpeakerPanel(options).mount();
    return activePanel;
  }

  /** @description Destroy the active Voice & Speakers manager. @returns {void} */
  function unmount() {
    activePanel?.destroy(); activePanel = null;
  }

  /** @description Open the active manager, mounting a default instance when needed. @returns {Promise<SpeakerPanel>} Active manager after refresh. */
  function open() {
    if (!activePanel) activePanel = new SpeakerPanel({}).mount();
    return activePanel.open();
  }

  /** @description Refresh the active manager without changing its visible state. @returns {Promise<void>} Refresh completion. */
  function refresh() {
    return activePanel ? activePanel.refresh() : Promise.resolve();
  }

  /** @description Return the active manager for integration lifecycle calls. @returns {SpeakerPanel|null} Active manager. */
  function getInstance() {
    return activePanel;
  }

  global.JarvisSpeakers = Object.freeze({ mount, open, refresh, unmount, getInstance });
})(window);
