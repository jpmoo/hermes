#!/usr/bin/env node
/**
 * Hermes MCP Server — exposes hermes_* tools for Claude.
 * Set HERMES_API_URL (e.g. https://home-server.../hermes) and HERMES_MCP_TOKEN (JWT).
 * Run: node server.js (stdio transport).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_URL = (process.env.HERMES_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.HERMES_MCP_TOKEN || '';

function api(path, options = {}) {
  const url = `${API_URL}/api${path}`;
  const headers = { ...options.headers, 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return fetch(url, { ...options, headers }).then((r) => (r.status === 204 ? {} : r.json()));
}

const TOOL_DEFS = [
  { name: 'hermes_create_note', description: 'Create a root note or reply.', inputSchema: { type: 'object', properties: { content: { type: 'string' }, parent_id: { type: 'string' }, external_anchor: { type: 'string' } }, required: ['content'] } },
  { name: 'hermes_get_thread', description: 'Retrieve a thread by root note ID.', inputSchema: { type: 'object', properties: { root_id: { type: 'string' } }, required: ['root_id'] } },
  { name: 'hermes_search_semantic', description: 'Query notes by semantic similarity.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } }, required: ['q'] } },
  { name: 'hermes_search_tags', description: 'Query notes by tag(s).', inputSchema: { type: 'object', properties: { tag_ids: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['and', 'or'] } } } },
  { name: 'hermes_get_queue', description: 'Get pending tag proposals.', inputSchema: { type: 'object', properties: { min_confidence: { type: 'number' } } } },
  { name: 'hermes_approve_tag', description: 'Approve or reject a pending tag.', inputSchema: { type: 'object', properties: { proposal_id: { type: 'string' }, approve: { type: 'boolean' } }, required: ['proposal_id'] } },
  { name: 'hermes_star_note', description: 'Star or unstar a note.', inputSchema: { type: 'object', properties: { note_id: { type: 'string' }, starred: { type: 'boolean' } }, required: ['note_id'] } },
  { name: 'hermes_get_starred', description: 'Get starred roots.' },
  { name: 'hermes_get_root_feed', description: 'Get root feed (reverse chron).' },
];

const server = new Server({ name: 'hermes-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object' } })) }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case 'hermes_create_note': {
        const { content, parent_id, external_anchor } = args || {};
        const body = await api('/notes', { method: 'POST', body: JSON.stringify({ content: content || '', parent_id: parent_id || null, external_anchor: external_anchor || null }) });
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_get_thread': {
        const { root_id } = args || {};
        const body = await api(`/notes/thread/${root_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_search_semantic': {
        const { q, limit } = args || {};
        const body = await api(`/notes/search-semantic?q=${encodeURIComponent(q || '')}&limit=${limit || 20}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_search_tags': {
        const { tag_ids, mode } = args || {};
        const ids = Array.isArray(tag_ids) ? tag_ids : (tag_ids || '').toString().split(',').filter(Boolean);
        const body = await api(`/notes/search-by-tags?tagIds=${ids.join(',')}&mode=${mode || 'and'}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_get_queue': {
        const { min_confidence } = args || {};
        const body = await api(`/queue?minConfidence=${min_confidence ?? 0}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_approve_tag': {
        const { proposal_id, approve } = args || {};
        if (approve) await api(`/queue/${proposal_id}/approve`, { method: 'POST' });
        else await api(`/queue/${proposal_id}/reject`, { method: 'POST' });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      }
      case 'hermes_star_note': {
        const { note_id, starred } = args || {};
        if (starred) await api(`/notes/${note_id}/star`, { method: 'POST' });
        else await api(`/notes/${note_id}/star`, { method: 'DELETE' });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      }
      case 'hermes_get_starred': {
        const body = await api('/notes/roots?starred=true');
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_get_root_feed': {
        const body = await api('/notes/roots');
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
