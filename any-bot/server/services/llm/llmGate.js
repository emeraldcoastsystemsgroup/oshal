'use strict';

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ    | AUTHOR      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Model-gateway pre-flight for any-bot providers. Every
 *                              provider.generateResponse() calls this BEFORE the LLM
 *                              call so all bot LLM traffic is metered at one place — the
 *                              OSHAL controller — which holds the budget/quota/routing
 *                              gate (governLlmCall) and the fleet-wide quota window.
 */

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 3000;

function controllerBase() {
  return process.env.SWARM_CONTROLLER_URL || 'http://oshal-api:5000';
}

function internalToken() {
  return process.env.OSHAL_INTERNAL_TOKEN || process.env.SESSION_SECRET || '';
}

/** Rough input-token estimate (~4 chars/token) for the projected-cost/quota math. */
function estimateTokens(messages, systemPrompt) {
  let chars = systemPrompt ? String(systemPrompt).length : 0;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const c = m && m.content;
      chars += typeof c === 'string' ? c.length : (c ? JSON.stringify(c).length : 0);
    }
  }
  return Math.ceil(chars / 4);
}

/** Prefer the end-user (owner_sub) so per-user caps apply; else the bot; else global. */
function deriveScopeKey(options) {
  const userSub = (options && options.extraEnv && options.extraEnv.OSHAL_USER_SUB) || (options && options.userSub);
  if (userSub) return { scope: 'owner_sub', key: String(userSub) };
  const agentId = options && options.agentId;
  if (agentId) return { scope: 'bot', key: String(agentId) };
  return { scope: 'global', key: 'global' };
}

function postCheck(payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(controllerBase() + '/api/llm-governance/check');
    } catch (e) {
      return reject(e);
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-oshal-internal': internalToken(),
        },
        timeout: DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('gate timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Pre-flight the model gateway before an LLM call.
 *
 * FAIL-OPEN: any error/timeout (or the gate being unreachable) returns
 * { allowed: true, model: requestedModel } so the gateway can never break the
 * bot's call path. When the controller has OSHAL_LLM_BUDGETS off it returns
 * allowed + the same model, so this is effectively a no-op until enforcement is
 * turned on — the bot just pays one local round-trip.
 *
 * @param {string} model - The model the provider intends to use.
 * @param {Array} messages - Conversation messages (for the token estimate).
 * @param {Object} options - generateResponse options (agentId, extraEnv, systemPrompt).
 * @returns {Promise<{allowed:boolean, model:string, reason:string}>}
 */
async function gateLlmCall(model, messages, options = {}) {
  const requestedModel = model || (options && options.model) || '';
  const { scope, key } = deriveScopeKey(options);
  const estTokens = estimateTokens(messages, options && options.systemPrompt);
  const payload = JSON.stringify({ requestedModel, scope, key, estTokens });
  try {
    const decision = await postCheck(payload);
    return {
      allowed: decision.allowed !== false,
      model: decision.model || requestedModel,
      reason: decision.reason || 'ok',
    };
  } catch (_err) {
    return { allowed: true, model: requestedModel, reason: 'gate-unreachable-open' };
  }
}

module.exports = { gateLlmCall };
