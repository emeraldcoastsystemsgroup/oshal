/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the knowledge-workspace modal stylesheet verbatim out of chat-rag-workspace-popup.mjs so that controller file returns under the 1000-code-line governance cap; CSS inside a template literal counts as code lines and was 335 of its 1044
 */

/**
 * @description Stylesheet for the shared knowledge-workspace modal, injected once into a
 * <style id="sharedRagWorkspaceStyle"> element by initializeSharedRagWorkspacePopup. It lives in
 * its own module rather than a .css file because the popup builds its DOM at runtime on surfaces
 * (chat standalone, swarmbot chat) that have no build step and no shared <link> to append to —
 * shipping the rules as a string keeps the popup a single self-contained import.
 * @type {string}
 */
export const RAG_WORKSPACE_MODAL_CSS = `
  .rag-workspace-modal {
    position: fixed;
    inset: 0;
    z-index: 1400;
  }
  .rag-workspace-modal[hidden] {
    display: none;
  }
  .rag-workspace-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(6, 8, 16, 0.72);
    backdrop-filter: blur(12px);
  }
  .rag-workspace-dialog {
    position: relative;
    width: min(920px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    margin: 24px auto;
    overflow: auto;
    border-radius: 24px;
    border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, var(--glass-border, rgba(255,255,255,0.12)));
    background:
      radial-gradient(circle at top left, color-mix(in srgb, var(--accent-primary) 14%, transparent) 0%, transparent 36%),
      linear-gradient(160deg, rgba(18, 20, 34, 0.98), rgba(12, 14, 24, 0.96));
    box-shadow: 0 30px 100px rgba(0, 0, 0, 0.45);
  }
  .rag-workspace-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 24px 24px 18px;
    border-bottom: 1px solid var(--glass-border, rgba(255,255,255,0.08));
  }
  .rag-workspace-title {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rag-workspace-title strong {
    color: var(--text-primary);
    font-size: 20px;
    letter-spacing: -0.02em;
  }
  .rag-workspace-title span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 13px;
    line-height: 1.5;
    max-width: 620px;
  }
  .rag-workspace-close {
    align-self: flex-start;
    min-width: 44px;
  }
  .rag-workspace-shell {
    padding: 20px 24px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .rag-workspace-status {
    min-height: 18px;
    padding: 0 2px;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
  }
  .rag-workspace-status[data-tone="error"] { color: var(--status-error, #f87171); }
  .rag-workspace-status[data-tone="success"] { color: var(--status-success, #4ade80); }
  .rag-workspace-status[data-tone="info"] { color: var(--accent-primary); }
  .rag-workspace-note {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border-radius: 16px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: color-mix(in srgb, var(--accent-primary) 8%, var(--glass-bg-heavy, rgba(255,255,255,0.04)));
  }
  .rag-workspace-note strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-workspace-note span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(300px, 1fr);
    gap: 16px;
  }
  .rag-workspace-panel {
    border-radius: 18px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: linear-gradient(145deg, var(--glass-bg-heavy, rgba(255,255,255,0.06)), var(--glass-bg, rgba(255,255,255,0.03)));
    padding: 18px;
    box-shadow: var(--card-shadow, 0 12px 40px rgba(0,0,0,0.2));
  }
  .rag-workspace-panel h4 {
    margin: 0 0 6px;
    color: var(--text-primary);
    font-size: 14px;
  }
  .rag-workspace-panel p {
    margin: 0;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.5;
  }
  .rag-drop-zone {
    margin-top: 14px;
    border: 1px dashed color-mix(in srgb, var(--accent-primary) 40%, var(--glass-border, rgba(255,255,255,0.08)));
    border-radius: 18px;
    padding: 22px 18px;
    background: color-mix(in srgb, var(--accent-primary) 8%, rgba(10, 14, 24, 0.8));
    text-align: center;
    transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }
  .rag-drop-zone.drag-over {
    border-color: color-mix(in srgb, var(--accent-primary) 72%, white);
    background: color-mix(in srgb, var(--accent-primary) 14%, rgba(10, 14, 24, 0.86));
    transform: translateY(-1px);
  }
  .rag-drop-kicker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    margin-bottom: 12px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--accent-primary) 18%, rgba(255,255,255,0.06));
    color: var(--text-primary);
    font-size: 20px;
  }
  .rag-drop-zone strong {
    display: block;
    margin-bottom: 6px;
    color: var(--text-primary);
    font-size: 15px;
  }
  .rag-drop-zone span {
    display: block;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.5;
  }
  .rag-workspace-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-target-grid {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-target-card {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px;
    align-items: flex-start;
    padding: 14px 14px 12px;
    border-radius: 16px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.02);
    cursor: pointer;
    transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }
  .rag-target-card:hover,
  .rag-target-card:focus-within {
    border-color: color-mix(in srgb, var(--accent-primary) 52%, var(--glass-border, rgba(255,255,255,0.08)));
    background: color-mix(in srgb, var(--accent-primary) 10%, rgba(255,255,255,0.03));
    transform: translateY(-1px);
  }
  .rag-target-card[data-selected="true"] {
    border-color: color-mix(in srgb, var(--accent-primary) 78%, white);
    background: color-mix(in srgb, var(--accent-primary) 14%, rgba(255,255,255,0.04));
  }
  .rag-target-card input {
    margin-top: 2px;
  }
  .rag-target-card strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-target-card span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-form-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 14px;
  }
  .rag-form-field label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim, var(--text-secondary));
  }
  .rag-form-field input,
  .rag-form-field select {
    width: 100%;
    min-height: 42px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-primary);
    font-size: 13px;
  }
  .rag-form-field select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .rag-form-helper {
    color: var(--text-dim, var(--text-secondary));
    font-size: 11px;
    line-height: 1.45;
  }
  .rag-target-preview {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-target-preview-card {
    padding: 14px;
    border-radius: 16px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.03);
  }
  .rag-target-preview-card strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-target-preview-card span {
    display: block;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-collection-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    padding: 8px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 16%, rgba(255,255,255,0.04));
    border: 1px solid color-mix(in srgb, var(--accent-primary) 34%, var(--glass-border, rgba(255,255,255,0.08)));
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
  }
  .rag-pending-list,
  .rag-results-list {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-pending-item,
  .rag-result-item {
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.03);
  }
  .rag-pending-item strong,
  .rag-result-item strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-pending-item span,
  .rag-result-item span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-search-actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-search-actions button:disabled,
  .rag-workspace-actions button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .rag-empty-state {
    padding: 14px;
    border-radius: 14px;
    border: 1px dashed var(--glass-border, rgba(255,255,255,0.08));
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.5;
  }
  @media (max-width: 840px) {
    .rag-workspace-dialog {
      width: min(100vw - 16px, 920px);
      margin: 8px auto;
      max-height: calc(100vh - 16px);
    }
    .rag-workspace-header,
    .rag-workspace-shell {
      padding-left: 16px;
      padding-right: 16px;
    }
    .rag-workspace-note,
    .rag-workspace-header,
    .rag-workspace-actions,
    .rag-search-actions {
      flex-direction: column;
      align-items: stretch;
    }
    .rag-workspace-grid {
      grid-template-columns: 1fr;
    }
  }
`;
