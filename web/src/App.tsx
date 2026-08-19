/**
 * Web chatbot UI (project statement 4.1, the optional User Interface).
 *
 * Two panes: the conversation, and a live view of every MCP JSON-RPC frame.
 * The log is not decoration - it is the visible form of requirement 3, and
 * keeping it beside the chat lets a reader connect a sentence the assistant
 * produced with the protocol traffic that produced it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatMessage, ChatResponse, LogEntry, MessageKind, Status } from './types';

const KIND_COLORS: Record<MessageKind, string> = {
  synchronization: 'var(--kind-synchronization)',
  request: 'var(--kind-request)',
  response: 'var(--kind-response)',
  error: 'var(--kind-error)',
  notification: 'var(--kind-notification)',
};

const SUGGESTIONS = [
  'Who was Alan Turing?',
  'La clienta Maria Elena Ramirez dice que su internet esta muy lento. Investiga y abre un ticket si corresponde.',
  'Create a README.md inside demo-repo describing this project, add it to the git repository and commit it. Then show me the git log.',
];

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverFilter, setServerFilter] = useState('all');
  const [expanded, setExpanded] = useState<number | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  /* ----------------------------------------------------------- status poll */

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch('/api/status');
        const data = (await response.json()) as Status;
        if (cancelled) return;
        setStatus(data);
        // Startup spawns subprocesses, so keep polling until the host is up.
        if (!data.ready && !data.startupError) setTimeout(poll, 1000);
      } catch {
        if (!cancelled) setTimeout(poll, 2000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, []);

  /* -------------------------------------------------------- live log stream */

  useEffect(() => {
    // Seed with whatever already happened (the handshakes run before the
    // browser connects), then follow the stream for everything after.
    void fetch('/api/log?limit=500')
      .then((response) => response.json() as Promise<{ entries: LogEntry[] }>)
      .then((data) => setEntries(data.entries))
      .catch(() => undefined);

    const source = new EventSource('/api/log/stream');
    source.onmessage = (event) => {
      const entry = JSON.parse(event.data) as LogEntry;
      setEntries((current) => [...current.slice(-800), entry]);
    };
    return () => source.close();
  }, []);

  /* --------------------------------------------------------- auto-scrolling */

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const element = logRef.current;
    if (!element) return;
    // Only follow the tail when the reader is already at the bottom, so
    // scrolling back to inspect an earlier frame is not yanked away.
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [entries]);

  /* ------------------------------------------------------------------ send */

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || busy) return;

      setInput('');
      setBusy(true);
      setMessages((current) => [
        ...current,
        { id: `u-${Date.now()}`, role: 'user', content: trimmed },
        { id: `a-${Date.now()}`, role: 'assistant', content: '', pending: true },
      ]);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed }),
        });
        const data = (await response.json()) as ChatResponse & { error?: string };

        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (!last) return next;
          next[next.length - 1] = data.error
            ? { ...last, role: 'system', content: data.error, pending: false }
            : { ...last, content: data.reply, executions: data.executions, pending: false };
          return next;
        });
      } catch (error) {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last) {
            next[next.length - 1] = {
              ...last,
              role: 'system',
              content: (error as Error).message,
              pending: false,
            };
          }
          return next;
        });
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const reset = useCallback(async () => {
    await fetch('/api/reset', { method: 'POST' });
    setMessages([]);
  }, []);

  /* ---------------------------------------------------------------- render */

  const serverNames = useMemo(
    () => [...new Set(entries.map((entry) => entry.server))].sort(),
    [entries],
  );

  const visibleEntries = useMemo(
    () => (serverFilter === 'all' ? entries : entries.filter((e) => e.server === serverFilter)),
    [entries, serverFilter],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>MCP Chat Host</h1>
          <span className="subtitle">UVG CC3067 Redes &middot; Proyecto 1</span>
        </div>

        <div className="server-pills">
          {status?.servers.map((server) => (
            <span
              className="pill"
              key={server.name}
              title={`${server.implementation ?? '?'} v${server.version ?? '?'} - MCP ${server.protocolVersion} - ${server.toolCount} tools`}
            >
              <span className="dot" />
              {server.name}
              <span className="transport">{server.transport}</span>
            </span>
          ))}
          {status?.failed.map((failure) => (
            <span className="pill offline" key={failure.name} title={failure.error}>
              <span className="dot" />
              {failure.name}
            </span>
          ))}
        </div>

        <div className="topbar-spacer" />
        {status && <span className="model-chip">{status.model}</span>}
        <button onClick={reset} disabled={messages.length === 0}>
          New conversation
        </button>
      </header>

      <div className="panes">
        <section className="chat-pane">
          <div className="transcript" ref={transcriptRef}>
            {messages.length === 0 && (
              <div className="empty-state">
                <h2>{status?.ready ? 'Ready' : 'Connecting to MCP servers...'}</h2>
                <p>
                  {status?.ready
                    ? `${status.toolCount} tools available across ${status.servers.length} MCP servers.`
                    : 'Spawning local servers and completing the initialize handshake.'}
                </p>
                {status?.startupError && <p style={{ color: 'var(--kind-error)' }}>{status.startupError}</p>}
                <div className="suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      className="suggestion"
                      key={suggestion}
                      onClick={() => void send(suggestion)}
                      disabled={!status?.ready}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span className="role">{message.role === 'user' ? 'You' : message.role === 'system' ? 'Error' : 'Assistant'}</span>

                {message.executions && message.executions.length > 0 && (
                  <div className="executions">
                    {message.executions.map((execution, index) => (
                      <div className={`execution${execution.isError ? ' failed' : ''}`} key={index}>
                        <span className="server">{execution.server}</span>
                        <span>{execution.tool}</span>
                        <span className="duration">{execution.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="bubble">
                  {message.pending ? (
                    <span className="typing">
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    message.content
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="composer">
            <textarea
              value={input}
              placeholder={status?.ready ? 'Ask something, or describe a subscriber problem...' : 'Connecting...'}
              disabled={!status?.ready || busy}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter inserts a newline - the convention
                // users already expect from chat interfaces.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
            />
            <button className="primary" onClick={() => void send(input)} disabled={!status?.ready || busy}>
              Send
            </button>
          </div>
        </section>

        <aside className="log-pane">
          <div className="log-header">
            <h2>MCP protocol log</h2>
            <span className="log-count">{visibleEntries.length} frames</span>
            <select
              className="log-filter"
              value={serverFilter}
              onChange={(event) => setServerFilter(event.target.value)}
            >
              <option value="all">all servers</option>
              {serverNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>

            <div className="legend">
              {(Object.keys(KIND_COLORS) as MessageKind[]).map((kind) => (
                <span className="legend-item" key={kind}>
                  <span className="legend-swatch" style={{ background: KIND_COLORS[kind] }} />
                  {kind}
                </span>
              ))}
            </div>
          </div>

          <div className="log-list" ref={logRef}>
            {visibleEntries.length === 0 && <div className="log-empty">No frames yet.</div>}
            {visibleEntries.map((entry) => (
              <div key={entry.seq}>
                <div
                  className="log-entry"
                  style={{ borderLeftColor: KIND_COLORS[entry.kind] }}
                  onClick={() => setExpanded(expanded === entry.seq ? null : entry.seq)}
                  title={`${entry.kind} over ${entry.transport}`}
                >
                  <span className="time">{entry.timestamp.slice(11, 23)}</span>
                  <span className="arrow" style={{ color: KIND_COLORS[entry.kind] }}>
                    {entry.direction === 'sent' ? '→' : '←'}
                  </span>
                  <span className="method">{entry.method ?? (entry.kind === 'error' ? 'error' : 'result')}</span>
                  <span className="server-tag">{entry.server}</span>
                </div>
                {expanded === entry.seq && (
                  <pre className="log-payload">{JSON.stringify(entry.message, null, 2)}</pre>
                )}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
