#!/usr/bin/env node
/**
 * Deterministic end-to-end probe for the single God’s Eye View MCP endpoint.
 *
 * The probe deliberately uses only local MCP and bridge traffic. It does not
 * call a live data provider and does not require a provider key.
 *
 * Usage:
 *   GEV_AGENT_TOKEN=secret node scripts/qa-mcp.mjs --url http://localhost:4173
 *   GEV_AGENT_TOKEN=secret node scripts/qa-mcp.mjs --start --port 4173
 *
 * `--start` owns a Vite process for the duration of the probe. Without it,
 * the script assumes the supplied URL is already serving the app.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let failures = 0;
function output(label, ok, detail = '') {
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

function parseRpcResponse(text) {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .at(-1);
  return JSON.parse(data || text);
}

function resultValue(response) {
  const value = response?.result?.structuredContent;
  if (value !== undefined) return value;
  const text = response?.result?.content?.find(
    (item) => item.type === 'text',
  )?.text;
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
}

function stateVersion(value) {
  return Number(value?.stateVersion ?? value?.state?.stateVersion ?? NaN);
}

function imageValue(value) {
  if (value?.type === 'image') return value;
  return Array.isArray(value?.content)
    ? value.content.find((item) => item.type === 'image')
    : undefined;
}

export class McpHttpClient {
  constructor(endpoint, token) {
    this.endpoint = new URL('/mcp', endpoint).toString();
    this.token = token;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(method, params = {}, { signal } = {}) {
    const headers = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method,
        params,
      }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`MCP ${response.status}: ${text.slice(0, 300)}`);
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    return parseRpcResponse(text);
  }

  async initialize() {
    return this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'qa-mcp', version: '1' },
    });
  }

  async initialized() {
    const headers = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': this.sessionId,
    };
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }),
    });
    if (!response.ok && response.status !== 202)
      throw new Error(`MCP initialized ${response.status}`);
  }

  async listTools() {
    return this.request('tools/list');
  }

  async callTool(name, arguments_ = {}, options = {}) {
    return this.request('tools/call', { name, arguments: arguments_ }, options);
  }

  async joinSession(sessionId) {
    return this.callTool('gev_join_session', { sessionId });
  }
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${url}${lastError ? ` (${lastError.message})` : ''}`,
  );
}

async function startServer(port, token) {
  const viteMode = hasFlag('--preview') ? 'preview' : null;
  const child = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      ...(viteMode ? [viteMode] : []),
      '--host',
      'localhost',
      '--port',
      String(port),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, GEV_AGENT_TOKEN: token, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (data) => process.stdout.write(`[vite] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[vite] ${data}`));
  const stop = () => child.kill('SIGTERM');
  await waitForServer(`http://localhost:${port}/`);
  return { child, stop, url: `http://localhost:${port}` };
}

async function run() {
  const token = process.env.GEV_AGENT_TOKEN || option('--token');
  if (!token) throw new Error('GEV_AGENT_TOKEN (or --token) is required');
  const port = Number(option('--port', '4173'));
  const owned = hasFlag('--start') ? await startServer(port, token) : null;
  const appUrl = owned?.url || option('--url', `http://localhost:${port}`);
  let browser;
  try {
    await waitForServer(`${appUrl}/`);
    const mcp = new McpHttpClient(appUrl, token);
    const init = await mcp.initialize();
    output(
      'MCP initialize',
      init.result?.serverInfo?.name === 'gods-eye-view',
      init.result?.serverInfo?.name || 'unexpected server',
    );
    await mcp.initialized();
    const listed = await mcp.listTools();
    const names = new Set(listed.result?.tools?.map((tool) => tool.name));
    const expectedTools = [
      'gev_list_sessions',
      'gev_join_session',
      'gev_share_session',
      'gev_acquire_lease',
      'gev_release_lease',
      'gev_whoami',
      'gev_get_state',
      'fly_to_location',
      'set_layer_visibility',
      'annotate_map',
      'control_scene',
      'gev_capture_view',
      'gev_satellite_ortho',
      'gev_streetview_panorama',
      'gev_streetview_headings',
      'gev_pano_pinhole',
      'gev_cesium_render',
    ];
    const missingTools = expectedTools.filter((name) => !names.has(name));
    output(
      'MCP tool catalog',
      missingTools.length === 0,
      `${names.size} tools${missingTools.length ? `; missing ${missingTools.join(', ')}` : ''}`,
    );

    browser = await puppeteer.launch({
      headless: !hasFlag('--headful'),
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        (await puppeteer.executablePath().catch(() => undefined)),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    page.on('pageerror', (error) =>
      console.error(`[browser] ${error.message}`),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        console.error(`[browser:${message.type()}] ${message.text()}`);
    });
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(() => document.readyState === 'complete', {
        timeout: 15_000,
      })
      .catch(() => {});
    const sessionDeadline = Date.now() + 20_000;
    let hasDefault = false;
    let lastSessions;
    while (!hasDefault && Date.now() < sessionDeadline) {
      const sessions = await mcp.callTool('gev_list_sessions');
      lastSessions = sessions;
      const sessionList =
        sessions.result?.structuredContent ||
        sessions.result?.content?.[0]?.text;
      hasDefault = JSON.stringify(sessionList || '').includes('default');
      if (!hasDefault) await sleep(250);
    }
    output(
      'Browser default session',
      hasDefault,
      hasDefault ? 'connected' : 'browser agent bridge is not connected',
    );
    if (!hasDefault) {
      const startup = await page.evaluate(async () => {
        const { application } = await import('/src/main.js');
        return {
          application: application.getState(),
          loader: document.querySelector('#loading-screen .loader-status')
            ?.textContent,
          agentEnabled: Boolean(window.__godsEyeView?.agent),
          agentEndpoint: window.__godsEyeView?.agent?.endpoint,
          socketState: window.__godsEyeView?.agent?.socket?.readyState,
        };
      });
      console.log(
        `  Browser-dependent checks skipped: ${JSON.stringify({ startup, lastSessions })}`,
      );
      return 2;
    }
    const joined = await mcp.joinSession('default');
    output(
      'claim default session',
      !joined.result?.isError && !joined.error,
      joined.error?.message || 'MCP client joined the browser session',
    );
    if (joined.result?.isError || joined.error) return 1;
    const before = resultValue(
      await mcp.callTool('gev_get_state', { sessionId: 'default' }),
    );
    output('get state', before !== undefined, 'initial state returned');
    const moved = await mcp.callTool('fly_to_location', {
      locationId: 'austin',
      waitForArrival: false,
      sessionId: 'default',
    });
    output(
      'camera action',
      !moved.result?.isError && !moved.error,
      moved.error?.message || 'fly dispatched',
    );
    const layer = await mcp.callTool('set_layer_visibility', {
      layerId: 'earthquakes',
      enabled: false,
      sessionId: 'default',
    });
    output(
      'layer action',
      !layer.result?.isError && !layer.error,
      layer.error?.message || 'layer dispatched',
    );
    const after = resultValue(
      await mcp.callTool('gev_get_state', { sessionId: 'default' }),
    );
    output(
      'observe → act → observe',
      stateVersion(after) > stateVersion(before),
      `stateVersion ${stateVersion(before)} → ${stateVersion(after)}`,
    );
    const annotation = await mcp.callTool('annotate_map', {
      annotations: [
        {
          type: 'pin',
          latitude: 30.2672,
          longitude: -97.7431,
          label: 'MCP QA',
        },
      ],
      persist: true,
      sessionId: 'default',
    });
    output(
      'annotation action',
      !annotation.result?.isError && !annotation.error,
      annotation.error?.message || 'annotation dispatched',
    );
    const cleared = await mcp.callTool('clear_annotations', {
      sessionId: 'default',
    });
    output(
      'annotation cleanup',
      !cleared.result?.isError && !cleared.error,
      cleared.error?.message || 'annotations cleared',
    );
    const scene = await mcp.callTool('control_scene', {
      action: 'status',
      sessionId: 'default',
    });
    output(
      'scene control',
      !scene.result?.isError && !scene.error,
      scene.error?.message || 'scene status returned',
    );
    const capture = await mcp.callTool('gev_capture_view', {
      sessionId: 'default',
    });
    const image = imageValue(capture.result);
    const captureMetadata = resultValue(capture);
    const captureDiagnostics = image
      ? null
      : await page.evaluate(() => {
          const canvas = document.querySelector(
            '#cesiumContainer .cesium-widget canvas',
          );
          if (!canvas) return { canvas: false };
          try {
            const target = document.createElement('canvas');
            target.width = Math.min(640, canvas.width);
            target.height = Math.min(480, canvas.height);
            target
              .getContext('2d')
              ?.drawImage(canvas, 0, 0, target.width, target.height);
            return {
              canvas: true,
              width: canvas.width,
              height: canvas.height,
              encodedLength: target.toDataURL('image/jpeg', 0.6).length,
            };
          } catch (error) {
            return {
              canvas: true,
              width: canvas.width,
              height: canvas.height,
              error: error.message,
            };
          }
        });
    output(
      'capture image',
      Boolean(
        image?.data &&
        /^image\/(png|jpeg)$/.test(image.mimeType) &&
        captureMetadata?.width > 0 &&
        captureMetadata?.height > 0,
      ),
      image
        ? `${image.mimeType} ${captureMetadata?.width}×${captureMetadata?.height}`
        : `image content missing: ${JSON.stringify({ capture, captureDiagnostics }).slice(0, 800)}`,
    );

    const second = await browser.newPage();
    await second.goto(`${appUrl}?agentSession=qa-second`, {
      waitUntil: 'domcontentloaded',
    });
    await second
      .waitForFunction(() => document.readyState === 'complete', {
        timeout: 15_000,
      })
      .catch(() => {});
    const secondMcp = new McpHttpClient(appUrl, token);
    await secondMcp.initialize();
    await secondMcp.initialized();
    const secondIdentity = resultValue(
      await secondMcp.callTool('gev_whoami'),
    );
    const secondPrincipal = secondIdentity?.principalId;
    output(
      'second MCP client identity',
      typeof secondPrincipal === 'string' && secondPrincipal.length > 0,
      secondPrincipal || 'principal missing',
    );
    const secondJoined = await secondMcp.joinSession('qa-second');
    output(
      'claim second session',
      !secondJoined.result?.isError && !secondJoined.error,
      secondJoined.error?.message || 'second MCP client joined its browser session',
    );
    const listedSessions = resultValue(await mcp.callTool('gev_list_sessions'));
    const secondListedSessions = resultValue(
      await secondMcp.callTool('gev_list_sessions'),
    );
    const sessionText = JSON.stringify({ listedSessions, secondListedSessions });
    output(
      'two named browser sessions',
      JSON.stringify(listedSessions || '').includes('default') &&
        JSON.stringify(secondListedSessions || '').includes('qa-second'),
      sessionText,
    );
    const isolated = await mcp.callTool('gev_get_state', {
      sessionId: 'qa-second',
    });
    output(
      'session isolation',
      isolated.result?.isError === true || isolated.error,
      isolated.error?.message || resultValue(isolated)?.error || 'unjoined session was accessible',
    );
    const secondState = await secondMcp.callTool('gev_get_state', {
      sessionId: 'qa-second',
    });
    output(
      'second session access',
      !secondState.result?.isError && !secondState.error,
      secondState.error?.message || 'second MCP client reads its joined session',
    );
    const sharedBefore = await secondMcp.callTool('gev_get_state', {
      sessionId: 'default',
    });
    output(
      'private session access',
      sharedBefore.result?.isError === true || sharedBefore.error,
      resultValue(sharedBefore)?.error ||
        `unshared session was accessible: ${JSON.stringify(sharedBefore).slice(0, 500)}`,
    );
    const shared = await mcp.callTool('gev_share_session', {
      sessionId: 'default',
      invitedPrincipalId: secondPrincipal,
    });
    output(
      'share session',
      !shared.result?.isError && !shared.error,
      shared.error?.message || 'session shared with second MCP client',
    );
    const sharedJoin = await secondMcp.joinSession('default');
    output(
      'join shared session',
      !sharedJoin.result?.isError && !sharedJoin.error,
      sharedJoin.error?.message || 'second MCP client joined shared session',
    );
    const lease = await mcp.callTool('gev_acquire_lease', {
      sessionId: 'default',
      ttlMs: 5_000,
    });
    output(
      'acquire session lease',
      !lease.result?.isError && !lease.error,
      lease.error?.message || 'lease acquired',
    );
    const leased = await secondMcp.callTool('set_layer_visibility', {
      layerId: 'earthquakes',
      enabled: true,
      sessionId: 'default',
    });
    output(
      'lease isolation',
      leased.result?.isError === true || leased.error,
      resultValue(leased)?.error || 'second MCP client mutated leased session',
    );
    const released = await mcp.callTool('gev_release_lease', {
      sessionId: 'default',
    });
    output(
      'release session lease',
      !released.result?.isError && !released.error,
      released.error?.message || 'lease released',
    );
    const ordered = await Promise.all([
      mcp.callTool('set_layer_visibility', {
        layerId: 'earthquakes',
        enabled: true,
        sessionId: 'default',
      }),
      mcp.callTool('set_layer_visibility', {
        layerId: 'earthquakes',
        enabled: false,
        sessionId: 'default',
      }),
    ]);
    output(
      'same-session ordering',
      ordered.every((item) => !item.result?.isError && !item.error),
      'two mutations completed',
    );

    const badAuth = await fetch(mcp.endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    output('bad auth', badAuth.status === 401, `HTTP ${badAuth.status}`);
    const oversized = await fetch(mcp.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/list',
        params: {},
        padding: 'x'.repeat(1024 * 1024 + 1),
      }),
    });
    output(
      'bounded request failure',
      oversized.status === 413,
      `HTTP ${oversized.status}`,
    );

    const controller = new AbortController();
    const pending = mcp.callTool(
      'fly_to_location',
      { locationId: 'tokyo', waitForArrival: true, sessionId: 'default' },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 25);
    await pending
      .then(() =>
        output('cancellation', false, 'request unexpectedly completed'),
      )
      .catch((error) =>
        output('cancellation', error.name === 'AbortError', error.name),
    );
    await second.close();
    const disconnectPending = mcp.callTool(
      'fly_to_location',
      { locationId: 'london', waitForArrival: true, sessionId: 'default' },
    );
    await sleep(50);
    await page.close();
    const disconnectResult = await Promise.race([
      disconnectPending,
      sleep(5_000).then(() => ({ timeout: true })),
    ]);
    const disconnectValue = resultValue(disconnectResult);
    output(
      'disconnect during action',
      (disconnectResult?.result?.isError === true &&
        ['SESSION_CLOSED', 'SESSION_NOT_FOUND', 'DISCONNECTED'].includes(
          disconnectValue?.code,
        )) ||
        disconnectValue?.data?.cancelled === true,
      disconnectResult?.timeout
        ? 'timed out'
        : disconnectValue?.code ||
          `request unexpectedly completed: ${JSON.stringify(disconnectValue).slice(0, 500)}`,
    );
    await browser.close();
    browser = null;
    output('disconnect cleanup', true, 'browser closed cleanly');
    return failures ? 1 : 0;
  } finally {
    await browser?.close().catch(() => {});
    owned?.stop();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
    .then((code = 0) => (process.exitCode = code))
    .catch((error) => {
      console.error(`qa-mcp: ${error.message}`);
      process.exitCode = 1;
    });
}
