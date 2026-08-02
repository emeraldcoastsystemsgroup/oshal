/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | LIVE FIX (ADR-119 A2 drill, 2026-08-02): _inspectContainer's docker Go template was invalid on every container, so EVERY inspect threw and returned status:'not-found'/health:'unknown' — while still reporting success:true. Two defects in one format string: RestartCount is a TOP-LEVEL inspect field, not .State.RestartCount ("map has no entry for key RestartCount"), and .State.Health.Status was dereferenced unconditionally, which also errors on a container with no healthcheck. Consequence: the A2 verification loop could never observe health, so a successful restart would still escalate verify-failed. Template corrected + Health guarded with {{if .State.Health}}; the catch path now reports inspectOk:false instead of masquerading as a clean 'not-found', and check-container-health propagates that as success:false so an unreadable docker socket is never read as "the container is gone".
 */

/**
 * Self-Healing Bot Tools — Infrastructure remediation tool implementations
 * 
 * Provides Docker container health checking, restart, and log scanning capabilities.
 * These tools are registered via AGENT_MCP_TOOLS in the provision manifest and
 * auto-discovered by the dynamic tool scanner in app.js (PHASE_16).
 * 
 * Date: 2026-02-18
 */

const { execSync } = require('child_process');
const logger = require('../../utils/logger');

/**
 * Check Docker container health status.
 * Returns container state, health status, uptime, and recent restart count.
 * 
 * @param {Object} params - { container_name?: string, all?: boolean, exec?: Function }
 *   `exec` is an injected command runner (defaults to child_process.execSync). It exists
 *   so the regression guard can drive REAL docker output and a REAL inspect failure
 *   through this function instead of stubbing the function itself — the seam that broke
 *   here was the docker template, and a guard that replaces the observation cannot see it.
 * @returns {Object} Health check results
 */
async function checkContainerHealth(params = {}) {
  const { container_name, all, exec } = params;

  try {
    if (container_name) {
      // Check specific container. success mirrors inspectOk: a failed inspect is NOT an
      // observation, and the ADR-119 A2 verification loop must never read it as one.
      const result = _inspectContainer(container_name, exec || execSync);
      return {
        success: result.inspectOk === true,
        container: container_name,
        ...result,
      };
    }

    if (all) {
      // Check all swarm containers
      const containers = _listSwarmContainers();
      const results = containers.map(name => ({
        container: name,
        ..._inspectContainer(name, exec || execSync),
      }));

      const healthy = results.filter(r => r.status === 'running' && r.health === 'healthy').length;
      const unhealthy = results.filter(r => r.health === 'unhealthy' || r.status !== 'running').length;

      return {
        success: true,
        summary: {
          total: results.length,
          healthy,
          unhealthy,
          degraded: results.length - healthy - unhealthy,
        },
        containers: results,
      };
    }

    // Default: check all swarm containers
    return await checkContainerHealth({ all: true, exec });

  } catch (error) {
    return {
      success: false,
      error: error.message,
      container: container_name || 'all',
    };
  }
}

/**
 * Restart a Docker container.
 * Only allows restarting containers in the swarm whitelist.
 * 
 * @param {Object} params - { container_name: string, force?: boolean }
 * @returns {Object} Restart result
 */
async function restartContainer(params = {}) {
  const { container_name, force } = params;

  if (!container_name) {
    return { success: false, error: 'container_name is required' };
  }

  // Security: only allow swarm containers
  const ALLOWED_PREFIXES = ['swarm-', 'oshal-'];
  const isAllowed = ALLOWED_PREFIXES.some(p => container_name.startsWith(p));
  if (!isAllowed) {
    return {
      success: false,
      error: `Container ${container_name} is not in the allowed restart list. Only swarm-* and oshal-* containers can be restarted.`,
    };
  }

  try {
    // Check current state before restart
    const beforeState = _inspectContainer(container_name);
    logger.info(`[SelfHealing] Restarting ${container_name} (current state: ${beforeState.status}, health: ${beforeState.health})`);

    // Perform restart
    const cmd = force
      ? `docker restart -t 5 ${container_name}`
      : `docker restart ${container_name}`;

    execSync(cmd, { encoding: 'utf8', timeout: 30000 });

    // Wait for container to come back
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check state after restart
    const afterState = _inspectContainer(container_name);

    logger.info(`[SelfHealing] ✅ ${container_name} restarted (new state: ${afterState.status}, health: ${afterState.health})`);

    return {
      success: true,
      container: container_name,
      before: beforeState,
      after: afterState,
      action: force ? 'force-restart' : 'restart',
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    logger.error(`[SelfHealing] ❌ Failed to restart ${container_name}: ${error.message}`);
    return {
      success: false,
      container: container_name,
      error: error.message,
    };
  }
}

/**
 * Scan Docker logs for recent errors and categorize them.
 * Analyzes the last N lines of container logs for known error patterns.
 * 
 * @param {Object} params - { container_name?: string, tail?: number, since?: string }
 * @returns {Object} Log scan results with categorized errors
 */
async function scanErrorLogs(params = {}) {
  const { container_name, tail = 200, since } = params;

  try {
    const containers = container_name
      ? [container_name]
      : _listSwarmContainers();

    const results = [];

    for (const name of containers) {
      try {
        let cmd = `docker logs --tail ${tail}`;
        if (since) cmd += ` --since ${since}`;
        cmd += ` ${name} 2>&1`;

        const logs = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
        const lines = logs.split('\n').filter(l => l.trim());

        // Categorize errors
        const errors = [];
        const warnings = [];
        const criticals = [];

        const ERROR_PATTERNS = [
          { pattern: /ECONNREFUSED/i, category: 'connection', severity: 'high', description: 'Service connection refused' },
          { pattern: /ETIMEDOUT/i, category: 'timeout', severity: 'high', description: 'Connection timed out' },
          { pattern: /MCP.*timeout/i, category: 'mcp-timeout', severity: 'medium', description: 'MCP server initialization timeout' },
          { pattern: /AgentMemory.*failed/i, category: 'chromadb', severity: 'medium', description: 'AgentMemory/ChromaDB initialization failure' },
          { pattern: /fetch failed/i, category: 'network', severity: 'high', description: 'Network fetch failure' },
          { pattern: /redis.*error/i, category: 'redis', severity: 'critical', description: 'Redis connection error' },
          { pattern: /database.*error|postgres.*error/i, category: 'database', severity: 'critical', description: 'Database connection error' },
          { pattern: /OOMKilled|out of memory/i, category: 'memory', severity: 'critical', description: 'Out of memory' },
          { pattern: /SIGKILL|SIGTERM/i, category: 'signal', severity: 'high', description: 'Process killed by signal' },
          { pattern: /CrashLoopBackOff/i, category: 'crash-loop', severity: 'critical', description: 'Container in crash loop' },
          { pattern: /permission denied/i, category: 'permissions', severity: 'medium', description: 'Permission denied' },
          { pattern: /healthcheck.*failed|unhealthy/i, category: 'health', severity: 'high', description: 'Health check failure' },
        ];

        for (const line of lines) {
          for (const { pattern, category, severity, description } of ERROR_PATTERNS) {
            if (pattern.test(line)) {
              const entry = {
                category,
                severity,
                description,
                line: line.substring(0, 300),
                container: name,
              };

              if (severity === 'critical') criticals.push(entry);
              else if (severity === 'high') errors.push(entry);
              else warnings.push(entry);

              break; // Only match first pattern per line
            }
          }
        }

        results.push({
          container: name,
          totalLines: lines.length,
          criticals: criticals.filter(e => e.container === name),
          errors: errors.filter(e => e.container === name),
          warnings: warnings.filter(e => e.container === name),
        });

      } catch (logErr) {
        results.push({
          container: name,
          error: logErr.message,
          totalLines: 0,
          criticals: [],
          errors: [],
          warnings: [],
        });
      }
    }

    // Build summary
    const totalCriticals = results.reduce((sum, r) => sum + r.criticals.length, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
    const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);

    return {
      success: true,
      summary: {
        containersScanned: results.length,
        criticals: totalCriticals,
        errors: totalErrors,
        warnings: totalWarnings,
        overallHealth: totalCriticals > 0 ? 'CRITICAL' : totalErrors > 0 ? 'DEGRADED' : 'HEALTHY',
      },
      containers: results,
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

// ──────────────────────────────────────────────────────────────
// Private helpers
// ──────────────────────────────────────────────────────────────

/**
 * The docker inspect Go template every container observation reads.
 *
 * Exported so its guard can assert the two field paths that were WRONG in the shipped
 * version and broke the whole ADR-119 A2 verification loop:
 *   - `RestartCount` is a TOP-LEVEL inspect field. `.State.RestartCount` does not exist
 *     and makes the template a hard parse error on every container.
 *   - `.State.Health` is absent on containers with no healthcheck, so `.State.Health.Status`
 *     must be guarded — an unguarded deref errors on prometheus/alertmanager/cadvisor.
 * A template error means NO output at all, which the catch below used to report as a clean
 * `status: 'not-found'` — indistinguishable from a genuinely missing container.
 */
const INSPECT_FORMAT =
  '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
  + '|{{.State.StartedAt}}|{{.RestartCount}}|{{.Config.Image}}';

/**
 * Inspect a single Docker container and return structured status.
 *
 * `inspectOk` distinguishes "docker answered and the container is not there" from
 * "the inspect itself failed" (bad template, no socket, timeout). Callers MUST NOT
 * treat the second as an observation.
 */
function _inspectContainer(name, exec = execSync) {
  try {
    const output = exec(
      `docker inspect --format '${INSPECT_FORMAT}' ${name} 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    const [status, health, startedAt, restartCount, image] = output.split('|');

    // Calculate uptime
    const startTime = new Date(startedAt);
    const uptimeMs = Date.now() - startTime.getTime();
    const uptimeMinutes = Number.isFinite(startTime.getTime()) ? Math.floor(uptimeMs / 60000) : 0;

    return {
      inspectOk: true,
      status: status || 'unknown',
      health: health || 'none',
      startedAt: startedAt || 'unknown',
      uptimeMinutes,
      restartCount: parseInt(restartCount) || 0,
      image: image || 'unknown',
    };
  } catch (error) {
    return {
      inspectOk: false,
      status: 'inspect-failed',
      health: 'unknown',
      error: error.message,
      uptimeMinutes: 0,
      restartCount: 0,
    };
  }
}

/**
 * List all swarm-related Docker containers.
 */
function _listSwarmContainers() {
  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}" --filter "name=swarm-" --filter "name=oshal-" 2>/dev/null',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    return output.split('\n').filter(name => name.trim());
  } catch (error) {
    return [];
  }
}

// Export tool handlers with names matching the MCP tool definitions
/**
 * @description Public tool-handler surface for the self-healing bot. Keyed by the
 * exact MCP tool names so the dynamic tool scanner can bind each invocation to its
 * implementation; intended as the sole entry point consumed by the provision manifest.
 */
module.exports = {
  'check-container-health': checkContainerHealth,
  'restart-container': restartContainer,
  'scan-error-logs': scanErrorLogs,
  // Exposed for the regression guard only — the template is the artifact that broke.
  INSPECT_FORMAT,
  _inspectContainer,
};
