/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the no-shell execution path for registry CLI tools, extracted from cliTools.js (which reaches the 800-code-line decomposition threshold with these two functions inlined). cli_yq is the first caller: it previously concatenated model-supplied arguments into a command string for child_process.exec, which made every shell metacharacter executable syntax on a tool declared requiresApproval:false. These functions are the sibling fixes' landing place too, so the argv contract lives in one file with one set of tests.
 */

'use strict';

const { execFile } = require('child_process');

/**
 * @description Turns a tool's caller-supplied arguments into an argument VECTOR, so that the
 * characters a model writes are only ever data. There is no shell downstream of this function:
 * `&`, `|`, `;`, `$(…)`, backticks and newlines have no syntactic power and simply become
 * ordinary characters inside an argv entry.
 *
 * An array is taken verbatim — that is the lossless form and the one callers should prefer.
 * A string has to be split, and splitting is itself a parse, so the rules are stated here rather
 * than inherited from a shell: single quotes make a literal run, double quotes make a run in
 * which only `\"` and `\\` are escapes, a backslash outside quotes escapes the next character,
 * unquoted whitespace separates entries, and EVERY other character is literal. That keeps the
 * legitimate shape (`eval '.items[] | select(.active)' -`) intact while giving metacharacters
 * zero power. An unbalanced quote throws instead of guessing, because a silent mis-parse is how
 * an argument turns back into syntax.
 *
 * @param {string|string[]} args - Caller-supplied arguments, already authorization-checked.
 * @param {string} toolName - Tool name, used only for error text.
 * @returns {string[]} Argument vector to hand to execFile/spawn with shell:false.
 */
function cliArgsToArgv(args, toolName) {
  if (Array.isArray(args)) {
    // Array.from, not .map: .map SKIPS holes in a sparse array, so `['a', , 'b']` would pass the
    // per-entry check and the hole would reach execFile as the literal string "undefined".
    return Array.from(args, (entry, index) => {
      if (typeof entry !== 'string') {
        throw new Error(`${toolName} argv entry ${index} must be a string, received ${typeof entry}`);
      }
      return entry;
    });
  }
  if (typeof args !== 'string') {
    throw new Error(`${toolName} arguments must be a string or an array of strings`);
  }

  const argv = [];
  let current = '';
  let open = false;
  let quote = null;

  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote === "'") {
      if (ch === "'") { quote = null; } else { current += ch; }
    } else if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && (args[i + 1] === '"' || args[i + 1] === '\\')) {
        current += args[i + 1];
        i += 1;
      } else {
        current += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      open = true;
    } else if (ch === '\\' && i + 1 < args.length) {
      current += args[i + 1];
      i += 1;
      open = true;
    } else if (/\s/.test(ch)) {
      if (open) { argv.push(current); current = ''; open = false; }
    } else {
      current += ch;
      open = true;
    }
  }

  if (quote) {
    throw new Error(`${toolName} arguments end inside an unbalanced ${quote} quote; quote the value or pass argv as an array`);
  }
  if (open) argv.push(current);
  return argv;
}

/**
 * @description Runs a CLI binary with an argument vector and NO shell, which is the only way an
 * argument a model wrote cannot become a command. Optional `stdin` replaces the `echo '…' | tool`
 * pipe that a shell-string invocation needs: the payload is written to the child's stdin, where
 * quoting cannot escape anything.
 *
 * The options object handed to execFile is built field by field on purpose — spreading the
 * caller's options would let a future `{ shell: true }` reach the child and undo this.
 *
 * @param {string} file - Executable to run (resolved from PATH by the OS, not by a shell).
 * @param {string[]} argv - Argument vector; every entry is passed through verbatim.
 * @param {{timeout?: number, maxBuffer?: number, cwd?: string, stdin?: string}} [options] - Child options.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>} Trimmed child output.
 */
async function executeCLIArgv(file, argv, options = {}) {
  const {
    timeout = 60000,
    maxBuffer = 50 * 1024 * 1024, // 50MB
    cwd,
    stdin,
  } = options;

  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      argv,
      { maxBuffer, cwd, timeout, shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${error.message}\nStderr: ${stderr}`));
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
      },
    );
    if (child.stdin) {
      // A child that exits without reading (e.g. `--version`) makes the write EPIPE; that is the
      // child's business, not a tool failure, so it must not become an unhandled error event.
      child.stdin.on('error', () => {});
      if (typeof stdin === 'string' && stdin.length > 0) child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

module.exports = { cliArgsToArgv, executeCLIArgv };
