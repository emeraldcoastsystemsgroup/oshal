/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial result-feed renderer: promotes workspace result folders to clickable Code Server links and de-emphasizes UUID handover filenames in completed task replies.
 */

import { timeAgo } from '../utils/formatters.js';
import { buildCodeServerWorkspacePath, joinWorkspacePath } from './ticket-view-helpers.js';

const RESULT_FOLDER_PATTERN = /(?:^|[/\s])((?:deliverables|output|data)(?:\/[A-Za-z0-9._-]+)*)\/?/i;
const UUID_HANDOVER_FILENAME_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_[A-Za-z0-9-]+)?_PHASE_\d+_ROUND_\d+\.md\b/gi;
const HANDOVER_LINE_PATTERN = /^\s*[-*]?\s*(?:developer-handovers\/)?[0-9a-f-]{36}(?:_[A-Za-z0-9-]+)?_PHASE_\d+_ROUND_\d+\.md\s*$/gim;

/**
 * @description Build cockpit feed entries with result-folder links promoted ahead of verbose handoff filenames.
 * @param entries - Timeline entries to render.
 * @param ticket - Hydrated ticket detail object used for workspace links and bot labels.
 * @returns Rendered feed-entry HTML.
 */
export function buildFeedEntriesHtml(entries, ticket) {
  return entries.map((entry) => buildFeedEntryHtml(entry, ticket)).join('');
}

function buildFeedEntryHtml(entry, ticket) {
  const timestamp = entry.timestamp || entry.createdAt || entry.created_at || '';
  const text = entry.summary || entry.comment || entry.description || entry.action || '';
  const isUser = entry.type === 'user' || entry.role === 'user';
  const typeIcon = isUser ? 'ph-user' : 'ph-robot';
  const typeColor = isUser ? 'var(--accent-primary)' : 'var(--status-active)';
  const resultLink = isUser ? '' : buildResultFolderLink(text, ticket);
  const rendered = renderMarkdownForFeed(resultLink ? summarizeResultText(text) : text);
  const sourceBadge = entry.sourceSequenceId
    ? `<span style="font-size:10px;padding:1px 6px;border-radius:var(--radius-pill);background:rgba(99,102,241,0.12);color:var(--accent-primary);margin-left:4px" title="${entry.sourceTicketName || ''}">↳ #${entry.sourceSequenceId}</span>`
    : '';
  return `<div style="padding:12px;border-radius:var(--radius-md);background:${isUser ? 'rgba(99,102,241,0.08)' : 'var(--glass-bg)'};border:1px solid var(--border-color);margin-bottom:8px"><div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><i class="ph ${typeIcon}" style="color:${typeColor};font-size:14px"></i><span style="font-size:11px;font-weight:600;color:${typeColor}">${entry.actor || (isUser ? 'You' : ticket.assignee || 'Bot')}</span>${sourceBadge}<span style="font-size:11px;color:var(--text-muted);margin-left:auto">${timestamp ? timeAgo(timestamp) : ''}</span></div>${resultLink}<div style="font-size:13px;color:var(--text-primary);line-height:1.5">${rendered}</div></div>`;
}

function renderMarkdownForFeed(text) {
  if (typeof marked !== 'undefined' && text) {
    return marked.parse(text);
  }
  return text;
}

function summarizeResultText(text) {
  return String(text || '')
    .replace(HANDOVER_LINE_PATTERN, '')
    .replace(UUID_HANDOVER_FILENAME_PATTERN, 'handover file')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildResultFolderLink(text, ticket) {
  const workspacePath = ticket?.workspacePath || '';
  if (!workspacePath || !hasResultFolderSignal(text)) {
    return '';
  }
  const folderPath = readResultFolderPath(text);
  const workspaceFolder = buildCodeServerWorkspacePath(workspacePath);
  const targetFolder = folderPath ? joinWorkspacePath(workspaceFolder, folderPath) : workspaceFolder;
  const href = `/code?folder=${encodeURIComponent(targetFolder)}`;
  const label = folderPath ? `Open ${folderPath} folder` : 'Open result folder';
  return `<div style="margin:2px 0 10px"><a href="${href}" target="_blank" rel="noopener" class="td-action-btn" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)"><i class="ph ph-folder-open"></i> ${label}</a></div>`;
}

function hasResultFolderSignal(text) {
  const value = String(text || '');
  return RESULT_FOLDER_PATTERN.test(value) || /developer-handovers\/[0-9a-f-]{36}_/i.test(value);
}

function readResultFolderPath(text) {
  const match = String(text || '').match(RESULT_FOLDER_PATTERN);
  return match?.[1]?.replace(/^\/+|\/+$/g, '') || '';
}
