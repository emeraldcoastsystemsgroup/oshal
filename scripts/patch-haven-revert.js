/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One-off container hotfix: rewrite the compiled Haven persona chat method back onto getProvider().sendRequest() with a model override, instead of the direct OpenAI Chat Completions path
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed a stray leading comma that made the whole file a SyntaxError on line 1, so it could never have run. Found by widening the eslint max-lines gate to scripts/ — the previous src-only-TypeScript scope meant no gate had ever parsed this file. Added this header at the same time.
 */

const fs = require('fs');
const p = '/app/dist/features/haven/haven-persona-service.js';
let c = fs.readFileSync(p, 'utf8');

// Replace the havenLlmChat direct call with getProvider().sendRequest()
const OLD = `        // Direct OpenAI Chat Completions — bypasses Cline CLI binary entirely
        logger.info({ householdId, deviceCount: snapshot.devices.length, messageCount: messages.length }, 'Haven: calling OpenAI Chat Completions directly (fast path)');
        const result = await (require("./haven-direct-llm-service")).havenLlmChat(systemPrompt, messages, true);
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

const NEW = `        // ClaudeCodeProvider (cline) in chat mode — model overridden to gpt-4o via HAVEN_MODEL env
        const havenModel = process.env.HAVEN_MODEL || 'gpt-4o';
        const taskId = \`haven-\${householdId}-\${Date.now()}\`;
        logger.info({ householdId, taskId, model: havenModel, deviceCount: snapshot.devices.length, messageCount: messages.length }, 'Haven: calling provider in chat mode (fast model)');
        const provider = this.getProvider();
        const response = await provider.sendRequest({
            messages,
            systemPrompt,
            interactionMode: 'chat',
            agentId: 'haven',
            taskId,
            model: havenModel,
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

if (c.includes(OLD)) {
  c = c.replace(OLD, NEW);
  fs.writeFileSync(p, c, 'utf8');
  console.log('REVERTED OK — back to getProvider().sendRequest() with model override');
} else {
  console.log('OLD block not found. Showing current chat method:');
  const idx = c.indexOf('async chat(');
  if (idx >= 0) {
    console.log(c.slice(idx, idx + 800));
  }
}