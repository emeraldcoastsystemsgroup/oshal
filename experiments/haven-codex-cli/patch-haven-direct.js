const fs = require('fs');
const p = '/app/dist/features/haven/haven-persona-service.js';
let c = fs.readFileSync(p, 'utf8');

// 1. Add the havenLlmChat import if not already present
const IMPORT_MARKER = 'const home_context_service_1 = require("../../features/haven/home-context-service");';
const IMPORT_ADD = 'const haven_direct_llm_service_1 = require("../../features/haven/haven-direct-llm-service");\n';
if (!c.includes('haven_direct_llm_service_1')) {
  c = c.replace(IMPORT_MARKER, IMPORT_MARKER + '\n' + IMPORT_ADD);
  console.log('Added import for havenLlmChat');
} else {
  console.log('Import already present — skipping');
}

// 2. Replace the provider block (taskId through return statement) with havenLlmChat
// The old block is:
//   const taskId = `haven-${householdId}-${Date.now()}`;
//   logger.info({ ... }, '...');
//   const provider = this.getProvider();
//   const response = await provider.sendRequest({ ... model: ... });
//   // Extract text from response content blocks
//   const text = response.content ...
//   ...
//   return { reply: text, householdId };
//
// We want to replace from "// Stable taskId" through "return { reply: text, householdId };"

const OLD_BLOCK = `        // Stable taskId — CRITICAL: ClaudeCodeProvider calls ensureWorkspacePath(taskId) in BOTH
        // buildPrompt() and sendRequest(). Without a stable taskId, Date.now() produces two
        // different paths and the context file written in buildPrompt() is not found by Cline.
        const taskId = \`haven-\${householdId}-\${Date.now()}\`;
        logger.info({ householdId, taskId, deviceCount: snapshot.devices.length, messageCount: messages.length }, 'Haven: calling provider in chat mode (stable taskId)');
        const provider = this.getProvider();
        const response = await provider.sendRequest({
            messages,
            systemPrompt,
            interactionMode: 'chat',
            agentId: 'haven',
            taskId,
            model: process.env.HAVEN_MODEL || 'gpt-4o',
        });
        // Extract text from response content blocks
        const text = response.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
        if (!text) {
            logger.warn({ householdId, taskId }, 'Haven: empty response from provider');
            return { reply: "I'm here — say that again?", householdId };
        }
        return { reply: text, householdId };`;

const NEW_BLOCK = `        // Direct OpenAI Chat Completions — bypasses Cline CLI binary entirely
        logger.info({ householdId, deviceCount: snapshot.devices.length, messageCount: messages.length }, 'Haven: calling OpenAI Chat Completions directly (fast path)');
        const result = await haven_direct_llm_service_1.havenLlmChat(systemPrompt, messages, true);
        if (result.dispatch) {
            // Model wants to dispatch to swarm — return a confirmation reply
            return { reply: 'On it.', householdId, dispatch: result.dispatch };
        }
        const text = (result.text || '').trim();
        if (!text) {
            logger.warn({ householdId }, 'Haven: empty response from direct LLM');
            return { reply: "I'm here — say that again?", householdId };
        }
        return { reply: text, householdId };`;

if (c.includes(OLD_BLOCK)) {
  c = c.replace(OLD_BLOCK, NEW_BLOCK);
  fs.writeFileSync(p, c, 'utf8');
  console.log('PATCHED OK — provider.sendRequest replaced with havenLlmChat');
} else {
  console.log('OLD_BLOCK not found. Showing actual content around provider.sendRequest:');
  const idx = c.indexOf('provider.sendRequest');
  if (idx >= 0) {
    console.log(JSON.stringify(c.slice(Math.max(0, idx - 300), idx + 400)));
  } else {
    console.log('provider.sendRequest not found either — dumping lines 130-180:');
    const lines = c.split('\n').slice(129, 180);
    lines.forEach((l, i) => console.log(`${i + 130}: ${l}`));
  }
}