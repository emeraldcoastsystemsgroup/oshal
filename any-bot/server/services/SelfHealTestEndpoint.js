/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * SelfHealTestEndpoint — SelfHealable Contract for All Bots
 * 
 * Every bot in the swarm gets a `POST /api/selfheal/test` endpoint automatically.
 * This is the "SelfHealable contract" — the self-healing code deploy bot calls this
 * endpoint BEFORE and AFTER applying a fix to establish baseline and verify success.
 * 
 * ## Default Behavior (all bots)
 * - Health check returns 200
 * - Tool registry has expected tools loaded
 * - No recent crash/restart in last 60s
 * - Returns { pass: true, tests: [...] }
 * 
 * ## Custom Tests (opt-in)
 * Bots can register custom test functions via:
 *   SelfHealTestEndpoint.registerTest('test-name', async () => ({ pass, detail }))
 * 
 * ## Usage by Self-Healing Bot
 * 1. Call target bot's POST /api/selfheal/test (baseline)
 * 2. Apply fix
 * 3. Call POST /api/selfheal/test again (verification)
 * 4. Compare results → pass/fail
 * 
 * @see Issue #011 — Self-Healing Code Deploy Bot
 * Date: 2026-02-18
 */

const logger = require('../utils/logger');

/**
 * @description Implements the swarm-wide "SelfHealable" contract so the self-healing
 * deploy bot can probe any bot's liveness and health in a uniform way before and after
 * applying an automated fix. Bundles a fixed suite of default checks (process health,
 * tool registry, crash recency, memory pressure, event-loop responsiveness) with an
 * opt-in registry of per-bot custom checks, and exposes them over a single HTTP route.
 * Instantiated once and shared as an app-wide singleton (see module export).
 */
class SelfHealTestEndpoint {
  constructor() {
    this.customTests = new Map();
    this.toolRegistry = null;
    this.app = null;
  }

  /**
   * Initialize the SelfHealable endpoint and wire it into Express.
   * Called from app.js after tool registration is complete.
   * 
   * @param {Express} app - Express application
   * @param {ToolRegistry} toolRegistry - The bot's tool registry
   */
  initialize(app, toolRegistry) {
    this.app = app;
    this.toolRegistry = toolRegistry;

    // Register the selfheal test routes
    app.post('/api/selfheal/test', this._handleTest.bind(this));
    app.get('/api/selfheal/test', this._handleTest.bind(this));

    const agentId = process.env.AGENT_ID || 'unknown';
    logger.info(`🩺 [SelfHealTest] Endpoint registered for ${agentId}: POST/GET /api/selfheal/test`);
  }

  /**
   * Register a custom test function for this bot.
   * Custom tests run IN ADDITION to the default tests.
   * 
   * @param {string} name - Test name (e.g., 'vertex-ai-connectivity')
   * @param {Function} testFn - Async function returning { pass: boolean, detail: string }
   */
  registerTest(name, testFn) {
    this.customTests.set(name, testFn);
    logger.info(`🩺 [SelfHealTest] Custom test registered: ${name}`);
  }

  /**
   * Handle the selfheal test request.
   * Runs all default tests + any custom tests, returns aggregate results.
   */
  async _handleTest(req, res) {
    const agentId = process.env.AGENT_ID || 'unknown';
    const startTime = Date.now();

    try {
      const results = [];

      // ─── Default Test 1: Health Check ────────────────────────
      results.push(await this._testHealthCheck());

      // ─── Default Test 2: Tool Registry ───────────────────────
      results.push(await this._testToolRegistry());

      // ─── Default Test 3: No Recent Crashes ───────────────────
      results.push(await this._testNoCrashes());

      // ─── Default Test 4: Memory Usage ────────────────────────
      results.push(await this._testMemoryUsage());

      // ─── Default Test 5: Event Loop Responsiveness ───────────
      results.push(await this._testEventLoop());

      // ─── Custom Tests ────────────────────────────────────────
      for (const [name, testFn] of this.customTests.entries()) {
        try {
          const result = await Promise.race([
            testFn(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), 10000)),
          ]);
          results.push({
            name,
            pass: !!result.pass,
            detail: result.detail || '',
            type: 'custom',
          });
        } catch (err) {
          results.push({
            name,
            pass: false,
            detail: `Custom test error: ${err.message}`,
            type: 'custom',
          });
        }
      }

      // ─── Aggregate ──────────────────────────────────────────
      const passed = results.filter(r => r.pass).length;
      const failed = results.filter(r => !r.pass).length;
      const overallPass = failed === 0;
      const durationMs = Date.now() - startTime;

      const response = {
        pass: overallPass,
        agent_id: agentId,
        timestamp: new Date().toISOString(),
        duration_ms: durationMs,
        summary: {
          total: results.length,
          passed,
          failed,
        },
        tests: results,
      };

      const statusCode = overallPass ? 200 : 500;
      logger.info(`🩺 [SelfHealTest] ${agentId}: ${passed}/${results.length} tests passed (${durationMs}ms)`);

      res.status(statusCode).json(response);

    } catch (error) {
      logger.error(`🩺 [SelfHealTest] Error running tests: ${error.message}`);
      res.status(500).json({
        pass: false,
        agent_id: agentId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // Default Tests
  // ════════════════════════════════════════════════════════════

  async _testHealthCheck() {
    try {
      // The bot is running if this code executes — that's the test
      return {
        name: 'health-check',
        pass: true,
        detail: 'Bot process is running and responding',
        type: 'default',
      };
    } catch (err) {
      return { name: 'health-check', pass: false, detail: err.message, type: 'default' };
    }
  }

  async _testToolRegistry() {
    try {
      if (!this.toolRegistry) {
        return {
          name: 'tool-registry',
          pass: true,
          detail: 'No tool registry configured (base bot)',
          type: 'default',
        };
      }

      const toolCount = this.toolRegistry.count ? this.toolRegistry.count() : 0;
      const expectedMin = parseInt(process.env.EXPECTED_TOOL_COUNT || '0', 10);

      // If AGENT_MCP_TOOLS is defined, we expect tools to be loaded
      const hasMcpTools = !!process.env.AGENT_MCP_TOOLS;
      let pass = true;
      let detail = `${toolCount} tools registered`;

      if (hasMcpTools && toolCount === 0) {
        pass = false;
        detail = 'AGENT_MCP_TOOLS defined but no tools registered';
      } else if (expectedMin > 0 && toolCount < expectedMin) {
        pass = false;
        detail = `Expected at least ${expectedMin} tools, got ${toolCount}`;
      }

      return { name: 'tool-registry', pass, detail, type: 'default' };
    } catch (err) {
      return { name: 'tool-registry', pass: false, detail: err.message, type: 'default' };
    }
  }

  async _testNoCrashes() {
    try {
      // Check uptime — if process started less than 60s ago, it may have just crashed
      const uptimeSeconds = process.uptime();
      const pass = uptimeSeconds > 30; // Allow 30s grace after startup
      const detail = pass
        ? `Process uptime: ${Math.floor(uptimeSeconds)}s`
        : `Process recently restarted (uptime: ${Math.floor(uptimeSeconds)}s) — possible crash`;

      return { name: 'no-recent-crashes', pass, detail, type: 'default' };
    } catch (err) {
      return { name: 'no-recent-crashes', pass: false, detail: err.message, type: 'default' };
    }
  }

  async _testMemoryUsage() {
    try {
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
      const rssMB = Math.round(memUsage.rss / 1024 / 1024);

      // Fail if RSS > 1GB (likely memory leak)
      const pass = rssMB < 1024;
      const detail = `RSS: ${rssMB}MB, Heap: ${heapUsedMB}/${heapTotalMB}MB`;

      return { name: 'memory-usage', pass, detail, type: 'default' };
    } catch (err) {
      return { name: 'memory-usage', pass: false, detail: err.message, type: 'default' };
    }
  }

  async _testEventLoop() {
    try {
      const start = Date.now();
      await new Promise(resolve => setImmediate(resolve));
      const lag = Date.now() - start;

      // Fail if event loop lag > 500ms (severely blocked)
      const pass = lag < 500;
      const detail = `Event loop lag: ${lag}ms`;

      return { name: 'event-loop', pass, detail, type: 'default' };
    } catch (err) {
      return { name: 'event-loop', pass: false, detail: err.message, type: 'default' };
    }
  }
}

// Singleton — shared across the app
/**
 * @description Shared singleton instance of {@link SelfHealTestEndpoint}. A single
 * instance is exported so every part of the app (route wiring and any module
 * registering custom tests) operates on the same test registry and Express binding.
 */
module.exports = new SelfHealTestEndpoint();
