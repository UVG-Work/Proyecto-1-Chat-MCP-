// Transport interface shared by the stdio and Streamable HTTP implementations.

import type { JsonRpcMessage } from './types.js';

export interface TransportHandlers {
  onMessage: (message: JsonRpcMessage) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export interface Transport {
  readonly kind: string;

  start(handlers: TransportHandlers): Promise<void>;

  send(message: JsonRpcMessage): Promise<void>;

  close(): Promise<void>;

  setProtocolVersion?(version: string): void;
}
