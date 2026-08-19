/**
 * Model Context Protocol - wire types.
 *
 * These types are transcribed by hand from the MCP specification (revision
 * 2025-11-25) and the JSON-RPC 2.0 specification. No MCP SDK is used anywhere
 * in this project, as required by the project statement (section 3.1).
 *
 * References:
 *   - JSON-RPC 2.0 ......... https://www.jsonrpc.org/specification
 *   - MCP lifecycle ........ https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
 *   - MCP transports ....... https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 *   - MCP tools ............ https://modelcontextprotocol.io/specification/2025-11-25/server/tools
 */

/* -------------------------------------------------------------------------- */
/* JSON-RPC 2.0                                                               */
/* -------------------------------------------------------------------------- */

/** JSON-RPC requires the literal string "2.0" in every message. */
export const JSONRPC_VERSION = '2.0' as const;

/** A request id is a string or a number. */
export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

/** A notification is a request without an id; it must never be answered. */
export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

/** Error codes reserved by the JSON-RPC 2.0 specification. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/* -------------------------------------------------------------------------- */
/* MCP protocol versions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Protocol revisions this implementation understands, newest first.
 *
 * Version negotiation matters here: the client sends the newest version it
 * supports, but the server is allowed to answer with a different one, and the
 * client must accept it if it appears in this list (MCP lifecycle spec,
 * "Version Negotiation"). The official Filesystem and Git servers commonly
 * answer with an older revision than the one we ask for, so hard-coding a
 * single version string would break the connection to them.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** The revision we advertise when opening a connection. */
export const LATEST_PROTOCOL_VERSION: ProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];

/* -------------------------------------------------------------------------- */
/* Lifecycle: initialize                                                      */
/* -------------------------------------------------------------------------- */

export interface Implementation {
  name: string;
  title?: string;
  version: string;
}

/** Capabilities a client may advertise. Kept deliberately small. */
export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
  elicitation?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

/** Capabilities a server may advertise. */
export interface ServerCapabilities {
  logging?: Record<string, unknown>;
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
  completions?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface InitializeParams {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: Implementation;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
  /** Optional free-text guidance the server wants the model to see. */
  instructions?: string;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A JSON Schema object describing a tool's arguments. MCP requires the root
 * schema to be of type "object".
 */
export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations?: ToolAnnotations;
}

export interface ListToolsResult {
  tools: Tool[];
  /** Opaque cursor; when present the client must page to collect every tool. */
  nextCursor?: string;
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ResourceLinkContent {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface EmbeddedResourceContent {
  type: 'resource';
  resource: Record<string, unknown>;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ResourceLinkContent
  | EmbeddedResourceContent
  | { type: string; [key: string]: unknown };

export interface CallToolResult {
  content: ContentBlock[];
  /**
   * Tool-level failure flag. This is NOT a JSON-RPC error: a tool that fails
   * still returns a successful JSON-RPC response carrying isError: true, so the
   * model can read the failure and react to it.
   */
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Method names used in this project                                          */
/* -------------------------------------------------------------------------- */

export const McpMethod = {
  Initialize: 'initialize',
  InitializedNotification: 'notifications/initialized',
  Ping: 'ping',
  ToolsList: 'tools/list',
  ToolsCall: 'tools/call',
  ToolsListChanged: 'notifications/tools/list_changed',
} as const;
