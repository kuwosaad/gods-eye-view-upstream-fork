# God's Eye View MCP

God's Eye View is connected through one local MCP server. The server gives
compatible agents a single set of tools for observing and controlling the
live globe. Voice control and MCP use the same canonical catalog, so a command
has one meaning whichever interface sends it.

```text
MCP client -> http://localhost:4173/mcp -> browser bridge -> live GEV browser
```

## Current status

The local end-to-end slice works in Vite development and preview servers. One
MCP endpoint exposes session discovery, bounded state observation, viewport
capture, and all 28 existing voice actions. Calls travel through the
authenticated browser bridge and execute against the live Cesium application.
A real-browser QA mission verifies initialization, catalog discovery, state
reading, camera movement, layer control, cancellation, capture, and disconnect
cleanup. A stdio proxy is also available for clients that only support stdio.

The same endpoint also exposes observation resources, resource update
notifications, per-client principals, session ACLs and leases, a bounded audit
trail, per-cost-class quotas, retained artifacts, and five fixed derived-imagery
operations. Remote and LAN operation remain disabled.

## Contracts

MCP uses normal JSON-RPC and Streamable HTTP. The browser side uses the
versioned GEV wire protocol (`version: 1`) over `/__gev_agent`. A command is
bounded JSON with an `id`, `sessionId`, `name`, `args`, and optional `mutation`
flag. Responses carry the same `id` and either `result` or a bounded error.
Supported bridge message types are `gev:hello`, `gev:command`, `gev:cancel`,
`gev:response`, `gev:error`, `gev:event`, `gev:ping`, and `gev:pong`.

Successful MCP tool results contain text plus structured JSON. Session actions
use this stable envelope, and mutations include final observed state after the
version increments:

```json
{
  "tool": "set_layer_visibility",
  "sessionId": "default",
  "stateVersion": 4,
  "data": { "ok": true },
  "warnings": [],
  "artifacts": []
}
```

`npm run dev` and `npm run preview` can enable the same browser bridge and
`/mcp` integration. Set `GEV_AGENT_TOKEN` for an explicit token; alternatively
set `GEV_AGENT_ENABLED=1` to generate and store an owner-only runtime token.
`npm run mcp:stdio` provides a stdio proxy to this same local HTTP service and
catalog rather than a second tool implementation.

Preview embeds the bridge bootstrap at build time, so build and serve it with
the same token:

```bash
GEV_AGENT_TOKEN="choose-a-long-random-value" npm run build
GEV_AGENT_TOKEN="choose-a-long-random-value" npm run preview
```

Errors expose a short public message and stable code. The public code set
includes
`INVALID_REQUEST`, `TOOL_NOT_FOUND`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`,
`DISCONNECTED`, `REQUEST_TIMEOUT`, `ABORTED`, `QUEUE_FULL`, `LEASED`,
`PROVIDER_FAILURE`, and `ACCESS_DENIED`; sensitive upstream details stay
server-side.

## Capability classes

Every tool should declare one class before it is added to the public catalog:

| Class | Meaning | Examples |
| --- | --- | --- |
| Read-only | Observes state and may run concurrently | `gev_get_state`, entity context |
| Mutating | Changes one browser session and is FIFO queued | camera, layers, styles, annotations |
| Cost-bearing | May consume a provider quota or paid API | provider-backed imagery and feeds |
| Destructive | Removes or permanently changes user work and requires an explicit owner-authorized call | session closure |
| Developer-only | Runs diagnostics or QA and stays disabled for normal agents | test and benchmark tools |

Cost-bearing tools have separate per-principal quotas. Session deletion is
owner-only. The bridge also enforces queue, timeout, cancellation, frame-size,
and pending-request limits.

## Setup

Start GEV with a local bearer token:

```bash
GEV_AGENT_TOKEN="choose-a-long-random-value" npm run dev
```

The MCP endpoint is:

```text
http://localhost:4173/mcp
```

Clients must send `Authorization: Bearer <same-token>`. The browser bridge uses
the same token and registers a named session over `/__gev_agent`. The normal
browser registers as `default`. Add `?agentSession=research-agent` to the browser
URL to register a different name, then pass that name as `sessionId` in calls.
Call `gev_join_session` once to claim an unclaimed browser before reading or
changing it. Use `gev_create_session` to reserve a name and receive its browser
URL.

An MCP client configuration has this shape. Replace the token placeholder using
the syntax supported by that client:

```json
{
  "mcpServers": {
    "gods-eye-view": {
      "url": "http://localhost:4173/mcp",
      "headers": {
        "Authorization": "Bearer ${GEV_AGENT_TOKEN}"
      }
    }
  }
}
```

## Tool groups

The unified catalog currently contains the existing 28 voice actions. They are
organized by purpose rather than by separate servers:

- observation and entity context;
- camera navigation and tracking;
- data layers, panels, map stacks, HUD, and visual styles;
- cockpit, CCTV, radio, and context modes;
- annotations, routes, and scenes;
- provider and location operations.

Session discovery and state inspection are exposed as `gev_list_sessions` and
`gev_get_state`. Catalog actions accept an optional `sessionId` added by the
MCP adapter. `gev_capture_view` captures the live viewport with bounded image
content and metadata. Bounded standalone imagery is implemented as reusable
fixed-operation tools: `gev_satellite_ortho`, `gev_streetview_panorama`,
`gev_streetview_headings`, `gev_pano_pinhole`, and `gev_cesium_render`. These
return retained artifact resource links.

Read-only resource URIs are:

```text
gev://sessions/{id}/state
gev://sessions/{id}/layers
gev://sessions/{id}/entities
gev://sessions/{id}/annotations
gev://sessions/{id}/artifacts/{artifactId}
```

The server invalidates resource caches and sends update notifications after
mutations. Calling `gev_get_state` remains the direct way to retrieve the
complete bounded snapshot.

## Security limits

The initial service is deliberately local. The HTTP endpoint and browser bridge
require loopback peers and local Host/Origin values, reject forwarding headers,
and require the bearer token. Request bodies and WebSocket frames are size
bounded. Browser sessions replace an older connection with the same ID; bridge
requests have timeouts, cancellation, pending-request limits, and heartbeat
cleanup. Mutations are serialized per session.

Do not expose this service on a LAN or the public internet. Provider keys must
stay in the existing server-side provider boundary and must never be placed in
MCP arguments, results, or logs. Remote access needs a separately designed TLS,
authentication, authorization, quota, and audit layer.

## Troubleshooting

- **401 Unauthorized:** check that `GEV_AGENT_TOKEN` is set for the server and
  that the client sends the identical bearer token.
- **No sessions:** open the GEV browser from the same server and wait for the
  application to finish starting.
- **Unknown session:** call `gev_list_sessions`, then use the returned ID as
  `sessionId`.
- **MCP session not initialized:** use an MCP client that supports Streamable
  HTTP and lets the client perform the MCP initialize request.
- **Connection refused:** start the local Vite server and use its actual port;
  the documented default is 4173.
- **Preview has no browser session:** rebuild with `GEV_AGENT_TOKEN` (or
  `GEV_AGENT_ENABLED=1`) and start preview with the same runtime token.

See [AGENT-MCP-PLAN.md](AGENT-MCP-PLAN.md) for the completed phase gates and
release checks.

Run the deterministic local mission with a disposable token and test browser:

```bash
GEV_AGENT_TOKEN="test-only-token" \
node scripts/qa-mcp.mjs --start --port 4187
```
