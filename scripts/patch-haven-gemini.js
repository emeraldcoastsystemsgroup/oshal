/**
 * Patches the running container to wire Haven → Gemini 1.5 Flash.
 * Run: docker cp scripts/patch-haven-gemini.js oshal-api-server:/tmp/ && docker exec oshal-api-server node /tmp/patch-haven-gemini.js
 */
const fs = require('fs');

// ── 1. Inject havenGoogleChat into compiled haven-direct-llm-service.js ────────

const llmSvcPath = '/app/dist/features/haven/haven-direct-llm-service.js';
let llmSvc = fs.readFileSync(llmSvcPath, 'utf8');

const GOOGLE_CHAT_FN = `
// ── havenGoogleChat — Gemini 1.5 Flash fast path ────────────────────────────
async function havenGoogleChat(systemPrompt, messages) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('Haven: GOOGLE_API_KEY not set');
  const geminiModel = process.env.HAVEN_GOOGLE_MODEL || 'gemini-1.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + geminiModel + ':generateContent?key=' + apiKey;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Gemini API responded ' + res.status + ': ' + t.slice(0, 200));
  }
  const data = await res.json();
  if (data.error) throw new Error('Gemini API error ' + data.error.code + ': ' + data.error.message);
  const text = ((data.candidates || [])[0]?.content?.parts?.[0]?.text || '').trim();
  return { text };
}
exports.havenGoogleChat = havenGoogleChat;
`;

if (!llmSvc.includes('havenGoogleChat')) {
  llmSvc = llmSvc + GOOGLE_CHAT_FN;
  fs.writeFileSync(llmSvcPath, llmSvc, 'utf8');
  console.log('havenGoogleChat injected into haven-direct-llm-service.js');
} else {
  console.log('havenGoogleChat already present in haven-direct-llm-service.js');
}

// ── 2. Patch haven-persona-service.js to call havenGoogleChat ──────────────────

const personaSvcPath = '/app/dist/features/haven/haven-persona-service.js';
let personaSvc = fs.readFileSync(personaSvcPath, 'utf8');

// The current block (from revert patch) starts with "// ClaudeCodeProvider (cline) in chat mode"
const OLD_BLOCK = `        // ClaudeCodeProvider (cline) in chat mode — model overridden to gpt-4o via HAVEN_MODEL env
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

const NEW_BLOCK = `        // Gemini 1.5 Flash direct path — fast (1-3s), uses GOOGLE_API_KEY from env
        logger.info({ householdId, deviceCount: snapshot.devices.length, messageCount: messages.length }, 'Haven: calling Gemini 1.5 Flash directly');
        const { havenGoogleChat } = require('./haven-direct-llm-service');
        const result = await havenGoogleChat(systemPrompt, messages);
        const text = (result.text || '').trim();
        if (!text) {
            logger.warn({ householdId }, 'Haven: empty response from Gemini');
            return { reply: "I'm here — say that again?", householdId };
        }
        return { reply: text, householdId };`;

if (personaSvc.includes(OLD_BLOCK)) {
  personaSvc = personaSvc.replace(OLD_BLOCK, NEW_BLOCK);
  fs.writeFileSync(personaSvcPath, personaSvc, 'utf8');
  console.log('PATCHED haven-persona-service.js → havenGoogleChat (Gemini fast path)');
} else {
  console.log('OLD_BLOCK not found in haven-persona-service.js. Showing lines 130-160:');
  const lines = personaSvc.split('\n').slice(129, 160);
  lines.forEach((l, i) => console.log(`${i + 130}: ${l}`));
}