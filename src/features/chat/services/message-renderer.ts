/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial extraction from chat-standalone.html
 *                     |                             | Message rendering utilities for chat UI
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned rendered chat markup with cockpit bubble classes while preserving existing semantics
 */

/**
 * @description Escapes HTML special characters to prevent XSS attacks
 * @param text - Raw text to escape
 * @returns HTML-safe escaped text
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * @description Renders markdown-formatted text as HTML
 * Supports code blocks, inline code, bold, italic, and line breaks
 * @param text - Markdown-formatted text
 * @returns HTML string with rendered markdown
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  
  let html = escapeHtml(text);
  
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="code-block"><code class="language-${lang}">${code}</code></pre>`;
  });
  
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

/**
 * @description Formats a Date object as HH:MM time string
 * @param date - Date object to format
 * @returns Formatted time string (e.g., "14:30")
 */
export function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * @description Renders a user message as a DOM element
 * @param text - Message text content
 * @param timestamp - Optional timestamp for the message
 * @returns HTMLDivElement containing the rendered message
 */
export function renderUserMessage(text: string, timestamp?: Date): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'chat-message user user-message';
  
  container.innerHTML = `
    <div class="msg-sender">
      <span class="codicon codicon-account"></span>
      <span>You</span>
      ${timestamp ? `<span class="message-time">${formatTime(timestamp)}</span>` : ''}
    </div>
    <div class="msg-bubble message-body">
      ${escapeHtml(text)}
    </div>
  `;
  
  return container;
}

/**
 * @description Renders an assistant message as a DOM element with markdown support
 * @param text - Message text content (supports markdown)
 * @param timestamp - Optional timestamp for the message
 * @returns HTMLDivElement containing the rendered message
 */
export function renderAssistantMessage(text: string, timestamp?: Date): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'chat-message bot assistant-message';
  
  container.innerHTML = `
    <div class="msg-sender">
      <span class="codicon codicon-hubot"></span>
      <span>Assistant</span>
      ${timestamp ? `<span class="message-time">${formatTime(timestamp)}</span>` : ''}
    </div>
    <div class="msg-bubble message-body">
      ${renderMarkdown(text)}
    </div>
  `;
  
  return container;
}

/**
 * @description Renders a system message as a DOM element
 * @param text - System message text
 * @param type - Message type determining styling (info, warning, error, success)
 * @returns HTMLDivElement containing the rendered system message
 */
export function renderSystemMessage(
  text: string, 
  type: 'info' | 'warning' | 'error' | 'success' = 'info'
): HTMLDivElement {
  const container = document.createElement('div');
  container.className = `chat-message system-message system-${type}`;
  
  const iconMap = {
    info: 'codicon-info',
    warning: 'codicon-warning',
    error: 'codicon-error',
    success: 'codicon-check',
  };
  
  container.innerHTML = `
    <div class="msg-bubble system-message-content">
      <span class="codicon ${iconMap[type]}"></span>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
  
  return container;
}

/**
 * @description Renders a typing indicator showing assistant is composing a response
 * @returns HTMLDivElement containing the animated typing indicator
 */
export function renderTypingIndicator(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'typing-indicator';
  container.id = 'typing-indicator';
  
  container.innerHTML = `
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="typing-text">Assistant is thinking...</span>
  `;
  
  return container;
}
