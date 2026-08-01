'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const test = require('node:test');
const { PairedTyper } = require('../src/desktop/paired-typer');

function fakeHost() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.commands = [];
  child.stdin = {
    writable: true,
    write(value) {
      child.commands.push(String(value).trim());
      return true;
    },
    end() {
      this.writable = false;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    },
  };
  child.kill = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
  };
  return child;
}

test('paired typer exposes progress without echoing prepared text', async () => {
  const host = fakeHost();
  const typer = new PairedTyper({ spawnProcess: () => host });
  const enable = typer.enable();
  host.stdout.write('READY\n');
  await enable;

  const states = [];
  typer.on('state', (state) => states.push(state));
  const typing = typer.type('private text');
  assert.match(host.commands.at(-1), /^TYPE [A-Za-z0-9+/=]+$/);
  assert.equal(host.commands.at(-1).includes('private text'), false);

  host.stdout.write('START 0 12\nPROGRESS 1 12\nPAUSED mouse_move\nRESUMED\nPROGRESS 12 12\nDONE\n');
  await typing;

  assert.equal(states.some((state) => state.status === 'paused' && state.reason === 'mouse_move'), true);
  assert.deepEqual(typer.snapshot(), {
    enabled: true,
    status: 'idle',
    completed: 0,
    total: 0,
    reason: null,
  });
  typer.disable();
});

test('cancel rejects an active type action and leaves the host reusable', async () => {
  const host = fakeHost();
  const typer = new PairedTyper({ spawnProcess: () => host });
  const enable = typer.enable();
  host.stdout.write('READY\n');
  await enable;

  const typing = typer.type('abc');
  typer.cancel('test');
  await assert.rejects(typing, { code: 'PAIRED_TYPING_CANCELLED' });
  assert.equal(host.commands.includes('CANCEL'), true);
  assert.equal(typer.snapshot().status, 'idle');
  typer.disable();
});
