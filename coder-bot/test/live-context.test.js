/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the de-duplication and version accounting of the microphone buffer, which together decide how much the always-listening mode costs. Adding the same utterance twice must advance the version ONCE — browser speech recognition re-emits a phrase as it firms up, and without this a single sentence would bill a model call per repetition. The rest pins that an assessment settles the pending flag and that fresh speech re-opens it, since that pair is the whole "assess once per new utterance, and never lose one" contract.
 */

'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { LiveContext } = require('../src/live-context');

test('live microphone context deduplicates text and tracks assessment versions', () => {
  const context = new LiveContext();
  context.add('I need to create a branch');
  context.add('I need to create a branch');
  assert.equal(context.version, 1);
  assert.equal(context.hasPending(), true);

  context.markAssessed(1, 'Use git switch -c.');
  assert.equal(context.hasPending(), false);
  assert.match(context.snapshot().insight, /git switch/);

  context.add('Then push it to origin');
  assert.equal(context.version, 2);
  assert.match(context.recentText(), /push it to origin/);
});
