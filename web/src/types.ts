/** Shapes returned by the Express bridge in src/api/server.ts. */

export type MessageKind =
  | 'synchronization'
  | 'request'
  | 'response'
  | 'error'
  | 'notification';

export interface LogEntry {
  seq: number;
  timestamp: string;
  direction: 'sent' | 'received';
  server: string;
  transport: string;
  kind: MessageKind;
  method?: string;
  id?: string | number;
  message: unknown;
}

export interface ServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  description: string;
  implementation: string | null;
  version: string | null;
  protocolVersion: string;
  toolCount: number;
}

export interface Status {
  ready: boolean;
  startupError?: string;
  model: string;
  servers: ServerStatus[];
  failed: { name: string; error: string }[];
  toolCount: number;
}

export interface ToolExecution {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  isError: boolean;
  error: string | null;
}

export interface ChatResponse {
  reply: string;
  iterations: number;
  executions: ToolExecution[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  executions?: ToolExecution[];
  pending?: boolean;
}
