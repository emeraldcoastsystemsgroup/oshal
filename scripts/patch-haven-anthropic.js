#!/usr/bin/env node
/**
 * patch-haven-anthropic.js
 * Patches the compiled haven-persona-service.js to call Anthropic's
 * Messages API directly using the key from cline's secrets file.
 * Bypasses the cline subprocess entirely — same API key, no task overhead.
 */

const fs = require('fs');
const path = require('path');

const TARGET = '/app/dist/features/haven/haven-persona-service.js';

if (!fs.existsSync(TARGET)) {
  console.error('❌ Target file not found:', TARGET);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');

// Find the marker where the LLM call begins
const MARKER = 'Haven: calling provider in chat mode';
if (!src.includes(MARKER)) {
  console.error('❌ Marker not found in compiled file. Run after container restart.');
  process.exit(1);
}

// Find the start of the logger.info({ call
const markerIdx = src.indexOf(MARKER);
// Walk back to find the logger.info( call
const loggerStart = src.lastIndexOf('logger.info(', markerIdx);
if (loggerStart === -1) {
  console.error('❌ Could not find logger.info before marker');
  process.exit(1);
}

// Find the end of the entire method — look for the final return statement
// The method ends with:  return { reply: text, householdId }; or similar
// We need to replace from the logger call to just before the closing brace of chat()

// Find "return { reply:" after the marker
const returnIdx = src.indexOf('return { reply:', markerIdx);
if (returnIdx === -1) {
  console.error('❌ Could not find return statement after marker');
  process.exit(1);
}
// Find the end of that return statement
const returnEnd = src.indexOf(';', returnIdx) + 1;

// Build the replacement block — Anthropic Messages API direct call
const replacement = `// ── Anthropic Messages API direct call (no cline subprocess) ──────────────
    const secretsPath = require('path').join(process.env.HOME || '/root', '.cline/data/secrets.json');
    let anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    if (!anthropicKey || anthropicKey.startsWith('placeholder')) {
      try {
        const raw = require('fs').readFileSync(secretsPath, 'utf8');
        const parsed = JSON.parse(raw);
        anthropicKey = parsed.anthropicApiKey || '';
      } catch (e) {
        logger.warn({ err: e }, 'Haven: could not read anthropicApiKey from secrets.json');
      }
    }
    if (!anthropicKey || anthropicKey.startsWith('placeholder')) {
      throw new Error('Haven: no valid ANTHROPIC_API_KEY available');
    }
    const anthropicModel = process.env.HAVEN_ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
    logger.info({ householdId, model: anthropicModel, messageCount: messages.length }, 'Haven: Anthropic direct call');
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => '');
      throw new Error('Anthropic API ' + anthropicRes.status + ': ' + errBody.slice(0, 200));
    }
    const anthropicData = await anthropicRes.json();
    const text = (anthropicData.content?.[0]?.text || '').trim();
    logger.info({ householdId, replyLength: text.length }, 'Haven: Anthropic reply ready');
    if (!text) {
      logger.warn({ householdId }, 'Haven: empty response from Anthropic');
      return { reply: "I'm here — say that again?", householdId };
    }
    return { reply: text, householdId }`;

// Replace from logger.info call to end of return statement
src = src.slice(0, loggerStart) + replacement + src.slice(returnEnd);

fs.writeFileSync(TARGET, src);
console.log('✅ Anthropic direct-call patch applied — claude-3-5-haiku-20241022');