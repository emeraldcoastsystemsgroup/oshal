/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * MockUIBot — Client-side test harness for UI rendering
 * 
 * Generates a deterministic sequence of message objects that exercise
 * every MessageRenderer code-path. No server required.
 * 
 * Usage:
 *   const bot = new MockUIBot();
 *   const messages = bot.simulateTask();        // returns array
 *   const stream  = bot.simulateTaskStream();   // async generator (delayed)
 */

class MockUIBot {
  constructor() {
    this.tsCounter = Date.now();
  }

  /** Helper — auto-incrementing timestamp for message IDs */
  _ts() {
    return String(this.tsCounter++);
  }

  // ─── Full Task Simulation ────────────────────────────────────
  /**
   * Returns every message type the MessageRenderer handles, in a
   * realistic agent-execution order.
   */
  simulateTask() {
    return [
      // 1. API request starts
      this._apiReqStarted(0.0043, 'Analyze the project structure and suggest improvements.'),

      // 2. Thinking / reasoning
      this._reasoning(
        'Let me analyze the project structure first. I need to understand the directory layout, ' +
        'identify the key entry points, and review the package.json for dependencies. ' +
        'The user wants improvements, so I should look for code organization issues, ' +
        'missing error handling, and potential performance bottlenecks. ' +
        'I\'ll start by reading the root directory listing.'
      ),

      // 3. Tool: read a file
      this._tool('readFile', { path: 'src/server/app.js' }),

      // 4. Tool: list directory
      this._tool('listFilesTopLevel', {
        path: 'src/',
        content: 'src/\n├── server/\n│   ├── app.js\n│   ├── routes/\n│   └── middleware/\n├── client/\n│   ├── index.html\n│   └── js/\n└── package.json'
      }),

      // 5. Command — pending (no output yet)
      this._command('cat package.json | jq .dependencies'),

      // 6. Command — with output
      this._commandWithOutput(
        'npm audit --json | jq .metadata',
        '{\n  "vulnerabilities": {\n    "info": 0,\n    "low": 2,\n    "moderate": 1,\n    "high": 0,\n    "critical": 0\n  },\n  "dependencies": 347,\n  "devDependencies": 42\n}'
      ),

      // 7. Tool: edit a file
      this._tool('editedExistingFile', {
        path: 'src/server/middleware/errorHandler.js',
        content: [
          '/**',
          ' * Global error handler middleware',
          ' * Catches unhandled errors and returns structured JSON responses',
          ' */',
          'function errorHandler(err, req, res, next) {',
          '  const status = err.statusCode || 500;',
          '  const message = err.message || \'Internal Server Error\';',
          '',
          '  console.error(`[${new Date().toISOString()}] ${status} - ${message}`);',
          '',
          '  res.status(status).json({',
          '    error: true,',
          '    message,',
          '    ...(process.env.NODE_ENV === \'development\' && { stack: err.stack })',
          '  });',
          '}',
          '',
          'module.exports = errorHandler;'
        ].join('\n')
      }),

      // 8. Tool: search files
      this._tool('searchFiles', {
        path: 'src/',
        regex: 'console\\.log',
        content: 'src/server/app.js:14:  console.log(\'Server starting on port\', PORT);\nsrc/server/routes/api.js:8:  console.log(\'Request:\', req.method, req.path);\nsrc/client/js/main.js:22:  console.log(\'App initialized\');'
      }),

      // 9. Standard text response
      this._text(
        '## Analysis Complete\n\n' +
        'I\'ve reviewed the project structure and found several areas for improvement:\n\n' +
        '1. **Error Handling** — Added a global error handler middleware (`errorHandler.js`)\n' +
        '2. **Security** — Found 3 low/moderate vulnerabilities via `npm audit`\n' +
        '3. **Logging** — Identified 3 raw `console.log` calls that should use a structured logger\n\n' +
        '### Recommended Next Steps\n' +
        '- Replace `console.log` with `winston` or `pino`\n' +
        '- Run `npm audit fix` to resolve known vulnerabilities\n' +
        '- Add input validation middleware using `joi` or `zod`\n\n' +
        '> The error handler has already been created and is ready to wire into `app.js`.'
      ),

      // 10. Completion result
      this._completionResult(
        'Task completed successfully.\n\n' +
        '**Files created:** 1 (`src/server/middleware/errorHandler.js`)\n' +
        '**Files analyzed:** 6\n' +
        '**Issues found:** 3 (2 low vulns, 1 moderate vuln, 3 unstructured log calls)'
      ),
    ];
  }

  // ─── Async Streaming Variant ─────────────────────────────────
  /**
   * Yields messages one at a time with realistic delays.
   * Use with `for await (const msg of bot.simulateTaskStream()) { ... }`
   */
  async *simulateTaskStream(delayMs = 600) {
    const messages = this.simulateTask();
    for (const msg of messages) {
      await new Promise(r => setTimeout(r, delayMs));
      yield msg;
    }
  }

  // ─── Individual Error / Edge-Case Messages ───────────────────

  /** Generate an error message */
  getErrorMessage(text = 'Connection timed out after 30s — the API endpoint did not respond.') {
    return { ts: this._ts(), type: 'say', say: 'error', text };
  }

  /** Generate a user feedback message */
  getUserFeedback(text = 'Looks good, please continue with the deployment.') {
    return { ts: this._ts(), type: 'say', say: 'user_feedback', text };
  }

  /** Generate a follow-up question */
  getFollowup(question = 'Should I use TypeScript or JavaScript for the new service?') {
    return { ts: this._ts(), type: 'ask', ask: 'followup', text: JSON.stringify({ question }) };
  }

  // ─── Private Message Builders ────────────────────────────────

  _apiReqStarted(cost, request) {
    return {
      ts: this._ts(),
      type: 'say',
      say: 'api_req_started',
      text: JSON.stringify({ cost, request })
    };
  }

  _reasoning(text) {
    return { ts: this._ts(), type: 'say', say: 'reasoning', text };
  }

  _tool(toolName, opts = {}) {
    const payload = { tool: toolName, ...opts };
    return { ts: this._ts(), type: 'say', say: 'tool', text: JSON.stringify(payload) };
  }

  _command(cmd) {
    return { ts: this._ts(), type: 'say', say: 'command', text: cmd };
  }

  _commandWithOutput(cmd, output) {
    return {
      ts: this._ts(),
      type: 'say',
      say: 'command',
      text: `${cmd}<<COMMAND_OUTPUT>>${output}`
    };
  }

  _text(text) {
    return { ts: this._ts(), type: 'say', say: 'text', text };
  }

  _completionResult(text) {
    return { ts: this._ts(), type: 'say', say: 'completion_result', text };
  }
}

// Export for browser
if (typeof window !== 'undefined') {
  window.MockUIBot = MockUIBot;
}
