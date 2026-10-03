/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Stand-in agy executable for the Antigravity image-turn guards (tests/unit/storyboard-antigravity-image-turn.spec.ts). It runs as a REAL child process under the wrapper's real argv, cwd and env (private HOME included), records what it was handed to FAKE_AGY_OBSERVE_FILE, and replays the stream-json shape of the 2026-10-02 headless proof (agy 1.2.8): a generate_image tool step ACTIVE then DONE, the image written as <HOME>/.gemini/antigravity-cli/brain/<conversation>/storyboard_frame_<epoch-ms>.jpg, the step output "Generated image is saved at <path>" under .system_generated/steps/<n>/output.txt, and a SUCCESS result. FAKE_AGY_IMAGE_MODE picks the variant: jpeg (default), png, scan (no step output, so only the brain scan finds it), no-step (an image in the brain but no generate_image step), run-command (only a run_command step, with an image drawn into the workspace and the brain), error-step (generate_image ends in ERROR), stale (the only image predates the turn) and outside (the step output names a file outside the brain). It never contacts a model.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The ERROR step now carries the shape agy 1.2.8 emitted in the 2026-10-03 storyboard replays (tool_info.error = { type: 'TOOL_ERROR', message: 'no image generated in response' }) and the model's reply after it (NO_IMAGE_CAPABILITY). New modes: error-step-image (generate_image ends in ERROR although an image and its step output sit in the brain, so only the DONE check can refuse it) and active-only (generate_image starts and never finishes). FAKE_AGY_REPLY_JSON and FAKE_AGY_TOOL_ERROR_JSON (JSON, so control characters survive the environment) replace the final reply and the ERROR step's error object.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | FAKE_AGY_ACTIVE_STATE names the state of the active-only mode's one generate_image step (ACTIVE by default), so a guard can hand Guard A a state word the node's provider failover would classify.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | FAKE_AGY_IMAGE_MODE_SEQUENCE (comma-separated modes) picks each turn's mode in order, counted from the turns already recorded in FAKE_AGY_OBSERVE_FILE (the last one repeats), so a guard can let a render's first fresh turn end in ERROR and its retry render (operator decision 2026-10-03: retry, max 3, fresh turns). Unset, FAKE_AGY_IMAGE_MODE decides as before.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** A real 96 x 80 JPEG (blue circle on white), the format generate_image answered in the proof. */
const JPEG = Buffer.from([
  '/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//',
  '2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAAR',
  'CABQAGADASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAAYHAgX/xAAtEAACAgAEAwYGAwAAAAAAAAACAwABBAUGERIx',
  'sQchIkFSgVFhYpGhwRNDcf/EABkBAQEBAQEBAAAAAAAAAAAAAAAEBQMCBv/EACERAAEEAgEFAQAAAAAAAAAAAAABAgMRBAUT',
  'EjEyQXFR/9oADAMBAAIRAxEAPwDToiIAiJy1i0qJrTEAGtyIr2qq/wBgHUSPzXXmGQRKy1F4gq7v5DvhD2rnf4k87WueMK7B',
  'yk18AVV9d5dHrp3pdV9OLp2IajEy5Otc8WVWblOr4Gqq6bShyrXmFeVLzJF4cr/sDxB71zr8xJrp2JdX8DZ2KWETlTFuULVG',
  'JgVbiQ3vV1OpCdhERAEREA5awEqNrSoACrIivlVV5zLNTajdnOJta7IMEF+Bfq+q/n0lL2hZmSMEnLlFsWIviZt6a5V730me',
  'Tb1uMiN5Xd/RHkSLfSgiImuTCIiAe9pnUTsmxNLYRHgjvxr58P1V8+s1NTAcoGqKjA6ohKuV1fnMOmh9nuZk/BOy9pblh74l',
  '7+m+de19ZkbLGRW8re/spx5FvpUsIiJiFgiIgGXa7dbNTNC77lLAK+3F+5Oyi12m16mad13NWB19uH9Sdn1eLXAyvxDNk81E',
  'RE7ngREQBKLQbrXqZQVfc1Zhf24v1J2UWg02zUyjqu5SzO/tw/ucMquB9/inuPzQ1GIifKGkIiIBH9oWWE/BJzBQ7lh74Wbe',
  'm+V+19Znk3Fqwco1NGjA6sSG+V1flMs1Npx2TYm2LEjwR34Gen6b+fWbetyUVvE7v6I8iNb6kPBiImuTCIiAJofZ7lhIwTsw',
  'aOxYi+Fe/prnfvfSTWmdOOznE0xgkGCC/GfLi+kfn0mpqWCVApQ0ABVCI1yqq8pkbLJRG8Te/spx41vqU6iImIWCIiAJy1a3',
  'LJbQEwKtiEq3q6/ydRAI/NdB4V5EzLX3hyvv/jOuIPa+dfmTztE54sroEqdXxBtV12moxLo9jOxKu/pxdAxTLk6JzxhVRpUm',
  'vibavpvKHKtB4VBUzMn3iCr+sPCHvfO/xLCIk2M70q6+BsDEOVLWlYrUAgA1sIjW1VU6iJCdhERAP//Z',
].join(''), 'base64');

/** The same picture as a real PNG. */
const PNG = Buffer.from([
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABQCAYAAADm4nCVAAAACXBIWXMAAAsTAAALEwEAmpwYAAAEMklEQVR4nO2cW0tUYRSG',
  '/QkrOl1lSddB10U1lVp56gBlXSaamWWaktVVFBhBZkhRP8AiLIu6tkSloBLFf5CDOjPqlKNz0BxnxTspDAOmjvvb69t7vhde',
  'GOak8z4z+7D2Wl8OG4kqR/bPGxkAwjIAhGUACMsAEJYBICwDQFgGgLAMAGFpDyASS3D3tyi3dkzz5ZZJzq/x8d4Lo7yr1Mvb',
  '8keSxm3ch8dqHkzx445p7v4eTb5Wd2kJwD8V56edIT521cdb80eYPD8zMl57/JqPn3WGOBCMs47SCkDfYIzPNgd485HMAv+f',
  '8Z7nbgW4fyjGOkkLAD0DMS6s9Vke+krGL6t3UA8QOdKbmuqWSduCT3f57QCPBhayE0DXpzDvKPKKhb/s3GIvv++JZA+A2HyC',
  'G1qD4sFTmhvbgjz3J+FuAOFogk83+cXDphVcUu/nUHjRnQAmfsf5QOW4eMi0ig9WjSf/V1cBmIks8qEq/cOnJe+rGOPp2UV3',
  'AMA2Hz9t6VBpnS5r8NuyT1AOoP7RlHiYlKGbngSdDeBdT0Q8RNqg33SHnQlgfDKuxXE+WXCegBNGxwG4eHdCPDyyyJX3J50F',
  'ALUd6dDIYqsq4ikBgGKXdGBksQtqfc4AgJKydFikyF+GY/oDQD1fOihSWD3VGkDgV5y3HJUPihQZnw2fUVsA7a9D4iGRYj9/',
  'O6MvADfufCnNRXV+PQGgAwEdCtIBkWLjM1rZbWEZALSBSIdDNvnzj5h+ANC3Ix0M2eS2VyH9AKBpSjoYssm1D6f0A4CuNOlg',
  'yIFnxZYB2FM+Kh4M2WS0QWoHIK/U+aVnWqN3n/TqByAbDkFpydsLRqyKzQAgtwAwm6DMZHbCHpfshPOvZM9haKGOh6HmRCwz',
  'mVKExyWliGwqxvUMaFiMi85lTzk6OqdhORrCQJx0QKTYxdc1vSADYbJROiBS7BddGl+SNBflNWhLwSio9LeUFPn8Hc3bUiC0',
  '8EkHRYr8dXjOGa2JbtwZF1u881UKAEPQ0oGRhd50WE1botL29Ip77rlGXN3isPZ0CEMNGG6QDo826J0lXqULfSgdUcIEunSA',
  'tEF/6I04e0jvRpt+U/G0Rje3O3xID8KoJ0Y+pcOkdfpUo5/nF1wwpgrNOmxQe3/FuG1LFti6VAGWAZAOl1ax55ILlypIXazj',
  'TJO+pYqyBn9yWQVXL1eDfQIm0KXDpjTfbA/ass3XZsEmHKLmanCegOP8j31ZtGBTqgLBf0uW4VRfauhubEJ2NUUtFu3rH4rx',
  'iTqfrWNGqmo7jgSwLISCb6WKSUu8J+r5KkrKrgGwLBwGYhoR31T0YWYaOl6LMjIuI9p5aOl4AKlCBwJmstpeTicnUzAcgdbA',
  'vJSli3Eb9+ExPAfPxWus7F7IWgBulwEgLANAWAaAsAwAYRkAwjIAhGUACMsAEJYBwLL6C4XwsJRI74bnAAAAAElFTkSuQmCC',
].join(''), 'base64');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function observe(prompt) {
  const out = process.env.FAKE_AGY_OBSERVE_FILE;
  if (!out) return;
  fs.appendFileSync(out, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, prompt })}\n`);
}

/** A JSON value from the environment, or the fallback when the variable is unset. */
function jsonEnv(name, fallback) {
  const raw = process.env[name];
  return raw === undefined ? fallback : JSON.parse(raw);
}

/** The error object of the ERROR step, as agy 1.2.8 reported it in the 2026-10-03 replays. */
const toolError = () => jsonEnv('FAKE_AGY_TOOL_ERROR_JSON', { type: 'TOOL_ERROR', message: 'no image generated in response' });
/** The model's final reply. */
const reply = (fallback) => jsonEnv('FAKE_AGY_REPLY_JSON', fallback);

function toolStep(name, state, error) {
  emit({ event: 'step_update', step_update: { step_type: 'tool', state, tool_name: name,
    tool_info: { name, parameters: { ImageName: 'storyboard-frame' }, ...(error ? { error } : {}) } } });
}

/** Write one generated image into a fresh conversation folder of the private brain. */
function writeBrainImage(bytes, ext, { stepOutput, mtime } = {}) {
  const conversation = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', crypto.randomUUID());
  fs.mkdirSync(conversation, { recursive: true });
  const file = path.join(conversation, `storyboard_frame_${Date.now()}.${ext}`);
  fs.writeFileSync(file, bytes);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  if (stepOutput) {
    const stepDir = path.join(conversation, '.system_generated', 'steps', '2');
    fs.mkdirSync(stepDir, { recursive: true });
    fs.writeFileSync(path.join(stepDir, 'output.txt'), `Generated image is saved at ${stepOutput === true ? file : stepOutput}.\n`);
  }
  return file;
}

function finish(response) {
  emit({ event: 'result', result: { status: 'SUCCESS', response, usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128 } } });
}

const MODES = {
  jpeg: () => { toolStep('generate_image', 'ACTIVE'); writeBrainImage(JPEG, 'jpg', { stepOutput: true }); toolStep('generate_image', 'DONE'); finish(reply('RENDERED')); },
  png: () => { toolStep('generate_image', 'ACTIVE'); writeBrainImage(PNG, 'png', { stepOutput: true }); toolStep('generate_image', 'DONE'); finish(reply('RENDERED')); },
  scan: () => { toolStep('generate_image', 'ACTIVE'); writeBrainImage(JPEG, 'jpg'); toolStep('generate_image', 'DONE'); finish(reply('RENDERED')); },
  'no-step': () => { writeBrainImage(JPEG, 'jpg', { stepOutput: true }); finish(reply('RENDERED')); },
  'run-command': () => {
    toolStep('run_command', 'ACTIVE');
    fs.writeFileSync(path.join(process.cwd(), 'output.png'), PNG);
    writeBrainImage(PNG, 'png');
    toolStep('run_command', 'DONE');
    finish(reply('RENDERED'));
  },
  'error-step': () => { toolStep('generate_image', 'ACTIVE'); toolStep('generate_image', 'ERROR', toolError()); finish(reply('NO_IMAGE_CAPABILITY')); },
  'error-step-image': () => {
    toolStep('generate_image', 'ACTIVE');
    writeBrainImage(JPEG, 'jpg', { stepOutput: true });
    toolStep('generate_image', 'ERROR', toolError());
    finish(reply('RENDERED'));
  },
  'active-only': () => { toolStep('generate_image', process.env.FAKE_AGY_ACTIVE_STATE || 'ACTIVE'); finish(reply('RENDERED')); },
  stale: () => { toolStep('generate_image', 'ACTIVE'); writeBrainImage(JPEG, 'jpg', { mtime: new Date(Date.now() - 3_600_000) }); toolStep('generate_image', 'DONE'); finish(reply('RENDERED')); },
  outside: () => {
    toolStep('generate_image', 'ACTIVE');
    const drawn = path.join(process.cwd(), 'drawn.jpg');
    fs.writeFileSync(drawn, JPEG);
    writeBrainImage(Buffer.from('not an image at all'), 'txt', { stepOutput: drawn });
    toolStep('generate_image', 'DONE');
    finish(reply('RENDERED'));
  },
};

/** This turn's mode: the sequence's entry for this turn (counted from the turns already observed), else FAKE_AGY_IMAGE_MODE. */
function turnMode() {
  const sequence = String(process.env.FAKE_AGY_IMAGE_MODE_SEQUENCE || '').split(',').map((mode) => mode.trim()).filter(Boolean);
  if (!sequence.length) return process.env.FAKE_AGY_IMAGE_MODE || 'jpeg';
  const out = process.env.FAKE_AGY_OBSERVE_FILE;
  const seen = out && fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length : 0;
  return sequence[Math.min(seen, sequence.length - 1)];
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const first = JSON.parse(input.split('\n')[0]);
  const mode = turnMode();
  observe(String(first.message && first.message.content || ''));
  emit({ event: 'init', init: { model: 'fake-agy', cwd: process.cwd() } });
  (MODES[mode] || MODES.jpeg)();
});
