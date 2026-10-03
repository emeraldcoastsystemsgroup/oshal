/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep this device's position current while an assistant page is open (ADR-169 L3 browser ingest), so Jarvis can answer "where am I" from the phone the person is holding. It reuses the browser device the person turned on in Settings, Location (the id that page stores in this browser) and adds no consent of its own: with no stored device, or a geolocation permission that is not already granted, it does nothing and never prompts. While the page is visible it posts at most one fix every 30 seconds to the same POST /api/location/presence the Settings page uses; the server keeps refusing unknown devices (404), devices with reporting off (409) and over-frequent posts (429), and a 401/403/404/409 stops this page's watch. It cannot report while the page is closed or hidden; that needs a device node (ADR-169 L9).
 */
(function attach(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object' && root.document && root.navigator) {
    root.OSHAL_LOCATION_REPORTER = api;
    api.start(api.browserEnv(root));
  }
})(typeof window !== 'undefined' ? window : globalThis, function build() {
  'use strict';
  /** The key Settings, Location stores this browser's opted-in device id under. */
  var DEVICE_KEY = 'oshal.location.browserDeviceId';
  var POST_EVERY_MS = 30000;
  var PRESENCE_URL = '/api/location/presence';
  /** Answers that mean this page should stop watching: signed out, refused, device gone, reporting off. */
  var STOP_STATUSES = [401, 403, 404, 409];

  /**
   * @description The browser objects the reporter uses, gathered in one place so tests can pass their own.
   * @param {Window} w The page's window.
   * @returns {object} storage, geolocation, permissions, fetch, document and clock.
   */
  function browserEnv(w) {
    var storage = null;
    try { storage = w.localStorage; } catch (e) { storage = null; /* blocked storage: there is no device id to read */ }
    return {
      storage: storage, geolocation: w.navigator.geolocation, permissions: w.navigator.permissions,
      fetch: w.fetch ? w.fetch.bind(w) : null, document: w.document, now: function () { return Date.now(); },
    };
  }

  /**
   * @description The device id Settings, Location stored for this browser, if any.
   * @param {object} env The environment.
   * @returns {string|null} The id.
   */
  function deviceId(env) {
    try { return env.storage ? env.storage.getItem(DEVICE_KEY) : null; } catch (e) { return null; /* private mode */ }
  }

  /**
   * @description One fix as the presence route expects it.
   * @param {string} id The device id.
   * @param {GeolocationPosition} pos The position.
   * @param {number} now The clock.
   * @returns {object} The body.
   */
  function fixBody(id, pos, now) {
    return { deviceId: id, lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy,
      observedAt: new Date(pos.timestamp || now).toISOString() };
  }

  /**
   * @description Watch this device's position and post it while the page is visible.
   * @param {object} env The environment.
   * @param {string} id The device id.
   * @returns {{stop: function(): void, isWatching: function(): boolean}} A handle.
   */
  function watch(env, id) {
    var last = 0, watchId = null;
    function stop() { if (watchId !== null) env.geolocation.clearWatch(watchId); watchId = null; }
    function onPosition(pos) {
      if (watchId === null || (env.document && env.document.hidden)) return;
      var now = env.now();
      if (now - last < POST_EVERY_MS) return;
      last = now;
      env.fetch(PRESENCE_URL, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(fixBody(id, pos, now)) })
        .then(function (res) { if (STOP_STATUSES.indexOf(res.status) !== -1) stop(); })
        .catch(function () { /* offline or server down: the next position tries again */ });
    }
    watchId = env.geolocation.watchPosition(onPosition, function () { /* a refused or failed read posts nothing */ },
      { enableHighAccuracy: false, maximumAge: 15000, timeout: 30000 });
    return { stop: stop, isWatching: function () { return watchId !== null; } };
  }

  /**
   * @description Start reporting if this browser was turned on in Settings, Location and already has
   * geolocation permission. Never prompts.
   * @param {object} env The environment.
   * @returns {Promise<object|null>} The watch handle, or null when it does not start.
   */
  function start(env) {
    var id = deviceId(env);
    if (!id || !env.geolocation || !env.permissions || !env.fetch) return Promise.resolve(null);
    return env.permissions.query({ name: 'geolocation' })
      .then(function (status) { return status && status.state === 'granted' ? watch(env, id) : null; })
      .catch(function () { return null; /* no Permissions API answer: do not risk a prompt */ });
  }

  return Object.freeze({ start: start, browserEnv: browserEnv, fixBody: fixBody, DEVICE_KEY: DEVICE_KEY, POST_EVERY_MS: POST_EVERY_MS });
});
