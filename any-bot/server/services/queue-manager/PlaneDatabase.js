/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PlaneDatabase - Database operations for Plane ticket management
 * Extracted from QueueManagerService for better maintainability
 */

const { Client } = require('pg');
const logger = require('../../utils/logger');

/**
 * @description Encapsulates all direct PostgreSQL access for the Plane-backed
 * ticket workflow so the queue manager and autonomous agents can read and
 * mutate issues, comments, attachments, relations, and sub-issue hierarchies
 * without embedding SQL elsewhere. Centralizing these queries keeps schema
 * knowledge in one place and lets callers obtain short-lived clients on demand.
 * Exported as the module's single value via `module.exports`.
 */
class PlaneDatabase {
  /**
   * @description Hold the PostgreSQL connection configuration so that each
   * operation can spin up a fresh client; the config is not connected here to
   * keep the instance cheap to construct and connections short-lived.
   * @param {Object} dbConfig - node-postgres client configuration (host, port, user, password, database, etc.)
   */
  constructor(dbConfig) {
    this.dbConfig = dbConfig;
  }

  /**
   * Create a new database client
   * @returns {Client} PostgreSQL client
   */
  createClient() {
    return new Client(this.dbConfig);
  }

  /**
   * Update ticket status in Plane
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @param {string} statusName - Status name (Todo, In Progress, etc.)
   * @param {string} projectId - Project ID
   * @returns {Promise<boolean>} - Success status
   */
  async updateTicketStatus(client, ticketId, statusName, projectId) {
    try {
      const query = `
        UPDATE issues 
        SET state_id = (
          SELECT id FROM states 
          WHERE name = $1 AND project_id = $2 
          LIMIT 1
        ),
        updated_at = NOW()
        WHERE id = $3
      `;
      
      const result = await client.query(query, [statusName, projectId, ticketId]);
      
      if (result.rowCount === 1) {
        logger.info(`✓ Status updated: ${ticketId} → ${statusName}`);
        return true;
      } else {
        logger.warn(`Status update failed for ${ticketId} (state '${statusName}' may not exist)`);
        return false;
      }
    } catch (error) {
      logger.error(`Status update error:`, error.message);
      return false;
    }
  }

  /**
   * Post comment to ticket
   * @param {Client} client - Database client
   * @param {Object} ticket - Ticket object
   * @param {string} comment - Comment text
   * @returns {Promise<boolean>} - Success status
   */
  async postComment(client, ticket, comment) {
    try {
      const query = `
        INSERT INTO issue_comments (
          id, comment_stripped, comment_html, comment_json, 
          issue_id, project_id, workspace_id, 
          created_at, updated_at, attachments, access
        ) VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4, $5, $6,
          NOW(), NOW(), '{}', 'EXTERNAL'
        )
      `;

      const commentHtml = `<p>${comment.replace(/\n/g, '</p><p>')}</p>`;
      const commentJson = {
        type: "doc",
        content: [{
          type: "paragraph", 
          content: [{type: "text", text: comment}]
        }]
      };

      const result = await client.query(query, [
        comment, 
        commentHtml, 
        JSON.stringify(commentJson),
        ticket.id, 
        ticket.project_id, 
        ticket.workspace_id
      ]);

      if (result.rowCount === 1) {
        logger.info(`✓ Comment posted to ticket: ${ticket.id}`);
        return true;
      } else {
        logger.warn(`Comment posting failed for ${ticket.id}`);
        return false;
      }
    } catch (error) {
      logger.error(`Comment posting error:`, error.message);
      return false;
    }
  }

  /**
   * Get task ID for ticket
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @returns {Promise<string|null>} - Task ID or null
   */
  async getTicketTaskId(client, ticketId) {
    try {
      const query = `SELECT task_id FROM issues WHERE id = $1`;
      const result = await client.query(query, [ticketId]);
      return result.rows[0]?.task_id || null;
    } catch (error) {
      logger.error(`Failed to get task_id for ticket ${ticketId}:`, error.message);
      return null;
    }
  }

  /**
   * Store task ID in ticket metadata
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @param {string} taskId - Task ID
   * @returns {Promise<boolean>} - Success status
   */
  async setTicketTaskId(client, ticketId, taskId) {
    try {
      const query = `UPDATE issues SET task_id = $1 WHERE id = $2`;
      await client.query(query, [taskId, ticketId]);
      logger.info(`✓ Task ${taskId} linked to ticket ${ticketId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to set task_id for ticket ${ticketId}:`, error.message);
      return false;
    }
  }

  /**
   * Get recent comments for a ticket (FIX 7: comment history for agent context)
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @param {number} limit - Max comments to return (default 5)
   * @returns {Promise<Array>} - Array of comment objects
   */
  async getRecentComments(client, ticketId, limit = 5) {
    try {
      const query = `
        SELECT comment_stripped, created_at
        FROM issue_comments
        WHERE issue_id = $1
        AND comment_stripped IS NOT NULL
        AND comment_stripped != ''
        ORDER BY created_at DESC
        LIMIT $2
      `;
      const result = await client.query(query, [ticketId, limit]);
      return result.rows.reverse(); // Return in chronological order
    } catch (error) {
      logger.error(`Failed to get recent comments for ticket ${ticketId}:`, error.message);
      return [];
    }
  }

  /**
   * Get attachments for a ticket (Enhancement B)
   * Queries both issue_attachments and file_assets tables
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @returns {Promise<Array>} - Array of attachment objects with asset URL, attributes, size
   */
  async getTicketAttachments(client, ticketId) {
    try {
      // Query both attachment sources
      const query = `
        SELECT 
          'issue_attachment' as source,
          ia.id,
          ia.asset,
          ia.attributes,
          ia.created_at,
          0 as size
        FROM issue_attachments ia
        WHERE ia.issue_id = $1
        AND ia.deleted_at IS NULL
        
        UNION ALL
        
        SELECT 
          'file_asset' as source,
          fa.id,
          fa.asset,
          fa.attributes,
          fa.created_at,
          fa.size
        FROM file_assets fa
        WHERE fa.issue_id = $1
        AND fa.is_deleted = false
        AND fa.is_uploaded = true
        
        ORDER BY created_at ASC
      `;
      
      const result = await client.query(query, [ticketId]);
      
      if (result.rows.length > 0) {
        logger.info(`Found ${result.rows.length} attachment(s) for ticket ${ticketId}`);
      }
      
      return result.rows.map(row => ({
        id: row.id,
        source: row.source,
        asset: row.asset,
        attributes: row.attributes || {},
        size: row.size || 0,
        createdAt: row.created_at,
        // Extract filename from asset path or attributes
        filename: row.attributes?.name || row.asset?.split('/').pop() || 'unknown',
        // Detect file type from extension
        fileType: this._detectFileType(row.attributes?.name || row.asset || '')
      }));
    } catch (error) {
      logger.error(`Failed to get attachments for ticket ${ticketId}:`, error.message);
      return [];
    }
  }

  /**
   * Format attachments as context string for agent prompts
   * @param {Array} attachments - Array from getTicketAttachments()
   * @returns {string} - Formatted context string
   */
  formatAttachmentsForPrompt(attachments) {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    const lines = ['## Attached Files'];
    for (const att of attachments) {
      const sizeStr = att.size > 0 ? ` (${this._formatFileSize(att.size)})` : '';
      lines.push(`- **${att.filename}**${sizeStr} [${att.fileType}]`);
      lines.push(`  URL: ${att.asset}`);
    }
    return lines.join('\n');
  }

  /**
   * Convert markdown text to basic HTML for Plane description_html
   * Handles: headings, bold, italic, code, lists, checkboxes, horizontal rules, blockquotes
   * @param {string} markdown - Markdown text
   * @returns {string} - HTML string
   * @private
   */
  _markdownToHtml(markdown) {
    if (!markdown) return '<p></p>';
    
    const lines = markdown.split('\n');
    const htmlParts = [];
    let inList = false;
    let inCodeBlock = false;
    
    for (const line of lines) {
      // Code block toggle
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          htmlParts.push('</code></pre>');
          inCodeBlock = false;
        } else {
          if (inList) { htmlParts.push('</ul>'); inList = false; }
          htmlParts.push('<pre><code>');
          inCodeBlock = true;
        }
        continue;
      }
      
      if (inCodeBlock) {
        htmlParts.push(line.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        continue;
      }
      
      // Horizontal rule
      if (line.trim().match(/^[-*_]{3,}$/)) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        htmlParts.push('<hr/>');
        continue;
      }
      
      // Headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        const level = headingMatch[1].length;
        htmlParts.push(`<h${level}>${this._inlineMarkdown(headingMatch[2])}</h${level}>`);
        continue;
      }
      
      // Blockquote
      if (line.trim().startsWith('>')) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        const text = line.replace(/^>\s*/, '');
        htmlParts.push(`<blockquote><p>${this._inlineMarkdown(text)}</p></blockquote>`);
        continue;
      }
      
      // List items (bullet or checkbox)
      const listMatch = line.match(/^\s*[-*]\s+(\[[ x]\])?\s*(.*)/);
      if (listMatch) {
        if (!inList) { htmlParts.push('<ul>'); inList = true; }
        const checkbox = listMatch[1];
        const text = listMatch[2] || '';
        if (checkbox) {
          const checked = checkbox === '[x]' ? ' checked' : '';
          htmlParts.push(`<li><input type="checkbox"${checked} disabled/> ${this._inlineMarkdown(text)}</li>`);
        } else {
          htmlParts.push(`<li>${this._inlineMarkdown(text)}</li>`);
        }
        continue;
      }
      
      // Numbered list
      const numMatch = line.match(/^\s*\d+\.\s+(.*)/);
      if (numMatch) {
        if (!inList) { htmlParts.push('<ul>'); inList = true; }
        htmlParts.push(`<li>${this._inlineMarkdown(numMatch[1])}</li>`);
        continue;
      }
      
      // Close list if non-list line
      if (inList && line.trim() === '') {
        htmlParts.push('</ul>');
        inList = false;
        continue;
      }
      
      // Empty line → paragraph break
      if (line.trim() === '') {
        continue;
      }
      
      // Regular paragraph
      if (inList) { htmlParts.push('</ul>'); inList = false; }
      htmlParts.push(`<p>${this._inlineMarkdown(line)}</p>`);
    }
    
    if (inList) htmlParts.push('</ul>');
    if (inCodeBlock) htmlParts.push('</code></pre>');
    
    return htmlParts.join('\n') || '<p></p>';
  }

  /**
   * Convert inline markdown: bold, italic, code, links
   * @private
   */
  _inlineMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  /**
   * Convert markdown to Plane's JSON description format (ProseMirror-like)
   * @param {string} markdown - Markdown text
   * @returns {Object} - Plane description JSON
   * @private
   */
  _markdownToPlaneJson(markdown) {
    if (!markdown) return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] };
    
    // Simple conversion: split into paragraphs, each becomes a ProseMirror paragraph node
    const content = [];
    const paragraphs = markdown.split(/\n\n+/);
    
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: trimmed }]
      });
    }
    
    if (content.length === 0) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: markdown }] });
    }
    
    return { type: 'doc', content };
  }

  /**
   * Detect file type category from filename/path
   * @private
   */
  _detectFileType(filePath) {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const typeMap = {
      pdf: 'document', doc: 'document', docx: 'document', txt: 'text',
      md: 'markdown', csv: 'spreadsheet', xlsx: 'spreadsheet', xls: 'spreadsheet',
      png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image',
      mp3: 'audio', wav: 'audio', mp4: 'video', mov: 'video',
      js: 'code', ts: 'code', py: 'code', java: 'code', go: 'code', rs: 'code',
      json: 'data', yaml: 'data', yml: 'data', xml: 'data',
      zip: 'archive', tar: 'archive', gz: 'archive',
      pptx: 'presentation', ppt: 'presentation'
    };
    return typeMap[ext] || 'file';
  }

  /**
   * Format file size for display
   * @private
   */
  _formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Create a sub-issue in Plane (Enhancement C)
   * @param {Client} client - Database client
   * @param {string} parentId - Parent issue ID
   * @param {string} title - Sub-issue title
   * @param {string} description - Sub-issue description
   * @param {string} projectId - Project ID
   * @param {string} workspaceId - Workspace ID
   * @returns {Promise<string|null>} - New issue ID or null
   */
  async createSubIssue(client, parentId, title, description, projectId, workspaceId) {
    try {
      // Get the default state (Todo) for the project
      const stateQuery = `SELECT id FROM states WHERE project_id = $1 AND name = 'Todo' LIMIT 1`;
      const stateResult = await client.query(stateQuery, [projectId]);
      const stateId = stateResult.rows[0]?.id;

      if (!stateId) {
        logger.error(`No 'Todo' state found for project ${projectId}`);
        return null;
      }

      // Get created_by_id from parent ticket (inherit creator) or fall back to first workspace member
      let createdById = null;
      try {
        const creatorQuery = `
          SELECT COALESCE(
            (SELECT created_by_id FROM issues WHERE id = $1),
            (SELECT member_id FROM workspace_members WHERE workspace_id = $2 LIMIT 1),
            (SELECT id FROM users LIMIT 1)
          ) as user_id
        `;
        const creatorResult = await client.query(creatorQuery, [parentId, workspaceId]);
        createdById = creatorResult.rows[0]?.user_id || null;
      } catch (err) {
        logger.warn(`Could not resolve created_by_id for sub-issue, trying users table: ${err.message}`);
        try {
          const fallbackResult = await client.query(`SELECT id FROM users LIMIT 1`);
          createdById = fallbackResult.rows[0]?.id || null;
        } catch (e) { /* proceed without */ }
      }

      // Get next sequence_id for this project
      const seqQuery = `SELECT COALESCE(MAX(sequence_id), 0) + 1 as next_seq FROM issues WHERE project_id = $1`;
      const seqResult = await client.query(seqQuery, [projectId]);
      const nextSeq = seqResult.rows[0].next_seq;

      // Get sort_order
      const sortQuery = `SELECT COALESCE(MAX(sort_order), 0) + 65535 as next_sort FROM issues WHERE project_id = $1`;
      const sortResult = await client.query(sortQuery, [projectId]);
      const sortOrder = sortResult.rows[0].next_sort;

      const query = `
        INSERT INTO issues (
          id, name, description, description_stripped, description_html,
          priority, state_id, project_id, workspace_id, parent_id,
          created_by_id, updated_by_id,
          sequence_id, sort_order,
          created_at, updated_at,
          start_date, target_date,
          archived_at, is_draft
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          'medium', $5, $6, $7, $8,
          $9, $9,
          $10, $11,
          NOW(), NOW(),
          NULL, NULL,
          NULL, false
        )
        RETURNING id
      `;

      const descHtml = this._markdownToHtml(description);
      const descJson = this._markdownToPlaneJson(description);

      const result = await client.query(query, [
        title,
        JSON.stringify(descJson),
        description,
        descHtml,
        stateId,
        projectId,
        workspaceId,
        parentId,
        createdById,
        nextSeq,
        sortOrder
      ]);

      const newId = result.rows[0]?.id;
      if (newId) {
        logger.info(`✓ Sub-issue created: ${newId} (parent: ${parentId}) — "${title}"`);
      }
      return newId;
    } catch (error) {
      logger.error(`Failed to create sub-issue for parent ${parentId}:`, error.message);
      return null;
    }
  }

  /**
   * Get child issues for a parent ticket (Enhancement C)
   * @param {Client} client - Database client
   * @param {string} parentId - Parent issue ID
   * @returns {Promise<Array>} - Array of child issue objects
   */
  async getChildIssues(client, parentId) {
    try {
      const query = `
        SELECT i.id, i.name, i.description_stripped, 
               s.name as status, i.priority, i.created_at
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id
        WHERE i.parent_id = $1
        ORDER BY i.sequence_id ASC
      `;
      const result = await client.query(query, [parentId]);
      return result.rows;
    } catch (error) {
      logger.error(`Failed to get child issues for parent ${parentId}:`, error.message);
      return [];
    }
  }

  /**
   * Check if a ticket has any children (is a parent ticket)
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @returns {Promise<boolean>} - true if ticket has children
   */
  async hasChildren(client, ticketId) {
    try {
      const query = `SELECT EXISTS(SELECT 1 FROM issues WHERE parent_id = $1 AND deleted_at IS NULL) as has_children`;
      const result = await client.query(query, [ticketId]);
      return result.rows[0]?.has_children || false;
    } catch (error) {
      logger.error(`Failed to check children for ticket ${ticketId}:`, error.message);
      return false;
    }
  }

  /**
   * Check if all child issues of a parent are resolved
   * @param {Client} client - Database client
   * @param {string} parentId - Parent issue ID
   * @returns {Promise<{total: number, completed: number, allDone: boolean}>}
   */
  async checkChildCompletion(client, parentId) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN s.name IN ('Done', 'Cancelled', 'Customer Action') THEN 1 END) as completed
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id
        WHERE i.parent_id = $1
      `;
      const result = await client.query(query, [parentId]);
      const { total, completed } = result.rows[0];
      return {
        total: parseInt(total),
        completed: parseInt(completed),
        allDone: parseInt(total) > 0 && parseInt(total) === parseInt(completed)
      };
    } catch (error) {
      logger.error(`Failed to check child completion for parent ${parentId}:`, error.message);
      return { total: 0, completed: 0, allDone: false };
    }
  }

  /**
   * Get linked issues for a ticket (Enhancement E2: Ticket Links)
   * Queries issue_relations table for all relation types
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @returns {Promise<Array>} - Array of linked issue objects
   */
  async getTicketLinks(client, ticketId) {
    try {
      const query = `
        SELECT 
          ir.relation_type,
          i.id,
          i.name,
          s.name as status,
          i.priority,
          i.sequence_id
        FROM issue_relations ir
        JOIN issues i ON ir.related_issue_id = i.id
        LEFT JOIN states s ON i.state_id = s.id
        WHERE ir.issue_id = $1
        AND i.deleted_at IS NULL
        
        UNION ALL
        
        SELECT 
          CASE ir.relation_type
            WHEN 'blocked_by' THEN 'blocks'
            WHEN 'blocks' THEN 'blocked_by'
            WHEN 'relates_to' THEN 'relates_to'
            WHEN 'duplicate' THEN 'duplicate'
            ELSE ir.relation_type
          END as relation_type,
          i.id,
          i.name,
          s.name as status,
          i.priority,
          i.sequence_id
        FROM issue_relations ir
        JOIN issues i ON ir.issue_id = i.id
        LEFT JOIN states s ON i.state_id = s.id
        WHERE ir.related_issue_id = $1
        AND i.deleted_at IS NULL
        
        ORDER BY relation_type, sequence_id
      `;
      
      const result = await client.query(query, [ticketId]);
      
      if (result.rows.length > 0) {
        logger.info(`Found ${result.rows.length} linked issue(s) for ticket ${ticketId}`);
      }
      
      return result.rows;
    } catch (error) {
      logger.error(`Failed to get ticket links for ${ticketId}:`, error.message);
      return [];
    }
  }

  /**
   * Format linked issues as context string for agent prompts
   * @param {Array} links - Array from getTicketLinks()
   * @returns {string} - Formatted context string
   */
  formatLinksForPrompt(links) {
    if (!links || links.length === 0) {
      return '';
    }

    const grouped = {};
    for (const link of links) {
      const type = link.relation_type || 'related';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(link);
    }

    const lines = ['## Linked Issues'];
    for (const [type, issues] of Object.entries(grouped)) {
      const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      lines.push(`### ${label}`);
      for (const issue of issues) {
        lines.push(`- **#${issue.sequence_id}**: ${issue.name} [${issue.status || 'Unknown'}] (${issue.priority || 'none'})`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Create a root-level issue in Plane (not a sub-issue)
   * Used by AutonomousRemediator to create tickets from detected anomalies.
   * Same INSERT pattern as createSubIssue() but without parent_id.
   * 
   * @param {Client} client - Database client
   * @param {string} title - Issue title
   * @param {string} description - Issue description (markdown)
   * @param {string} projectId - Project ID
   * @param {string} workspaceId - Workspace ID
   * @param {string} [priority='medium'] - Priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
   * @param {string} [assigneeId=null] - Assignee user UUID
   * @param {string[]} [labelIds=[]] - Array of label UUIDs
   * @returns {Promise<{id: string, sequenceId: number}|null>} - New issue ID and sequence, or null
   */
  async createRootIssue(client, title, description, projectId, workspaceId, priority = 'medium', assigneeId = null, labelIds = []) {
    try {
      // Validate priority
      const validPriorities = ['urgent', 'high', 'medium', 'low', 'none'];
      if (!validPriorities.includes(priority)) {
        logger.error(`[PlaneDatabase] Invalid priority '${priority}' — must be one of: ${validPriorities.join(', ')}`);
        return null;
      }

      // Get the default state (Todo) for the project
      const stateQuery = `SELECT id FROM states WHERE project_id = $1 AND name = 'Todo' LIMIT 1`;
      const stateResult = await client.query(stateQuery, [projectId]);
      const stateId = stateResult.rows[0]?.id;

      if (!stateId) {
        logger.error(`[PlaneDatabase] No 'Todo' state found for project ${projectId}`);
        return null;
      }

      // Get created_by_id — first workspace member or first user
      let createdById = null;
      try {
        const creatorQuery = `
          SELECT COALESCE(
            (SELECT member_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1),
            (SELECT id FROM users LIMIT 1)
          ) as user_id
        `;
        const creatorResult = await client.query(creatorQuery, [workspaceId]);
        createdById = creatorResult.rows[0]?.user_id || null;
      } catch (err) {
        logger.warn(`[PlaneDatabase] Could not resolve created_by_id for root issue: ${err.message}`);
        try {
          const fallbackResult = await client.query(`SELECT id FROM users LIMIT 1`);
          createdById = fallbackResult.rows[0]?.id || null;
        } catch (e) { /* proceed without */ }
      }

      // Get next sequence_id for this project
      const seqQuery = `SELECT COALESCE(MAX(sequence_id), 0) + 1 as next_seq FROM issues WHERE project_id = $1`;
      const seqResult = await client.query(seqQuery, [projectId]);
      const nextSeq = seqResult.rows[0].next_seq;

      // Get sort_order
      const sortQuery = `SELECT COALESCE(MAX(sort_order), 0) + 65535 as next_sort FROM issues WHERE project_id = $1`;
      const sortResult = await client.query(sortQuery, [projectId]);
      const sortOrder = sortResult.rows[0].next_sort;

      const query = `
        INSERT INTO issues (
          id, name, description, description_stripped, description_html,
          priority, state_id, project_id, workspace_id,
          created_by_id, updated_by_id,
          sequence_id, sort_order,
          created_at, updated_at,
          start_date, target_date,
          archived_at, is_draft
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $9,
          $10, $11,
          NOW(), NOW(),
          NULL, NULL,
          NULL, false
        )
        RETURNING id, sequence_id
      `;

      const descHtml = this._markdownToHtml(description);
      const descJson = this._markdownToPlaneJson(description);

      const result = await client.query(query, [
        title,
        JSON.stringify(descJson),
        description,
        descHtml,
        priority,
        stateId,
        projectId,
        workspaceId,
        createdById,
        nextSeq,
        sortOrder
      ]);

      const row = result.rows[0];
      if (row) {
        logger.info(`✓ Root issue created: ${row.id} (seq: ${row.sequence_id}) — "${title}"`);

        // Assign if assigneeId provided
        if (assigneeId) {
          try {
            await client.query(
              `INSERT INTO issue_assignees (id, issue_id, assignee_id, project_id, workspace_id, created_at, updated_at)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())`,
              [row.id, assigneeId, projectId, workspaceId]
            );
            logger.info(`✓ Assigned root issue ${row.id} to ${assigneeId}`);
          } catch (assignErr) {
            logger.warn(`Could not assign root issue: ${assignErr.message}`);
          }
        }

        // Add labels if provided
        if (labelIds && labelIds.length > 0) {
          for (const labelId of labelIds) {
            try {
              await client.query(
                `INSERT INTO issue_labels (id, issue_id, label_id, project_id, workspace_id, created_at, updated_at)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())`,
                [row.id, labelId, projectId, workspaceId]
              );
            } catch (labelErr) {
              logger.warn(`Could not add label ${labelId}: ${labelErr.message}`);
            }
          }
          logger.info(`✓ Added ${labelIds.length} label(s) to root issue ${row.id}`);
        }

        return { id: row.id, sequenceId: row.sequence_id };
      }
      return null;
    } catch (error) {
      logger.error(`[PlaneDatabase] Failed to create root issue "${title}":`, error.message);
      return null;
    }
  }

  /**
   * Get parent_id for a ticket (null if root ticket)
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @returns {Promise<string|null>} - Parent issue ID or null
   */
  async getParentId(client, ticketId) {
    try {
      const query = `SELECT parent_id FROM issues WHERE id = $1`;
      const result = await client.query(query, [ticketId]);
      return result.rows[0]?.parent_id || null;
    } catch (error) {
      logger.error(`Failed to get parent_id for ticket ${ticketId}:`, error.message);
      return null;
    }
  }

  /**
   * Get child issues with their deliverable comments (for parent assembly)
   * Returns each child's latest substantive comment (agent work product)
   * @param {Client} client - Database client
   * @param {string} parentId - Parent issue ID
   * @returns {Promise<Array>} - Array of {id, name, status, deliverable} objects
   */
  async getChildDeliverables(client, parentId) {
    try {
      // ⭐ PHASE_63 FIX: Removed 'Queue Manager v%' filter — agent completion comments
      // all end with '---\n*Queue Manager v2.0*' footer, so the old filter was excluding
      // ALL agent work. Now we only filter pure routing/admin comments by checking for
      // specific short admin patterns, while keeping substantive work (LENGTH > 500).
      // The LENGTH > 500 threshold ensures we skip short routing notices but keep real work.
      const query = `
        SELECT i.id, i.name, i.description_stripped,
               s.name as status, i.priority, i.sequence_id,
               (
                 SELECT ic.comment_stripped
                 FROM issue_comments ic
                 WHERE ic.issue_id = i.id
                 AND ic.comment_stripped IS NOT NULL
                 AND ic.comment_stripped != ''
                 AND ic.comment_stripped NOT LIKE '%TASK BRIEF — Queue Manager%'
                 AND ic.comment_stripped NOT LIKE '%Ticket Routed%'
                 AND ic.comment_stripped NOT LIKE '%Routing to @agent:%'
                 AND ic.comment_stripped NOT LIKE '%Agent Work In Progress%'
                 AND ic.comment_stripped NOT LIKE '%Subtask Decomposition%'
                 AND LENGTH(ic.comment_stripped) > 500
                 ORDER BY ic.created_at DESC
                 LIMIT 1
               ) as deliverable
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id
        WHERE i.parent_id = $1
        ORDER BY i.sequence_id ASC
      `;
      const result = await client.query(query, [parentId]);
      return result.rows;
    } catch (error) {
      logger.error(`Failed to get child deliverables for parent ${parentId}:`, error.message);
      return [];
    }
  }

  /**
   * Check for new activity since timestamp
   * @param {Client} client - Database client
   * @param {string} ticketId - Ticket ID
   * @param {number} sinceTimestamp - Timestamp to check from
   * @returns {Promise<boolean>} - Has new activity
   */
  async hasNewActivity(client, ticketId, sinceTimestamp) {
    try {
      const query = `
        SELECT COUNT(*) as count
        FROM issue_comments
        WHERE issue_id = $1
        AND created_at > $2
      `;
      const result = await client.query(query, [ticketId, new Date(sinceTimestamp)]);
      return parseInt(result.rows[0].count) > 0;
    } catch (error) {
      logger.error(`Failed to check activity for ticket ${ticketId}:`, error.message);
      return false;
    }
  }
}

module.exports = PlaneDatabase;
