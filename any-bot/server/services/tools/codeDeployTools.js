/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: genericized internal host project-root default path (removed internal username)
 */

/**
 * Code Deploy Tools — Self-Healing Code Deploy Bot Pipeline
 * 
 * 8-tool autonomous pipeline: IDENTIFY → RESEARCH → PULL → FIX →
 * PACKAGE → DEPLOY → TEST → VERIFY/REVERT
 * 
 * Auto-discovered by app.js dynamic tool file scanning (PHASE_16).
 * Keys match mcp_tools[].name in provision-manifest.json.
 * 
 * @see Issue #011 — Self-Healing Code Deploy Bot
 * Date: 2026-02-18
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const logger = require('../../utils/logger');

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════
const PROJECT_ROOT = process.env.HOST_PROJECT_ROOT || '/Users/you/Projects/oshal';
const GIT_REMOTE = 'git@github.com:oshal-maintainer/oshal.git';
const ALLOWED_PREFIXES = ['swarm-', 'oshal-'];
const MAX_FIX_ATTEMPTS = 3;
const SELFHEAL_TEST_TIMEOUT = 15000;

// ═══════════════════════════════════════════════════════════════
// TOOL 1: identify-target-bot
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 1 (IDENTIFY): pinpoints the single swarm/oshal
 * container the self-healing run should act on, so downstream tools target the
 * right bot. Matches by explicit name, by published host port, and finally by
 * scanning recent logs for an error pattern, then returns a normalized snapshot
 * (status, health, port, persona, restart count) of the chosen target.
 * @param {Object} [params] Search criteria; at least one field is recommended.
 * @param {string|number} [params.port] Host port the target publishes, used to filter candidates.
 * @param {string} [params.container_name] Exact or partial container name to match.
 * @param {string} [params.error_pattern] Regex (case-insensitive) matched against recent container logs when other criteria find nothing.
 * @returns {Promise<Object>} Result with `success`; on success a `target` snapshot plus `all_matches`, otherwise an `error` string.
 */
async function identifyTargetBot(params = {}) {
  const { port, container_name, error_pattern } = params;
  try {
    const containers = _listSwarmContainers();
    let matches = [];

    if (container_name) {
      const found = containers.find(c => c.name === container_name || c.name.includes(container_name));
      if (found) matches = [found];
    }

    if (port) {
      const portMatches = containers.filter(c => {
        try {
          const inspect = execSync(
            `docker inspect --format '{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}={{(index $conf 0).HostPort}} {{end}}' ${c.name} 2>/dev/null`,
            { encoding: 'utf8', timeout: 5000 }
          ).trim();
          return inspect.includes(`:${port}`) || inspect.includes(`=${port}`);
        } catch { return false; }
      });
      matches = matches.length ? matches.filter(m => portMatches.some(p => p.name === m.name)) : portMatches;
    }

    if (error_pattern && matches.length === 0) {
      for (const c of containers) {
        try {
          const logs = execSync(`docker logs --tail 100 ${c.name} 2>&1`, { encoding: 'utf8', timeout: 10000 });
          if (new RegExp(error_pattern, 'i').test(logs)) {
            matches.push({ ...c, error_match: true });
          }
        } catch { /* skip */ }
      }
    }

    if (matches.length === 0) {
      return { success: false, error: 'No matching bot found', search: { port, container_name, error_pattern } };
    }

    const target = matches[0];
    const inspect = JSON.parse(execSync(`docker inspect ${target.name} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }));
    const info = inspect[0] || {};
    const envVars = (info.Config?.Env || []).reduce((acc, e) => {
      const [k, ...v] = e.split('=');
      acc[k] = v.join('=');
      return acc;
    }, {});

    const hostPort = _getHostPort(info);

    return {
      success: true,
      target: {
        container_name: target.name,
        agent_id: envVars.AGENT_ID || 'unknown',
        status: info.State?.Status || 'unknown',
        health: info.State?.Health?.Status || 'none',
        port: hostPort,
        image: info.Config?.Image || 'unknown',
        persona: envVars.BOT_PERSONA_FILE || 'unknown',
        started_at: info.State?.StartedAt,
        restart_count: info.RestartCount || 0,
      },
      all_matches: matches.map(m => m.name),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL 2: research-error
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 2 (RESEARCH): turns a raw error into an actionable
 * analysis before any code is touched, enriching it with recent container error
 * logs and producing a categorization, a best-guess source file, suggested web
 * search queries, and common fixes. Deliberately mandates external research so a
 * fix is grounded rather than guessed.
 * @param {Object} [params] Inputs describing the failure.
 * @param {string} params.error_message Required. The error text to analyze and categorize.
 * @param {string} [params.container_name] Container whose recent logs are appended as additional error context.
 * @param {string} [params.context] Free-form extra context echoed back in the analysis.
 * @returns {Promise<Object>} Result with `success`; on success a `research` analysis object, otherwise an `error` string.
 */
async function researchError(params = {}) {
  const { error_message, container_name, context } = params;
  if (!error_message) return { success: false, error: 'error_message is required' };

  try {
    let errorContext = error_message;
    if (container_name) {
      try {
        const logs = execSync(`docker logs --tail 50 ${container_name} 2>&1`, { encoding: 'utf8', timeout: 10000 });
        const errorLines = logs.split('\n').filter(l => /error|fail|exception|crash/i.test(l)).slice(-10);
        errorContext += '\n\nRecent error logs:\n' + errorLines.join('\n');
      } catch { /* proceed without logs */ }
    }

    const analysis = {
      error_message,
      error_type: _categorizeError(error_message),
      likely_file: _guessSourceFile(error_message),
      suggested_search_queries: [
        `Node.js ${error_message.substring(0, 80)}`,
        `Docker container ${_categorizeError(error_message)} fix`,
        error_message.match(/(\w+Error|ECONN\w+|ETIMED\w+)/)?.[1] || error_message.substring(0, 50),
      ],
      research_mandate: 'MANDATORY: Use Google Search MCP to research these queries before attempting any fix.',
      common_fixes: _suggestCommonFixes(_categorizeError(error_message)),
    };

    if (context) analysis.additional_context = context;

    return { success: true, research: analysis };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL 3: git-pull-latest
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 3 (PULL): brings the project working tree up to
 * date so a fix is applied against current code, optionally stashing local
 * changes first, switching to the requested branch, pulling from origin, and
 * reporting each step plus the resulting HEAD commit.
 * @param {Object} [params] Pull options.
 * @param {string} [params.branch='main'] Branch to check out (if needed) and pull.
 * @param {boolean} [params.stash_first=true] Whether to `git stash` local changes before pulling.
 * @returns {Promise<Object>} Step-by-step results including `current_branch`, `head_commit`, and `success`; on failure an `error` string.
 */
async function gitPullLatest(params = {}) {
  const { branch = 'main', stash_first = true } = params;

  try {
    const results = { steps: [] };

    if (stash_first) {
      try {
        const stashOut = execSync(`cd ${PROJECT_ROOT} && git stash`, { encoding: 'utf8', timeout: 15000 });
        results.steps.push({ action: 'stash', output: stashOut.trim(), success: true });
        results.stash_created = !stashOut.includes('No local changes');
      } catch (e) {
        results.steps.push({ action: 'stash', error: e.message, success: false });
      }
    }

    const currentBranch = execSync(`cd ${PROJECT_ROOT} && git branch --show-current`, { encoding: 'utf8', timeout: 5000 }).trim();
    results.current_branch = currentBranch;

    if (currentBranch !== branch) {
      const checkout = execSync(`cd ${PROJECT_ROOT} && git checkout ${branch}`, { encoding: 'utf8', timeout: 10000 });
      results.steps.push({ action: 'checkout', branch, output: checkout.trim(), success: true });
    }

    const pullOut = execSync(`cd ${PROJECT_ROOT} && git pull origin ${branch} 2>&1`, { encoding: 'utf8', timeout: 30000 });
    results.steps.push({ action: 'pull', output: pullOut.trim(), success: true });

    const headCommit = execSync(`cd ${PROJECT_ROOT} && git log --oneline -1`, { encoding: 'utf8', timeout: 5000 }).trim();
    results.head_commit = headCommit;
    results.success = true;

    return results;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL 4: analyze-and-fix-code
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 4 (FIX): applies a targeted single-occurrence
 * search/replace edit to a project file, always writing a `.selfheal.bak`
 * backup first so the change is reversible. Enforces that the path stays inside
 * the project root for safety; when no replacement is supplied it instead
 * returns file info so the caller can craft an exact edit.
 * @param {Object} [params] Fix parameters.
 * @param {string} params.file_path Required. Absolute path, or path relative to the project root, of the file to edit.
 * @param {string} [params.error_message] Contextual error being fixed (informational).
 * @param {string} [params.fix_description] Human description of the intended fix (informational).
 * @param {string} [params.search_text] Exact text to locate; paired with replace_text to apply a change.
 * @param {string} [params.replace_text] Replacement text substituted for the first match of search_text.
 * @returns {Promise<Object>} Result with `success`; on a successful edit includes `backup_path`, `changes`/diff, and a `revert_command`, otherwise file info or an `error`.
 */
async function analyzeAndFixCode(params = {}) {
  const { file_path, error_message, fix_description, search_text, replace_text } = params;

  if (!file_path) return { success: false, error: 'file_path is required' };

  try {
    const fullPath = file_path.startsWith('/') ? file_path : path.join(PROJECT_ROOT, file_path);

    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${fullPath}` };
    }

    if (!fullPath.startsWith(PROJECT_ROOT)) {
      return { success: false, error: 'Security: file_path must be within the project root' };
    }

    const originalContent = fs.readFileSync(fullPath, 'utf8');
    const backupPath = fullPath + '.selfheal.bak';
    fs.writeFileSync(backupPath, originalContent);

    let newContent = originalContent;
    let changesMade = false;

    if (search_text && replace_text) {
      if (originalContent.includes(search_text)) {
        newContent = originalContent.replace(search_text, replace_text);
        changesMade = true;
      } else {
        return {
          success: false,
          error: 'search_text not found in file',
          file_path: fullPath,
          file_length: originalContent.length,
          hint: 'Verify exact whitespace and content of search_text',
        };
      }
    }

    if (changesMade) {
      fs.writeFileSync(fullPath, newContent);
      const diff = _generateSimpleDiff(originalContent, newContent, fullPath);

      return {
        success: true,
        file_path: fullPath,
        backup_path: backupPath,
        changes: {
          original_length: originalContent.length,
          new_length: newContent.length,
          diff_summary: diff,
        },
        revert_command: `cp "${backupPath}" "${fullPath}"`,
        note: 'Backup created. Use revert-and-escalate tool to undo if tests fail.',
      };
    }

    return {
      success: true,
      file_path: fullPath,
      file_info: {
        length: originalContent.length,
        lines: originalContent.split('\n').length,
        first_100_chars: originalContent.substring(0, 100),
      },
      message: 'File read successfully. Provide search_text and replace_text to apply a fix.',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL 5: package-and-build
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 5 (PACKAGE): prepares the fixed code for
 * deployment. Because bot containers live-mount the server source, the default
 * path is a no-op that simply advises a restart; only when an image rebuild is
 * explicitly requested does it run `docker build` against the any-bot Dockerfile
 * and tag a fresh image.
 * @param {Object} [params] Packaging options.
 * @param {string} params.container_name Required. Container the package step is targeting.
 * @param {boolean} [params.build_image=false] When false, treats code as live-mounted; when true, performs a Docker image build.
 * @param {string} [params.image_tag] Tag for the built image; required when build_image is true.
 * @returns {Promise<Object>} Result with `success`, the chosen `action`, and a `next_step` hint, or an `error` string on failure.
 */
async function packageAndBuild(params = {}) {
  const { container_name, build_image = false, image_tag } = params;

  if (!container_name) return { success: false, error: 'container_name is required' };

  try {
    if (!build_image) {
      return {
        success: true,
        action: 'live-mount',
        message: `Live code mount detected. Changes to any-bot/server/ are already visible in ${container_name}. Just restart the container to pick up changes (Node.js require cache clear).`,
        next_step: 'Use deploy-container tool to restart',
      };
    }

    if (!image_tag) return { success: false, error: 'image_tag required when build_image is true' };

    const buildContext = path.join(PROJECT_ROOT, 'any-bot');
    if (!fs.existsSync(path.join(buildContext, 'Dockerfile'))) {
      return { success: false, error: `No Dockerfile found in ${buildContext}` };
    }

    const buildCmd = `docker build -t ${image_tag} ${buildContext}`;
    logger.info(`[CodeDeploy] Building image: ${buildCmd}`);
    const buildOut = execSync(buildCmd, { encoding: 'utf8', timeout: 300000 });

    return {
      success: true,
      action: 'docker-build',
      image_tag,
      build_output_tail: buildOut.split('\n').slice(-10).join('\n'),
      next_step: 'Use deploy-container tool to restart with new image',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL 6: deploy-container
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 6 (DEPLOY): restarts the target container so it
 * picks up the fixed code, then waits and re-inspects to confirm it came back
 * running and healthy. Restricts action to allow-listed container prefixes as a
 * safety guard and reports before/after state for auditing.
 * @param {Object} [params] Deploy options.
 * @param {string} params.container_name Required. Container to restart; must start with an allowed prefix (swarm-/oshal-).
 * @param {boolean} [params.force=false] When true, restarts with a shortened 5s stop timeout.
 * @param {number} [params.wait_seconds=15] Seconds to wait after restart before re-inspecting health.
 * @returns {Promise<Object>} Result whose `success` reflects whether the container is running, plus `before`/`after` state and `healthy`; on failure an `error` string.
 */
async function deployContainer(params = {}) {
  const { container_name, force = false, wait_seconds = 15 } = params;

  if (!container_name) return { success: false, error: 'container_name is required' };
  if (!ALLOWED_PREFIXES.some(p => container_name.startsWith(p))) {
    return { success: false, error: `Security: Only ${ALLOWED_PREFIXES.join(', ')} containers allowed` };
  }

  try {
    const beforeState = _quickInspect(container_name);
    logger.info(`[CodeDeploy] Deploying ${container_name} (before: ${beforeState.status}/${beforeState.health})`);

    const cmd = force ? `docker restart -t 5 ${container_name}` : `docker restart ${container_name}`;
    execSync(cmd, { encoding: 'utf8', timeout: 30000 });

    await new Promise(resolve => setTimeout(resolve, wait_seconds * 1000));

    const afterState = _quickInspect(container_name);

    const deployed = afterState.status === 'running';
    const healthy = afterState.health === 'healthy' || afterState.health === 'none';

    logger.info(`[CodeDeploy] ${deployed ? '✅' : '❌'} ${container_name} deploy: ${afterState.status}/${afterState.health}`);

    return {
      success: deployed,
      container_name,
      before: beforeState,
      after: afterState,
      healthy,
      wait_seconds,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return { success: false, error: error.message, container_name };
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL 7: run-selfheal-test
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 7 (TEST): verifies the deployed fix actually works
 * by calling the bot's own `/api/selfheal/test` endpoint and reporting a
 * pass/fail verdict. Resolves the host port from the container when not given,
 * and treats a non-responsive endpoint as a failure (the bot may still be down).
 * @param {Object} [params] Test target.
 * @param {string|number} [params.port] Host port to call; if omitted it is derived from container_name.
 * @param {string} [params.container_name] Container used to look up the port when port is not supplied. One of port/container_name is required.
 * @param {string} [params.host='localhost'] Hostname to send the test request to.
 * @returns {Promise<Object>} Result with `success`, a boolean `pass`, plus `summary`/`tests` from the endpoint, or an `error` with `pass:false` on failure.
 */
async function runSelfhealTest(params = {}) {
  const { container_name, port, host = 'localhost' } = params;

  if (!port && !container_name) return { success: false, error: 'port or container_name required' };

  try {
    let targetPort = port;
    if (!targetPort && container_name) {
      const info = JSON.parse(execSync(`docker inspect ${container_name} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }));
      targetPort = _getHostPort(info[0] || {});
    }

    if (!targetPort) {
      return { success: false, error: `Could not determine port for ${container_name}` };
    }

    const result = await _httpRequest({
      hostname: host,
      port: parseInt(targetPort),
      path: '/api/selfheal/test',
      method: 'POST',
      timeout: SELFHEAL_TEST_TIMEOUT,
    });

    return {
      success: true,
      test_result: result,
      pass: result.pass === true,
      summary: result.summary || {},
      tests: result.tests || [],
      target: { host, port: targetPort, container_name },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      pass: false,
      target: { port, container_name },
      note: 'Bot may be down or selfheal test endpoint not responding',
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL 8: revert-and-escalate
// ═══════════════════════════════════════════════════════════════
/**
 * @description Pipeline stage 8 (VERIFY/REVERT): the safety net for a failed
 * fix. Restores the file from its `.selfheal.bak` backup (falling back to `git
 * checkout`), restarts the container onto the reverted code, gathers recent logs,
 * and builds an escalation report that either signals a retry is still available
 * or, once the attempt cap is reached, hands off to the user with suggested
 * actions.
 * @param {Object} [params] Revert/escalation inputs.
 * @param {string} [params.file_path] File to restore from backup or git; absolute or relative to the project root.
 * @param {string} [params.container_name] Container to restart after reverting and to pull recent logs from.
 * @param {string} [params.error_message] Error that triggered the revert, included in the escalation report.
 * @param {number} [params.attempt_number=1] Current attempt count, compared against the max-attempts cap to decide retry vs. escalate.
 * @param {string} [params.escalation_notes] Free-form notes carried into the escalation report.
 * @returns {Promise<Object>} Result with `success`, a `reverted` flag, per-step details, and an `escalation` object indicating retry availability or user hand-off; on failure an `error` string.
 */
async function revertAndEscalate(params = {}) {
  const { file_path, container_name, error_message, attempt_number = 1, escalation_notes } = params;

  try {
    const results = { reverted: false, steps: [] };

    // Step 1: Revert code changes
    if (file_path) {
      const fullPath = file_path.startsWith('/') ? file_path : path.join(PROJECT_ROOT, file_path);
      const backupPath = fullPath + '.selfheal.bak';

      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, fullPath);
        fs.unlinkSync(backupPath);
        results.reverted = true;
        results.steps.push({ action: 'revert-file', path: fullPath, success: true });
        logger.info(`[CodeDeploy] ↩️ Reverted ${fullPath} from backup`);
      } else {
        try {
          execSync(`cd ${PROJECT_ROOT} && git checkout -- "${file_path}"`, { encoding: 'utf8', timeout: 10000 });
          results.reverted = true;
          results.steps.push({ action: 'git-checkout', path: file_path, success: true });
        } catch (gitErr) {
          results.steps.push({ action: 'revert-failed', error: gitErr.message, success: false });
        }
      }
    }

    // Step 2: Restart container to pick up reverted code
    if (container_name && results.reverted) {
      try {
        execSync(`docker restart ${container_name}`, { encoding: 'utf8', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 10000));
        const state = _quickInspect(container_name);
        results.steps.push({ action: 'restart-after-revert', status: state.status, health: state.health, success: true });
      } catch (restartErr) {
        results.steps.push({ action: 'restart-failed', error: restartErr.message, success: false });
      }
    }

    // Step 3: Collect error logs for analysis
    let recentLogs = '';
    if (container_name) {
      try {
        recentLogs = execSync(`docker logs --tail 50 ${container_name} 2>&1`, { encoding: 'utf8', timeout: 10000 });
      } catch { /* proceed */ }
    }

    // Step 4: Build escalation report
    const canRetry = attempt_number < MAX_FIX_ATTEMPTS;
    const escalation = {
      status: canRetry ? 'RETRY_AVAILABLE' : 'ESCALATE_TO_USER',
      attempt_number,
      max_attempts: MAX_FIX_ATTEMPTS,
      error_message: error_message || 'Fix failed verification',
      file_path,
      container_name,
      recent_logs: recentLogs.split('\n').slice(-20).join('\n'),
      escalation_notes: escalation_notes || '',
    };

    if (!canRetry) {
      escalation.user_action_required = {
        message: 'All automated fix attempts have failed. Please review the error and provide guidance.',
        suggested_actions: [
          'Review the error logs above',
          'Check the file at: ' + (file_path || 'unknown'),
          'Update the Plane ticket with any changes you would like to try',
          'Return the ticket to the self-healing bot to retry with your guidance',
        ],
      };
    }

    results.escalation = escalation;
    results.success = true;

    logger.info(`[CodeDeploy] ${canRetry ? '🔄' : '🚨'} Attempt ${attempt_number}/${MAX_FIX_ATTEMPTS} — ${canRetry ? 'retry available' : 'escalating to user'}`);

    return results;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// Private Helpers
// ═══════════════════════════════════════════════════════════════

function _listSwarmContainers() {
  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" --filter "name=swarm-" --filter "name=oshal-" 2>/dev/null',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return output.split('\n').filter(l => l.trim()).map(line => {
      const [name, status, image] = line.split('|');
      return { name, status, image };
    });
  } catch { return []; }
}

function _getHostPort(inspectData) {
  const ports = inspectData?.NetworkSettings?.Ports || inspectData?.HostConfig?.PortBindings || {};
  for (const [, bindings] of Object.entries(ports)) {
    if (Array.isArray(bindings) && bindings.length > 0 && bindings[0].HostPort) {
      return bindings[0].HostPort;
    }
  }
  const env = (inspectData?.Config?.Env || []).find(e => e.startsWith('PORT='));
  return env ? env.split('=')[1] : null;
}

function _quickInspect(name) {
  try {
    const format = '{{.State.Status}}|{{.State.Health.Status}}|{{.State.StartedAt}}';
    const output = execSync(`docker inspect --format '${format}' ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
    const [status, health, startedAt] = output.split('|');
    return { status: status || 'unknown', health: health || 'none', startedAt };
  } catch {
    return { status: 'not-found', health: 'unknown' };
  }
}

function _categorizeError(msg) {
  if (/ECONNREFUSED/i.test(msg)) return 'connection-refused';
  if (/ETIMEDOUT/i.test(msg)) return 'timeout';
  if (/404|not found/i.test(msg)) return 'not-found';
  if (/500|internal server/i.test(msg)) return 'server-error';
  if (/ENOMEM|out of memory|OOMKill/i.test(msg)) return 'memory';
  if (/permission denied/i.test(msg)) return 'permissions';
  if (/SyntaxError|unexpected token/i.test(msg)) return 'syntax-error';
  if (/TypeError|undefined is not/i.test(msg)) return 'type-error';
  if (/ReferenceError|is not defined/i.test(msg)) return 'reference-error';
  if (/ENOENT|no such file/i.test(msg)) return 'file-not-found';
  if (/redis/i.test(msg)) return 'redis-error';
  if (/chroma|chromadb/i.test(msg)) return 'chromadb-error';
  return 'unknown';
}

function _guessSourceFile(msg) {
  const fileMatch = msg.match(/at\s+.*?\(([^:]+):\d+:\d+\)/);
  if (fileMatch) return fileMatch[1];
  const pathMatch = msg.match(/(\/app\/server\/[\w/.]+\.js)/);
  if (pathMatch) return pathMatch[1].replace('/app/server/', 'any-bot/server/');
  return null;
}

function _suggestCommonFixes(errorType) {
  const fixes = {
    'connection-refused': ['Check if target service is running', 'Verify port/host configuration', 'Check network connectivity'],
    'timeout': ['Increase timeout value', 'Check if target service is overloaded', 'Verify network path'],
    'not-found': ['Check API endpoint URL', 'Verify resource exists', 'Check API version'],
    'server-error': ['Check server logs for stack trace', 'Verify input data', 'Check dependencies'],
    'syntax-error': ['Check for missing brackets/commas', 'Validate JSON if applicable', 'Check template literals'],
    'type-error': ['Check for null/undefined values', 'Verify object structure', 'Add null checks'],
    'reference-error': ['Check import/require statements', 'Verify variable names', 'Check scope'],
    'file-not-found': ['Verify file path exists', 'Check working directory', 'Verify file permissions'],
    'redis-error': ['Check Redis connection string', 'Verify Redis is running', 'Check auth credentials'],
    'chromadb-error': ['Check ChromaDB URL', 'Verify ChromaDB container is running', 'Check collection exists'],
    'memory': ['Reduce batch sizes', 'Add garbage collection hints', 'Check for memory leaks'],
    'permissions': ['Check file permissions', 'Verify Docker socket access', 'Check user/group'],
  };
  return fixes[errorType] || ['Review error message carefully', 'Check recent code changes', 'Search for similar issues online'];
}

function _generateSimpleDiff(original, modified, filePath) {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const changes = [];
  const maxLines = Math.max(origLines.length, modLines.length);

  for (let i = 0; i < maxLines; i++) {
    if (origLines[i] !== modLines[i]) {
      changes.push({
        line: i + 1,
        removed: origLines[i] || '',
        added: modLines[i] || '',
      });
    }
  }

  return {
    file: filePath,
    total_changes: changes.length,
    changes: changes.slice(0, 20),
  };
}

function _httpRequest(options) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 10000;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data, statusCode: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// Export — keys match mcp_tools[].name in provision-manifest.json
// ═══════════════════════════════════════════════════════════════
module.exports = {
  'identify-target-bot': identifyTargetBot,
  'research-error': researchError,
  'git-pull-latest': gitPullLatest,
  'analyze-and-fix-code': analyzeAndFixCode,
  'package-and-build': packageAndBuild,
  'deploy-container': deployContainer,
  'run-selfheal-test': runSelfhealTest,
  'revert-and-escalate': revertAndEscalate,
};
