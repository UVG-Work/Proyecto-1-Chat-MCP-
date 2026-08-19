/**
 * stdio transport (client side).
 *
 * Per the MCP transports specification:
 *   - the client launches the server as a subprocess;
 *   - JSON-RPC messages travel as UTF-8 over the child's stdin/stdout;
 *   - messages are delimited by newlines and must not contain embedded newlines;
 *   - the child may write anything to stderr, and the client must NOT treat
 *     stderr output as an error signal.
 *
 * This is a from-scratch implementation - no MCP SDK (project statement 3.1).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { platform } from 'node:process';

import { isJsonRpcMessage, serializeLine } from './jsonrpc.js';
import type { Transport, TransportHandlers } from './transport.js';
import type { JsonRpcMessage } from './types.js';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  /** Extra environment variables merged over the parent environment. */
  env?: Record<string, string>;
  cwd?: string;
  /** Receives the child's stderr lines. Informational, never an error. */
  onStderr?: (line: string) => void;
}

/**
 * Windows cannot spawn shell shims such as npx or uvx directly - they are .cmd
 * files, not executables - so we route through the shell there. When we do, any
 * argument containing whitespace has to be quoted by hand, because the shell
 * re-splits the joined command line. On POSIX we spawn directly and skip all of
 * this, which is both safer and faster.
 */
function quoteForWindowsShell(value: string): string {
  return /[\s&|<>^]/.test(value) ? `"${value}"` : value;
}

export class StdioClientTransport implements Transport {
  readonly kind = 'stdio';

  private child: ChildProcessWithoutNullStreams | undefined;
  private handlers: TransportHandlers | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;

  constructor(private readonly options: StdioTransportOptions) {}

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;

    const useShell = platform === 'win32';
    const args = this.options.args ?? [];

    // With shell: true, Node concatenates the argument array onto the command
    // line anyway and warns about it (DEP0190). Building the single command
    // string ourselves - quoting as we go - is the same operation without the
    // warning, and keeps the quoting rules visible in one place.
    const command = useShell
      ? [this.options.command, ...args].map(quoteForWindowsShell).join(' ')
      : this.options.command;
    const spawnArgs = useShell ? [] : args;

    const child = spawn(command, spawnArgs, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk));

    child.on('error', (error) => {
      this.handlers?.onError(
        new Error(`Failed to start MCP server "${this.options.command}": ${error.message}`),
      );
    });

    child.on('close', (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      if (code !== 0 && code !== null) {
        this.handlers?.onError(
          new Error(
            `MCP server "${this.options.command}" exited with code ${code}` +
              (this.stderrBuffer ? `\n${this.stderrBuffer.trim()}` : ''),
          ),
        );
      } else if (signal) {
        this.handlers?.onError(
          new Error(`MCP server "${this.options.command}" terminated by signal ${signal}`),
        );
      }
      this.handlers?.onClose();
    });

    // Give a failing spawn a moment to surface before we start the handshake,
    // so a missing binary reads as a clear startup error rather than a timeout.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  /**
   * Reassemble newline-delimited frames. TCP-style chunking means one "data"
   * event may hold a partial message, several messages, or both, so the tail is
   * carried over to the next chunk.
   */
  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');

      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A server that violates the spec by printing banners to stdout would
        // land here. Report it and keep going rather than killing the session.
        this.handlers?.onError(
          new Error(`Non-JSON line on stdout from "${this.options.command}": ${line.slice(0, 200)}`),
        );
        continue;
      }

      if (!isJsonRpcMessage(parsed)) {
        this.handlers?.onError(
          new Error(`Malformed JSON-RPC message from "${this.options.command}": ${line.slice(0, 200)}`),
        );
        continue;
      }

      this.handlers?.onMessage(parsed);
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    // Keep only the tail, so a chatty server cannot grow this without bound
    // while still leaving enough context to explain a non-zero exit.
    if (this.stderrBuffer.length > 8192) {
      this.stderrBuffer = this.stderrBuffer.slice(-8192);
    }
    if (!this.options.onStderr) return;
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) this.options.onStderr(trimmed);
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error(`Cannot send: stdio transport for "${this.options.command}" is not open`);
    }
    const line = serializeLine(message);
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, 'utf8', (error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Graceful shutdown per the spec: close stdin first and give the server a
   * chance to exit on its own, then escalate to SIGTERM and finally SIGKILL.
   */
  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.closed) {
      this.closed = true;
      return;
    }
    this.closed = true;

    child.stdin.end();

    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));

    if ((await Promise.race([exited.then(() => 'exited' as const), timeout(2000)])) === 'timeout') {
      child.kill('SIGTERM');
      if ((await Promise.race([exited.then(() => 'exited' as const), timeout(2000)])) === 'timeout') {
        child.kill('SIGKILL');
      }
    }
  }
}
