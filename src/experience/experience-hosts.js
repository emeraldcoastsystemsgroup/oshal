/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Select package-declared exact member surfaces from the existing caller-filtered profile without a second navigation policy.
 */
(function (target) {
  'use strict';
  function admits(host, item) {
    if (!Array.isArray(host.surfaces)) return true;
    const name = item.toolUi?.visibilityToolName || String(item.id || '').replace(/^tool-/, '');
    return host.surfaces.includes(name);
  }
  target.OSHAL_EXPERIENCE_HOSTS = { admits };
})(typeof window === 'undefined' ? globalThis : window);
