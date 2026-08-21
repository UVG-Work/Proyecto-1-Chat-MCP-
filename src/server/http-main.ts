// Streamable HTTP entry point for the NOC MCP server.

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';

import { makeError, parseMessage } from '../mcp/jsonrpc.js';
import { JsonRpcErrorCode, McpMethod, type JsonRpcMessage } from '../mcp/types.js';
import { createNocServer } from './noc-server.js';

const PORT = Number(process.env['PORT'] ?? process.env['NOC_HTTP_PORT'] ?? 8787);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const MCP_PATH = process.env['MCP_PATH'] ?? '/mcp';

const USE_SSE = process.env['MCP_SSE'] === '1';

const server = createNocServer();

const sessions = new Map<string, { createdAt: number; lastSeen: number }>();

const SESSION_TTL_MS = 60 * 60 * 1000;

function log(message: string): void {
  process.stderr.write(`[noc-http] ${new Date().toISOString()} ${message}\n`);
}

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const allowList = (process.env['MCP_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowList.includes('*')) return true;
  if (allowList.length > 0) return allowList.includes(origin);

  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function readBody(request: http.IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limitBytes) {
        reject(new Error('Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.byteLength),
    ...extraHeaders,
  });
  response.end(body);
}

function sendSse(
  response: http.ServerResponse,
  message: JsonRpcMessage,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...extraHeaders,
  });
  // An id lets a disconnected client resume with Last-Event-ID.
  response.write(`id: ${randomUUID()}\n`);
  response.write(`data: ${JSON.stringify(message)}\n\n`);
  response.end();
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}

async function handleMcpPost(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const accept = String(request.headers['accept'] ?? '');
  // The spec requires clients to advertise both; we warn rather than reject so
  // a slightly non-compliant client can still be debugged against this server.
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    log(`warning: client Accept header does not advertise the required types: "${accept}"`);
  }

  let raw: string;
  try {
    raw = await readBody(request);
  } catch (error) {
    sendJson(response, 400, makeError(null, JsonRpcErrorCode.InvalidRequest, (error as Error).message));
    return;
  }

  let message: JsonRpcMessage;
  try {
    message = parseMessage(raw);
  } catch {
    sendJson(response, 400, makeError(null, JsonRpcErrorCode.ParseError, 'Parse error'));
    return;
  }

  const isInitialize = 'method' in message && message.method === McpMethod.Initialize;
  const providedSession = request.headers['mcp-session-id'];
  const sessionId = typeof providedSession === 'string' ? providedSession : undefined;

  // Every request except initialize must carry a session we issued.
  if (!isInitialize && sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      // 404 tells the client its session is gone and it must re-initialize.
      sendJson(response, 404, makeError(null, JsonRpcErrorCode.InvalidRequest, 'Unknown session'));
      return;
    }
    session.lastSeen = Date.now();
  }

  const result = await server.handleMessage(message);

  // A notification or a response carries nothing back: 202 with an empty body.
  if (result === null) {
    response.writeHead(202).end();
    return;
  }

  const extraHeaders: Record<string, string> = {};
  if (isInitialize) {
    const issued = randomUUID();
    sessions.set(issued, { createdAt: Date.now(), lastSeen: Date.now() });
    extraHeaders['MCP-Session-Id'] = issued;
    pruneSessions();
    log(`session ${issued} initialized (${sessions.size} active)`);
  }

  if (USE_SSE) sendSse(response, result, extraHeaders);
  else sendJson(response, 200, result, extraHeaders);
}

const httpServer = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (!isOriginAllowed(request.headers.origin)) {
    log(`rejected disallowed Origin: ${request.headers.origin}`);
    sendJson(response, 403, makeError(null, JsonRpcErrorCode.InvalidRequest, 'Origin not allowed'));
    return;
  }

  // Liveness probe for the cloud platform. Not part of the MCP specification.
  if (url.pathname === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      server: 'noc-support-desk',
      tools: server.listToolDescriptors().length,
      sessions: sessions.size,
      sse: USE_SSE,
    });
    return;
  }

  if (url.pathname !== MCP_PATH) {
    sendJson(response, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}` });
    return;
  }

  if (request.method === 'POST') {
    handleMcpPost(request, response).catch((error: Error) => {
      log(`unhandled POST failure: ${error.message}`);
      if (!response.headersSent) {
        sendJson(response, 500, makeError(null, JsonRpcErrorCode.InternalError, error.message));
      }
    });
    return;
  }

  if (request.method === 'GET') {
    // We never initiate requests, so we decline the optional stream. The spec
    // names 405 as the correct way to say so.
    response.writeHead(405, { Allow: 'POST, DELETE' }).end();
    return;
  }

  if (request.method === 'DELETE') {
    const provided = request.headers['mcp-session-id'];
    if (typeof provided === 'string' && sessions.delete(provided)) {
      log(`session ${provided} terminated by client (${sessions.size} active)`);
    }
    response.writeHead(204).end();
    return;
  }

  response.writeHead(405, { Allow: 'POST, GET, DELETE' }).end();
});

httpServer.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}${MCP_PATH} (SSE ${USE_SSE ? 'on' : 'off'})`);
  log(`tools: ${server.listToolDescriptors().map((tool) => tool.name).join(', ')}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
  });
}
