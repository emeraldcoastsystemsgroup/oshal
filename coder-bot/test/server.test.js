/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the HTTP surface's most important property by asserting the bound address is literally 127.0.0.1. These routes photograph the screen and move the mouse and are unauthenticated by design, which is only safe on loopback — a change to 0.0.0.0 would expose them to the network, so it must break a test rather than pass review. Also pins that the screenshot-intent classifier does not fire on an ordinary Git question (an unrequested screen capture is a privacy surprise) and that a real chat request reaches the deterministic Git path end to end through the server. Runs on an ephemeral port so it never collides with a live instance, and closes the server in `after` so the proactive monitor's timer cannot keep the test process alive.
 */

'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { isScreenshotRequest, start } = require('../src/server');

test('natural screenshot requests route to local screen capture', () => {
  assert.equal(isScreenshotRequest('Okay screenshot what do you see?'), true);
  assert.equal(isScreenshotRequest('You take a screen shot'), true);
  assert.equal(isScreenshotRequest('Explain how Git branches work'), false);
});

test('standalone server binds locally and exposes its state', async (t) => {
  const { server } = start({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');

  const state = await fetch(`http://127.0.0.1:${address.port}/api/state`).then((response) => response.json());
  assert.equal(state.localOnly, true);
  assert.equal(state.controlActive, false);
  assert.equal(state.proactive.enabled, true);

  const page = await fetch(`http://127.0.0.1:${address.port}/`).then((response) => response.text());
  assert.match(page, /Coder Bot/);

  const answer = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'I need to pull from my Git repo' }),
  }).then((response) => response.json());
  assert.match(answer.text, /git pull --ff-only/);
});
