#!/usr/bin/env node
'use strict';
/**
 * @description npx entry for the Vids Operator.
 *
 *   npx oshal-vids            start the local control panel (default)
 *   npx oshal-vids chrome     launch a debug Chrome you sign into once
 *   npx oshal-vids worker     join the OSHAL swarm as a remote worker (P4)
 *   npx oshal-vids story      animate a story across ~10 Extend scenes -> content folder + Drive
 *   npx oshal-vids setup      (re)run dependency setup
 */
const cmd = (process.argv[2] || 'panel').toLowerCase();

function run(modPath, fn) {
  const mod = require(modPath);
  return fn ? mod[fn]() : mod;
}

switch (cmd) {
  case 'panel':
  case 'start':
    run('../src/server', 'start');
    break;
  case 'chrome':
    require('../scripts/launch-chrome');
    break;
  case 'setup':
    require('../scripts/setup');
    break;
  case 'story':
    require('../scripts/story-cli');
    break;
  case 'cycle':
    require('../scripts/cycle-cli');
    break;
  case 'worker':
    try {
      run('../src/worker/remote-client', 'startWorker');
    } catch {
      console.error('Swarm worker lands in P4. For now use: npx oshal-vids');
      process.exit(1);
    }
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(`Vids Operator
  npx oshal-vids          start the local control panel (http://localhost:${process.env.VIDS_PORT || 8074})
  npx oshal-vids chrome   launch a debug Chrome to sign into Google Vids once
  npx oshal-vids worker   join the OSHAL swarm as a remote worker
  npx oshal-vids story    animate a story across ~10 Extend scenes (--id <lib> | --next | --script <file>)
  npx oshal-vids cycle    keep making stories from the library (--every 30m --limit 3 --loop)
  npx oshal-vids setup    re-run dependency setup`);
    break;
  default:
    console.error(`Unknown command: ${cmd}. Try: npx oshal-vids help`);
    process.exit(1);
}
