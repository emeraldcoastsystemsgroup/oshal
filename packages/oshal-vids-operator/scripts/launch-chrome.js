'use strict';
/**
 * @description Launch a Chrome with remote debugging on a DEDICATED profile.
 *
 * The operator signs into Google (and opens their Vids project) ONCE in this
 * window; the driver then attaches over CDP and drives that session — no
 * automation login wall. Uses a separate user-data-dir so it never disturbs the
 * operator's everyday Chrome profile.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.VIDS_CDP_PORT || 9222);
const PROFILE = process.env.VIDS_CHROME_PROFILE || path.join(os.homedir(), '.oshal-vids-chrome');

function findChrome() {
  if (process.env.VIDS_CHROME_PATH && fs.existsSync(process.env.VIDS_CHROME_PATH)) return process.env.VIDS_CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
      ]
    : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const chrome = findChrome();
if (!chrome) {
  console.error('Could not find Chrome. Set VIDS_CHROME_PATH to your chrome executable.');
  process.exit(1);
}

fs.mkdirSync(PROFILE, { recursive: true });
const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  'https://docs.google.com/videos',
];

console.log(`Launching Chrome (debug :${PORT}, profile ${PROFILE}).`);
console.log('Sign into Google and open your Vids project in this window, then run: npx oshal-vids');
const child = spawn(chrome, args, { stdio: 'ignore', detached: true });
child.unref();
