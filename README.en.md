# MCP Chat Host

A chatbot that connects to several Model Context Protocol servers at once and lets a language model
use their tools. Two official servers (Filesystem and Git) and one written for this project (an ISP
support desk) that runs both locally and deployed to the cloud.

Universidad del Valle de Guatemala, CC3067 Redes, Proyecto 1.

The MCP protocol is implemented by hand. No MCP SDK is used: the JSON-RPC framing, the initialize
lifecycle, version negotiation, the stdio transport and the Streamable HTTP transport are all written
from scratch, on both the client and the server side.

## Requirements

- Node.js 20 or newer
- uv (the official Git MCP server is a Python package run with uvx)
- Git
- An OpenRouter API key, free at https://openrouter.ai/keys

Wireshark with Npcap is only needed to reproduce the packet captures.

## Install

    git clone https://github.com/UVG-Work/Proyecto-1-Chat-MCP-.git
    cd Proyecto-1-Chat-MCP-
    npm install
    npm install --prefix web

Copy the example environment file and add your key:

    cp .env.example .env

Set at least these two values in `.env`:

    OPENROUTER_API_KEY=sk-or-v1-...
    OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free

The model must support tool calling. To list the models that do:

    curl -s "https://openrouter.ai/api/v1/models?supported_parameters=tools"

A model without tool support answers normal questions but silently never calls a tool, which looks
like a bug in the client. Check this first if tools are being ignored.

Prepare the sandbox used by the Filesystem and Git demonstration:

    npm run setup:demo

## Run

Terminal chatbot:

    npm run cli

Web chatbot, in two terminals:

    npm run api
    npm run web

Then open http://localhost:5173

## Terminal commands

Inside `npm run cli`:

    /servers        connected servers, transports and negotiated protocol versions
    /tools          the tool catalogue as the model receives it
    /log [n]        the last n MCP frames, default 40
    /log full       every frame with its complete JSON payload
    /log <server>   frames for one server only
    /stats          frame counts by message kind
    /reset          clear the conversation context
    /exit           quit

## Other commands

Check that the MCP layer works without using the language model:

    npm run probe                       all enabled servers
    npm run probe -- git                only servers matching a name
    npm run demo:session -- noc-local   a full MCP session over stdio
    npm run demo:session -- noc-remote  the same session against the deployment

Run a scripted demonstration:

    npm run demo:chat -- --scenario context     LLM API and session context
    npm run demo:chat -- --scenario git         Filesystem and Git servers
    npm run demo:chat -- --scenario noc         the custom NOC server
    npm run demo:chat -- --scenario outage      the zone outage path
    npm run demo:chat -- --scenario suspended   the suspended account path

Add `--log` to any scenario to print the full MCP frame log afterwards.

Run the custom server on its own:

    npm run noc:stdio    stdio transport
    npm run noc:http     Streamable HTTP on http://127.0.0.1:8787/mcp

## Choosing which servers to use

`config/servers.json` lists the servers the host connects to. Setting `enabled` to false skips an
entry without deleting it.

To use the custom server locally, enable `noc-local` and disable `noc-remote`. To use the deployed
one, do the opposite and set `NOC_REMOTE_URL` in `.env`. Nothing else changes: the same server code
serves both.

## The custom server

An ISP support desk with five tools:

    lookup_subscriber      find an account by name, id, circuit id or phone
    get_link_metrics       latency, jitter, packet loss, SNR, throughput
    run_link_diagnostics   evaluate the telemetry and return a diagnosis
    check_zone_outage      known incidents affecting a service zone
    open_incident_ticket   escalate by creating a ticket

All data is synthetic. Full specification in `docs/server-spec.md`.

Example: ask the chatbot "La clienta Maria Elena Ramirez dice que su internet esta muy lento.
Investiga y abre un ticket si corresponde." It calls all five tools in order and reports the ticket
number.

## Deploying the server

The repository contains a Dockerfile and a Render blueprint. Create a Web Service on Render pointed
at this repository, wait for the build, then check it:

    curl https://your-service.onrender.com/health

Put the URL in `.env` as `NOC_REMOTE_URL=https://your-service.onrender.com/mcp`, enable `noc-remote`
in `config/servers.json`, and verify with `npm run probe -- noc-remote`.

The free tier sleeps when idle, so the first request after a pause takes around 50 seconds.

## Packet captures

Plaintext capture on loopback:

    powershell -ExecutionPolicy Bypass -File scripts/capture-loopback.ps1

Encrypted capture against the deployment, with TLS keys exported so Wireshark can decrypt it:

    powershell -ExecutionPolicy Bypass -File scripts/capture-remote.ps1

Both write to `docs/captures/`. For the encrypted one, point Wireshark at the key log under
Preferences, Protocols, TLS, (Pre)-Master-Secret log filename.

## Project structure

    src/mcp/         the protocol: types, framing, transports, client, interaction log
    src/server/      the custom NOC server and its two entry points
    src/host/        the host: server config, tool routing, conversation, LLM adapter
    src/cli/         terminal chatbot and the probe and demo runners
    src/api/         HTTP bridge for the web UI
    web/             React chatbot
    docs/            server specification, protocol analysis, conclusions, captures
    config/          which MCP servers to connect to

## Documentation

    docs/server-spec.md          specification, parameters and endpoints of the custom server
    docs/wireshark-analysis.md   packet capture analysis, layer by layer
    docs/conclusions.md          conclusions, difficulties and lessons learned

## Notes

The `git_init` tool does not exist in the official Git MCP server (version 1.29.0), so
`npm run setup:demo` creates the demonstration repository. Everything after that, creating the
README, staging it and committing, is done by the chatbot through MCP.

The ban on SDKs applies to MCP implementations only. The `openai` package is used as a plain HTTP
client for OpenRouter's API; every MCP byte in this project is produced by code in `src/mcp/` and
`src/server/`.
