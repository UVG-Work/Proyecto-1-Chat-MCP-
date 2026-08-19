/**
 * JSON-RPC 2.0 helpers: message construction, parsing and classification.
 *
 * Written by hand against https://www.jsonrpc.org/specification. Everything the
 * host and the servers put on the wire is built here so that the framing rules
 * live in exactly one place.
 */

import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type RequestId,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

export function makeRequest(
  id: RequestId,
  method: string,
  params?: Record<string, unknown>,
): JsonRpcRequest {
  const request: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method };
  if (params !== undefined) request.params = params;
  return request;
}

export function makeNotification(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcNotification {
  const notification: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method };
  if (params !== undefined) notification.params = params;
  return notification;
}

export function makeSuccess(
  id: RequestId,
  result: Record<string, unknown>,
): JsonRpcSuccessResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function makeError(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the value looks like any well-formed JSON-RPC 2.0 message. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isObject(value)) return false;
  if (value['jsonrpc'] !== JSONRPC_VERSION) return false;

  const hasId = 'id' in value;
  const hasMethod = typeof value['method'] === 'string';
  const hasResult = 'result' in value;
  const hasError = 'error' in value;

  if (hasMethod) return true; // request (with id) or notification (without)
  return hasId && (hasResult || hasError); // response
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message);
}

export function isErrorResponse(message: JsonRpcMessage): message is JsonRpcErrorResponse {
  return isResponse(message) && 'error' in message;
}

/**
 * Human-readable classification used by the interaction log and by the
 * Wireshark write-up (requirements 3 and 7). The project statement asks us to
 * separate synchronization messages from requests and responses, so the
 * lifecycle handshake is called out as its own kind.
 */
export type MessageKind = 'synchronization' | 'request' | 'response' | 'error' | 'notification';

const SYNCHRONIZATION_METHODS = new Set(['initialize', 'notifications/initialized', 'ping']);

export function classify(message: JsonRpcMessage): MessageKind {
  if (isRequest(message)) {
    return SYNCHRONIZATION_METHODS.has(message.method) ? 'synchronization' : 'request';
  }
  if (isNotification(message)) {
    return SYNCHRONIZATION_METHODS.has(message.method) ? 'synchronization' : 'notification';
  }
  return isErrorResponse(message) ? 'error' : 'response';
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

export class JsonRpcParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonRpcParseError';
  }
}

/** Parse one serialized message, rejecting anything that is not valid JSON-RPC. */
export function parseMessage(raw: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new JsonRpcParseError(`Invalid JSON: ${(cause as Error).message}`, raw);
  }
  if (!isJsonRpcMessage(parsed)) {
    throw new JsonRpcParseError('Not a valid JSON-RPC 2.0 message', raw);
  }
  return parsed;
}

/**
 * Serialize a message for the stdio transport.
 *
 * The stdio transport delimits messages with newlines and forbids embedded
 * newlines, so we assert that JSON.stringify produced a single line. It always
 * does (it escapes literal newlines inside strings), but an explicit check here
 * turns a silent framing corruption into a loud failure.
 */
export function serializeLine(message: JsonRpcMessage): string {
  const json = JSON.stringify(message);
  if (json.includes('\n')) {
    throw new Error('Serialized JSON-RPC message contains an embedded newline');
  }
  return json + '\n';
}

/** An Error carrying a JSON-RPC error payload, so servers can map it to a response. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }

  static methodNotFound(method: string): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
  }

  static invalidParams(detail: string): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Invalid params: ${detail}`);
  }

  static internal(detail: string): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.InternalError, `Internal error: ${detail}`);
  }
}
