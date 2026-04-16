import { randomUUID } from 'node:crypto';

function loggingEnabled() {
  const v = process.env.HERMES_HTTP_LOG;
  if (v === '0' || v === 'false') return false;
  return true;
}

function includeMcp() {
  const v = process.env.HERMES_HTTP_LOG_MCP;
  if (v === '0' || v === 'false') return false;
  return true;
}

/**
 * Log API (and optionally MCP) requests after the response finishes.
 * Lines are JSON with `"hermes_http":true` for easy filtering: `journalctl -u hermes | grep hermes_http`
 *
 * Env:
 * - HERMES_HTTP_LOG=0 — disable
 * - HERMES_HTTP_LOG_MCP=0 — do not log /mcp (default: log MCP too)
 */
export function httpRequestLog(req, res, next) {
  if (!loggingEnabled()) return next();

  const pathname = req.path || (req.url || '').split('?')[0] || '';
  if (req.method === 'OPTIONS') return next();

  const isApi = pathname.startsWith('/api');
  const isMcp = pathname === '/mcp' || pathname.startsWith('/mcp/');
  if (!isApi && !(isMcp && includeMcp())) return next();

  const reqId = randomUUID().slice(0, 8);
  const started = Date.now();
  const pathForLog = req.originalUrl || req.url;

  res.on('finish', () => {
    const fwd = req.headers['x-forwarded-for'];
    const ip =
      typeof fwd === 'string'
        ? fwd.split(',')[0].trim()
        : Array.isArray(fwd)
          ? fwd[0]
          : req.socket?.remoteAddress || undefined;

    console.log(
      JSON.stringify({
        hermes_http: true,
        reqId,
        method: req.method,
        path: pathForLog,
        status: res.statusCode,
        ms: Date.now() - started,
        ...(ip ? { ip } : {}),
      })
    );
  });

  next();
}
