/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Acceptance runner for the ESPN "Log in + push" window (BACKLOG: the sign-in window made the user hunt for the one control that works). On a throwaway node profile it drives the real connectEspnFantasy, takes the window that call opens, and passes only when a visible ESPN sign-in form is on screen with no click from anyone; closing the window must then settle as a cancel with nothing pushed. It loads live ESPN on purpose: the unit spec pins the URL constant, and this is the half that goes red when ESPN moves the entry, instead of the button quietly landing on a dead page again.
 */

import { app, type BrowserWindow, type WebContents, type WebFrameMain } from 'electron';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigStore } from './config';
import { connectEspnFantasy } from './espn-cookie-login';
import { ESPN_TARGET, type PushOutcome } from './login-push-core';

/** How long a first-time user may be left looking at the window before the form must be there. */
const FORM_WAIT_MS = 45_000;
const SWEEP_MS = 1_000;
/** A frame that will not answer (an ad frame mid-teardown) must not stall the whole sweep. */
const FRAME_EVAL_MS = 3_000;
/**
 * Where a push would go if anything were captured. A discard port on loopback: nothing is ever
 * captured here (no one signs in), and if it were, it could not reach a real swarm.
 */
const UNREACHABLE_SWARM = 'http://127.0.0.1:9';

// A never-used profile, set before `ready`: the ESPN partition lives under userData, so this is
// what makes the run a first-time user with an empty jar rather than whoever last signed in here.
const PROFILE = mkdtempSync(join(tmpdir(), 'oshal-espn-login-'));
app.setPath('userData', PROFILE);

/** What one frame reports about sign-in fields that a person could actually see and type into. */
interface FrameForm {
  identity: boolean;
  password: boolean;
}

/** Run inside every frame: a visible email/username field is the sign-in form, password or not. */
const FRAME_FORM_PROBE = `(() => {
  const seen = (el) => el.offsetWidth > 0 && el.offsetHeight > 0 && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden' && window.innerWidth > 0 && window.innerHeight > 0;
  const inputs = [...document.querySelectorAll('input')].filter(seen);
  const identity = inputs.some((i) => i.type === 'email'
    || (i.type === 'text' && /user|email/i.test([i.autocomplete, i.name, i.id, i.placeholder].join(' '))));
  return { identity, password: inputs.some((i) => i.type === 'password') };
})()`;

/**
 * @description A frame's in-document view cannot tell a hidden iframe from a shown one, so the
 * PARENT is asked whether it shows an iframe from that origin at a size a person could use.
 * @param origin - Origin of the frame that holds the form.
 * @returns Script source evaluated in the parent frame.
 */
function parentShowsFrameProbe(origin: string): string {
  return `[...document.querySelectorAll('iframe')].some((f) => {
    let o = ''; try { o = new URL(f.src, location.href).origin; } catch (e) { return false; }
    const r = f.getBoundingClientRect(); const s = getComputedStyle(f);
    return o === ${JSON.stringify(origin)} && r.width >= 200 && r.height >= 200
      && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  })`;
}

/**
 * @description Evaluate a script in a frame, giving up after a bound instead of hanging.
 * @param frame - Target frame.
 * @param source - Script source.
 * @returns The script's value, or null when the frame did not answer in time or threw.
 */
async function evalIn<T>(frame: WebFrameMain, source: string): Promise<T | null> {
  const bound = new Promise<null>((resolve) => setTimeout(() => resolve(null), FRAME_EVAL_MS));
  // A frame torn down mid-evaluation rejects; for this sweep that means "no form here", and the
  // next sweep looks again — so the rejection is the answer, not an error to report.
  const answer = frame.executeJavaScript(source).then((v) => v as T, () => null);
  return Promise.race([answer, bound]);
}

/**
 * @description One sweep over every frame in the window for a sign-in form a person can see.
 * @param contents - The login window's contents.
 * @returns The frame URL and fields of the first visible form, or null when there is none yet.
 */
async function findVisibleForm(contents: WebContents): Promise<(FrameForm & { frame: string }) | null> {
  const frames = contents.mainFrame.framesInSubtree;
  const reports = await Promise.all(frames.map((frame) => evalIn<FrameForm>(frame, FRAME_FORM_PROBE)));
  for (let i = 0; i < frames.length; i += 1) {
    const report = reports[i];
    if (!report?.identity) continue;
    const frame = frames[i];
    const parent = frame.parent;
    const shown = !parent || (await evalIn<boolean>(parent, parentShowsFrameProbe(new URL(frame.url).origin)));
    if (shown) return { ...report, frame: frame.url };
  }
  return null;
}

/**
 * @description Sweep until the form is visible or the first-time user's patience has run out.
 * @param win - The login window connectEspnFantasy opened.
 * @returns The form and how long it took to appear, or null when it never did.
 */
async function waitForLoginForm(win: BrowserWindow): Promise<(FrameForm & { frame: string; ms: number }) | null> {
  const started = Date.now();
  while (Date.now() - started < FORM_WAIT_MS && !win.isDestroyed()) {
    const form = await findVisibleForm(win.webContents);
    if (form) return { ...form, ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, SWEEP_MS));
  }
  return null;
}

/**
 * @description Keep what the window showed, pass or fail, so a red run can be looked at.
 * @param win - The login window.
 * @returns Path of the PNG, or why there is none.
 */
async function saveScreenshot(win: BrowserWindow): Promise<string> {
  if (win.isDestroyed()) return 'window already closed';
  const file = join(PROFILE, 'espn-login-window.png');
  writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
}

/**
 * @description The window connectEspnFantasy opens — or its early answer when it opens none (a
 * bad swarm origin or a jar that already holds a login would both return without a window).
 * @param outcome - The pending connectEspnFantasy call.
 * @param opened - Resolves with the next window created.
 * @returns The window.
 */
async function loginWindow(outcome: Promise<PushOutcome>, opened: Promise<BrowserWindow>): Promise<BrowserWindow> {
  const early = outcome.then((result): never => {
    throw new Error(`connectEspnFantasy answered without opening a window: ${result.reason} ${result.detail ?? ''}`);
  });
  return Promise.race([opened, early]);
}

/**
 * @description Open the real sign-in window as a first-time user would, and hold it to the promise
 * that the sign-in form is the first thing on screen.
 * @returns Resolves on pass; rejects with what the window showed instead.
 */
async function verifyEspnLoginWindow(): Promise<void> {
  await app.whenReady();
  const store = new ConfigStore();
  store.save({ controlPlaneUrl: UNREACHABLE_SWARM, cockpitBaseUrl: UNREACHABLE_SWARM });
  const opened = new Promise<BrowserWindow>((resolve) => app.once('browser-window-created', (_e, w) => resolve(w)));
  const outcome = connectEspnFantasy(store, { timeoutMs: FORM_WAIT_MS * 2 });
  const win = await loginWindow(outcome, opened);
  const form = await waitForLoginForm(win);
  const landed = win.isDestroyed() ? 'window closed' : win.webContents.getURL();
  const screenshot = await saveScreenshot(win);
  if (!win.isDestroyed()) win.close();
  const result = await outcome;
  if (!form) {
    throw new Error(`no visible ESPN sign-in form within ${FORM_WAIT_MS / 1000}s of opening ${ESPN_TARGET.loginUrl} (window at ${landed}; screenshot ${screenshot})`);
  }
  if (result.ok || result.reason !== 'cancelled') {
    throw new Error(`closing the window must settle as a cancel with nothing pushed, got ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({
    loginUrl: ESPN_TARGET.loginUrl, formFrame: form.frame, passwordField: form.password,
    secondsToForm: Number((form.ms / 1000).toFixed(1)), landed, outcome: result.reason, profile: PROFILE, screenshot,
  })}\n`);
}

void verifyEspnLoginWindow()
  .then(() => app.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`ESPN login window boundary failed: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });
