#!/usr/bin/env node
/**
 * Haven OpenAI Chat Completions patch
 * Replaces the ClaudeCodeProvider call with a direct /v1/chat/completions fetch.
 * Uses OPENAI_API_KEY env var.
 * Applied as a runtime patch to dist/features/haven/haven-persona-service.js
 */
const fs = require('fs');
const path = require('path');

const FILE = '/app/dist/features/haven/haven-persona-service.js';
const src = fs.readFileSync(FILE, 'utf8');

// Detect which version is currently in the file
if (src.includes('OPENAI_CHAT_PATCH')) {
  console.log('OpenAI chat patch already applied');
  process.exit(0);
}

// The replacement chat function — replaces everything from the fast-path comment
// down to the return statement.
const REPLACEMENT = `
    // OPENAI_CHAT_PATCH — bypasses cline subprocess
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || openaiKey.startsWith('placeholder')) {
      throw new Error('Haven: OPENAI_API_KEY not set or is placeholder');
    }
    const openaiModel = process.env.HAVEN_MODEL || 'gpt-4o-mini';
    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + openaiKey,
      },
      body: JSON.stringify({
        model: openaiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });
    if (!chatRes.ok) {
      const errBody = await chatRes.text().catch(() => '');
      throw new Error('OpenAI chat ' + chatRes.status + ': ' + errBody.slice(0, 200));
    }
    const chatData = await chatRes.json();
    const text = (chatData.choices?.[0]?.message?.content ?? '').trim();
    if (!text) {
      logger.warn({ householdId }, 'Haven: empty response from OpenAI');
      return { reply: "I'm here — say that again?", householdId };
    }
    return { reply: text, householdId };
`;

// Find the fast-path section to replace — look for the section between
// the "fast direct LLM path" comment and the final closing brace of chat()
const startMarker = '// ── Fast direct LLM path';
const endMarker = 'return { reply: text, householdId };\n    }';

const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker);

if (startIdx === -1) {
  // Fallback: older compiled version — replace the provider call block
  const legacyMarker = 'Haven: calling provider in chat mode';
  const legacyIdx = src.indexOf(legacyMarker);
  if (legacyIdx === -1) {
    console.error('ERROR: Could not find patch target in compiled file.');
    console.error('File may have been patched in an unexpected way.');
    process.exit(1);
  }
  // For the legacy version, inject OpenAI call before the logger.info call
  const lineStart = src.lastIndexOf('\n', legacyIdx);
  const blockEnd = src.indexOf('return { reply: text, householdId };', legacyIdx);
  if (blockEnd === -1) {
    console.error('ERROR: Could not find return statement after legacy marker.');
    process.exit(1);
  }
  const endOfBlock = blockEnd + 'return { reply: text, householdId };'.length;
  const patched = src.slice(0, lineStart + 1) + REPLACEMENT + '\n' + src.slice(endOfBlock + 1);
  fs.writeFileSync(FILE, patched);
  console.log('✅ OpenAI chat patch applied (legacy path)');
  process.exit(0);
}

const endOfBlock = endIdx + endMarker.length;
const patched = src.slice(0, startIdx) + REPLACEMENT + '\n    }\n' + src.slice(endOfBlock + 1);
fs.writeFileSync(FILE, patched);
console.log('✅ OpenAI chat patch applied (new path)');