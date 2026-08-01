'use strict';

/**
 * Persistent bridge to the Windows low-level input host.
 *
 * Paired typing never logs or echoes prepared text. Only character counts and
 * state changes cross the observable status channel.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const HOST_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'paired-typing-host.ps1');

class PairedTypingCancelledError extends Error {
  constructor(reason = 'cancelled') {
    super(`paired typing cancelled: ${reason}`);
    this.name = 'PairedTypingCancelledError';
    this.code = 'PAIRED_TYPING_CANCELLED';
  }
}

class PairedTyper extends EventEmitter {
  constructor({ hostPath = HOST_PATH, spawnProcess = spawn } = {}) {
    super();
    this.hostPath = hostPath;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.hostReady = false;
    this.startPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = null;
    this.state = { enabled: false, status: 'off', completed: 0, total: 0, reason: null };
  }

  snapshot() {
    return { ...this.state };
  }

  publish(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.snapshot());
  }

  async enable() {
    if (process.platform !== 'win32') throw new Error('paired typing currently requires Windows');
    if (this.child && this.state.enabled) return this.snapshot();
    try {
      await this.start();
    } catch (error) {
      this.publish({ enabled: false, status: 'error', reason: error.message, completed: 0, total: 0 });
      throw error;
    }
    this.publish({ enabled: true, status: 'idle', completed: 0, total: 0, reason: null });
    return this.snapshot();
  }

  disable() {
    if (this.pending) this.send('CANCEL');
    this.publish({ enabled: false, status: 'off', completed: 0, total: 0, reason: null });
    this.stop();
    return this.snapshot();
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.publish({ status: 'starting', reason: null });
    this.startPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const child = this.spawnProcess('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.hostPath,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2_000);
      });
      readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
      child.on('error', (error) => this.handleExit(error));
      child.on('close', (code) => {
        const detail = stderr.trim();
        this.handleExit(new Error(`paired typing host exited ${code}${detail ? `: ${detail}` : ''}`));
      });
    });
    return this.startPromise;
  }

  async type(text) {
    if (!this.state.enabled) throw new Error('paired typing is not enabled');
    if (this.pending) throw new Error('paired typing is already handling text');
    if (!this.hostReady) await this.start();
    const value = String(text ?? '');
    if (!value) return;

    const result = new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: null };
      const timeoutMs = Number(process.env.VIDS_PAIRED_TYPE_TIMEOUT_MS || 0);
      if (timeoutMs > 0) {
        this.pending.timer = setTimeout(() => this.cancel('timeout'), timeoutMs);
      }
    });
    this.send(`TYPE ${Buffer.from(value, 'utf8').toString('base64')}`);
    return result;
  }

  pause() {
    if (this.pending) this.send('PAUSE');
  }

  resume() {
    if (this.pending) this.send('RESUME');
  }

  cancel(reason = 'operator') {
    if (!this.pending) return;
    this.send('CANCEL');
    this.rejectPending(new PairedTypingCancelledError(reason));
    this.publish({ status: this.state.enabled ? 'idle' : 'off', reason, completed: 0, total: 0 });
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error('paired typing host is unavailable');
    this.child.stdin.write(`${command}\n`);
  }

  handleLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line) return;
    const [event, first, second] = line.split(/\s+/, 3);
    if (event === 'READY') {
      this.hostReady = true;
      if (this.readyResolve) this.readyResolve();
      this.readyResolve = null;
      this.readyReject = null;
    } else if (event === 'START') {
      this.publish({ status: 'typing', completed: Number(first) || 0, total: Number(second) || 0, reason: null });
    } else if (event === 'PROGRESS') {
      this.publish({ status: 'typing', completed: Number(first) || 0, total: Number(second) || 0 });
    } else if (event === 'PAUSED') {
      this.publish({ status: 'paused', reason: first || 'operator' });
    } else if (event === 'RESUMED') {
      this.publish({ status: 'typing', reason: null });
    } else if (event === 'DONE') {
      this.resolvePending();
      this.publish({ status: this.state.enabled ? 'idle' : 'off', completed: 0, total: 0, reason: null });
    } else if (event === 'CANCELLED') {
      this.rejectPending(new PairedTypingCancelledError(first || 'operator'));
      this.publish({ status: this.state.enabled ? 'idle' : 'off', completed: 0, total: 0, reason: first || 'operator' });
    } else if (event === 'ERROR') {
      this.handleExit(new Error(`paired typing host error: ${line.slice(6)}`));
    }
  }

  resolvePending() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve();
  }

  rejectPending(error) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }

  handleExit(error) {
    const wasStopping = !this.child;
    this.child = null;
    this.hostReady = false;
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    this.startPromise = null;
    if (reject) reject(error);
    this.rejectPending(error);
    if (!wasStopping && this.state.enabled) {
      this.publish({ enabled: false, status: 'error', reason: error.message, completed: 0, total: 0 });
    }
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.hostReady = false;
    this.startPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    if (!child) return;
    try {
      if (child.stdin.writable) child.stdin.write('QUIT\n');
      child.stdin.end();
    } catch {
      child.kill();
    }
  }
}

const pairedTyper = new PairedTyper();
process.once('exit', () => pairedTyper.stop());

module.exports = { PairedTyper, PairedTypingCancelledError, pairedTyper };
