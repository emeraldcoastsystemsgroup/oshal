/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of AuthPopup UI component for provider authentication
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Replaced inline styles with design-system CSS classes for theme compliance
 */

import React from "react";

/**
 * @description AuthPopup UI component. Renders a modal for provider authentication.
 * Accepts provider info and callback for authentication completion.
 *
 * @param {Object} props
 * @param {string} props.providerName - Name of the provider requiring authentication
 * @param {(token: string) => void} props.onAuthComplete - Callback when authentication is complete
 * @param {() => void} props.onClose - Callback to close the popup
 * @returns {JSX.Element} The rendered authentication popup/modal.
 */
export const AuthPopup: React.FC<{
  providerName: string;
  onAuthComplete: (token: string) => void;
  onClose: () => void;
}> = ({ providerName, onAuthComplete, onClose }) => {
  const [token, setToken] = React.useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token.trim()) {
      onAuthComplete(token.trim());
      onClose();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="glass-panel-heavy p-lg" style={{ minWidth: 320 }}>
        <h3 className="mb-md">
          Authenticate with {providerName}
        </h3>
        <form onSubmit={handleSubmit}>
          <label htmlFor="auth-token" className="label mb-sm">
            Enter API Token or Credentials:
          </label>
          <input
            id="auth-token"
            type="text"
            className="input mb-md"
            value={token}
            onChange={e => setToken(e.target.value)}
            autoFocus
          />
          <div className="flex gap-sm" style={{ justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Authenticate
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
