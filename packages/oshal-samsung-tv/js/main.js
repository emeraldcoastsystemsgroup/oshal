/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: Samsung Tizen launcher shell. Reads/saves the OSHAL host (localStorage), registers the TV Return key, and navigates the TOP window to /api/home/ui?tv=1 so the dashboard's own D-pad spatial-nav + the Google OIDC login both run as a top-level page (not an iframe). Surface only (ADR-047).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Primary surface is now the full Jarvis TV experience (/api/jarvis/tv) — animated assistant, live conversation, scan-to-talk QR for the phone push-to-talk remote, spoken answers. Smart Home (/api/home/ui?tv=1) is the secondary button (ADR-068).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Room targeting: the launcher stores a Room name and opens Jarvis as /api/jarvis/tv?room=<room> so the phone push-to-talk remote can target THIS TV by room (no multi-TV echo). Editor now sets host + room (ADR-068).
 */
(function () {
  'use strict';

  /** Default host — matches the Fire TV / Roku default so the app works out of the box. */
  var DEFAULT_HOST = 'https://oshal.agenticfederal.us';
  var STORAGE_KEY = 'oshal_host';
  /** Primary surface = the full Jarvis TV experience (animated assistant, live conversation,
   *  scan-to-talk QR for the phone push-to-talk remote, spoken answers). */
  var JARVIS_PATH = '/api/jarvis/tv';
  /** Secondary surface = the Smart Home dashboard (?tv=1 enables its D-pad spatial nav). */
  var HOME_PATH = '/api/home/ui?tv=1';
  /** Room = how the phone targets THIS TV (only the chosen room shows + speaks the reply). */
  var ROOM_KEY = 'oshal_room';
  var DEFAULT_ROOM = 'Living Room';

  var $ = function (id) { return document.getElementById(id); };

  /** Read the saved host, falling back to the default. Trailing slash trimmed. */
  function getHost() {
    var v = '';
    try { v = (window.localStorage.getItem(STORAGE_KEY) || '').trim(); } catch (e) { v = ''; }
    return (v || DEFAULT_HOST).replace(/\/+$/, '');
  }

  /** Persist a host (best-effort; private-mode storage failures are non-fatal). */
  function setHost(value) {
    try { window.localStorage.setItem(STORAGE_KEY, value.trim().replace(/\/+$/, '')); } catch (e) { /* ignore */ }
  }

  /** Read the saved room label, falling back to the default. */
  function getRoom() {
    var v = '';
    try { v = (window.localStorage.getItem(ROOM_KEY) || '').trim(); } catch (e) { v = ''; }
    return v || DEFAULT_ROOM;
  }

  /** Persist the room label (best-effort). */
  function setRoom(value) {
    try { window.localStorage.setItem(ROOM_KEY, value.trim()); } catch (e) { /* ignore */ }
  }

  /** Navigate the TOP window to a surface path (top-level so OIDC + spatial-nav/voice work). */
  function open(path) {
    window.location.href = getHost() + path;
  }

  /** Open Jarvis scoped to this TV's room so the phone can target it. */
  function openJarvis() {
    open(JARVIS_PATH + '?room=' + encodeURIComponent(getRoom()));
  }

  /** Register the TV remote keys we care about (Return/back) when the Tizen API is present. */
  function registerKeys() {
    try {
      if (window.tizen && window.tizen.tvinputdevice) {
        window.tizen.tvinputdevice.registerKey('Return');
      }
    } catch (e) { /* not on a real TV (emulator/desktop) — arrow + Enter still work */ }
  }

  function showEditor(show) {
    $('editor').hidden = !show;
    $('hostRow').style.display = show ? 'none' : '';
    $('actions').style.display = show ? 'none' : '';
    if (show) { $('hostInput').value = getHost(); $('roomInput').value = getRoom(); $('hostInput').focus(); }
    else { $('jarvis').focus(); }
  }

  function wire() {
    $('hostText').textContent = getHost();
    $('roomText').textContent = getRoom();
    $('jarvis').addEventListener('click', openJarvis);
    $('home').addEventListener('click', function () { open(HOME_PATH); });
    $('change').addEventListener('click', function () { showEditor(true); });
    $('cancel').addEventListener('click', function () { showEditor(false); });
    $('save').addEventListener('click', function () {
      var h = $('hostInput').value.trim();
      if (h) setHost(h);
      var r = $('roomInput').value.trim();
      if (r) setRoom(r);
      $('hostText').textContent = getHost();
      $('roomText').textContent = getRoom();
      openJarvis();
    });

    // RETURN/back: close the editor if open, else let the platform exit the app.
    document.addEventListener('keydown', function (e) {
      var isBack = e.keyCode === 10009 /* Tizen RETURN */ || e.keyCode === 8 || e.key === 'GoBack';
      if (isBack && !$('editor').hidden) { showEditor(false); e.preventDefault(); }
    });

    $('jarvis').focus();
  }

  registerKeys();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
