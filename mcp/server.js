#!/usr/bin/env node
/**
 * Hermes MCP Server — exposes hermes_* tools for Claude.
 * Set HERMES_API_URL (e.g. https://home-server.../hermes) and HERMES_MCP_TOKEN (JWT).
 * Run: node server.js (stdio transport).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listTools, callTool } from '../server/src/mcpTools.js';

const API_URL = (process.env.HERMES_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.HERMES_MCP_TOKEN || '';

function api(path, options = {}) {
  const url = `${API_URL}/api${path}`;
  const headers = { ...options.headers, 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return fetch(url, { ...options, headers }).then((r) => (r.status === 204 ? {} : r.json()));
}

const server = new Server({ name: 'hermes-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, listTools);
server.setRequestHandler(CallToolRequestSchema, (req) => callTool(api, req));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
