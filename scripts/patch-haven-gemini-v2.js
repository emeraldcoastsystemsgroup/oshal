/**
 * patch-haven-gemini-v2.js
 * Rewires haven-persona-service.js to call Gemini 1.5 Flash directly (GOOGLE_API_KEY).
 * Falls back to /v1/responses (OpenAI Codex OAuth token) if GOOGLE_API_KEY absent.
 * Both paths bypass cline's 29-50s task loop entirely.
 *
 * Run: docker cp scripts/patch-haven-gemini-v2.js oshal-api-server:/tmp/ && docker exec oshal-api-server node /tmp/patch-haven-gemini-v2.js
 */
const fs = require('fs');

const personaSvcPath = '/app/dist/features/haven/haven-persona-service.js';
let src = fs.readFileSync(personaSvcPath, 'utf8');

// Exact block from the compiled file (lines 139–166)
const OLD = `        // Stable taskId — CRITICAL: ClaudeCodeProvider calls ensureWorkspacePath(taskId) in BOTH
        // buildPrompt() and sendRequest(). Without a stable taskId, Date.now() produces two
        // different paths and the context file written in buildPrompt() is not found by Cline.
        const taskId = \`haven-\${householdId}-\${Date.now()}\`;
        // Haven uses gpt-4o (fast chat model), not gpt-5.3-codex (reasoning model that takes 20-30s).
        // HAVEN_MODEL env var allows docker-compose to pin the model; defaults to gpt-4o.
        const havenModel = process.env.HAVEN_MODEL || 'gpt-4o';
        logger.info({ householdId, taskId, model: havenModel, deviceCount: snapshot.devices.length, messageCount: messages.length }, 'Haven: calling provider in chat mode (stable taskId, fast model)');
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

const NEW = `        // ── Fast direct LLM path — bypasses cline task loop (was 29-50s) ──────────
        // Priority: Gemini 1.5 Flash (GOOGLE_API_KEY) → OpenAI /v1/responses (OAuth token)
        const googleApiKey = process.env.GOOGLE_API_KEY;
        const geminiModel = process.env.HAVEN_GOOGLE_MODEL || 'gemini-1.5-flash';
        let text = '';
        if (googleApiKey) {
            // ── Gemini 1.5 Flash path ──────────────────────────────────────────────
            logger.info({ householdId, model: geminiModel, messageCount: messages.length }, 'Haven: Gemini direct call');
            const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + geminiModel + ':generateContent?key=' + googleApiKey;
            const geminiContents = messages.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: typeof m.content === 'string' ? m.content : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('') }],
            }));
            const geminiRes = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents: geminiContents,
                    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
                }),
            });
            if (!geminiRes.ok) {
                const t = await geminiRes.text().catch(() => '');
                throw new Error('Gemini API ' + geminiRes.status + ': ' + t.slice(0, 200));
            }
            const geminiData = await geminiRes.json();
            if (geminiData.error) throw new Error('Gemini error ' + geminiData.error.code + ': ' + geminiData.error.message);
            text = ((geminiData.candidates || [])[0]?.content?.parts?.[0]?.text || '').trim();
            logger.info({ householdId, replyLength: text.length }, 'Haven: Gemini reply ready');
        } else {
            // ── OpenAI /v1/responses fallback (OAuth token from ~/.cline/data/secrets.json) ──
            const secretsPath = require('path').join(process.env.HOME || '/root', '.cline/data/secrets.json');
            let accessToken = '';
            try {
                const raw = require('fs').readFileSync(secretsPath, 'utf8');
                const creds = JSON.parse(JSON.parse(raw)['openai-codex-oauth-credentials'] || '{}');
                accessToken = creds.access_token || '';
            } catch(e) { logger.warn({ err: e }, 'Haven: could not read OAuth token'); }
            if (!accessToken) throw new Error('Haven: no GOOGLE_API_KEY and no OAuth token available');
            const codexModel = process.env.HAVEN_MODEL || 'gpt-4o';
            logger.info({ householdId, model: codexModel, messageCount: messages.length }, 'Haven: OpenAI /v1/responses call');
            const responsesInput = messages.map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: typeof m.content === 'string' ? m.content : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('') }],
            }));
            const codexRes = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
                body: JSON.stringify({ model: codexModel, max_output_tokens: 1024, input: responsesInput, instructions: systemPrompt, temperature: 0.7 }),
            });
            if (!codexRes.ok) {
                const t = await codexRes.text().catch(() => '');
                throw new Error('OpenAI /v1/responses ' + codexRes.status + ': ' + t.slice(0, 200));
            }
            const codexData = await codexRes.json();
            text = (codexData.output_text || (codexData.output || [])[0]?.content?.[0]?.text || '').trim();
            logger.info({ householdId, replyLength: text.length }, 'Haven: /v1/responses reply ready');
        }
        if (!text) {
            logger.warn({ householdId }, 'Haven: empty response from direct LLM');
            return { reply: "I'm here — say that again?", householdId };
        }
        return { reply: text, householdId };`;

if (!src.includes(OLD)) {
  console.error('OLD_BLOCK not found — content may have already been patched or changed.');
  console.log('Lines 139-166 of file:');
  src.split('\n').slice(138, 168).forEach((l, i) => console.log(i + 139 + ': ' + l));
  process.exit(1);
}

const patched = src.replace(OLD, NEW);
fs.writeFileSync(personaSvcPath, patched, 'utf8');
console.log('PATCHED OK — haven-persona-service.js now calls Gemini/Codex directly (no cline subprocess)');