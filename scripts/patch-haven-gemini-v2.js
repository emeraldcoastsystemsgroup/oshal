#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | SEC-05 closure: retire compiled-runtime Haven patching because it bypassed the accounted provider boundary and could introduce raw credential reads.
 */

'use strict';

console.error(
  'Retired: Haven runtime patching is disabled. Configure an accounted hosted/BYO provider through OSHAL.',
);
process.exitCode = 73;
