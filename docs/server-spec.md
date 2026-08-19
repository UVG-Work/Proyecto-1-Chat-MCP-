# NOC Support Desk MCP Server — Specification

Custom MCP server built for Proyecto 1 (requirements 5 and 6). It exposes the tools a first-line
support agent at an internet service provider would use to handle a subscriber complaint.

The same server runs in two deployments: locally as a subprocess over **stdio**, and remotely over
**Streamable HTTP**. Both entry points wrap the identical server object (`createNocServer()` in
`src/server/noc-server.ts`), so the two deployments cannot drift apart.

| | |
|---|---|
| Server name | `noc-support-desk` |
| Version | `1.0.0` |
| MCP revision | `2025-11-25` (negotiates down to `2025-06-18`, `2025-03-26`, `2024-11-05`) |
| Capabilities | `tools` (with `listChanged: false`) |
| Transports | stdio · Streamable HTTP |
| Implementation | TypeScript, no MCP SDK |

---

## 1. Industry use case

An ISP support desk receives a call: *"my internet is slow."* Resolving it means identifying the
account, reading live telemetry from the subscriber's circuit, ruling out a known area outage, and
deciding whether the evidence justifies dispatching a technician. Each of those is a separate system
in a real operator, and an agent has to chain them in the right order.

That chaining is what makes it a good MCP use case: the model is not calling one tool, it is
sequencing five of them and deciding at each step what to do next.

All data is synthetic and contains no real subscriber information.

---

## 2. Protocol surface

### 2.1 Methods

| Method | Kind | Supported |
|---|---|---|
| `initialize` | request | yes |
| `notifications/initialized` | notification | yes (consumed, never answered) |
| `ping` | request | yes, returns `{}` |
| `tools/list` | request | yes (no pagination — the catalogue is small and fixed) |
| `tools/call` | request | yes |

Any other method returns JSON-RPC error `-32601` (Method not found).

### 2.2 Initialization

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": { "name": "uvg-mcp-chat-host", "version": "1.0.0" }
  }
}
```

Result:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "noc-support-desk", "title": "ISP NOC Support Desk", "version": "1.0.0" },
    "instructions": "This server exposes the first-line support desk ..."
  }
}
```

Version negotiation: the server echoes the client's revision when it recognises it, and otherwise
answers with its own newest. The `instructions` field carries the recommended tool ordering, which
the host forwards into the model's system prompt rather than hard-coding it.

### 2.3 Error codes

| Code | Meaning | Raised when |
|---|---|---|
| `-32700` | Parse error | the payload is not valid JSON |
| `-32600` | Invalid request | not a valid JSON-RPC 2.0 message |
| `-32601` | Method not found | unknown method |
| `-32602` | Invalid params | unknown tool name, missing required argument, wrong argument type, value outside an `enum` |
| `-32603` | Internal error | unexpected server-side failure |

A tool that runs and *fails* is not an error at this level: it returns a successful response whose
`result` carries `isError: true` and an explanatory text block, so the model can read the failure and
choose a different approach.

---

## 3. Tools

All five accept a single flat object. Every result contains a human-readable `text` block and, on
success, a `structuredContent` object carrying the same data in machine-readable form.

### 3.1 `lookup_subscriber`

Find an account. Call this first whenever the caller is identified by name or phone number.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Name, subscriber id (`SUB-######`), circuit id (`GT-CIR-######`) or phone number |

Matching ignores accents, punctuation and spacing, so `Lucia`, `Lucía`, `55128834` and
`+502 5512-8834` all resolve.

Returns matching accounts with their circuit id, zone, plan and account status.
`isError: true` when nothing matches.

```json
{ "name": "lookup_subscriber", "arguments": { "query": "Maria Elena Ramirez" } }
```

### 3.2 `get_link_metrics`

Live telemetry for one circuit.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `circuit_id` | string | yes | Circuit identifier, e.g. `GT-CIR-004821` |

Returns latency (ms), jitter (ms), packet loss (%), SNR (dB), measured downstream/upstream
throughput (Mbps), uptime (hours) and link flaps in the last 24 hours, plus the measured throughput
as a percentage of the subscribed plan.

### 3.3 `run_link_diagnostics`

Evaluate telemetry against operator thresholds and return a diagnosis with a recommended action.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `circuit_id` | string | yes | Circuit identifier |

Thresholds:

| Metric | Degraded | Critical |
|---|---|---|
| Packet loss | ≥ 1 % | ≥ 5 % |
| Latency | ≥ 60 ms | ≥ 120 ms |
| Jitter | ≥ 15 ms | ≥ 30 ms |
| SNR | ≤ 20 dB | ≤ 15 dB |
| Flaps (24 h) | ≥ 5 | — |

Possible diagnoses:

| `diagnosis` | Meaning |
|---|---|
| `healthy` | everything within thresholds; check customer-side equipment |
| `link-fault` | one or more thresholds breached; severity `degraded` or `critical` |
| `zone-outage` | a known incident in the subscriber's zone explains it; do not duplicate the ticket |
| `account-suspended` | the link is physically fine but the account is suspended; route to billing |

The last two exist to stop the obvious wrong answer. A suspended account and a fibre cut both look
like a dead link from the telemetry alone, and dispatching a technician for either wastes a truck
roll.

### 3.4 `check_zone_outage`

Known incidents for a service zone.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `zone` | string | yes | Zone identifier, e.g. `ZONA-GUATE-07` |

Returns incident id, cause, status (`investigating`, `identified`, `repair-in-progress`, `resolved`),
start time, estimated resolution and the number of affected subscribers.

### 3.5 `open_incident_ticket`

Escalate. The only tool that changes state.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subscriber_id` | string | yes | Exact subscriber id, e.g. `SUB-100482` |
| `summary` | string | yes | One-line description of the fault and its evidence |
| `severity` | string | yes | One of `low`, `medium`, `high`, `critical` |

Severity determines routing: `high` and `critical` go to Field Operations, the rest to Remote NOC
Tier 2. Returns the ticket id.

Tickets are held in memory. The remote container's filesystem is ephemeral, and persistence would
add nothing to what the project demonstrates.

---

## 4. Transports

### 4.1 stdio (local)

```bash
npm run noc:stdio
# or, as the host spawns it:
npx tsx ./src/server/stdio-main.ts
```

- One JSON-RPC message per line, UTF-8, no embedded newlines.
- stdout carries MCP messages and nothing else.
- stderr carries diagnostics and must not be treated as an error signal.
- Closing stdin shuts the server down.

### 4.2 Streamable HTTP (remote)

```bash
npm run noc:http     # http://127.0.0.1:8787/mcp
```

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/mcp` | request → `200` with `application/json` (or `text/event-stream` when `MCP_SSE=1`); notification or response → `202 Accepted`, empty body |
| `GET` | `/mcp` | `405 Method Not Allowed` — this server never initiates requests |
| `DELETE` | `/mcp` | terminates the session named by `MCP-Session-Id`; `204` |
| `GET` | `/health` | liveness JSON; **not** part of MCP |

Headers:

| Header | Direction | Purpose |
|---|---|---|
| `Accept` | client → server | must list both `application/json` and `text/event-stream` |
| `Content-Type` | both | `application/json` |
| `MCP-Session-Id` | issued by server on `InitializeResult`, echoed by client thereafter | session binding |
| `MCP-Protocol-Version` | client → server | the negotiated revision, on every post-handshake request |
| `Origin` | client → server | validated when present; mismatch returns `403` |

An unknown or expired `MCP-Session-Id` returns `404`, which instructs the client to start a new
session with a fresh `initialize`. Sessions expire after one hour of inactivity.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listening port (the cloud platform injects this) |
| `HOST` | `0.0.0.0` | bind address |
| `MCP_PATH` | `/mcp` | endpoint path |
| `MCP_SSE` | `0` | `1` answers requests with an SSE stream instead of plain JSON |
| `MCP_ALLOWED_ORIGINS` | *(empty)* | comma-separated allow list; empty means localhost only |

---

## 5. Worked example

Full exchange for *"María Elena's internet is slow"*, abbreviated to the essentials.

```jsonc
// 1. handshake
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
<-- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25",...}}
--> {"jsonrpc":"2.0","method":"notifications/initialized"}

// 2. discovery
--> {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
<-- {"jsonrpc":"2.0","id":2,"result":{"tools":[ ... 5 tools ... ]}}

// 3. identify the account
--> {"jsonrpc":"2.0","id":3,"method":"tools/call",
     "params":{"name":"lookup_subscriber","arguments":{"query":"Maria Elena Ramirez"}}}
<-- {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Found 1 ..."}],
     "structuredContent":{"matches":[{"subscriberId":"SUB-100482","circuitId":"GT-CIR-004821",...}]}}}

// 4. read telemetry
--> {"jsonrpc":"2.0","id":4,"method":"tools/call",
     "params":{"name":"get_link_metrics","arguments":{"circuit_id":"GT-CIR-004821"}}}
<-- {"jsonrpc":"2.0","id":4,"result":{... packetLossPct: 8.2, snrDb: 14.1 ...}}

// 5. rule out a zone outage
--> {"jsonrpc":"2.0","id":5,"method":"tools/call",
     "params":{"name":"check_zone_outage","arguments":{"zone":"ZONA-MIXCO-03"}}}
<-- {"jsonrpc":"2.0","id":5,"result":{... "outages": [] ...}}

// 6. diagnose
--> {"jsonrpc":"2.0","id":6,"method":"tools/call",
     "params":{"name":"run_link_diagnostics","arguments":{"circuit_id":"GT-CIR-004821"}}}
<-- {"jsonrpc":"2.0","id":6,"result":{... "diagnosis":"link-fault","severity":"critical" ...}}

// 7. escalate
--> {"jsonrpc":"2.0","id":7,"method":"tools/call",
     "params":{"name":"open_incident_ticket","arguments":{
       "subscriber_id":"SUB-100482",
       "summary":"8.2% packet loss and SNR 14.1 dB on GT-CIR-004821; 11 flaps in 24h",
       "severity":"critical"}}}
<-- {"jsonrpc":"2.0","id":7,"result":{... "ticketId":"TCK-4401" ...}}
```

---

## 6. Test data

| Subscriber | Circuit | Zone | Condition |
|---|---|---|---|
| `SUB-100482` María Elena Ramírez | `GT-CIR-004821` | `ZONA-MIXCO-03` | degraded — 8.2 % loss, SNR 14.1 dB, 11 flaps |
| `SUB-100731` Carlos Humberto Divas | `GT-CIR-005190` | `ZONA-GUATE-10` | healthy |
| `SUB-100955` Ana Lucía Estrada | `GT-CIR-005544` | `ZONA-GUATE-07` | down — inside an active fibre-cut outage |
| `SUB-101204` Jorge Antonio Similox | `GT-CIR-006012` | `ZONA-SACATEPEQUEZ-01` | link healthy, account suspended |
| `SUB-101488` Sofía Renata Marroquín | `GT-CIR-006377` | `ZONA-GUATE-15` | congested — 137 ms latency, 42.6 ms jitter, no loss |

Each row exercises a different diagnostic path, so all four `diagnosis` values are reachable in a
demonstration.
