#!/usr/bin/env node
/*
 * RETIRED TWILIO CLI
 *
 * Per-user Twilio credentials are intentionally usable only by schema-bounded controller
 * operations. A generic CLI would make the credential available to child environments,
 * workspaces, argv-driven verbs, and model-selected tools, so this compatibility entry point
 * now fails closed before reading configuration, connector storage, or network state.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Initial phone/text compatibility CLI for the communications worker.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Removed the historical hard-coded key fallback.
 * 3   | maintainer@emeraldcoastsystemsgroup.com     | Preserved the exact scoped caller identity during its supported lifetime.
 * 4   | maintainer@emeraldcoastsystemsgroup.com     | SEC-05 closure: retire the generic credential carrier; fixed controller operations now own authorized per-user Twilio sends.
 */
'use strict';

console.error(
  'oshal-twilio is retired: use an authenticated, fixed controller Twilio operation. Nothing was sent.',
);
process.exitCode = 73;
