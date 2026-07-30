/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the two things in the assistant that must not regress silently. First, the deterministic Git answers: "pull down a repo and branch it" has to produce `git clone` + `git switch -c` and must not degrade into `git pull`, because that specific wrong answer sends a user into the wrong directory or an unexpected merge — the assertions also pin the absence of destructive commands. Second, and the reason this file exists at all: the control agent is handed a fake desktop whose `key` FAILS the test if it is ever called, then asked to press Enter. That proves the keystroke allowlist is enforced in code rather than merely requested in a prompt — a model can ask for Enter and still not get it, which is what stops a typed terminal command or a focused Submit from being committed. Uses node:test so the tool keeps zero dependencies.
 */

'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const {
  ControlAgent,
  formatGuide,
  normalizeGuide,
  quickGitAnswer,
  screenPrompt,
} = require('../src/assistant');

test('voice-style Git pull request returns cautious copyable commands', () => {
  const answer = quickGitAnswer('Okay, I need to pull from the Git repo');
  assert.match(answer, /git status/);
  assert.match(answer, /git pull --ff-only/);
  assert.doesNotMatch(answer, /git reset --hard/);
});

test('voice-style branch request returns switch and publish commands', () => {
  const answer = quickGitAnswer('I need to branch for this change');
  assert.match(answer, /git switch -c/);
  assert.match(answer, /git push -u origin/);
});

test('combined download-and-branch intent returns clone followed by branch creation', () => {
  const answer = quickGitAnswer('I need to pull down a directory from GitHub and branch it');
  assert.match(answer, /git clone <full-repository-url> <local-folder>/);
  assert.match(answer, /git switch -c <branch-name>/);
  assert.match(answer, /git pull --ff-only.*only after/s);
});

test('combined intent preserves a complete repository URL', () => {
  const answer = quickGitAnswer('Clone https://github.com/example/project.git and create a branch');
  assert.match(answer, /git clone https:\/\/github\.com\/example\/project\.git <local-folder>/);
});

test('screen guidance is normalized and formatted as text', () => {
  const guide = normalizeGuide({
    surface: 'VS Code',
    summary: 'A TypeScript error is visible.',
    steps: ['Read the first diagnostic.'],
    commands: ['npm test'],
    confidence: 2,
  });
  assert.equal(guide.confidence, 1);
  assert.match(formatGuide(guide), /```powershell[\s\S]*npm test/);
  assert.match(screenPrompt('Explain the error', { width: 100, height: 50 }), /UNTRUSTED/);
});

test('control agent blocks Enter even if a model requests it', async () => {
  const agent = new ControlAgent({
    desktop: { key: async () => assert.fail('unsafe key should not execute') },
  });
  await assert.rejects(
    agent.execute({ action: 'key', key: '{ENTER}' }, { originX: 0, originY: 0, width: 1, height: 1 }),
    /blocked unsafe key action/,
  );
});
