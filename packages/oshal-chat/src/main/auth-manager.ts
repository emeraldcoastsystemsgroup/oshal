/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local account manager: probes whether the user's CLIs are logged in (creds live in ~/.) and launches each CLI's own login in a visible terminal so its browser-popup OAuth runs HERE, on the user's machine — the thing a headless swarm container can't do.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

/** One local provider the user can sign into on this machine. */
interface LocalAccount {
  id: string;
  label: string;
  /** The login command launched in a terminal (browser popup runs locally). */
  loginCmd: string;
  /** True when this provider already has usable credentials in ~/. */
  isAuthed: () => boolean;
}

const home = homedir();

const ACCOUNTS: LocalAccount[] = [
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    loginCmd: 'codex login',
    isAuthed: () => existsSync(join(home, '.codex', 'auth.json')),
  },
  {
    id: 'claude',
    label: 'Anthropic (Claude)',
    loginCmd: 'claude /login',
    isAuthed: () => existsSync(join(home, '.claude', '.credentials.json')),
  },
  {
    id: 'gcloud',
    label: 'Google Cloud (gcloud)',
    loginCmd: 'gcloud auth login',
    isAuthed: () =>
      existsSync(join(home, '.config', 'gcloud', 'credentials.db')) ||
      existsSync(join(home, '.config', 'gcloud', 'application_default_credentials.json')) ||
      existsSync(join(home, 'AppData', 'Roaming', 'gcloud', 'credentials.db')),
  },
  {
    id: 'aws',
    label: 'AWS CLI',
    loginCmd: 'aws sso login',
    isAuthed: () =>
      existsSync(join(home, '.aws', 'credentials')) ||
      existsSync(join(home, '.aws', 'sso', 'cache')),
  },
];

const BY_ID = new Map(ACCOUNTS.map((a) => [a.id, a]));

/** Current login state of every local account, for the config screen. */
export function accountStatus(): Array<{ id: string; label: string; authed: boolean; loginCmd: string }> {
  return ACCOUNTS.map((a) => ({ id: a.id, label: a.label, authed: a.isAuthed(), loginCmd: a.loginCmd }));
}

/**
 * @description Launches a provider's login in a NEW visible terminal so the CLI
 * can open its browser OAuth and write creds to ~/. Detached + unref'd so it
 * outlives this IPC call; the user finishes the flow in the terminal window.
 * @returns the command that was launched (the UI tells the user to watch for the popup).
 */
export function launchLogin(id: string): { ok: boolean; command?: string; error?: string } {
  const account = BY_ID.get(id);
  if (!account) return { ok: false, error: `Unknown account "${id}"` };

  try {
    if (platform() === 'win32') {
      // `start` opens a fresh console; /k keeps it open so the user sees the prompt/result.
      spawn('cmd.exe', ['/c', 'start', '"OSHAL login"', 'cmd', '/k', account.loginCmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }).unref();
    } else if (platform() === 'darwin') {
      spawn('osascript', ['-e', `tell app "Terminal" to do script "${account.loginCmd}"`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      // Best-effort on Linux: try a common terminal, else run headless (CLI prints a URL).
      spawn('x-terminal-emulator', ['-e', account.loginCmd], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, command: account.loginCmd };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
