/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Mount ChatWindow React component into #chat-root in ui.html
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed late module-load chat mounting by rendering immediately when DOMContentLoaded has already fired
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Changed to mount DebugWindow (swarm lab) instead of ChatWindow for /ui route
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Restored ChatWindow mount - provides full chat interface (messages, input, provider selector) PLUS DebugWindow side panel
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log timestamp formatting for governance compliance while validating the /ui swarm debug surface
 */

// Assumes React and ReactDOM are available globally or via import maps/bundler
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWindow } from '../features/chat-orchestration/components/ChatWindow';

function mountChatWindow() {
  const rootEl = document.getElementById("chat-root");
  if (rootEl) {
    const root = createRoot(rootEl);
    root.render(<ChatWindow />);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountChatWindow, { once: true });
} else {
  mountChatWindow();
}
