// MCP client: lifecycle, version negotiation, request correlation, tools/list and tools/call.

import {
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  makeNotification,
  makeRequest,
  makeError,
} from './jsonrpc.js';
import { McpSessionExpiredError } from './http-transport.js';
import type { InteractionLog } from './log.js';
import type { Transport } from './transport.js';
import {
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpMethod,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type ClientCapabilities,
  type Implementation,
  type InitializeResult,
  type JsonRpcMessage,
  type ListToolsResult,
  type RequestId,
  type ServerCapabilities,
  type Tool,
} from './types.js';

const CLIENT_INFO: Implementation = {
  name: 'uvg-mcp-chat-host',
  title: 'UVG MCP Chat Host',
  version: '1.0.0',
};

const CLIENT_CAPABILITIES: ClientCapabilities = {};

export interface McpClientOptions {
  name: string;
  transport: Transport;
  log: InteractionLog;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class McpClient {
  readonly name: string;

  private readonly transport: Transport;
  private readonly log: InteractionLog;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<RequestId, PendingRequest>();

  private nextId = 1;
  private initialized = false;
  private closed = false;

  private serverInfo: Implementation | undefined;
  private serverCapabilities: ServerCapabilities = {};
  private negotiatedVersion: string = LATEST_PROTOCOL_VERSION;
  private instructions: string | undefined;

  private tools: Tool[] = [];

  constructor(options: McpClientOptions) {
    this.name = options.name;
    this.transport = options.transport;
    this.log = options.log;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  async connect(): Promise<InitializeResult> {
    await this.transport.start({
      onMessage: (message) => this.handleMessage(message),
      onError: (error) => this.failAllPending(error),
      onClose: () => this.failAllPending(new Error(`Connection to "${this.name}" closed`)),
    });

    return this.performHandshake();
  }

  private async performHandshake(): Promise<InitializeResult> {
    const result = (await this.request(McpMethod.Initialize, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    })) as unknown as InitializeResult;

    const offered = result.protocolVersion;
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(offered)) {
      await this.close();
      throw new Error(
        `Server "${this.name}" requires unsupported MCP protocol version "${offered}". ` +
          `This client supports: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
      );
    }

    this.negotiatedVersion = offered;
    // HTTP must carry the negotiated revision on every subsequent request.
    this.transport.setProtocolVersion?.(offered);
    this.serverInfo = result.serverInfo;
    this.serverCapabilities = result.capabilities ?? {};
    this.instructions = result.instructions;

    // The handshake only completes once the client confirms it is ready.
    await this.notify(McpMethod.InitializedNotification);
    this.initialized = true;

    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new Error(`Client "${this.name}" closed`));
    await this.transport.close();
  }

  async listTools(): Promise<Tool[]> {
    const collected: Tool[] = [];
    let cursor: string | undefined;

    do {
      const params = cursor === undefined ? {} : { cursor };
      const result = (await this.request(McpMethod.ToolsList, params)) as unknown as ListToolsResult;
      collected.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor !== undefined);

    this.tools = collected;
    return collected;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.request(McpMethod.ToolsCall, { name, arguments: args });
    return result as unknown as CallToolResult;
  }

  get info(): Implementation | undefined {
    return this.serverInfo;
  }

  get capabilities(): ServerCapabilities {
    return this.serverCapabilities;
  }

  get protocolVersion(): string {
    return this.negotiatedVersion;
  }

  get serverInstructions(): string | undefined {
    return this.instructions;
  }

  get transportKind(): string {
    return this.transport.kind;
  }

  get cachedTools(): Tool[] {
    return this.tools;
  }

  get isReady(): boolean {
    return this.initialized && !this.closed;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    allowSessionRecovery = true,
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error(`Client "${this.name}" is closed`);

    const id = this.nextId++;
    const message = makeRequest(id, method, params);

    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" to "${this.name}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      // Do not let a pending request keep the process alive on its own.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
    });

    this.log.record('sent', this.name, this.transport.kind, message);
    try {
      await this.transport.send(message);
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }

      // The server no longer recognises our session - typically because a
      // hosted instance restarted and its in-memory session store went with it.
      // Re-handshake and replay rather than failing the user's request.
      if (
        error instanceof McpSessionExpiredError &&
        allowSessionRecovery &&
        method !== McpMethod.Initialize
      ) {
        await this.performHandshake();
        return this.request(method, params, false);
      }

      throw error;
    }

    return promise;
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const message = makeNotification(method, params);
    this.log.record('sent', this.name, this.transport.kind, message);
    await this.transport.send(message);
  }

  private handleMessage(message: JsonRpcMessage): void {
    this.log.record('received', this.name, this.transport.kind, message);

    if (isResponse(message)) {
      const id = message.id;
      if (id === null) return; // parse-level error with no correlation possible

      const pending = this.pending.get(id);
      if (!pending) return; // late response to a timed-out request; nothing to do

      clearTimeout(pending.timer);
      this.pending.delete(id);

      if (isErrorResponse(message)) {
        const { code, message: text, data } = message.error;
        const suffix = data === undefined ? '' : ` (${JSON.stringify(data)})`;
        pending.reject(
          new Error(`${this.name} rejected "${pending.method}": [${code}] ${text}${suffix}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Order matters: a request is structurally a notification plus an id, so
    // the request check has to come first for the narrowing to hold.
    if (isRequest(message)) {
      // We advertised no client capabilities, so any server-initiated request is
      // one we cannot serve. The spec expects a JSON-RPC error, not silence.
      const response = makeError(
        message.id,
        JsonRpcErrorCode.MethodNotFound,
        `Client does not implement "${message.method}"`,
      );
      this.log.record('sent', this.name, this.transport.kind, response);
      void this.transport.send(response).catch(() => undefined);
      return;
    }

    if (isNotification(message)) {
      // tools/list_changed is the only server notification we act on; the cache
      // is refreshed lazily by the host on its next listTools() call.
      return;
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
