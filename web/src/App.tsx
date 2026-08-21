import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  IconChevron,
  IconCloud,
  IconInbound,
  IconOutbound,
  IconRefresh,
  IconSend,
  IconStdio,
} from './icons';
import type { ChatMessage, ChatResponse, LogEntry, MessageKind, Status } from './types';

const KIND_COLOR: Record<MessageKind, string> = {
  synchronization: 'var(--sync)',
  request: 'var(--request)',
  response: 'var(--response)',
  error: 'var(--error)',
  notification: 'var(--notify)',
};

const KIND_ORDER: MessageKind[] = [
  'synchronization',
  'request',
  'response',
  'notification',
  'error',
];

const SEEDS = [
  {
    label: 'Who was Alan Turing?',
    note: 'Answered from the model alone, without touching a tool',
    prompt: 'Who was Alan Turing?',
  },
  {
    label: 'Diagnose a slow connection',
    note: 'Chains five tool calls on the NOC server, then opens a ticket',
    prompt:
      'La clienta Maria Elena Ramirez dice que su internet esta muy lento. Investiga y abre un ticket si corresponde.',
  },
  {
    label: 'Write a file and commit it',
    note: 'Uses the Filesystem and Git servers together',
    prompt:
      'Create a README.md inside demo-repo describing this project, add it to the git repository and commit it. Then show me the git log.',
  },
];

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState<number | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let stopped = false;

    const poll = async () => {
      try {
        const response = await fetch('/api/status');
        const data = (await response.json()) as Status;
        if (stopped) return;
        setStatus(data);
        if (!data.ready && !data.startupError) setTimeout(poll, 1000);
      } catch {
        if (!stopped) setTimeout(poll, 2000);
      }
    };

    void poll();
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
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

  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 140) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const grow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || busy) return;

      const stamp = Date.now();
      setInput('');
      requestAnimationFrame(grow);
      setBusy(true);
      setMessages((current) => [
        ...current,
        { id: `u${stamp}`, role: 'user', content: trimmed },
        { id: `a${stamp}`, role: 'assistant', content: '', pending: true },
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
            : {
                ...last,
                content: data.reply,
                executions: data.executions,
                pending: false,
              };
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
    [busy, grow],
  );

  const reset = useCallback(async () => {
    await fetch('/api/reset', { method: 'POST' });
    setMessages([]);
  }, []);

  const origins = useMemo(
    () => [...new Set(entries.map((entry) => entry.server))].sort(),
    [entries],
  );

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.server === filter)),
    [entries, filter],
  );

  const connecting = !status || (!status.ready && !status.startupError);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>MCP Chat Host</h1>
          <span>CC3067 Redes</span>
        </div>

        <div className="rail">
          {status?.servers.map((server) => (
            <span
              className="node"
              key={server.name}
              title={`${server.implementation ?? 'unknown'} v${server.version ?? '?'} · MCP ${server.protocolVersion} · ${server.toolCount} tools`}
            >
              <i className="live" />
              {server.transport === 'http' ? <IconCloud /> : <IconStdio />}
              {server.name}
            </span>
          ))}
          {status?.failed.map((failure) => (
            <span className="node down" key={failure.name} title={failure.error}>
              <i className="live" />
              {failure.name}
            </span>
          ))}
        </div>

        <div className="spacer" />
        {status && <span className="model">{status.model}</span>}
        <button className="btn" onClick={reset} disabled={messages.length === 0}>
          <IconRefresh />
          Reset
        </button>
      </header>

      <div className="panes">
        <section className="chat">
          <div className="thread" ref={threadRef}>
            {messages.length === 0 && (
              <div className="blank">
                <h2>{connecting ? 'Connecting to MCP servers' : 'Ready'}</h2>
                <p>
                  {connecting
                    ? 'Spawning the local servers and completing the initialize handshake.'
                    : `${status?.toolCount ?? 0} tools across ${status?.servers.length ?? 0} servers. Every frame appears in the log on the right.`}
                </p>
                {status?.startupError && (
                  <p className="fail-note">{status.startupError}</p>
                )}
                <div className="seeds">
                  {SEEDS.map((seed) => (
                    <button
                      className="seed"
                      key={seed.label}
                      onClick={() => void send(seed.prompt)}
                      disabled={connecting || busy}
                    >
                      <span>
                        <b>{seed.label}</b>
                        <em>{seed.note}</em>
                      </span>
                      <IconChevron />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <article
                className={`turn ${message.role === 'system' ? 'fail' : message.role}`}
                key={message.id}
              >
                <span className="who">
                  {message.role === 'user'
                    ? 'You'
                    : message.role === 'system'
                      ? 'Failed'
                      : 'Assistant'}
                </span>

                {message.executions && message.executions.length > 0 && (
                  <div className="trace">
                    {message.executions.map((execution, index) => (
                      <div
                        className={`step${execution.isError ? ' bad' : ''}`}
                        key={index}
                        title={execution.error ?? undefined}
                      >
                        <i className="tick" />
                        <span>
                          <span className="origin">{execution.server}</span> {execution.tool}
                        </span>
                        <span className="ms">{execution.durationMs} ms</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="msg">
                  {message.pending ? (
                    <span className="wait" aria-label="Working">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : message.role === 'assistant' ? (
                    <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
                  ) : (
                    message.content
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="composer">
            <textarea
              ref={boxRef}
              rows={1}
              value={input}
              placeholder={connecting ? 'Connecting…' : 'Ask anything, or describe a subscriber problem'}
              disabled={connecting || busy}
              onChange={(event) => {
                setInput(event.target.value);
                grow();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
            />
            <button
              className="btn btn-primary"
              onClick={() => void send(input)}
              disabled={connecting || busy || input.trim().length === 0}
              aria-label="Send message"
            >
              <IconSend />
            </button>
          </div>
        </section>

        <aside className="log">
          <div className="log-top">
            <h2>Protocol log</h2>
            <span className="count">{visible.length}</span>
            <select
              className="pick"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label="Filter by server"
            >
              <option value="all">All servers</option>
              {origins.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className="key">
            {KIND_ORDER.map((kind) => (
              <span key={kind}>
                <i style={{ background: KIND_COLOR[kind] }} />
                {kind}
              </span>
            ))}
          </div>

          <div className="stream" ref={streamRef}>
            {connecting && visible.length === 0 && (
              <div className="skeleton" aria-hidden>
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
            )}

            {!connecting && visible.length === 0 && (
              <p className="hollow">
                No frames yet. Send a message and the handshake and tool calls appear here.
              </p>
            )}

            {visible.map((entry) => (
              <div key={entry.seq}>
                <button
                  className={`row${open === entry.seq ? ' open' : ''}`}
                  onClick={() => setOpen(open === entry.seq ? null : entry.seq)}
                  title={`${entry.kind} over ${entry.transport}`}
                >
                  <span className="at">{entry.timestamp.slice(11, 23)}</span>
                  <span className="dir" style={{ color: KIND_COLOR[entry.kind] }}>
                    {entry.direction === 'sent' ? <IconOutbound /> : <IconInbound />}
                  </span>
                  <span className="what">
                    {entry.method ?? (entry.kind === 'error' ? 'error' : 'result')}
                  </span>
                  <span className="from">{entry.server}</span>
                </button>
                {open === entry.seq && (
                  <pre className="payload">{JSON.stringify(entry.message, null, 2)}</pre>
                )}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
