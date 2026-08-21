// Streamable HTTP transport, client side, including TLS key export for packet capture.

import { appendFileSync, mkdirSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { dirname } from 'node:path';
import type { TLSSocket } from 'node:tls';

import { isJsonRpcMessage } from './jsonrpc.js';
import type { Transport, TransportHandlers } from './transport.js';
import { LATEST_PROTOCOL_VERSION, type JsonRpcMessage } from './types.js';

export class McpSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSessionExpiredError';
  }
}

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  tlsKeyLogPath?: string;
  openServerStream?: boolean;
  requestTimeoutMs?: number;
}

function isTransient(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  return /temporarily unreachable|HTTP 50[234]|timed out/i.test(error.message);
}

export class HttpClientTransport implements Transport {
  readonly kind = 'http';

  private readonly url: URL;
  private readonly isSecure: boolean;
  private handlers: TransportHandlers | undefined;
  private sessionId: string | undefined;
  private protocolVersion: string = LATEST_PROTOCOL_VERSION;
  private serverStream: http.IncomingMessage | undefined;
  private closed = false;

  constructor(private readonly options: HttpTransportOptions) {
    this.url = new URL(options.url);
    this.isSecure = this.url.protocol === 'https:';
    if (options.tlsKeyLogPath) {
      mkdirSync(dirname(options.tlsKeyLogPath), { recursive: true });
    }
  }

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    // Nothing to connect: HTTP is request-driven. The first POST carries the
    // initialize request and establishes the session.
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error(`HTTP transport to ${this.url.href} is closed`);
    await this.postWithRetry(message);
  }

  private async postWithRetry(message: JsonRpcMessage): Promise<void> {
    const maxAttempts = this.options.maxRetries ?? 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.post(message);
        return;
      } catch (error) {
        if (error instanceof McpSessionExpiredError) throw error;

        lastError = error as Error;
        if (!isTransient(lastError) || attempt === maxAttempts) throw lastError;

        // Exponential backoff: 500ms, 1000ms, 2000ms ...
        const delay = 500 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new Error('Request failed');
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      // The spec requires both content types to be advertised, because the
      // server chooses per request whether to stream.
      Accept: 'application/json, text/event-stream',
      ...this.options.headers,
      ...extra,
    };
    if (this.sessionId) headers['MCP-Session-Id'] = this.sessionId;
    // Omitted on the very first request: the version is not negotiated yet.
    if (this.sessionId || this.protocolVersion !== LATEST_PROTOCOL_VERSION) {
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }
    return headers;
  }

  private attachKeyLog(request: http.ClientRequest): void {
    const keyLogPath = this.options.tlsKeyLogPath;
    if (!keyLogPath || !this.isSecure) return;

    request.on('socket', (socket) => {
      const tlsSocket = socket as TLSSocket;
      if (typeof tlsSocket.on !== 'function') return;
      tlsSocket.on('keylog', (line: Buffer) => {
        try {
          appendFileSync(keyLogPath, line);
        } catch {
          // Losing a keylog line degrades the capture; it must never break the
          // protocol session.
        }
      });
    });
  }

  private post(message: JsonRpcMessage): Promise<void> {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const transport = this.isSecure ? https : http;

    return new Promise<void>((resolve, reject) => {
      const request = transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port || (this.isSecure ? 443 : 80),
          path: this.url.pathname + this.url.search,
          method: 'POST',
          headers: this.buildHeaders({
            'Content-Type': 'application/json',
            'Content-Length': String(body.byteLength),
          }),
        },
        (response) => {
          // The session id arrives on the InitializeResult and is echoed from
          // then on. Header names are case-insensitive in Node.
          const issued = response.headers['mcp-session-id'];
          if (typeof issued === 'string' && issued.length > 0) {
            this.sessionId = issued;
          }

          const status = response.statusCode ?? 0;

          // 202 Accepted: the server took a notification or a response and has
          // nothing to say back.
          if (status === 202) {
            response.resume();
            resolve();
            return;
          }

          // A 404 is ambiguous: it is either our MCP session being gone, or the
          // hosting edge having no instance to route to. They need opposite
          // handling - re-handshake versus retry - so they are told apart by
          // whether the platform tagged the response as a routing failure.
          if (status === 404) {
            const routingFailure = response.headers['x-render-routing'] !== undefined;
            this.readBody(response)
              .then((text) => {
                if (routingFailure || !this.sessionId) {
                  reject(
                    new Error(
                      `MCP endpoint ${this.url.href} is temporarily unreachable ` +
                        `(HTTP 404, no instance available)`,
                    ),
                  );
                  return;
                }
                this.sessionId = undefined;
                reject(
                  new McpSessionExpiredError(
                    `MCP session no longer recognised by ${this.url.href}` +
                      (text ? `: ${text.slice(0, 200)}` : ''),
                  ),
                );
              })
              .catch(reject);
            return;
          }

          if (status < 200 || status >= 300) {
            this.readBody(response)
              .then((text) => {
                reject(
                  new Error(
                    `MCP endpoint ${this.url.href} returned HTTP ${status}` +
                      (text ? `: ${text.slice(0, 500)}` : ''),
                  ),
                );
              })
              .catch(reject);
            return;
          }

          const contentType = String(response.headers['content-type'] ?? '');

          if (contentType.includes('text/event-stream')) {
            // Resolve as soon as the stream is open; the JSON-RPC response
            // arrives later as an SSE event and is dispatched through onMessage.
            this.consumeSseStream(response);
            resolve();
            return;
          }

          this.readBody(response)
            .then((text) => {
              if (text.trim().length > 0) this.dispatchRaw(text);
              resolve();
            })
            .catch(reject);
        },
      );

      this.attachKeyLog(request);

      request.setTimeout(this.options.requestTimeoutMs ?? 120_000, () => {
        request.destroy(new Error(`Request to ${this.url.href} timed out`));
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  private readBody(response: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
  }

  private consumeSseStream(response: http.IncomingMessage): void {
    let buffer = '';
    response.setEncoding('utf8');

    response.on('data', (chunk: string) => {
      buffer += chunk;
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
        this.handleSseEvent(rawEvent);
      }
    });

    response.on('error', (error) => this.handlers?.onError(error));
  }

  private handleSseEvent(rawEvent: string): void {
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      const normalized = line.replace(/\r$/, '');
      if (normalized.startsWith('data:')) {
        dataLines.push(normalized.slice(5).replace(/^ /, ''));
      }
      // "id:", "event:" and "retry:" carry no information this client acts on.
    }
    const payload = dataLines.join('\n');
    if (payload.trim().length > 0) this.dispatchRaw(payload);
  }

  private dispatchRaw(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.handlers?.onError(new Error(`Non-JSON payload from ${this.url.href}: ${text.slice(0, 200)}`));
      return;
    }

    // A batch is legal JSON-RPC; unwrap it so callers only see single messages.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of messages) {
      if (isJsonRpcMessage(candidate)) {
        this.handlers?.onMessage(candidate);
      } else {
        this.handlers?.onError(
          new Error(`Malformed JSON-RPC message from ${this.url.href}: ${JSON.stringify(candidate).slice(0, 200)}`),
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.serverStream?.destroy();
    this.serverStream = undefined;

    if (!this.sessionId) return;

    const transport = this.isSecure ? https : http;
    await new Promise<void>((resolve) => {
      const request = transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port || (this.isSecure ? 443 : 80),
          path: this.url.pathname + this.url.search,
          method: 'DELETE',
          headers: this.buildHeaders(),
        },
        (response) => {
          // 405 simply means the server does not allow client-side termination.
          response.resume();
          response.on('end', () => resolve());
        },
      );
      this.attachKeyLog(request);
      request.on('error', () => resolve()); // shutdown must not throw
      request.end();
    });
  }
}
