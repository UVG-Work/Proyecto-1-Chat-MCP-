// JSON-RPC 2.0 and MCP wire types, transcribed from the specification (revision 2025-11-25).

export const JSONRPC_VERSION = '2.0' as const;

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

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

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const LATEST_PROTOCOL_VERSION: ProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface Implementation {
  name: string;
  title?: string;
  version: string;
}

export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
  elicitation?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

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
  instructions?: string;
}

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
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export const McpMethod = {
  Initialize: 'initialize',
  InitializedNotification: 'notifications/initialized',
  Ping: 'ping',
  ToolsList: 'tools/list',
  ToolsCall: 'tools/call',
  ToolsListChanged: 'notifications/tools/list_changed',
} as const;
