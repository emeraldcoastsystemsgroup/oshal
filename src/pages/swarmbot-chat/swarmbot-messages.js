/**
 * Swarm-bot workspace — message bubble rendering.
 *
 * The dedicated bubble-render module for the embedded/direct swarm-bot chat: appendMessage owns
 * the plain-text-first bubble (escaped text + read-aloud), and assistant bubbles are then
 * upgraded IN PLACE through the shared response renderer (parseResponse + renderBlocks from
 * /dist/response-renderer.js — built by `npm run build:chat`). The escaped plain-text bubble is
 * the permanent graceful fallback: if the bundle is absent, still loading, or a render fails,
 * the chat stays fully readable. The renderer's HTML is sanitized by construction (untrusted
 * text only enters through its escape path), which is what makes the innerHTML upgrade safe.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted bubble rendering (appendMessage, read-aloud, escapeHtml) from swarmbot-chat.js (file was past the 800 code-line trigger) and wired assistant bubbles through the shared response renderer with plain-text graceful fallback.
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('swarmbot-messages');

// Shared response renderer (rich assistant bubbles). The ES-module bundle is produced by
// `npm run build:chat` (vite entry `response-renderer`) and served at /dist/response-renderer.js;
// when it is absent or fails to load, assistant bubbles simply stay on the escaped plain-text
// path below — graceful degradation, never a broken chat.
let responseRenderer = null;
const responseRendererReady = import('/dist/response-renderer.js')
  .then((module) => {
    responseRenderer = module;
  })
  .catch(() => {
    logger.info('Shared response renderer bundle unavailable; assistant bubbles stay plain-text');
  });

/**
 * @description Appends one chat bubble to the message area. Renders escaped plain text
 * immediately (the graceful fallback), then upgrades assistant bubbles through the shared
 * response renderer when it is available.
 * @param {HTMLElement} container - The message-area element.
 * @param {string} role - Message role ('user' | 'assistant' | 'system').
 * @param {string} author - Display name shown in the message meta line.
 * @param {string} text - Raw message text (untrusted).
 */
export function appendMessage(container, role, author, text) {
  if (!text) {
    return;
  }

  document.querySelector('.empty-state')?.remove();
  const node = document.createElement('article');
  node.className = 'message';
  node.dataset.role = role;
  // Assistant messages get a read-aloud button (neural voice, browser fallback).
  const readAloud = role === 'assistant'
    ? '<button type="button" class="message-readaloud" title="Read aloud" aria-label="Read aloud">&#128264;</button>'
    : '';
  node.innerHTML = `
    <div class="message-meta">${escapeHtml(author)}</div>
    <div class="message-bubble">${escapeHtml(text)}</div>
    ${readAloud}
  `;
  if (readAloud) {
    node.querySelector('.message-readaloud')?.addEventListener('click', () => speakChatMessage(text));
  }
  container.appendChild(node);
  container.scrollTop = container.scrollHeight;
  if (role === 'assistant') {
    upgradeAssistantBubble(node, text);
  }
}

/**
 * @description Upgrades one assistant bubble in place through the shared response renderer
 * (parseResponse + renderBlocks): fenced code, mermaid source fallbacks, and oshal:chart /
 * oshal:table typed blocks become rich markup. Any load/render failure leaves the plain-text
 * bubble untouched.
 * @param {HTMLElement} node - The message article appended by appendMessage.
 * @param {string} text - The assistant's raw reply text.
 */
function upgradeAssistantBubble(node, text) {
  responseRendererReady.then(() => {
    if (!responseRenderer || typeof responseRenderer.renderResponseHtml !== 'function') {
      return;
    }
    return responseRenderer.renderResponseHtml(text).then((result) => {
      const bubble = node.querySelector('.message-bubble');
      if (!bubble || !result || !result.html) {
        return;
      }
      bubble.innerHTML = result.html;
    });
  }).catch((error) => {
    logger.warn('Rich bubble render failed; keeping plain-text bubble', {
      error: serializeUiError(error),
    });
  });
}

/**
 * @description Escapes HTML special characters so untrusted text is inert in bubble markup.
 * @param {string} value - Untrusted text.
 * @returns {string} HTML-safe text.
 */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

let chatAudio = null;

/**
 * @description Reads a chat message aloud via the neural TTS endpoint, falling back to the
 * browser voice. Clicking again (or a new message) cancels the prior playback.
 * @param {string} text - Message text to speak.
 */
async function speakChatMessage(text) {
  if (!text) return;
  try { if (chatAudio) { chatAudio.pause(); chatAudio = null; } } catch (e) { /* ignore */ }
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  const clean = String(text).slice(0, 4500);
  const browser = () => {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(clean);
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    }
  };
  try {
    const resp = await fetch('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    });
    if (!resp.ok) { browser(); return; }
    const json = await resp.json();
    const d = json && json.data ? json.data : json;
    if (d && d.audioData && d.fallback !== 'browser') {
      chatAudio = new Audio(`data:${d.format || 'audio/mpeg'};base64,${d.audioData}`);
      chatAudio.play().catch(browser);
    } else {
      browser();
    }
  } catch (e) {
    browser();
  }
}
