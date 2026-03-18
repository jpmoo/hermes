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
import { hermesApiFetcher, uploadNoteAttachmentsMultipart } from '../server/src/mcpApiClient.js';

const API_URL = (process.env.HERMES_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.HERMES_MCP_TOKEN || '';
const api = hermesApiFetcher(API_URL, () => TOKEN);
const uploadAttachments = (noteId, files) =>
  uploadNoteAttachmentsMultipart(API_URL, () => TOKEN, noteId, files);

const server = new Server({ name: 'hermes-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, listTools);
server.setRequestHandler(CallToolRequestSchema, (req) => callTool({ api, uploadAttachments }, req));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
