# MCP Chat Host

A chatbot that acts as an **MCP host**, connecting to several Model Context Protocol servers at
once — two official ones and a custom one of my own — and letting a language model use their tools
to answer questions and carry out tasks.

Universidad del Valle de Guatemala · CC3067 Redes · Proyecto 1 — *Uso de un protocolo existente*.

**The MCP protocol is implemented by hand.** No MCP SDK is used anywhere: the JSON-RPC 2.0 framing,
the `initialize` lifecycle, capability and version negotiation, the stdio transport and the
Streamable HTTP transport are all written from scratch in this repository, on both the client and
the server side. This is a requirement of the project statement (§3.1), which forbids libraries such
as FastMCP.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the chatbot](#running-the-chatbot)
- [The custom MCP server](#the-custom-mcp-server)
- [Deploying the server remotely](#deploying-the-server-remotely)
- [Capturing the traffic with Wireshark](#capturing-the-traffic-with-wireshark)
- [Project layout](#project-layout)
- [Implementation notes](#implementation-notes)

---

## What it does

| | Feature |
|---|---|
| 1 | Talks to a language model through its HTTP API (OpenRouter) |
| 2 | Keeps conversation context within a session, so follow-up questions resolve against earlier turns |
| 3 | Logs every MCP request and response, viewable in the terminal and live in the web UI |
| 4 | Uses the official **Filesystem** and **Git** MCP servers over stdio |
| 5 | Provides a custom **ISP / NOC support desk** MCP server, running locally over stdio |
| 6 | Runs that same server remotely over Streamable HTTP, used identically by the chatbot |
| 7 | Produces packet captures of the remote traffic for protocol analysis |

Two front ends are included: a terminal client (the required command-line interface) and a web
chatbot with a live protocol log.

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │        Host (anfitrión)      │
                    │   CLI  ·  Web UI + REST API  │
                    │                              │
                    │  conversation · tool routing │
                    │  interaction log (req. 3)    │
                    └──────┬───────────────┬───────┘
                           │               │
            ┌──────────────┴──┐         ┌──┴──────────────┐
            │   MCP clients   │         │  LLM provider   │
            │  (hand-written) │         │   OpenRouter    │
            └──┬───┬───┬──────┘         └─────────────────┘
               │   │   │
     stdio ────┘   │   └──── Streamable HTTP
                   │
   ┌───────────┐ ┌─┴─────────┐ ┌──────────────┐   ┌─────────────────┐
   │ filesystem│ │    git    │ │  noc-local   │   │   noc-remote    │
   │ (official)│ │ (official)│ │   (custom)   │   │  (same server,  │
   │           │ │           │ │              │   │   deployed)     │
   └───────────┘ └───────────┘ └──────────────┘   └─────────────────┘
```

Three seams carry the design:

1. **A `Transport` interface.** stdio and Streamable HTTP are two implementations behind one
   interface, so a server can move from a local subprocess to a cloud deployment without the client,
   the host or the server's tool code changing.
2. **A shared server core.** `src/server/core.ts` holds the tool registry and JSON-RPC dispatch;
   `stdio-main.ts` and `http-main.ts` are thin entry points over it. The local and remote servers are
   literally the same object.
3. **A single logging tap.** Every frame in either direction passes through one recorder, so the
   interaction log is complete by construction.

---

## Requirements

| Tool | Version | Why |
|---|---|---|
| [Node.js](https://nodejs.org) | 20 or newer (developed on 24) | runs everything |
| [uv](https://docs.astral.sh/uv/) | any recent | the official Git MCP server is a Python package run with `uvx` |
| [Git](https://git-scm.com) | any recent | the Git server operates on real repositories |
| [Wireshark](https://www.wireshark.org) + Npcap | any recent | only for the traffic analysis |

Node's `npx` fetches the official Filesystem server automatically on first run; nothing needs to be
installed globally.

An **OpenRouter API key** is required. Create one free at <https://openrouter.ai/keys> — no credit
card is needed, and there are free models that support tool calling.

---

## Installation

```bash
git clone https://github.com/UVG-Work/Proyecto-1-Chat-MCP-.git
cd Proyecto-1-Chat-MCP-

npm install            # host, MCP implementation and servers
npm install --prefix web   # web UI (optional, only for the browser front end)
```

Create your environment file:

```bash
cp .env.example .env
```

Then edit `.env` and set at least:

```ini
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=z-ai/glm-5.2:free
```

Any model that supports tool calling works. To list the ones that do:

```bash
curl -s "https://openrouter.ai/api/v1/models?supported_parameters=tools" | less
```

> A model **without** tool-calling support will appear to work for plain questions but will silently
> never call a tool, which looks like a bug in the client. Check this first if tools are ignored.

Finally, prepare the sandbox used by the Filesystem and Git demonstration:

```bash
npm run setup:demo
```

---

## Configuration

Which MCP servers the host connects to is data, not code — see [`config/servers.json`](config/servers.json).

```jsonc
{
  "servers": [
    { "name": "filesystem", "transport": "stdio", "enabled": true,
      "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "./sandbox"] },

    { "name": "git", "transport": "stdio", "enabled": true,
      "command": "uvx", "args": ["mcp-server-git"] },

    { "name": "noc-local", "transport": "stdio", "enabled": true,
      "command": "npx", "args": ["tsx", "./src/server/stdio-main.ts"] },

    { "name": "noc-remote", "transport": "http", "enabled": false,
      "url": "${NOC_REMOTE_URL}" }
  ]
}
```

- `enabled: false` skips a server without deleting its entry.
- `${VAR}` references are expanded from the environment.
- Arguments beginning with `./` are resolved against the repository root, so the host behaves the
  same regardless of the directory it is launched from.

Switching the custom server between local and remote is a one-line change: enable `noc-remote`,
disable `noc-local`. Nothing else in the project changes.

---

## Running the chatbot

### Terminal (required interface)

```bash
npm run cli
```

Commands available inside the chat:

| Command | Effect |
|---|---|
| `/servers` | connected servers, transports, negotiated protocol versions |
| `/tools` | the tool catalogue exactly as the model receives it |
| `/log [n]` | the last *n* MCP frames (default 40) |
| `/log full` | every frame with its complete JSON payload |
| `/log <server>` | frames for one server only |
| `/stats` | frame counts by message kind |
| `/reset` | clear the conversation context |
| `/exit` | quit |

### Web UI

Two processes:

```bash
npm run api     # terminal 1 — the host and its MCP connections
npm run web     # terminal 2 — the Vite dev server
```

Then open <http://localhost:5173>. The right-hand pane streams every JSON-RPC frame as it happens;
clicking a frame expands its full payload.

### Checking connectivity without the model

```bash
npm run probe              # connect to every enabled server and list its tools
npm run probe -- git       # only servers whose name contains "git"
npm run probe -- --verbose # print every frame as it is exchanged
```

This needs no API key and is the fastest way to confirm the MCP layer works.

---

## The custom MCP server

An **ISP / NOC support desk**: the tools a first-line agent at an internet provider would need to
handle a subscriber complaint. Full specification in [`docs/server-spec.md`](docs/server-spec.md).

| Tool | Purpose |
|---|---|
| `lookup_subscriber` | find an account by name, id, circuit id or phone |
| `get_link_metrics` | live telemetry: latency, jitter, packet loss, SNR, throughput |
| `run_link_diagnostics` | evaluate telemetry against operator thresholds, return a diagnosis |
| `check_zone_outage` | known incidents affecting a service zone |
| `open_incident_ticket` | escalate by creating a ticket |

All data is synthetic. Diagnostics are deterministic thresholds rather than random values, so a
demonstration gives the same answer every run.

Run it standalone:

```bash
npm run noc:stdio    # stdio transport (what the host spawns)
npm run noc:http     # Streamable HTTP on http://127.0.0.1:8787/mcp
```

### Example

> **You:** La clienta María Elena Ramírez dice que su internet está muy lento. Investiga y abre un
> ticket si corresponde.

The assistant chains five calls on its own: `lookup_subscriber` → `get_link_metrics` (8.2% packet
loss, SNR 14.1 dB) → `check_zone_outage` (nothing known) → `run_link_diagnostics` (critical link
fault) → `open_incident_ticket`, then reports the ticket number.

---

## Deploying the server remotely

The repository contains a `Dockerfile` and a Render blueprint (`render.yaml`). The image runs
`dist/server/http-main.js` — the same server as the local stdio entry point, behind a different
transport.

1. Create a new **Web Service** on [Render](https://dashboard.render.com) pointed at this repository.
   Render reads `render.yaml` automatically; otherwise choose *Docker* as the environment.
2. Wait for the build, then confirm it is alive:
   ```bash
   curl https://<your-service>.onrender.com/health
   ```
3. Point the host at it, in `.env`:
   ```ini
   NOC_REMOTE_URL=https://<your-service>.onrender.com/mcp
   ```
4. In `config/servers.json`, set `noc-remote` to `enabled: true` and `noc-local` to `false`.
5. Verify the remote server answers exactly like the local one:
   ```bash
   npm run probe -- noc-remote
   ```

The free tier sleeps when idle, so the first request after a pause takes around 50 seconds.

### HTTP endpoints

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/mcp` | a JSON-RPC request returns `application/json` (or SSE); a notification returns `202 Accepted` with no body |
| `GET` | `/mcp` | `405` — this server never initiates requests, so it declines the optional stream |
| `DELETE` | `/mcp` | terminates the session identified by `MCP-Session-Id` |
| `GET` | `/health` | liveness probe; not part of MCP |

---

## Capturing the traffic with Wireshark

Two captures are taken, for different reasons.

**Plaintext, on loopback.** Start the server locally and capture on the loopback adapter, so the
JSON-RPC messages are readable directly in the packet bytes:

```bash
npm run noc:http
# capture on "Adapter for loopback traffic capture", filter: tcp.port == 8787
npm run probe -- noc-http-local
```

**Encrypted, against the real deployment.** The remote server is served over HTTPS, so a naive
capture shows only TLS `Application Data`. The client can export its TLS session keys, which lets
Wireshark decrypt the capture without weakening the deployment:

```ini
# .env
MCP_TLS_KEYLOG=1
```

Keys are written to `docs/captures/session.keylog`. Point Wireshark at it under
*Preferences → Protocols → TLS → (Pre)-Master-Secret log filename*, and the JSON-RPC messages become
readable inside the TLS stream.

The analysis itself is in [`docs/wireshark-analysis.md`](docs/wireshark-analysis.md).

---

## Project layout

```
src/
  mcp/                     the protocol, written by hand
    types.ts               JSON-RPC 2.0 and MCP wire types
    jsonrpc.ts             message construction, classification, framing
    transport.ts           the Transport interface
    stdio-transport.ts     client side of the stdio transport
    http-transport.ts      client side of Streamable HTTP (+ TLS key export)
    client.ts              lifecycle, version negotiation, tools/list, tools/call
    log.ts                 the interaction log (requirement 3)
  server/
    core.ts                tool registry and JSON-RPC dispatch
    tools/noc-tools.ts     the five NOC tools
    data/noc-data.ts       synthetic dataset
    stdio-main.ts          local entry point
    http-main.ts           remote entry point (server side of Streamable HTTP)
  host/
    host.ts                the anfitrión: multi-server routing, agentic loop
    config.ts              server configuration loading
    connect.ts             config entry -> connected client
    conversation.ts        session context (requirement 2)
    llm/openrouter.ts      provider adapter
  cli/index.ts             terminal chatbot
  cli/probe.ts             connectivity probe
  api/server.ts            REST/SSE bridge for the web UI
web/                       React + Vite chatbot
docs/                      server specification, protocol analysis, captures
config/servers.json        which servers to connect to
```

---

## Implementation notes

Things worth knowing if you read the code.

**Version negotiation is not optional.** The client sends the newest revision it supports, but a
server may answer with a different one, and the client must accept any revision on its supported
list. Hard-coding a single version string breaks the connection to the official servers.

**stdout is sacred on stdio.** A server must write nothing to stdout except MCP messages. All
diagnostics in `stdio-main.ts` go to stderr, and the client treats stderr as informational — never
as an error signal.

**Frames are reassembled, not assumed.** A single `data` event on a stream may carry half a message,
several messages, or both, so both transports buffer and split on newline boundaries.

**Tool failures are not protocol failures.** A tool that runs and fails returns a successful JSON-RPC
response carrying `isError: true`, so the model can read the failure and react. Only unknown methods
and malformed parameters produce JSON-RPC errors.

**Tool names are namespaced.** The model sees one flat list, but two servers may expose the same tool
name, so the catalogue is namespaced as `<server>__<tool>` and calls are routed back by that prefix.

**`git_init` is not available.** `mcp-server-git` 1.29.0 exposes twelve tools, none of which creates
a repository. `npm run setup:demo` therefore initialises `sandbox/demo-repo`, and the chatbot does
the rest — creating the README, staging it and committing — through MCP.

**Talking to the model is not MCP.** The ban on SDKs in §3.1 concerns MCP implementations. The
`openai` package is used purely as an HTTP client for OpenRouter's OpenAI-compatible API; every MCP
byte in this project is produced by code in `src/mcp/` and `src/server/`.

---

## References

- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification)
- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP specification, revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Official MCP reference servers](https://github.com/modelcontextprotocol/servers)
- [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
