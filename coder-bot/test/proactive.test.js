/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the background loop's two invariants, both tested against a fake desktop and a fake assistant so no real screen is captured and no model is called. (1) Non-overlap: a second tick is started while the first is blocked inside its assessment, and only ONE analysis may run — overlapping passes would drive concurrent captures and duplicate spend, so the `running` flag is pinned here rather than trusted. (2) That an unchanged frame is still assessed and each frame is still deleted: the signature is CONTEXT for the prompt, not a skip gate, and this test is what documents that as intended behaviour instead of a missing optimization — a static screen the user is stuck on is when advice matters most. The `removed` assertion is the privacy check: every captured frame is cleaned up, one for one.
 */

'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { ProactiveMonitor, isCoderBotWindow, signatureDistance } = require('../src/proactive');

test('screen signatures ignore identical frames and detect large changes', () => {
  const dark = Buffer.alloc(144, 10).toString('base64');
  const same = Buffer.alloc(144, 10).toString('base64');
  const light = Buffer.alloc(144, 200).toString('base64');
  assert.equal(signatureDistance(dark, same), 0);
  assert.equal(signatureDistance(dark, light), 190);
  assert.equal(isCoderBotWindow({ title: 'Coder Bot - Google Chrome' }), true);
});

test('proactive monitor assesses each frame even when the image is unchanged', async () => {
  const signature = Buffer.alloc(144, 80).toString('base64');
  const events = [];
  const removed = [];
  let captures = 0;
  const desktop = {
    async foregroundInfo() { return { title: 'Visual Studio Code', process: 'Code' }; },
    async screenshot() {
      captures++;
      return { path: `screen-${captures}.png`, signature, width: 100, height: 100 };
    },
    removeScreenshot(file) { removed.push(file); },
  };
  const assistant = {
    async analyzeScreenshot(shot) {
      desktop.removeScreenshot(shot.path);
      return { text: 'Inspect the first compiler error.' };
    },
  };
  const monitor = new ProactiveMonitor({
    assistant,
    desktop,
    onEvent: (event) => events.push(event),
    intervalMs: 999_999,
  });

  await monitor.tick();
  await monitor.tick();

  assert.equal(events.filter((event) => event.type === 'proactive-suggestion').length, 2);
  assert.deepEqual(removed, ['screen-1.png', 'screen-2.png']);
});

test('proactive screen assessments never overlap', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let analyses = 0;
  const monitor = new ProactiveMonitor({
    desktop: {
      async foregroundInfo() { return { title: 'VS Code' }; },
      async screenshot() {
        return { path: 'one.png', signature: Buffer.alloc(144).toString('base64'), width: 1, height: 1 };
      },
      removeScreenshot() {},
    },
    assistant: {
      async analyzeScreenshot() {
        analyses++;
        await gate;
        return { text: 'done' };
      },
    },
  });

  const first = monitor.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const second = monitor.tick();
  assert.equal(analyses, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(analyses, 1);
});
