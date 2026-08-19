# Protocol Analysis with Wireshark

Requirements 7 and 9 of the project statement: capture the traffic between the host and the MCP
server, classify the JSON-RPC messages, and explain what happens at the link, network, transport and
application layers.

Two captures are used, for different reasons.

| Capture | File | Transport | Why |
|---|---|---|---|
| A — loopback, plaintext | `mcp-http-loopback.pcapng` | HTTP over 127.0.0.1 | JSON-RPC is readable directly in the packet bytes, so every message can be identified and classified without key material |
| B — remote, encrypted | `mcp-http-remote.pcapng` | HTTPS to the deployed server | the real deployment over the internet, with a real link layer, routing, and TLS |

Capture A answers *what the protocol says*. Capture B answers *what actually crosses a network*.
Neither is sufficient alone: a loopback capture has no Ethernet header and no routing to discuss,
while an encrypted capture hides the application layer unless the session keys are exported.

---

## 1. Methodology

### Capture A — loopback

```powershell
powershell -ExecutionPolicy Bypass -File scripts/capture-loopback.ps1
```

The script starts the NOC MCP server on port 8787, begins capturing on the Npcap loopback adapter
with the filter `tcp port 8787`, and runs `src/cli/demo-session.ts` — a scripted session that
performs the handshake, lists the tools, executes five tool calls and one deliberately invalid call,
then terminates the session.

The session is scripted rather than model-driven on purpose: no language model is involved, so the
exchange is byte-for-byte reproducible and the capture can be compared against a known sequence.

**Capture filter:** `tcp port 8787`
**Useful display filters:** `http`, `json`, `tcp.flags.syn == 1`, `http.response.code == 202`

Commands used to produce the tables below, so the analysis can be reproduced:

```bash
TS="/c/Program Files/Wireshark/tshark.exe"
CAP=docs/captures/mcp-http-loopback.pcapng

# protocol hierarchy and totals
"$TS" -r $CAP -q -z io,phs
"$TS" -r $CAP -q -z conv,tcp

# HTTP methods, URIs and status codes per frame
"$TS" -r $CAP -Y http -T fields -e frame.number -e http.request.method \
      -e http.request.uri -e http.response.code

# JSON-RPC methods decoded by the JSON dissector
"$TS" -r $CAP -Y http.request -T fields -e frame.number -e json.value.string

# request ids, for the correlation column
"$TS" -r $CAP -q -z follow,tcp,ascii,0 | grep -oE '"(id|method)":\s*("[^"]*"|[0-9]+)'
```

### Capture B — remote

The deployed server is served over HTTPS, so a naive capture shows only TLS `Application Data`. The
client exports its own TLS session keys in NSS key log format, which lets Wireshark decrypt the
capture without weakening the deployment:

```ini
# .env
MCP_TLS_KEYLOG=1
```

Keys are written to `docs/captures/session.keylog` by `src/mcp/http-transport.ts`, which attaches to
the `keylog` event on the outgoing TLS socket. In Wireshark, set
*Preferences → Protocols → TLS → (Pre)-Master-Secret log filename* to that file.

> The keylog file contains live session secrets and is deliberately git-ignored.

---

## 2. Capture A — results

48 frames, one TCP conversation, 14 kB, total duration 54.8 ms.

```
Protocol Hierarchy Statistics

frame          frames:48  bytes:14864
  null         frames:48  bytes:14864
    ip         frames:48  bytes:14864
      tcp      frames:48  bytes:14864
        http   frames:20  bytes:13608
          json frames:17  bytes:13020
```

### 2.1 Message classification

This is what requirement 7 asks for explicitly: which messages are synchronization, which are
requests, and which are responses.

| Frame | HTTP | JSON-RPC method | id | Classification |
|---:|---|---|---:|---|
| 1–3 | — | — | — | **TCP connection setup** (SYN, SYN-ACK, ACK) |
| 4 | `POST /mcp` | `initialize` | 1 | **synchronization** — request |
| 6 | `200 OK` | *(InitializeResult)* | 1 | **synchronization** — response, carries `MCP-Session-Id` |
| 8 | `POST /mcp` | `notifications/initialized` | — | **synchronization** — notification |
| 10 | `202 Accepted` | *(empty body)* | — | acknowledgement only; a notification is never answered |
| 12 | `POST /mcp` | `tools/list` | 2 | **request** |
| 14 | `200 OK` | *(ListToolsResult)* | 2 | **response** |
| 16 | `POST /mcp` | `tools/call` → `lookup_subscriber` | 3 | **request** |
| 18 | `200 OK` | *(CallToolResult)* | 3 | **response** |
| 20 / 22 | `POST` / `200` | `tools/call` → `get_link_metrics` | 4 | request / response |
| 24 / 26 | `POST` / `200` | `tools/call` → `check_zone_outage` | 5 | request / response |
| 28 / 30 | `POST` / `200` | `tools/call` → `run_link_diagnostics` | 6 | request / response |
| 32 / 34 | `POST` / `200` | `tools/call` → `open_incident_ticket` | 7 | request / response |
| 36 / 38 | `POST` / `200` | `tools/call` → `get_link_metrics` (unknown circuit) | 8 | request / response carrying `isError: true` |
| 40 | `DELETE /mcp` | — | — | **synchronization** — session termination |
| 42 | `204 No Content` | — | — | acknowledgement |
| 44–48 | — | — | — | **TCP teardown** (FIN-ACK both ways) |

Totals: **17 JSON-RPC messages** — 3 synchronization, 7 requests, 7 responses. The host's own
interaction log (`/log` in the CLI) reports exactly the same 17 frames, which confirms the log and
the wire agree.

Three details worth pointing out:

**The 202 on frame 10 is the specification working as designed.** A JSON-RPC *notification* has no
`id` and must never receive a response. The Streamable HTTP transport expresses that at the HTTP
layer: the server returns `202 Accepted` with an empty body rather than a JSON-RPC message. Frame 10
is 186 bytes and carries no JSON at all — visible in the hierarchy above, where only 17 of the 20
HTTP frames contain JSON.

**The failing tool call is not a protocol error.** Frame 38 is `200 OK`, not a JSON-RPC error object.
The tool ran, could not find circuit `GT-CIR-000000`, and reported that through `isError: true`
inside a successful result — so the model can read the failure and react. JSON-RPC errors are
reserved for protocol-level faults such as an unknown method.

**Session state is carried in a header, not in the JSON.** `MCP-Session-Id:
9eb97fe5-a64a-4e9b-ae08-a0d32da5b271` appears in the response headers of frame 6 and in the request
headers of every frame afterwards. The JSON-RPC layer is stateless; the session lives in HTTP.

---

## 3. Layer-by-layer analysis (requirement 9)

### 3.1 Link layer

Capture A has **no Ethernet header**. `frame.encap_type` is 15 and the protocol chain is
`null:ip:tcp` — the BSD Null/Loopback encapsulation, a 4-byte pseudo-header holding only the address
family (AF_INET).

This is the correct behaviour, and it is instructive: loopback traffic never reaches a network
interface card, so there is nothing for a MAC address to identify. There is no ARP, no framing
preamble, no FCS, and no collision domain. The "link" is a memory copy inside the kernel.

Capture B, by contrast, carries a real Ethernet II header with source and destination MAC addresses —
the destination being the default gateway's MAC, not the server's, because the server is not on the
local segment.

### 3.2 Network layer

IPv4, `127.0.0.1 → 127.0.0.1`, on the reserved loopback block `127.0.0.0/8`. TTL is irrelevant here
because the packet is never routed; there is no next hop to decrement toward.

The MSS advertised in the SYN is **65495 bytes**, derived from the loopback MTU of 65535. On a real
Ethernet path this would be 1460 (1500-byte MTU minus 20 bytes IP and 20 bytes TCP). The consequence
is visible in the capture: the largest response, the 866-byte `InitializeResult` plus headers, fits
in a single 1120-byte frame, whereas the same payload over Ethernet in capture B is split across
multiple segments.

### 3.3 Transport layer

TCP, server port 8787.

**Connection establishment** — frames 1–3, the three-way handshake:

```
1  64430 → 8787  [SYN]      Seq=0             Win=65535  MSS=65495  WS=256  SACK_PERM
2  8787 → 64430  [SYN, ACK] Seq=0  Ack=1      Win=65535  MSS=65495  WS=256  SACK_PERM
3  64430 → 8787  [ACK]      Seq=1  Ack=1      Win=65280
```

Both sides negotiate window scaling and selective acknowledgement.

**One connection for the whole session.** All ten HTTP request/response pairs travel over the single
conversation `127.0.0.1:64430 ↔ 127.0.0.1:8787`. The server sends `Connection: keep-alive` with
`Keep-Alive: timeout=5`, so the socket is reused rather than reopened per message. This matters for
MCP: the Streamable HTTP transport sends every client message as a *new HTTP request*, but not
necessarily on a new TCP connection. Ten requests cost one handshake, not ten.

**Data transfer** follows a strict PSH/ACK–ACK rhythm, with no retransmissions, no zero-window
events and no out-of-order segments — expected on loopback, where there is no medium to lose packets
on. The one `TCP Dup ACK` at frame 47 is an artefact of the simultaneous close, not a loss event.

**Connection teardown** — frames 44–48, the graceful four-way close:

```
44  64430 → 8787  [FIN, ACK]
45  8787 → 64430  [ACK]
46  8787 → 64430  [FIN, ACK]
47/48                        final ACKs
```

The client closes first, immediately after the `DELETE /mcp`. That ordering is the MCP shutdown
sequence expressed in TCP: terminate the session at the application layer, then release the
transport.

### 3.4 Application layer

Two protocols stacked, which is the heart of what MCP is:

**HTTP/1.1** provides the request/response envelope, the session header, and the status semantics.
The transport specification maps JSON-RPC concepts onto HTTP deliberately — a request gets a body, a
notification gets `202`, an expired session gets `404`, a declined stream gets `405`.

**JSON-RPC 2.0** is the actual protocol. Every body carries `"jsonrpc": "2.0"`, and requests carry an
`id` that correlates the response. Wireshark's JSON dissector decodes these without any
configuration, so the method names read directly out of the capture:

```
frame  4   2.0, initialize, 2025-11-25, uvg-mcp-chat-host, UVG MCP Chat Host, 1.0.0
frame  8   2.0, notifications/initialized
frame 12   2.0, tools/list
frame 16   2.0, tools/call, lookup_subscriber, Maria Elena Ramirez
frame 20   2.0, tools/call, get_link_metrics, GT-CIR-004821
frame 24   2.0, tools/call, check_zone_outage, ZONA-MIXCO-03
frame 28   2.0, tools/call, run_link_diagnostics, GT-CIR-004821
frame 32   2.0, tools/call, open_incident_ticket, SUB-100482, ..., critical
frame 36   2.0, tools/call, get_link_metrics, GT-CIR-000000
```

**MCP itself has no bytes on the wire.** It is a convention layered on JSON-RPC: a set of method
names, a lifecycle, and a capability negotiation. There is no MCP header and no MCP port. Frame 4 is
an ordinary JSON-RPC request whose method happens to be `initialize` — which is precisely why the
protocol can be implemented by hand, and why it runs unchanged over stdio, where none of layers
3.1–3.3 exist at all.

---

## 4. Capture B — remote deployment

Taken against `https://proyecto-1-chat-mcp.onrender.com/mcp` with
`scripts/capture-remote.ps1`. 85 frames, 29.8 kB.

```
Protocol Hierarchy Statistics

frame                 frames:85  bytes:29849
  eth                 frames:85  bytes:29849
    ip                frames:85  bytes:29849
      tcp             frames:85  bytes:29849
        tls           frames:45  bytes:26090
          http        frames:30  bytes:10661
            json      frames:22  bytes:7211
            data-text-lines frames:5 bytes:2460
```

The stack has gained two layers relative to capture A: a real `eth` link layer at the bottom, and
`tls` between TCP and HTTP. The `json` layer only appears at all because the exported session keys
were supplied; without them Wireshark stops at `tls`.

### 4.1 Side-by-side with capture A

| | A — loopback | B — remote |
|---|---|---|
| Protocol chain | `null:ip:tcp` | `eth:ethertype:ip:tcp` |
| Link layer | BSD Null/Loopback, 4-byte pseudo-header, **no MAC addresses** | Ethernet II, src `c8:53:09:f2:ca:22`, dst `f8:63:d9:b2:3c:b0` |
| Addresses | `127.0.0.1 → 127.0.0.1` | `192.168.0.7 → 216.24.57.15` |
| IP TTL | not meaningful | 128 outbound |
| TCP MSS | 65495 | 1460 |
| Handshake RTT | ~0.1 ms | **47 ms** |
| Encryption | none | TLS 1.3, `TLS_AES_256_GCM_SHA384` |
| Total frames | 48 | 85 |
| JSON-RPC visible? | directly | only with exported keys |

**The destination MAC is not the server's.** `f8:63:d9:b2:3c:b0` is the default gateway. Ethernet
addressing is hop-local: the frame is addressed to the next router, while the IP header carries the
end-to-end destination `216.24.57.15`. This is the clearest observable difference between layer 2
and layer 3 addressing in the whole project, and it simply cannot appear in a loopback capture.

**MSS drops from 65495 to 1460.** Loopback has a 65535-byte MTU because there is no medium; Ethernet
has 1500, minus 20 bytes IP and 20 bytes TCP. The practical consequence is visible in the capture:
responses that travelled as one frame locally are split across several segments here, and the
`tools/list` response in particular spans multiple TCP segments that Wireshark reassembles.

**RTT goes from microseconds to 47 ms.** The SYN leaves at t=0 and the SYN-ACK returns at t=0.0470.
Every subsequent request/response pair pays that latency, which is why the loopback session finished
in 55 ms and this one takes seconds.

### 4.2 The TLS handshake

| Frame | t (s) | Event |
|---:|---:|---|
| 1 | 0.0000 | TCP SYN |
| 2 | 0.0470 | TCP SYN-ACK |
| 5 | 0.0489 | TLS **ClientHello**, SNI `proyecto-1-chat-mcp.onrender.com` |
| 7 | 0.0952 | TLS **ServerHello** |

The record layer announces `0x0303` for compatibility, but the `supported_versions` extension
carries `0x0304` — the session is **TLS 1.3**, with cipher suite `0x1302`
(`TLS_AES_256_GCM_SHA384`).

Two observations matter here:

**SNI is sent in the clear.** Frame 5 exposes the hostname `proyecto-1-chat-mcp.onrender.com` before
any encryption is established, because the server needs it to choose a certificate. An observer who
cannot read a single byte of the MCP traffic still learns exactly which service is being contacted.

**Roughly 95 ms elapses before a single byte of MCP is exchanged.** TCP setup plus TLS negotiation
is pure overhead from the protocol's point of view — the cost of moving the same JSON-RPC messages
onto a network that cannot be trusted.

### 4.3 An unplanned finding: transient 404s and recovery

The decrypted HTTP view shows something the loopback capture never could:

| Frame | Request | Response |
|---:|---|---|
| 11 | `POST /mcp` | 13 → **404** |
| 15 | `POST /mcp` | 18 → 200 (initialize succeeds on retry) |
| 20 | `POST /mcp` | 22 → 202 (`notifications/initialized`) |
| 23 | `POST /mcp` | 25 → **404** |
| 27 | `POST /mcp` | 33 → 200 (`tools/list` succeeds on retry) |
| 35 / 39 | `POST /mcp` | 37 → **404**, 42 → 200 |
| 49 / 53 / 58 | `POST /mcp` | 51 → **404**, 55 → **404**, 62 → 200 |
| 80 | `DELETE /mcp` | 82 → 204 |

**Five requests were answered with 404 and every one of them succeeded on retry.** These are not MCP
errors: they carry `x-render-routing: no-server` and a plain-text body — visible in the hierarchy as
the five `data-text-lines` frames — and are emitted by the hosting platform's edge when it has no
instance to route to. The free tier does this intermittently.

This exposed a real defect. The client originally treated any 404 as "the session is gone" and
aborted. Two fixes followed, both visible in this capture working correctly:

1. A 404 carrying `x-render-routing` is transient and is retried with exponential backoff.
2. A 404 that genuinely indicates an unknown session now triggers a fresh `initialize` and a replay
   of the request, which is what the specification actually requires and what the original code
   failed to do.

The session completed with the same 17 JSON-RPC messages as capture A despite five infrastructure
failures along the way. This is the single most valuable thing the remote deployment taught the
project: a correctness bug that a local transport can never surface, because loopback never fails.

---

## 5. Conclusions

**MCP is a convention, not a wire format.** Nothing in the capture identifies MCP as such. It is
JSON-RPC 2.0 with agreed method names, which is exactly why implementing it by hand is tractable and
why the same server code serves both stdio and HTTP without modification.

**The transport specification is mostly about mapping, not invention.** The interesting work in
Streamable HTTP is deciding how JSON-RPC semantics project onto HTTP: notifications onto `202`,
sessions onto a header, expiry onto `404`, an unavailable stream onto `405`. The capture shows each of
those mappings occurring.

**Layering genuinely isolates concerns.** The identical JSON-RPC exchange ran over a kernel memory
copy with no link layer and over a routed, encrypted internet path. Only layers below the application
changed. That is the argument for layered design, observable rather than asserted.

**Reading encrypted traffic requires cooperation from an endpoint.** Capture B is only intelligible
because the client was modified to export its own session keys. An observer without that cooperation
sees connection metadata — endpoints, timing, byte counts — and nothing else. Building that export
was a deliberate choice to keep the deployment realistic rather than downgrading it to plaintext for
the convenience of the analysis.
