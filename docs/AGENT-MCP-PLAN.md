# God's Eye View MCP plan

## Goal

Run one local God's Eye View MCP service that any compatible agent can use to
observe and control one or more live globe sessions. The UI, voice agent, and
MCP must call the same action contracts so their behavior cannot drift.

```text
Agents -> /mcp -> session registry -> browser bridge -> live GEV browser
                         |                                  |
                         +-> bounded artifact tools         +-> Cesium, layers,
                                                             scenes, annotations
```

## Architectural decisions

- One MCP endpoint and one unified tool catalog.
- Streamable HTTP is the primary multi-agent transport. The stdio launcher
  forwards to the same service for clients that only support local stdio.
- One browser connection represents one named GEV session.
- The existing `createGevActionRunner()` remains the canonical mutation path.
- Voice and MCP derive schemas from the same portable catalog.
- Mutations are serialized per globe session. Independent sessions can run in
  parallel. Read-only calls may run concurrently when they can return a coherent
  state version.
- Provider credentials never enter MCP results or browser bridge messages.
- HTTP and WebSocket control surfaces bind to loopback and require a separate
  randomly generated bearer token.

### Contract rules

Every MCP call has a bounded argument object, a selected session (explicit when
more than one is connected), a timeout, and a public error code. The browser
wire message is version 1 and accepts only the bounded message types implemented
by `server/agent-bridge/protocol.js`. A successful result is returned as MCP
text plus structured JSON. Session mutations increment a monotonically
increasing `stateVersion` after completion; reads report the observed version
when available. The target result shape is `{ tool, sessionId, stateVersion,
data, warnings, artifacts }`.

Stable errors are deliberately small and safe to expose:
`INVALID_REQUEST`, `TOOL_NOT_FOUND`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`,
`DISCONNECTED`, `REQUEST_TIMEOUT`, `ABORTED`, `QUEUE_FULL`, `LEASED`,
`PROVIDER_FAILURE`, and `ACCESS_DENIED`. Unknown upstream failures collapse
to a generic public error; credentials, cookies, raw upstream payloads, and
filesystem paths never belong in an MCP result.

Each catalog entry must identify its capability class: read-only, mutating,
cost-bearing, destructive, or developer-only. Read-only calls can share a
session concurrently when their snapshot is coherent. Mutations are FIFO per
session. Cost-bearing calls need quotas, and destructive calls need an explicit
owner-authorized request before release. Developer-only calls are excluded from ordinary
agent access.

## Phase 0: contract and threat model

- [x] Map the application lifecycle, voice tools, provider server, QA harnesses,
      capture utilities, and package boundaries.
- [x] Choose a single-server architecture and named browser sessions.
- [x] Choose Streamable HTTP as the primary MCP transport.
- [x] Define tool groups: observations, globe, layers, entities, annotations,
      scenes, media, diagnostics, and session management.
- [x] Define the first vertical slice and its acceptance criteria.
- [x] Define the stable result envelope with `tool`, `sessionId`, `stateVersion`,
      `data`, `warnings`, and `artifacts`.
- [x] Define stable error codes for invalid arguments, unknown session,
      disconnected browser, timeout, cancellation, conflict, provider failure, and
      permission denial.
- [x] Document capability classes and which tools are read-only, mutating,
      cost-bearing, destructive, or developer-only.

Acceptance: every request and result has an owner, session, timeout, size bound,
and clearly defined failure behavior before network integration is enabled.

## Phase 1: shared tool and command foundations

- [x] Add a portable agent catalog facade for the existing 28 Realtime tools.
- [x] Add a parity test proving the agent and voice catalogs have identical tool
      identity, names, and schemas.
- [x] Make the portable catalog the true schema owner; retain the OpenAI module
      as an adapter for compatibility.
- [x] Add MCP naming and schema adapters without duplicating definitions.
- [x] Implement a transport-independent browser dispatcher.
- [x] Validate request envelopes and reject unknown tools before dispatch.
- [x] Add structured, sanitized results and errors.
- [x] Support request cancellation and deterministic destruction.
- [x] Implement a server-side named-session registry and request correlation.
- [x] Serialize mutations per session.
- [x] Bound mutation queue depth in addition to the existing execution timeout.

Acceptance: fake transports can execute and cancel commands, correlate concurrent
requests, reject malformed input, and isolate two sessions without Cesium,
network access, provider keys, or an MCP SDK.

## Phase 2: browser connection

- [x] Add an isolated Vite WebSocket plugin for browser session registration.
- [x] Define bounded versioned messages: `hello` with capabilities, `command`,
      `cancel`, `response`, `error`, `event`, `ping`, and `pong`.
- [x] Require loopback peer, exact local Host and Origin, and bearer-token auth.
- [x] Reject forwarding headers and oversized or malformed frames.
- [x] Add heartbeat, last-seen tracking, reconnect replacement, and cleanup.
- [x] Instantiate the browser bridge from `src/standalone/tools.js` after the
      viewer, style manager, data manager, scene director, and annotations exist.
- [x] Register cleanup through the existing application `defer()` lifecycle.
- [x] Expose a visible local indicator when agent control is connected.

Acceptance: opening GEV registers exactly one browser session; closing or
reloading it cancels pending calls and updates session health without leaking
listeners or promises.

## Phase 3: one MCP service and first useful tools

- [x] Pin the production MCP SDK and schema dependency after compatibility and
  security review.
- [x] Implement the authenticated Streamable HTTP `/mcp` endpoint as an isolated
  Vite provider with body, host, peer, origin, and forwarding-header guards.
- [x] Mount that provider at `/mcp` in the existing
  local server lifecycle.
- [x] Create a fresh MCP server/transport context per client as required by the
  SDK; never share response-routing state between clients.
- [x] Expose session discovery and selection.
- [x] Implement the first vertical-slice tools:
  - [x] `gev_list_sessions`
  - [x] `gev_get_state`
  - [x] `fly_to_location`
  - [x] `set_layer_visibility`
  - [x] `set_visual_style`
  - [x] `track_entity`
  - [x] `stop_tracking`
  - [x] `annotate_map`
  - [x] `control_scene`
  - [x] `gev_capture_view`
- [x] Return concise text and structured content for every tool.
- [x] Return final observed state after mutations instead of assuming success.

Development setup is `GEV_AGENT_TOKEN=<token> npm run dev`, with the client
connecting to `http://localhost:4173/mcp`. The same integration is attached to
Vite preview, and `npm run mcp:stdio` provides a stdio proxy to this service.
The same runtime, catalog, permissions, resources, quotas, artifacts, and
derived-imagery tools are used in development and preview.

Acceptance: an MCP client can connect, discover a browser, inspect its state,
move the real camera, toggle a deterministic layer, annotate the globe, observe
the resulting state, and capture a non-empty image.

The acceptance checklist is: initialize one Streamable HTTP client; discover
one named browser; read bounded state; perform one camera mutation, one layer
mutation, one annotation or scene mutation; read state again and verify the
changed state version; cancel an in-flight call; disconnect the browser and
observe a deterministic session error; and confirm no secret appears in any
result.

## Phase 4: complete existing interactive capabilities

- [x] Adapt all remaining existing voice actions into the unified MCP catalog.
- [x] Add map-stack, HUD, detection, post-processing, cockpit, CCTV, radio,
      context-mode, route, entity-query, ISS-pass, and annotation-clear tools.
- [x] Add read-only MCP resources:
  - [x] `gev://sessions/{id}/state`
  - [x] `gev://sessions/{id}/layers`
  - [x] `gev://sessions/{id}/entities`
  - [x] `gev://sessions/{id}/annotations`
  - [x] `gev://sessions/{id}/artifacts/{artifactId}`
- [x] Add change events or subscriptions with monotonically increasing state
      versions.
- [x] Preserve partial-success and stale-data signals from existing actions.

Acceptance: MCP and voice calls with the same tool and arguments produce the
same application transition and equivalent structured outcome.

## Phase 5: screenshots and bounded artifact tools

- [x] Create per-session artifact directories with IDs and retention policy.
- [x] Include camera, active layers, dimensions, timestamp, provider status, and
      tile-settled state with every screenshot.
- [x] Wrap satellite ortho, Street View panorama/headings, pinhole projection,
      and headless Cesium rendering as explicit MCP tools.
- [x] Spawn only fixed scripts with argument arrays; expose no shell command,
      arbitrary URL, arbitrary input path, or arbitrary output directory.
- [x] Constrain paths, symlinks, dimensions, zoom, tile count, file size,
      concurrency, runtime, and disk retention.
- [x] Return MCP image content or resource links backed by registered artifacts.

Acceptance: an agent can observe the live globe and request derived imagery
without gaining general filesystem, process, or network access.

## Phase 6: multi-agent coordination

- [x] Give every MCP caller an authenticated principal and deterministic omitted-session selection.
- [x] Add explicit create, join, share, list, and close session operations.
- [x] Enforce session ACLs and prevent cross-session state/artifact leakage.
- [x] Add per-session FIFO mutation queues and global concurrency budgets.
- [x] Add navigation supersession and explicit cancellation semantics.
- [x] Add optional write leases for several agents sharing one globe.
- [x] Add per-principal quotas for cost-bearing provider operations.

Session semantics: a browser chooses its name at connection time; reconnecting
with the same name replaces the old connection and rejects its pending calls.
An omitted session ID resolves only when exactly one browser is connected. With
zero browsers it returns `SESSION_NOT_FOUND`; with multiple browsers it returns
`SESSION_REQUIRED`. Separate sessions have independent cameras, layers,
annotations, queues, and state versions. Sharing one session requires an ACL
and optional write lease before release.

Acceptance: two agents can operate isolated globes concurrently, or collaborate
on one shared globe with deterministic command ordering and attributable state
changes.

## Phase 7: security and operations

- [x] Generate a dedicated MCP bearer token at launch, with an owner-only runtime
      file or explicit environment override.
- [x] Compare credentials in constant time and redact them everywhere.
- [x] Preserve loopback-only defaults, Host validation, strict WebSocket Origin
      policy, HTTP Origin validation when supplied, restrictive CORS, and
      DNS-rebinding protection.
- [x] Keep credential editing, arbitrary filesystem access, raw URL fetching,
      debug-log writes, and arbitrary process execution outside the tool catalog.
- [x] Add bounded audit records: principal, session, tool, safe argument summary,
      outcome, duration, stable error code, and cost class.
- [x] Add rate, byte, execution-time, and artifact quotas.
- [x] Keep remote/LAN operation disabled until a separate authenticated TLS
      deployment mode and visible remote-control indicator exist.

Acceptance: provider keys, bearer tokens, cookies, raw image data, and sensitive
upstream payloads cannot appear in bridge messages, MCP errors, or durable logs.

## Phase 8: verification and release

- [x] Add unit tests for schemas, envelopes, session ownership, queues,
      cancellation, timeouts, reconnects, auth, origin/host policy, redaction, and
      artifact bounds.
- [x] Add in-process MCP tests using a fake browser connection.
- [x] Add `scripts/qa-mcp.mjs` for a deterministic real-browser mission.
- [x] Verify two-client isolation and same-session ordering.
- [x] Verify browser disconnect during camera flight and artifact generation.
- [x] Add MCP groups to package-boundary declarations.
- [x] Add setup, client configuration, and troubleshooting documentation.
- [x] Run formatting, unit tests, tracking regression, package boundaries, build,
      and focused browser QA.

Release gate: an agent must complete a grounded loop—observe, act, observe again,
and explain only the state and artifacts the running globe confirms.

## Original delivery boundary

The first reviewable delivery ends after Phase 3. It proves the architecture with
one authenticated MCP endpoint, one connected browser session, observation,
camera movement, layer control, annotation, scene control, and screenshot capture.
Standalone imagery, full multi-agent permissions, and remote deployment follow
only after that core loop is stable.

### Implementation status (September 2026)

All phases are implemented in the single local runtime. The shared 28-action
catalog, five bounded imagery tools, observation resources, artifact store,
session ACLs and leases, quotas, audit trail, browser bridge, Streamable HTTP,
and stdio proxy are wired into the standalone application. The release mission
passes against both Vite development and built preview servers with two MCP
principals, observed state versions, viewport capture, cancellation, and
disconnect cleanup.
