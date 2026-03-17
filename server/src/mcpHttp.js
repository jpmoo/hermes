/**
 * Streamable HTTP MCP at GET/POST /mcp. One transport per session (required by SDK).
 * Caddy strip_prefix /hermes → backend sees /mcp.
 * Auth: Authorization: Bearer <JWT>; falls back to HERMES_MCP_TOKEN when header omitted.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listTools, callTool } from './mcpTools.js';

const mcpRequestStore = new AsyncLocalStorage();

const SESSION_TTL_MS = Number(process.env.HERMES_MCP_SESSION_TTL_MS) || 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** @type {Map<string, { transport: import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport, lastTouch: number }>} */
const sessions = new Map();

function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastTouch > SESSION_TTL_MS) {
      sessions.delete(id);
      s.transport.close?.().catch(() => {});
    }
  }
}
setInterval(pruneSessions, PRUNE_INTERVAL_MS).unref();

function makeApi(baseUrl, getToken) {
  return (path, options = {}) => {
    const url = `${baseUrl.replace(/\/$/, '')}/api${path}`;
    const token = getToken();
    const headers = { ...options.headers, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { ...options, headers }).then((r) => (r.status === 204 ? {} : r.json()));
  };
}

function isInitializeBody(body) {
  if (body == null) return false;
  if (Array.isArray(body)) return body.some((m) => m && typeof m === 'object' && m.method === 'initialize');
  return typeof body === 'object' && body.method === 'initialize';
}

function createMcpServer(api) {
  const mcpServer = new Server({ name: 'hermes-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  mcpServer.setRequestHandler(ListToolsRequestSchema, listTools);
  mcpServer.setRequestHandler(CallToolRequestSchema, (req) => callTool(api, req));
  return mcpServer;
}

/**
 * @param {import('express').Express} app
 * @param {{ port: number }} opts
 */
export function mountMcpHttp(app, opts) {
  const internalBase =
    process.env.HERMES_INTERNAL_API_URL || `http://127.0.0.1:${opts.port}`;

  const getToken = () => {
    const s = mcpRequestStore.getStore();
    if (s?.bearer) return s.bearer;
    return process.env.HERMES_MCP_TOKEN || '';
  };

  const api = makeApi(internalBase, getToken);

  app.all('/mcp', (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim() || '';
    const sidRaw = req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'];
    const sid = typeof sidRaw === 'string' ? sidRaw.trim() : '';

    const run = (fn) => {
      mcpRequestStore.run({ bearer: bearer || undefined }, () => {
        Promise.resolve(fn()).catch(next);
      });
    };

    run(async () => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!sid || !sessions.has(sid)) {
          res.status(400).setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing or unknown Mcp-Session-Id for SSE' }));
          return;
        }
        sessions.get(sid).lastTouch = Date.now();
        const body = req.method === 'HEAD' ? undefined : undefined;
        await sessions.get(sid).transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'POST') {
        const body = req.body;
        const initializing = isInitializeBody(body);

        if (initializing && !sid) {
          const sessionId = randomUUID();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId,
            onsessionclosed: () => {
              sessions.delete(sessionId);
            },
          });
          const mcpServer = createMcpServer(api);
          await mcpServer.connect(transport);
          sessions.set(sessionId, { transport, lastTouch: Date.now() });
          await transport.handleRequest(req, res, body);
          return;
        }

        if (sid && sessions.has(sid)) {
          sessions.get(sid).lastTouch = Date.now();
          await sessions.get(sid).transport.handleRequest(req, res, body);
          return;
        }

        if (!sid && !initializing) {
          res.status(400).setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Send initialize first, or include Mcp-Session-Id' }));
          return;
        }

        res.status(404).setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unknown MCP session' }));
        return;
      }

      if (req.method === 'DELETE' && sid && sessions.has(sid)) {
        const s = sessions.get(sid);
        sessions.delete(sid);
        await s.transport.close?.().catch(() => {});
        res.status(204).end();
        return;
      }

      res.status(405).setHeader('Allow', 'GET, POST, DELETE');
      res.end('Method Not Allowed');
    });
  });

  console.log('MCP Streamable HTTP: /mcp (sessions; internal API:', internalBase + ')');
}
