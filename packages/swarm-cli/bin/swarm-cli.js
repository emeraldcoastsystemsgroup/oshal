#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the headless swarm CLI: everything the Jarvis chat window does, from a terminal. Drives the SAME endpoints as the browser surface (POST /api/jarvis/ask → poll /ask/result, /history, /catalog, /tasks) so behavior is identical: classify→delegate→synthesize, session threads, handoff tickets. Auth = X-Service-Secret + x-oshal-user-sub (trusted-service pattern; serviceSecretOr on the /api/jarvis mount) — or nothing against a MOCK_OIDC dev server. Zero npm deps (Node 18+ global fetch), so it runs anywhere the repo is checked out — including inside bot containers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exit-path fix (Windows): process.exit() while undici's keep-alive socket tears down intermittently hits the libuv assertion "!(handle->flags & UV_HANDLE_CLOSING)" (src/win/async.c) and corrupts the exit code — fatal for headless scripting. Errors now THROW CliError (caught once in the entry point), success/failure land in process.exitCode, and requests send Connection: close so the loop drains and the process exits naturally.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Industry-standard auth: `swarm-cli login` (gh/kubectl shape) — interactive or flag-driven, kubeconfig-style named contexts persisted in <stateDir>/config.json (0600). A secret+sub login BOOTSTRAP-MINTS a personal access token via POST /api/cli-tokens and stores THAT — the machine-wide service secret is never written to disk. Requests then authenticate with `Authorization: Bearer oshal_pat_…`. New commands: login / logout / whoami / tokens [revoke <id>]. Precedence: flags > env (OSHAL_CLI_TOKEN, …) > current context. Secrets are prompted with echo suppressed.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Polish tier: zero-dep ANSI color (auto-off when piped / NO_COLOR / TERM=dumb), an OSHAL ASCII banner on interactive `chat`/`login` (UTF-8 block art with a pure-ASCII fallback; --no-banner to suppress), a slash-command REPL with TAB completion (/help /catalog /tasks /whoami /clear + the existing ones), `swarm-cli completion <bash|zsh|powershell>` (scripts live in scripts/completions/, read at runtime), and `version`. stdout stays answer/JSON-only so pipes are unaffected; color + banner ride stderr/interactive paths.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fixes: (HIGH) chat no longer crashes with ERR_USE_AFTER_CLOSE / exit 1 when stdin EOFs mid-turn — reprompt() guards rl.prompt() on the closed interface (piped `echo x | … chat` and Ctrl-D-during-a-turn now exit 0 after the answer). (MED) color gates each stream independently (COLOR_ERR from stderr.isTTY) so `2>file` from a TTY no longer receives escape codes. (MED) the `→` arrow is now the UNICODE-gated ARROW everywhere (whoami/status/handoff), matching the banner/prompt fallback. (LOW) `/clear` only emits its escape on a TTY; `--version` added to all three completion flag lists.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | PACKAGED: moved scripts/swarm-cli.js → packages/swarm-cli/bin/swarm-cli.js as a real, zero-dependency npm package (@oshal/swarm-cli), installable with `npm i -g ./packages/swarm-cli` so `swarm-cli` lands on PATH with no checkout and no dependency tree (a global install of the control-plane root would have dragged in express/pg/etc — wrong for a client). Two path consequences: the completion scripts are now package data at ../completions (relative to bin/), and `version` now reports THIS package's version rather than the control-plane's. Image installs it globally too, so `docker exec <container> swarm-cli …` works.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Fixed the residual status-color gap (BACKLOG): note()/error helpers baked COLOR_ON (stdout's TTY) even though COLOR_ERR was computed, so `swarm-cli ask x | jq` (stdout piped, stderr a terminal) printed plain status notes. Added a stderr-gated color set (paintErr/cErr/uiErr) and pointed note() + the entrypoint error line at it; the stdout-gated c/ui tables are untouched, so piped stdout stays plain and `2>file` stays byte-clean. Positive TTY-stderr coloring still needs a pseudo-tty to acceptance-test end-to-end.
 *
 * Usage:
 *   node scripts/swarm-cli.js ask "what's on my calendar today?"
 *   node scripts/swarm-cli.js chat                # interactive REPL, persistent thread
 *   node scripts/swarm-cli.js history             # replay the current thread
 *   node scripts/swarm-cli.js catalog             # what Jarvis can reach
 *   node scripts/swarm-cli.js tasks               # durable handed-off work + results
 *
 * Config (flags override env):
 *   OSHAL_API_URL / OSHAL_CONTROL_PLANE_URL  target controller (default http://localhost:35457)
 *   SWARM_SERVICE_SECRET                     trusted-service secret (--secret)
 *   OSHAL_USER_SUB                           the user to act as (--sub; required with the secret)
 *   OSHAL_CLI_STATE_DIR                      session-state dir (default ~/.oshal)
 *
 * Exit codes: 0 ok · 1 request/server error · 2 auth/config error · 3 timed out waiting.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { Writable } = require('stream');

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_AUTH = 2;
const EXIT_TIMEOUT = 3;

/** An error that already knows its exit code — thrown instead of hard process.exit()
 *  so the event loop drains and Windows' libuv exit-during-socket-teardown assertion
 *  can't fire. Caught exactly once, at the entry point. */
class CliError extends Error {
  /**
   * @description Builds a CLI failure with its process exit code.
   * @param {number} code - exit code (EXIT_AUTH / EXIT_ERROR / EXIT_TIMEOUT).
   * @param {string} message - operator-facing reason.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── color ─────────────────────────────────────────────────────────────────────
// Zero-dep ANSI. Helpers are nesting-safe (c.bold(c.cyan(x)) keeps both). When color
// is OFF — stdout not a TTY (piped/redirected), NO_COLOR set to any value, or
// TERM=dumb — every helper is the identity function, so pipes / --json / CI logs stay
// clean. Evaluated once at load; set FORCE_COLOR to force it through a pipe.
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const ANSI_CODES = { bold: '1m', dim: '2m', red: '31m', green: '32m', yellow: '33m', blue: '34m', magenta: '35m', cyan: '36m', gray: '90m' };
function supportsColor(stream) {
  if (process.env.FORCE_COLOR) return true;
  if (!stream || !stream.isTTY) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
}
const COLOR_ON = supportsColor(process.stdout);   // gates stdout content (answers, banner, prompt)
const COLOR_ERR = supportsColor(process.stderr);  // gates stderr content (status notes, errors) — each stream independently, like git/gh
/** Build one wrapping helper; re-opens its code after any nested reset so composed helpers keep both attrs. */
function paint(code) {
  const open = ESC + code;
  return (s) => {
    if (!COLOR_ON) return String(s);
    const str = String(s);
    return open + (str.includes(RESET) ? str.split(RESET).join(RESET + open) : str) + RESET;
  };
}
const c = Object.freeze(Object.fromEntries(Object.entries(ANSI_CODES).map(([name, code]) => [name, paint(code)])));
/** Role → color. All no-op when color is off. */
const ui = Object.freeze({
  prompt: (s) => c.bold(c.cyan(s)),
  jarvis: (s) => c.magenta(s),
  status: (s) => c.gray(s),
  error: (s) => c.bold(c.red(s)),
  success: (s) => c.bold(c.green(s)),
  handoff: (s) => c.yellow(s),
});
// Same helpers gated on STDERR's TTY state, so status notes + errors get color when stderr is a
// terminal even if stdout is piped (`swarm-cli ask x | jq`), and stay byte-clean when stderr is
// redirected (`2>file`). paint() alone bakes COLOR_ON (stdout), which under-colored these before.
function paintErr(code) {
  const open = ESC + code;
  return (s) => {
    if (!COLOR_ERR) return String(s);
    const str = String(s);
    return open + (str.includes(RESET) ? str.split(RESET).join(RESET + open) : str) + RESET;
  };
}
const cErr = Object.freeze(Object.fromEntries(Object.entries(ANSI_CODES).map(([name, code]) => [name, paintErr(code)])));
const uiErr = Object.freeze({
  prompt: (s) => cErr.bold(cErr.cyan(s)),
  jarvis: (s) => cErr.magenta(s),
  status: (s) => cErr.gray(s),
  error: (s) => cErr.bold(cErr.red(s)),
  success: (s) => cErr.bold(cErr.green(s)),
  handoff: (s) => cErr.yellow(s),
});

// ── banner ──────────────────────────────────────────────────────────────────
// UTF-8 terminals get the block wordmark + the ❯ prompt glyph; everything else
// (unknown locale, legacy Windows console) falls back to pure ASCII so nothing
// mojibakes. WT_SESSION marks Windows Terminal, which renders UTF-8 fine.
const UNICODE = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '') || !!process.env.WT_SESSION;
const PROMPT = UNICODE ? 'oshal ❯ ' : 'oshal > ';
const ARROW = UNICODE ? '→' : '->';   // used in status/whoami/handoff lines so nothing mojibakes on non-UTF-8 terminals
const BANNER_BLOCK = [
  ' ██████╗ ███████╗██╗  ██╗ █████╗ ██╗',
  '██╔═══██╗██╔════╝██║  ██║██╔══██╗██║',
  '██║   ██║███████╗███████║███████║██║',
  '██║   ██║╚════██║██╔══██║██╔══██║██║',
  '╚██████╔╝███████║██║  ██║██║  ██║███████╗',
  ' ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝',
].join('\n');
const BANNER_ASCII = String.raw`  ___   ____   _   _     _     _
 / _ \ / ___| | | | |   / \   | |
| | | |\___ \ | |_| |  / _ \  | |
| |_| | ___) ||  _  | / ___ \ | |___
 \___/ |____/ |_| |_|/_/   \_\|_____|`;
/** Print the startup banner — only in interactive contexts (TTY, not --quiet/--json/--no-banner). */
function banner(cfg) {
  if (cfg.noBanner || cfg.quiet || cfg.json || !process.stdout.isTTY) return;
  const art = UNICODE ? BANNER_BLOCK : BANNER_ASCII;
  process.stdout.write(`${c.cyan(art)}\n${c.gray('  the swarm, from your terminal.')}\n\n`);
}

// ── REPL slash-commands ───────────────────────────────────────────────────────
const SLASH_COMMANDS = ['/help', '/catalog', '/tasks', '/whoami', '/history', '/session', '/new', '/clear', '/exit', '/quit'];
const REPL_HELP = [
  'Chat commands — type a message to talk to Jarvis, or one of these:',
  '',
  '  /help              show this help',
  '  /catalog           list the apps & agents Jarvis can reach',
  '  /tasks             list durable handed-off work items + their results',
  '  /whoami            show who the server thinks you are',
  '  /history           replay this thread\'s transcript',
  '  /session           print the current thread id',
  '  /new               start a fresh thread (the old one is kept)',
  '  /clear             clear the terminal screen',
  '  /exit, /quit       leave chat — the thread is saved',
  '',
  'Anything not starting with "/" is sent to Jarvis. Press TAB to complete a slash-command.',
].join('\n');
/**
 * @description readline tab-completer for `chat`. Standard [hits, line] contract. Only
 * slash-commands complete; free text (and the empty line) yields no suggestions. A "/…"
 * that matches nothing returns the whole menu so a mistype shows the options.
 * @param {string} line - current input up to the cursor.
 * @returns {[string[], string]} the readline completion tuple.
 */
function completer(line) {
  if (!line.startsWith('/')) return [[], line];
  const hits = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(line));
  return [hits.length ? hits : SLASH_COMMANDS, line];
}

const DEFAULT_URL = 'http://localhost:35457';
const DEFAULT_TIMEOUT_S = 300;   // overall wait for one answer (server decision timeout is 75s)
const DEFAULT_POLL_MS = 1500;    // same cadence as the browser surface
const FETCH_TIMEOUT_MS = 30_000; // per-HTTP-request guard

const USAGE = `swarm-cli — talk to Jarvis (the whole swarm) from a terminal.

Commands:
  login            sign in: verify credentials, mint a personal token, save a context
  logout           forget the current context's credentials
  whoami           show who the server thinks you are
  ask <message…>   one-shot question; prints the answer to stdout
  chat             interactive REPL on a persistent thread (TAB completes; /help inside)
  history          print the current thread's transcript
  catalog          list the apps Jarvis can reach
  tasks            list durable handed-off work items + results
  tokens [revoke <id>]  list or revoke your personal access tokens
  completion <bash|zsh|powershell>   print a shell tab-completion script
  version          print the CLI version
  help             this text

Flags:
  --url <url>        controller base URL         (env OSHAL_API_URL)
  --token <pat>      personal access token       (env OSHAL_CLI_TOKEN)
  --secret <s>       trusted-service secret      (env SWARM_SERVICE_SECRET; bootstrap only)
  --sub <sub>        user to act as              (env OSHAL_USER_SUB; required with --secret)
  --context <name>   named context (default: the saved current context)
  --label <text>     token label for login/mint
  --session <id>     thread id (default: persisted per url+user in ~/.oshal)
  --new              start a fresh thread (and persist it as current)
  --json             machine output: full result JSON on stdout
  --timeout <sec>    max wait for an answer      (default ${DEFAULT_TIMEOUT_S})
  --poll <ms>        poll interval               (default ${DEFAULT_POLL_MS})
  --quiet            suppress stderr status notes
  --no-banner        suppress the startup banner

Auth precedence: flags > env > saved context (swarm-cli login). A secret+sub login mints a
personal token and stores that — the service secret itself is never saved to disk.
Tab completion: run  swarm-cli completion <bash|zsh|powershell>  and source it (see the
top of the script for install lines). NO_COLOR disables color; colors auto-off when piped.`;

/** Flags that take a value (everything else boolean). */
const VALUE_FLAGS = new Set(['url', 'secret', 'sub', 'session', 'timeout', 'poll', 'token', 'context', 'label']);

/**
 * @description Parses argv into { cmd, message, flags }. The first non-flag token is the
 * command; remaining non-flag tokens are joined as the message (so quoting is forgiving).
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{cmd: string, message: string, flags: Record<string, string|boolean>}} parsed input.
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        flags[name] = argv[++i];
        if (flags[name] === undefined) fail(EXIT_AUTH, `--${name} needs a value`);
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  const cmd = (positional.shift() || 'help').toLowerCase();
  return { cmd, message: positional.join(' ').trim(), flags };
}

/** Reads the persisted login config ({ currentContext, contexts }); {} on first run. */
function loadCliConfig(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')); }
  catch { return {}; }
}

/** Persists the login config with owner-only permissions (chmod is a no-op on Windows). */
function saveCliConfig(stateDir, config) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  try { fs.chmodSync(file, 0o600); } catch { /* windows: NTFS ACLs, not modes */ }
}

/**
 * @description Resolves the effective configuration: flags > env > the saved context
 * (written by `swarm-cli login`) > defaults. A personal token wins over the service
 * secret when both are present. Fails closed (exit 2) when a secret is provided without
 * a user sub — the server would 401 anyway, this just makes the reason obvious.
 * @param {Record<string, string|boolean>} flags - parsed CLI flags.
 * @param {boolean} [lenient] - skip the secret-needs-sub check (login prompts for it itself).
 * @returns {{url: string, token: string, secret: string, sub: string, session: string|undefined,
 *   json: boolean, quiet: boolean, timeoutMs: number, pollMs: number, fresh: boolean,
 *   stateDir: string, contextName: string, fileConfig: object}} config.
 */
function resolveConfig(flags, lenient) {
  const stateDir = process.env.OSHAL_CLI_STATE_DIR || path.join(os.homedir(), '.oshal');
  const fileConfig = loadCliConfig(stateDir);
  const contextName = String(flags.context || fileConfig.currentContext || 'default');
  const saved = (fileConfig.contexts || {})[contextName] || {};
  const url = String(flags.url || process.env.OSHAL_API_URL || process.env.OSHAL_CONTROL_PLANE_URL || saved.url || DEFAULT_URL)
    .replace(/\/+$/, '');
  const token = String(flags.token || process.env.OSHAL_CLI_TOKEN || saved.token || '').trim();
  const secret = String(flags.secret || process.env.SWARM_SERVICE_SECRET || saved.secret || '').trim();
  const sub = String(flags.sub || process.env.OSHAL_USER_SUB || saved.sub || '').trim();
  if (!lenient && !token && secret && !sub) {
    fail(EXIT_AUTH, 'A service secret needs an acting user: set OSHAL_USER_SUB or pass --sub.');
  }
  const timeoutMs = Math.max(1, Number(flags.timeout) || DEFAULT_TIMEOUT_S) * 1000;
  const pollMs = Math.max(100, Number(flags.poll) || DEFAULT_POLL_MS);
  return {
    url, token, secret, sub,
    session: flags.session ? String(flags.session) : undefined,
    json: flags.json === true, quiet: flags.quiet === true, noBanner: flags['no-banner'] === true,
    timeoutMs, pollMs, fresh: flags.new === true, stateDir, contextName, fileConfig,
  };
}

/** Auth headers: personal token (Bearer) first, then the trusted-service pair;
 *  empty against a MOCK_OIDC server. */
function authHeaders(cfg) {
  if (cfg.token) return { Authorization: `Bearer ${cfg.token}` };
  if (!cfg.secret) return {};
  return { 'X-Service-Secret': cfg.secret, 'x-oshal-user-sub': cfg.sub };
}

/**
 * @description One JSON round-trip to the controller. redirect:'manual' so the OIDC wall's
 * 302→/login (what a browser would follow) is surfaced as a clear auth failure instead of
 * an HTML soup parse error. Exits the process on auth walls; throws on transport errors.
 * @param {object} cfg - resolved config.
 * @param {string} method - HTTP method.
 * @param {string} pathname - path + query, e.g. '/api/jarvis/ask'.
 * @param {object} [body] - JSON body for POST.
 * @returns {Promise<any>} parsed JSON response.
 */
async function apiFetch(cfg, method, pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(cfg.url + pathname, {
      method,
      redirect: 'manual',
      signal: ctrl.signal,
      // Connection: close — no lingering keep-alive socket, so the one-shot commands
      // exit as soon as the loop drains (and never trip Windows' libuv teardown assert).
      headers: { 'Content-Type': 'application/json', Connection: 'close', ...authHeaders(cfg) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`cannot reach ${cfg.url} — ${err.cause?.code || err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 300 && res.status < 400) {
    fail(EXIT_AUTH, `auth required (redirected to sign-in). Set SWARM_SERVICE_SECRET + OSHAL_USER_SUB, or target a MOCK_OIDC dev server.`);
  }
  if (res.status === 401 || res.status === 403) {
    fail(EXIT_AUTH, `auth rejected (HTTP ${res.status}). Check SWARM_SERVICE_SECRET and OSHAL_USER_SUB.`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`non-JSON response (HTTP ${res.status}) from ${pathname}`); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status} from ${pathname}`);
  return data;
}

/** Path of the persisted session-state file. */
function stateFile(cfg) { return path.join(cfg.stateDir, 'swarm-cli-state.json'); }

/** Key for the current thread: one thread per controller+user pair. */
function stateKey(cfg) { return `${cfg.url}|${cfg.sub || 'oidc'}`; }

/**
 * @description Resolves the thread id for this run: explicit --session wins; --new mints a
 * fresh id; otherwise the persisted thread for this controller+user is reused (that is what
 * makes consecutive `ask` invocations one conversation, like the browser's localStorage id).
 * @param {object} cfg - resolved config.
 * @returns {string} a session id matching the server's /^[\w.-]{6,128}$/ contract.
 */
function resolveSession(cfg) {
  if (cfg.session) return cfg.session;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile(cfg), 'utf8')); } catch { /* first run */ }
  if (!cfg.fresh && state.sessions && state.sessions[stateKey(cfg)]) return state.sessions[stateKey(cfg)];
  const fresh = `cli-${crypto.randomUUID()}`;
  state.sessions = state.sessions || {};
  state.sessions[stateKey(cfg)] = fresh;
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    fs.writeFileSync(stateFile(cfg), JSON.stringify(state, null, 2));
  } catch (err) {
    note(cfg, `warning: could not persist session state (${err.message}); thread will not stick.`);
  }
  return fresh;
}

/** Status note to stderr — stdout stays pure answer/JSON for piping. `role` picks the color
 *  (status/handoff/error/success). Colored only when STDERR itself is a TTY (COLOR_ERR), so a
 *  redirected `2>file` never receives escape codes even when stdout is a terminal. */
function note(cfg, msg, role = 'status') {
  if (cfg.quiet) return;
  process.stderr.write(`${(uiErr[role] || uiErr.status)(msg)}\n`);
}

/** Abort with an exit code — throws (never hard-exits) so sockets can drain first. */
function fail(code, msg) {
  throw new CliError(code, msg);
}

/**
 * @description One full Jarvis turn, exactly like the chat window: POST /api/jarvis/ask
 * (202 + jobId) then poll GET /ask/result until done/error, bounded by cfg.timeoutMs.
 * @param {object} cfg - resolved config.
 * @param {string} sessionId - thread id.
 * @param {string} message - the user's message.
 * @returns {Promise<object>} the completed result ({ answer, dispatched, … }).
 */
async function askOnce(cfg, sessionId, message) {
  const accepted = await apiFetch(cfg, 'POST', '/api/jarvis/ask', { message, sessionId });
  if (!accepted.jobId) throw new Error(`ask not accepted: ${JSON.stringify(accepted)}`);
  const deadline = Date.now() + cfg.timeoutMs;
  for (;;) {
    if (Date.now() > deadline) fail(EXIT_TIMEOUT, `no answer within ${cfg.timeoutMs / 1000}s (job ${accepted.jobId} may still finish server-side; see 'tasks').`);
    await new Promise((r) => setTimeout(r, cfg.pollMs));
    const result = await apiFetch(cfg, 'GET', `/api/jarvis/ask/result?jobId=${encodeURIComponent(accepted.jobId)}`);
    if (result.status === 'pending') continue;
    if (result.status === 'error') throw new Error(result.error || 'jarvis turn failed');
    if (result.status === 'expired') throw new Error('job expired or not visible to this user (sub mismatch?)');
    return result;
  }
}

/** Print a completed turn: answer on stdout; handed-off work noted on stderr. */
function printResult(cfg, result) {
  if (cfg.json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  process.stdout.write(`${String(result.answer || '').trim()}\n`);
  for (const d of result.dispatched || []) {
    note(cfg, `${ARROW} handed off to the swarm: ${d.title || d.workJobId || d.ticketId || 'work item'}${d.ticketId ? ` (ticket ${d.ticketId})` : ''}`, 'handoff');
  }
}

/** One interactive line with an optional default; echoes normally. */
function promptText(question, def) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}${def ? ` [${def}]` : ''}: `, (a) => { rl.close(); resolve((a || def || '').trim()); });
  });
}

/** One interactive line with echo suppressed — for tokens and secrets. */
function promptHidden(question) {
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  process.stdout.write(`${question}: `);
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) => {
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

/**
 * @description `login` — the gh/kubectl-style sign-in. Collects controller URL + credentials
 * (flags or interactive prompts, secrets never echoed), verifies them against
 * GET /api/cli-tokens/whoami, and saves a named context. A service-secret login
 * BOOTSTRAP-MINTS a personal access token and stores THAT — the machine-wide secret is
 * never written to disk (falls back to storing it only if minting is unavailable).
 * @param {object} cfg - resolved config (used for defaults + state location).
 * @param {Record<string, string|boolean>} flags - raw CLI flags.
 */
async function cmdLogin(cfg, flags) {
  const url = String(flags.url || (await promptText('Controller URL', cfg.url))).replace(/\/+$/, '');
  let token = flags.token ? String(flags.token).trim() : '';
  let secret = flags.secret ? String(flags.secret).trim() : '';
  let sub = flags.sub ? String(flags.sub).trim() : '';
  if (!token && !secret) {
    token = await promptHidden('Personal access token (blank to bootstrap with the service secret)');
    if (!token) {
      secret = await promptHidden('Service secret');
      sub = await promptText('Act as user sub', cfg.sub || '');
      if (!secret || !sub) fail(EXIT_AUTH, 'login needs a personal token, or a service secret + sub.');
    }
  }
  const probe = { ...cfg, url, token, secret, sub };
  if (!token && secret) {
    try {
      const label = String(flags.label || `swarm-cli@${os.hostname()}`);
      const minted = await apiFetch(probe, 'POST', '/api/cli-tokens', { label });
      if (minted.token) {
        probe.token = minted.token;
        probe.secret = '';
        note(cfg, `minted personal token '${minted.label}' (id ${minted.id}) — the service secret will NOT be saved`);
      }
    } catch (err) {
      note(cfg, `could not mint a personal token (${err.message}); storing the service secret instead.`);
    }
  }
  const who = await apiFetch(probe, 'GET', '/api/cli-tokens/whoami');
  const file = cfg.fileConfig || {};
  file.contexts = file.contexts || {};
  file.contexts[cfg.contextName] = probe.token ? { url, token: probe.token } : { url, secret, sub };
  file.currentContext = cfg.contextName;
  saveCliConfig(cfg.stateDir, file);
  banner(cfg);
  process.stdout.write(`${ui.success(`${UNICODE ? '✓ ' : ''}Logged in`)} as ${who.sub}${who.operator ? ' (operator)' : ''} ${ARROW} ${url} [context: ${cfg.contextName}]\n`);
}

/** `logout` — forget the current (or --context named) context's credentials. */
async function cmdLogout(cfg) {
  const file = cfg.fileConfig || {};
  if (file.contexts && file.contexts[cfg.contextName]) {
    delete file.contexts[cfg.contextName];
    if (file.currentContext === cfg.contextName) delete file.currentContext;
    saveCliConfig(cfg.stateDir, file);
    process.stdout.write(`Logged out of context '${cfg.contextName}'.\n`);
  } else {
    note(cfg, `no stored context '${cfg.contextName}'`);
  }
}

/** `whoami` — the server-side view of the current credentials. */
async function cmdWhoami(cfg) {
  const who = await apiFetch(cfg, 'GET', '/api/cli-tokens/whoami');
  if (cfg.json) { process.stdout.write(`${JSON.stringify(who)}\n`); return; }
  process.stdout.write(`${who.sub}${who.email ? ` <${who.email}>` : ''}${who.operator ? ' (operator)' : ''} ${ARROW} ${cfg.url}\n`);
}

/** `tokens` — list your personal access tokens, or `tokens revoke <id>` one of them. */
async function cmdTokens(cfg, message) {
  const [verb, id] = message.split(/\s+/).filter(Boolean);
  if (verb === 'revoke') {
    if (!id) fail(EXIT_AUTH, 'usage: swarm-cli tokens revoke <id>');
    const result = await apiFetch(cfg, 'DELETE', `/api/cli-tokens/${encodeURIComponent(id)}`);
    process.stdout.write(result.revoked ? `revoked ${id}\n` : `nothing revoked (unknown id or already revoked)\n`);
    return;
  }
  const data = await apiFetch(cfg, 'GET', '/api/cli-tokens');
  if (cfg.json) { process.stdout.write(`${JSON.stringify(data)}\n`); return; }
  for (const t of data.tokens || []) {
    process.stdout.write(`${t.id}  ${t.revoked ? '[revoked]' : '[active] '}  ${t.label}  created ${t.createdAt}${t.lastUsedAt ? `  last used ${t.lastUsedAt}` : ''}\n`);
  }
  if (!(data.tokens || []).length) note(cfg, '(no tokens — mint one with: swarm-cli login)');
}

/** `ask` command — one-shot question. */
async function cmdAsk(cfg, message) {
  if (!message) fail(EXIT_AUTH, 'ask needs a message: swarm-cli ask "…"');
  const sessionId = resolveSession(cfg);
  note(cfg, `thread ${sessionId} ${ARROW} ${cfg.url}`);
  printResult(cfg, await askOnce(cfg, sessionId, message));
}

/** `chat` command — interactive REPL on the persistent thread. */
async function cmdChat(cfg) {
  let sessionId = resolveSession(cfg);
  banner(cfg);
  note(cfg, `Connected to ${cfg.url} (thread ${sessionId}). Type /help for commands, /exit to leave.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: ui.prompt(PROMPT), completer });
  // stdin can hit EOF (a pipe drains, or Ctrl-D) DURING an in-flight turn, which auto-closes
  // readline; calling rl.prompt() on a closed interface throws ERR_USE_AFTER_CLOSE and would
  // exit 1 after a perfectly good answer. Re-prompt only while it is still open.
  const reprompt = () => { if (!rl.closed) rl.prompt(); };
  // Run one slash-command; returns true if it was handled (so the loop re-prompts).
  const runSlash = async (text) => {
    switch (text) {
      case '/help': process.stdout.write(`${REPL_HELP}\n`); return true;
      case '/session': process.stdout.write(`${sessionId}\n`); return true;
      case '/clear': if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); return true;
      case '/new':
        sessionId = resolveSession({ ...cfg, session: undefined, fresh: true });
        note(cfg, `new thread ${sessionId}`); return true;
      case '/history': await cmdHistory({ ...cfg, session: sessionId }); return true;
      case '/catalog': await cmdCatalog(cfg); return true;
      case '/tasks': await cmdTasks(cfg); return true;
      case '/whoami': await cmdWhoami(cfg); return true;
      default: return false;
    }
  };
  reprompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { reprompt(); continue; }
    if (text === '/exit' || text === '/quit') break;
    if (text.startsWith('/')) {
      try {
        if (!(await runSlash(text))) note(cfg, `unknown command ${text} — /help for the list`, 'error');
      } catch (err) { note(cfg, `error: ${err.message}`, 'error'); }
      reprompt(); continue;
    }
    try {
      const result = await askOnce(cfg, sessionId, text);
      process.stdout.write(`${ui.jarvis('jarvis')}> ${String(result.answer || '').trim()}\n`);
      for (const d of result.dispatched || []) note(cfg, `${ARROW} handed off: ${d.title || 'work item'}`, 'handoff');
    } catch (err) {
      note(cfg, `error: ${err.message}`, 'error');
    }
    reprompt();
  }
  rl.close();
}

/** `history` command — replay the current thread's persisted turns. */
async function cmdHistory(cfg) {
  const sessionId = resolveSession(cfg);
  const data = await apiFetch(cfg, 'GET', `/api/jarvis/history?sessionId=${encodeURIComponent(sessionId)}`);
  if (cfg.json) { process.stdout.write(`${JSON.stringify(data)}\n`); return; }
  for (const t of data.turns || []) process.stdout.write(`${t.role === 'user' ? 'you' : 'jarvis'}> ${t.text}\n`);
  if (!(data.turns || []).length) note(cfg, `(empty thread ${sessionId})`);
}

/** `catalog` command — the apps Jarvis can reach (the surface's "what I can do" chips). */
async function cmdCatalog(cfg) {
  const data = await apiFetch(cfg, 'GET', '/api/jarvis/catalog');
  if (cfg.json) { process.stdout.write(`${JSON.stringify(data)}\n`); return; }
  for (const a of data.apps || []) process.stdout.write(`${c.cyan(String(a.key).padEnd(12))} ${a.name} ${c.gray(`— ${a.blurb}`)}\n`);
}

/** `completion` command — print the shell tab-completion script for bash / zsh / powershell.
 *  The scripts ship as package data (../completions relative to this bin/ entry point). */
function cmdCompletion(message) {
  const shell = String(message || '').trim().toLowerCase();
  const file = { bash: 'swarm-cli.bash', zsh: 'swarm-cli.zsh', powershell: 'swarm-cli.ps1', pwsh: 'swarm-cli.ps1', ps: 'swarm-cli.ps1' }[shell];
  if (!file) fail(EXIT_AUTH, 'usage: swarm-cli completion <bash|zsh|powershell>');
  try {
    process.stdout.write(fs.readFileSync(path.join(__dirname, '..', 'completions', file), 'utf8'));
  } catch (err) {
    fail(EXIT_ERROR, `completion script unavailable (${err.message})`);
  }
}

/** `version` command — this package's own version (bin/ → ../package.json), whether it was
 *  installed globally from npm, linked, or run straight out of the checkout. */
function cmdVersion() {
  let version = 'unknown';
  try { version = require('../package.json').version || version; } catch { /* payload without a manifest */ }
  process.stdout.write(`swarm-cli ${version}\n`);
}

/** Print the usage text; section headers colored when the terminal supports it. */
function printHelp() {
  const text = COLOR_ON ? USAGE.replace(/^(Commands:|Flags:)$/gm, (m) => c.bold(m)) : USAGE;
  process.stdout.write(`${text}\n`);
}

/** `tasks` command — durable handed-off work items + results (survives restarts). */
async function cmdTasks(cfg) {
  const data = await apiFetch(cfg, 'GET', '/api/jarvis/tasks');
  if (cfg.json) { process.stdout.write(`${JSON.stringify(data)}\n`); return; }
  for (const t of data.tasks || []) {
    process.stdout.write(`[${t.status}] ${t.title}${t.ticketId ? ` (ticket ${t.ticketId})` : ''}\n`);
    if (t.result && (t.status === 'done' || t.status === 'complete')) process.stdout.write(`    ${String(t.result).split('\n').join('\n    ')}\n`);
  }
  if (!(data.tasks || []).length) note(cfg, '(no tasks)');
}

/** Entry point. */
async function main() {
  const { cmd, message, flags } = parseArgs(process.argv.slice(2));
  // Credential-free commands: resolved before any config/server work.
  if (cmd === 'help' || flags.help) { printHelp(); return; }
  if (cmd === 'version' || flags.version) { cmdVersion(); return; }
  if (cmd === 'completion') { cmdCompletion(message); return; }
  const cfg = resolveConfig(flags, cmd === 'login');
  const commands = {
    login: () => cmdLogin(cfg, flags),
    logout: () => cmdLogout(cfg),
    whoami: () => cmdWhoami(cfg),
    tokens: () => cmdTokens(cfg, message),
    ask: () => cmdAsk(cfg, message),
    chat: () => cmdChat(cfg),
    history: () => cmdHistory(cfg),
    catalog: () => cmdCatalog(cfg),
    tasks: () => cmdTasks(cfg),
  };
  if (!commands[cmd]) fail(EXIT_AUTH, `unknown command '${cmd}' — try: swarm-cli help`);
  await commands[cmd]();
}

main().then(
  () => { process.exitCode = EXIT_OK; },
  (err) => {
    process.stderr.write(`${uiErr.error('swarm-cli:')} ${err.message}\n`);
    process.exitCode = err instanceof CliError ? err.code : EXIT_ERROR;
  },
);
