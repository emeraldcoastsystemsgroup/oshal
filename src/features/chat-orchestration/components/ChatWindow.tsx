/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ChatWindow UI component for chat feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed FSD barrel imports for ProviderDropdown and AuthPopup
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Replaced inline styles with design-system CSS classes for theme compliance
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Replaced basic React chat with iframe to standalone /chat (full OAuth auth flows)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log timestamp formatting for governance compliance while validating the /ui swarm debug surface
 */

import React from 'react';
import { DebugWindow } from './DebugWindow';

/**
 * @description Chat window layout component. Embeds the standalone /chat page (which has full
 * OAuth auth flows for OpenAI Codex, Claude Code, etc.) alongside the React DebugWindow.
 *
 * @returns {JSX.Element} The rendered chat + debug layout.
 */
export const ChatWindow: React.FC = () => {
  return (
    <div className="swarm-debug-layout">
      <div className="chat-column">
        <iframe
          src="/chat"
          title="Chat Interface"
          className="chat-iframe"
        />
      </div>
      <div className="debug-column">
        <DebugWindow />
      </div>
    </div>
  );
};
