# Conclusions, Difficulties and Lessons Learned

Proyecto 1 — *Uso de un protocolo existente*. CC3067 Redes, Universidad del Valle de Guatemala.

This document covers requirement 10 and provides the material for the project presentation:
what was implemented, what went wrong, how it was resolved, and what the exercise actually taught.

---

## 1. What was built

A chatbot acting as an MCP **host**, connected simultaneously to three MCP servers:

| Server | Origin | Transport | Tools |
|---|---|---|---:|
| `filesystem` | official Anthropic reference server | stdio | 14 |
| `git` | official Anthropic reference server | stdio | 12 |
| `noc-remote` | written for this project, deployed to Render | Streamable HTTP | 5 |

31 tools in one namespaced catalogue, driven by a language model through OpenRouter, with two front
ends (terminal and web) and a complete log of every JSON-RPC frame.

The entire protocol is hand-written. There is no MCP SDK anywhere in the repository: JSON-RPC
framing, the lifecycle, version and capability negotiation, and both transports — on the client
*and* the server side — are implemented in `src/mcp/` and `src/server/`.

---

## 2. Difficulties and how they were resolved

### 2.1 The client is the hard part, not the server

The obvious reading of the assignment is that the work lies in writing a server. It does not. Writing
a server means answering messages that arrive in a shape you chose. Writing a **client** means
speaking to servers somebody else wrote, strictly enough that they accept you — which is where every
ambiguity in the specification actually bites.

*Resolution:* the client was built first and validated against the two official servers before any
custom code existed. If the framing had been wrong, everything downstream would have been built on
sand.

### 2.2 Version negotiation cannot be hard-coded

The first instinct is to send `"protocolVersion": "2025-11-25"` and expect it back. The specification
says otherwise: the server replies with *its* preferred revision, and the client must accept any
revision it supports or disconnect.

*Resolution:* the client holds an ordered list of supported revisions and adopts whatever the server
answers with, as long as it appears on that list (`SUPPORTED_PROTOCOL_VERSIONS` in
`src/mcp/types.ts`). A single hard-coded string would have worked against our own server and failed
against somebody else's — the worst kind of bug, because local testing would never reveal it.

### 2.3 `git_init` does not exist

Requirement 4's example asks the chatbot to "create a repository, create a README, add it and
commit". The official `mcp-server-git` (v1.29.0) exposes twelve tools — status, diff, commit, add,
reset, log, branch, checkout, show — and **none of them creates a repository**.

*Resolution:* repository creation became a documented setup step (`npm run setup:demo`), while every
part that MCP can actually do — writing the README through the Filesystem server, staging and
committing through the Git server, reading back the log — is driven by the chatbot. The limitation is
stated plainly in the README rather than papered over.

### 2.4 Spawning stdio servers on Windows

The official servers are launched as `npx` and `uvx`, which on Windows are `.cmd` shims. Node refuses
to spawn those directly (a deliberate restriction since CVE-2024-27980), so the shell is required —
and passing an argument array with `shell: true` triggers a deprecation warning about unescaped
concatenation.

*Resolution:* on Windows the command and its arguments are quoted and joined into a single command
line explicitly, so the quoting rules live in one visible place instead of being applied invisibly by
Node. POSIX spawns directly and skips all of it.

### 2.5 A request is structurally a notification

TypeScript refused to narrow the message union. Because `JsonRpcRequest` is `JsonRpcNotification`
plus an `id`, a request is *assignable* to a notification, so eliminating notifications also
eliminated requests and the remaining branch narrowed to `never`.

*Resolution:* check for a request **before** checking for a notification. A small thing, but it is a
genuine reflection of the protocol: the only difference between the two is the presence of `id`, and
that ordering dependency is worth a comment in the code.

### 2.6 The 404 that meant two different things — the most instructive bug

The remote deployment failed immediately: `initialize` succeeded, and the very next request returned
404. Local testing had never produced this, because loopback never fails.

Investigation showed **two unrelated causes wearing the same status code**:

1. The hosting platform's edge answers `404` with `x-render-routing: no-server` when it has no
   instance available. Transient; the correct response is to retry.
2. An MCP server answers `404` when it does not recognise a session id. Permanent for that session;
   the correct response, per the specification, is to send a fresh `initialize` and replay.

The original client did neither — it treated every 404 as fatal.

*Resolution:* the two are distinguished by the routing header. Transient failures retry with
exponential backoff; genuine session loss re-runs the handshake once and replays the request. The
packet capture in `docs/wireshark-analysis.md` §4.3 shows the fix working: **five requests were
answered with 404 and every one succeeded on retry**, completing the identical 17-message session.

This bug is the strongest argument in the whole project for why requirement 6 asks for a *remote*
deployment. It is not busywork on top of the local server — it is the only condition under which
this class of defect appears.

### 2.7 The agentic loop cut itself off

Requirement 4's demonstration produced eight tool calls, all successful — and then reported failure.
The loop's safety limit was exactly 8, so the final round that would have produced the answer never
ran.

*Resolution:* the limit was raised to 16. The lesson is that a safety valve sized by guesswork will
eventually fire on legitimate work, and when it does the failure looks like a bug in something else
entirely.

### 2.8 Model availability is not guaranteed

The configured model (`anthropic/claude-3.5-haiku`) returned "No endpoints found" — it had been
withdrawn from the provider. The free model chosen as a replacement returned HTTP 429 under load.

*Resolution:* the provider's model list was queried directly, filtered by
`supported_parameters=tools`, and the candidates tested for genuine tool-calling behaviour before one
was selected. A model that silently ignores the `tools` parameter is particularly dangerous here: it
looks exactly like a bug in the MCP client.

---

## 3. Lessons learned

**MCP is a convention, not a wire format.** Nothing in either packet capture identifies MCP as such.
There is no MCP header, no MCP port, no magic number. It is JSON-RPC 2.0 with agreed method names, a
lifecycle, and a capability negotiation. That is precisely why implementing it by hand is tractable
in the first place, and why the same server code serves stdio and HTTP without modification.

**A transport specification is mostly a mapping exercise.** The interesting content of Streamable
HTTP is not new machinery — it is the decisions about how JSON-RPC semantics project onto HTTP:
notifications onto `202`, sessions onto a header, expiry onto `404`, a declined stream onto `405`.
The capture shows each mapping happening in sequence.

**Layering is a real property, observable rather than asserted.** The identical seventeen JSON-RPC
messages travelled once over a kernel memory copy with no link layer at all, and once over Ethernet,
a routed public address and TLS 1.3. Only the layers below the application changed. Reading the two
captures side by side makes the abstraction concrete in a way a diagram cannot.

**Encryption is opaque unless an endpoint cooperates.** Capture B is readable only because the client
was modified to export its own TLS session keys. Without that, an observer sees endpoints, timing and
byte counts — and the SNI hostname, which TLS sends in the clear before encryption begins. Choosing
to build the key export rather than downgrade the deployment to plaintext kept the analysis honest.

**Distributed state is where designs actually break.** The server kept sessions in an in-memory
`Map`, which is correct and sufficient locally and quietly wrong the moment a hosted instance can
restart or scale. The specification anticipates this precisely — it defines the 404-then-reinitialize
recovery — and the value of implementing that recovery only became visible when a real deployment
exercised it.

**Reliability is a protocol concern, not an afterthought.** Roughly a third of the requests in the
remote capture failed on first attempt. The session still completed, because retry and recovery were
built into the transport. On loopback that code would look like dead weight; over the internet it is
the difference between working and not.

---

## 4. Conclusions

The project asked for a chatbot using an existing protocol. What made it worthwhile was the
prohibition on SDKs: being forced to write the client and the server by hand turns the specification
from documentation into something that has to be read precisely, because every ambiguity becomes a
bug that a real counterparty will expose.

Three results stand out.

**The protocol works exactly as specified, and the capture proves it.** Every mapping the transport
specification defines was observed on the wire — including the `202 Accepted` for the `initialized`
notification, which is easy to implement wrongly and impossible to notice without looking at packets.

**The local and remote deployments are genuinely the same server.** Not a reimplementation kept in
sync, but one object behind two transports. Moving between them is a single line in a configuration
file, and the two produce identical `serverInfo`, identical negotiated versions and identical tool
catalogues. That is the concrete payoff of designing the transport as an interface on day one.

**The remote requirement earns its weight.** Deploying to real infrastructure surfaced a correctness
defect — the ambiguous 404 — that no amount of local testing would have found, because the failure
mode simply does not exist on loopback. Networks fail; loopback does not; and code that has only ever
run over loopback has never been tested against the condition it will actually meet.

Reading the two captures side by side is the clearest summary of the whole exercise: the same
seventeen application-layer messages, unchanged, carried once by a memory copy and once by Ethernet,
IP, TCP and TLS across the internet. The application never knew the difference. That is what the
layered model buys, and seeing it in packet form is more convincing than any description of it.
