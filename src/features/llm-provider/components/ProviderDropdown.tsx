/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ProviderDropdown UI component for provider selection
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to fetch provider list from /api/providers (dynamic, authenticated)
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Replaced inline styles with design-system CSS classes for theme compliance
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Suppressed no-console for this browser-rendered React component (no Node/Pino logger in the DOM); fetch-error warns stay on console
 */

/* eslint-disable no-console -- client-side: browser-rendered React component, no Node logger in the DOM */

import React, { useEffect, useState } from 'react';

/**
 * @description ProviderDropdown UI component. Renders a dropdown of available providers from window.PROVIDER_CONFIG.
 * Placeholder for authentication popup integration.
 *
 * @param {Object} props
 * @param {string} [props.selectedProvider] - Currently selected provider ID
 * @param {(providerId: string) => void} [props.onChange] - Callback when provider changes
 * @returns {JSX.Element} The rendered provider dropdown component.
 */
export const ProviderDropdown: React.FC<{
  selectedProvider?: string;
  onChange?: (provider: { id: string; name: string; authRequired?: boolean }) => void;
}> = ({ selectedProvider, onChange }) => {
  const [providers, setProviders] = useState<{ id: string; name: string; authRequired?: boolean }[]>([]);

  useEffect(() => {
    // Fetch provider list from backend API (dynamic, authenticated)
    fetch('/api/providers', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          console.warn('[ProviderDropdown] WARN: Failed to fetch /api/providers', { status: res.status });
          setProviders([]);
          return;
        }
        const data = await res.json();
        // API returns { id, displayName, requiresApiKey } — map to component shape
        const mapped = (Array.isArray(data) ? data : []).map((p: any) => ({
          id: p.id,
          name: p.displayName || p.name || p.id,
          authRequired: p.requiresApiKey ?? p.authRequired,
        }));
        setProviders(mapped);
      })
      .catch((err) => {
        console.warn('[ProviderDropdown] WARN: Error fetching /api/providers', err);
        setProviders([]);
      });
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = providers.find(p => p.id === e.target.value);
    if (onChange && selected) onChange(selected);
  };

  return (
    <div className="form-group">
      <label htmlFor="provider-select" className="label">
        Provider
      </label>
      <select
        id="provider-select"
        className="select"
        value={selectedProvider || ''}
        onChange={handleChange}
      >
        <option value="" disabled>
          Select a provider
        </option>
        {providers.map(provider => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>
    </div>
  );
};
