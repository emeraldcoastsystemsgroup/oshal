/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local account manager: probes whether the user's CLIs are logged in (creds live in ~/.) and launches each CLI's own login in a visible terminal so its browser-popup OAuth runs HERE, on the user's machine — the thing a headless swarm container can't do.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A: each account reports whether the swarm can adopt its login (codex, claude), so the Config screen can offer "Log in + push" / "Push to swarm" on exactly those rows.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Windows: EVERY account row failed with the shell dialog "Windows cannot find 'login\'" — the launcher passed the console title pre-quoted ('"OSHAL login"'), libuv escaped those quotes into start "\"OSHAL login\"" cmd /k "<cmd>", and cmd.exe does not understand backslash-escaped quotes (that is a C-runtime convention): it re-tokenized, `start` took \"OSHAL as the title and `login\` as the program to run. Quoting is now left entirely to libuv (a title with a space comes back correctly quoted) and the command is split into its own argv entries, so no entry carries a quote. Broken since SEQ 1 — the launcher had never been run on Windows. Also fixes claude's verb: the CLI's login is `claude auth login`; `claude /login` is a REPL slash command that as an argv would have been read as a prompt. Guard: tests/unit/node-login-launch.spec.ts.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { isPushableLogin } from './login-push-core';

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
    loginCmd: 'claude auth login',
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

/** Title of the console the vendor login runs in. Must contain a space — see windowsLoginArgv. */
export const WINDOWS_LOGIN_TITLE = 'OSHAL login';

/**
 * @description Builds the cmd.exe argv that opens one vendor login in a visible console.
 *
 * Nothing here may carry a quote character. Node/libuv adds the quoting Windows needs — a
 * title containing a space comes back as "OSHAL login" — but cmd.exe does not understand the
 * backslash-escaped quotes libuv emits for an argument that already contains them. Passing the
 * title pre-quoted produced `start "\"OSHAL login\"" cmd /k "claude /login"`, which cmd
 * re-tokenized into the title `\"OSHAL` and the program `login\`, and every account row died
 * on the shell's "Windows cannot find 'login\'" dialog. The command is split for the same
 * reason: one quote-free argv entry per token, and libuv does the rest.
 *
 * @param loginCmd - The vendor's login command line, e.g. `claude auth login`.
 * @returns argv for cmd.exe — quote-free by construction.
 */
export function windowsLoginArgv(loginCmd: string): string[] {
  return ['/c', 'start', WINDOWS_LOGIN_TITLE, 'cmd', '/k', ...loginCmd.split(/\s+/).filter(Boolean)];
}

/** Current login state of every local account, for the config screen. */
export function accountStatus(): Array<{ id: string; label: string; authed: boolean; loginCmd: string; pushable: boolean }> {
  return ACCOUNTS.map((a) => ({
    id: a.id, label: a.label, authed: a.isAuthed(), loginCmd: a.loginCmd, pushable: isPushableLogin(a.id),
  }));
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
      spawn('cmd.exe', windowsLoginArgv(account.loginCmd), {
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
