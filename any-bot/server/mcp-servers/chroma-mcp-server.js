/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Chroma MCP Server — Self-Contained Local RAG
 * HTTP-based MCP server with built-in in-memory vector store.
 * No external RAG service needed. Supports:
 *   - POST /ingest — Add documents (text chunks)
 *   - POST /execute — Run search_documents tool (keyword match)
 *   - GET /tools — List available tools
 *   - GET /health — Health check with document count
 *   - GET /documents — List all ingested documents
 */

const express = require('express');
const logger = require('../utils/logger');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8082;

// ═══════════════════════════════════════════
// In-memory document store (keyword search)
// ═══════════════════════════════════════════
const documents = []; // { id, text, metadata, createdAt }

function searchDocuments(query, topK = 5) {
  if (!query || documents.length === 0) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const scored = documents.map(doc => {
    const text = doc.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const idx = text.indexOf(term);
      if (idx !== -1) score += 1;
      // Bonus for title/metadata matches
      const meta = JSON.stringify(doc.metadata || {}).toLowerCase();
      if (meta.includes(term)) score += 0.5;
    }
    return { ...doc, score };
  }).filter(d => d.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(d => ({
    id: d.id,
    text: d.text.substring(0, 500),
    metadata: d.metadata,
    score: d.score,
  }));
}

logger.info(`Chroma MCP Server (local mode) starting...`);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'chroma-mcp',
    mode: 'local-memory',
    documents: documents.length,
    rag_service: 'built-in (no external dependency)'
  });
});

// List available tools
app.get('/tools', (req, res) => {
  res.json({
    tools: [
      {
        name: 'search_documents',
        description: 'Search documents in local vector database. Returns matching text chunks with relevance scores.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            top_k: { type: 'number', description: 'Number of results', default: 5 }
          },
          required: ['query']
        }
      }
    ]
  });
});

// Execute tool (MCP standard)
app.post('/execute', async (req, res) => {
  try {
    const { tool, arguments: args } = req.body;
    
    if (tool === 'search_documents') {
      const { query, top_k = 5 } = args || {};
      const results = searchDocuments(query, top_k);
      res.json({
        success: true,
        content: [{ type: 'text', text: JSON.stringify({ results, count: results.length, query }, null, 2) }],
      });
    } else {
      res.status(404).json({ error: `Tool '${tool}' not found` });
    }
  } catch (error) {
    logger.error(`Tool execution error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Ingest documents
app.post('/ingest', (req, res) => {
  try {
    const { documents: docs, text, metadata } = req.body;
    
    // Support single document or batch
    const toIngest = docs || [{ text, metadata }];
    let count = 0;
    
    for (const doc of toIngest) {
      if (!doc.text) continue;
      // Split into chunks of ~500 chars for better search
      const chunks = [];
      const words = doc.text.split(/\s+/);
      let chunk = '';
      for (const word of words) {
        if ((chunk + ' ' + word).length > 500 && chunk.length > 0) {
          chunks.push(chunk.trim());
          chunk = word;
        } else {
          chunk += ' ' + word;
        }
      }
      if (chunk.trim()) chunks.push(chunk.trim());
      
      for (const chunkText of chunks) {
        documents.push({
          id: `doc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          text: chunkText,
          metadata: doc.metadata || {},
          createdAt: new Date().toISOString(),
        });
        count++;
      }
    }
    
    logger.info(`Ingested ${count} chunks (total: ${documents.length})`);
    res.json({ success: true, chunksIngested: count, totalDocuments: documents.length });
  } catch (error) {
    logger.error(`Ingest error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Compatibility route: MCPService calls POST /tools/:toolName
// Translates to the /execute format
app.post('/tools/:toolName', async (req, res) => {
  try {
    const tool = req.params.toolName;
    const args = req.body;
    
    if (tool === 'search_documents') {
      const { query, top_k = 5 } = args || {};
      const results = searchDocuments(query, top_k);
      res.json({
        success: true,
        content: [{ type: 'text', text: JSON.stringify({ results, count: results.length, query }, null, 2) }],
      });
    } else {
      res.status(404).json({ error: `Tool '${tool}' not found` });
    }
  } catch (error) {
    logger.error(`Tool execution error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// List documents
app.get('/documents', (req, res) => {
  res.json({
    count: documents.length,
    documents: documents.map(d => ({
      id: d.id,
      preview: d.text.substring(0, 100) + '...',
      metadata: d.metadata,
      createdAt: d.createdAt,
    }))
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`✅ Chroma MCP Server (local) listening on port ${PORT}`);
  logger.info(`   Health: http://localhost:${PORT}/health`);
  logger.info(`   Tools: http://localhost:${PORT}/tools`);
  logger.info(`   Ingest: POST http://localhost:${PORT}/ingest`);
  logger.info(`   Search: POST http://localhost:${PORT}/execute`);
  logger.info(`   Mode: In-memory (no external RAG dependency)`);
});
