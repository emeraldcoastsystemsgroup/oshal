/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local account manager: probes whether the user's CLIs are logged in (creds live in ~/.) and launches each CLI's own login in a visible terminal so its browser-popup OAuth runs HERE, on the user's machine — the thing a headless swarm container can't do.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A: each account reports whether the swarm can adopt its login (codex, claude), so the Config screen can offer "Log in + push" / "Push to swarm" on exactly those rows.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Windows: EVERY account row failed with the shell dialog "Windows cannot find 'login\'" — the launcher passed the console title pre-quoted ('"OSHAL login"'), libuv escaped those quotes into start "\"OSHAL login\"" cmd /k "<cmd>", and cmd.exe does not understand backslash-escaped quotes (that is a C-runtime convention): it re-tokenized, `start` took \"OSHAL as the title and `login\` as the program to run. Quoting is now left entirely to libuv (a title with a space comes back correctly quoted) and the command is split into its own argv entries, so no entry carries a quote. Broken since SEQ 1 — the launcher had never been run on Windows. Also fixes claude's verb: the CLI's login is `claude auth login`; `claude /login` is a REPL slash command that as an argv would have been read as a prompt. Guard: tests/unit/node-login-launch.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Google (Gemini) joins the account list so the swarm-adoptable row is offered for it too. Distinct from the gcloud row below it, which signs into Google CLOUD and writes an ADC file the swarm does not consume. Its login command is the bare `gemini`: the CLI publishes no top-level `auth` subcommand (its yargs surface is `$0 [query..]` plus mcp/extensions/skills/hooks) — `auth` is a built-in SLASH command in the interactive UI, so the terminal has to open on the CLI itself for the browser sign-in to run.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added the Antigravity account row and made the retired Gemini account-login row local-only.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Corrected the Antigravity boundary after inspecting the real vendor credential: Windows Credential Manager contains the same JSON agy's headless file-storage mode consumes. The row is pushable through the existing authenticated rail, reports real credential presence, and launches the absolute vendor install path even though the installer does not add it to PATH.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { isPushableLogin } from './login-push-core';
import { antigravityCredentialPresent } from './antigravity-credential';

/** One local provider the user can sign into on this machine. */
interface LocalAccount {
  id: string;
  label: string;
  /** The login command launched in a terminal (browser popup runs locally). */
  loginCmd: string;
  /** Exact argv for binaries installed outside PATH (and paths containing spaces). */
  loginArgv?: () => string[];
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
    id: 'gemini',
    label: 'Google (Gemini)',
    // The Gemini CLI has no top-level `auth` subcommand — verified against the installed
    // @google/gemini-cli bundle, whose yargs surface is `$0 [query..]` plus mcp/extensions/
    // skills/hooks; `auth` is a BUILT_IN *slash* command (authCommand, subCommands
    // authLogin/authLogout) inside the interactive UI. So the launch is the bare CLI, where the
    // first-run auth picker — or `/auth` — opens Google's sign-in on this machine.
    //
    // That sign-in is RETIRED for individuals as of 2026-09-22. Choosing "Sign in with Google"
    // answers, verbatim: "Failed to sign in. Message: This client is no longer supported for
    // Gemini Code Assist for individuals. To continue using Gemini, please migrate to the
    // Antigravity suite of products: https://antigravity.google". So ~/.gemini/oauth_creds.json
    // can no longer be created by a sign-in, isAuthed below will read false on a fresh box, and
    // the push target is marked dormant in login-push-core. The row stays because the CLI's other
    // other auth methods still work and the file is still what the swarm would adopt if Google
    // ever reopens the path.
    loginCmd: 'gemini',
    isAuthed: () => existsSync(join(home, '.gemini', 'oauth_creds.json')),
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    // Where Google now sends individuals: the CLI's own sign-in answers "This client is no longer
    // supported for Gemini Code Assist for individuals … migrate to the Antigravity suite of
    // products" (measured on the operator's box 2026-09-22). Antigravity signs in as the user's own
    // Google identity and keeps its state beside the CLI's, which is why it keeps answering on
    // models the shared API key 503s on.
    //
    // The vendor installer puts v1.2.8 under %LOCALAPPDATA%\agy\bin and does not add it to PATH,
    // so Windows launches that exact path. An argv array preserves paths containing spaces.
    loginCmd: platform() === 'win32'
      ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
      : 'agy',
    loginArgv: () => [platform() === 'win32'
      ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
      : 'agy'],
    // On Windows the durable vendor JSON lives in Credential Manager as `gemini:antigravity`.
    // Presence is validated without writing or logging the credential.
    isAuthed: antigravityCredentialPresent,
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
export function windowsLoginArgv(loginCmd: string | readonly string[]): string[] {
  const command = typeof loginCmd === 'string' ? loginCmd.split(/\s+/).filter(Boolean) : [...loginCmd];
  return ['/c', 'start', WINDOWS_LOGIN_TITLE, 'cmd', '/k', ...command];
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
      spawn('cmd.exe', windowsLoginArgv(account.loginArgv?.() ?? account.loginCmd), {
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
