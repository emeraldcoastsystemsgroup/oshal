/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial simplified implementation for OSHAL chat
 *              |         | Basic message rendering with markdown support
 */

/**
 * @description Simple markdown renderer for message text
 * 
 * @param text - Raw message text
 * @returns HTML string with markdown converted
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  
  let html = escapeHtml(text);
  
  // Code blocks (triple backticks)
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
 * @description Escapes HTML special characters
 * 
 * @param text - Text to escape
 * @returns HTML-safe string
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * @description Renders a user message
 * 
 * @param text - Message text
 * @param timestamp - Optional timestamp
 * @returns HTMLElement for the message
 */
export function renderUserMessage(text: string, timestamp?: Date): HTMLElement {
  const container = document.createElement('div');
  container.className = 'chat-message user-message';
  
  container.innerHTML = `
    <div class="message-header">
      <span class="codicon codicon-account"></span>
      <span class="message-role">You</span>
      ${timestamp ? `<span class="message-time">${formatTime(timestamp)}</span>` : ''}
    </div>
    <div class="message-body">
      ${escapeHtml(text)}
    </div>
  `;
  
  return container;
}

/**
 * @description Renders an assistant message
 * 
 * @param text - Message text
 * @param timestamp - Optional timestamp
 * @returns HTMLElement for the message
 */
export function renderAssistantMessage(text: string, timestamp?: Date): HTMLElement {
  const container = document.createElement('div');
  container.className = 'chat-message assistant-message';
  
  container.innerHTML = `
    <div class="message-header">
      <span class="codicon codicon-hubot"></span>
      <span class="message-role">Assistant</span>
      ${timestamp ? `<span class="message-time">${formatTime(timestamp)}</span>` : ''}
    </div>
    <div class="message-body">
      ${renderMarkdown(text)}
    </div>
  `;
  
  return container;
}

/**
 * @description Renders a system/status message
 * 
 * @param text - Message text
 * @param type - Message type ('info' | 'warning' | 'error' | 'success')
 * @returns HTMLElement for the message
 */
export function renderSystemMessage(
  text: string,
  type: 'info' | 'warning' | 'error' | 'success' = 'info',
): HTMLElement {
  const container = document.createElement('div');
  container.className = `chat-message system-message system-${type}`;
  
  const iconMap = {
    info: 'codicon-info',
    warning: 'codicon-warning',
    error: 'codicon-error',
    success: 'codicon-check',
  };
  
  container.innerHTML = `
    <div class="system-message-content">
      <span class="codicon ${iconMap[type]}"></span>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
  
  return container;
}

/**
 * @description Formats a timestamp for display
 * 
 * @param date - Date to format
 * @returns Formatted time string (HH:MM)
 */
function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * @description Renders a typing indicator
 * 
 * @returns HTMLElement for typing indicator
 */
export function renderTypingIndicator(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'typing-indicator';
  container.id = 'typing-indicator';
  
  container.innerHTML = `
    <div class="typing-dots">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <span class="typing-text">Assistant is thinking...</span>
  `;
  
  return container;
}
