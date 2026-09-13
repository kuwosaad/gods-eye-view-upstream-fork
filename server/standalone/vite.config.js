import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { createAgentBridge } from '../agent-bridge/bridge.js';
import { createMcpMiddleware, MCP_PATH } from '../providers/mcp.js';
import { createMcpRuntime } from '../mcp/runtime.js';
import { createImageryServerTools } from '../mcp/server-tools.js';
import { ensureRuntimeToken } from '../mcp/security.js';
import { apiNotFoundPlugin } from './api-not-found.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

function defaultAgentTokenFile() {
  const user = String(
    typeof process.getuid === 'function'
      ? process.getuid()
      : process.env.USER || 'user',
  ).replace(/[^A-Za-z0-9_-]/g, '_');
  return join(tmpdir(), `gods-eye-view-agent-${user}.token`);
}

/** Resolve explicit credentials first, then opt in to an owner-only runtime token. */
export function resolveAgentToken({
  env = process.env,
  tokenLoader = ensureRuntimeToken,
} = {}) {
  const explicit =
    typeof env.GEV_AGENT_TOKEN === 'string' ? env.GEV_AGENT_TOKEN : '';
  if (explicit) return { token: explicit, filePath: null, generated: false };
  if (String(env.GEV_AGENT_ENABLED || '').trim() !== '1')
    return { token: '', filePath: null, generated: false };
  const filePath = env.GEV_AGENT_TOKEN_FILE || defaultAgentTokenFile();
  const token = tokenLoader({ filePath });
  return { token, filePath, generated: true };
}

/**
 * Install the one agent control plane on either a Vite dev or preview server.
 * The optional hooks are reserved for the session/security/audit cores; the
 * default path deliberately stays dependency-light and localhost-only.
 */
export function createAgentIntegrationPlugin({
  token,
  bridgeOptions = {},
  mcpOptions = {},
  runtimeOptions = {},
  onSession,
  onAudit,
} = {}) {
  if (typeof token !== 'string' || token.length === 0) return null;
  let installedServer = null;
  let cleanupPromise = null;
  const install = (server) => {
    if (installedServer === server) return;
    if (installedServer)
      throw new Error('GEV agent integration already installed');
    installedServer = server;
    const bridge = createAgentBridge({ token, ...bridgeOptions });
    const detach = bridge.attach(server.httpServer);
    let middleware;
    const artifactRoot = join(
      tmpdir(),
      `gods-eye-view-artifacts-${
        typeof process.getuid === 'function' ? process.getuid() : 'user'
      }`,
    );
    const runtime = createMcpRuntime({
      bridge,
      artifactRoot,
      quota: {},
      browserUrl: '/',
      ...runtimeOptions,
      audit: (event) => onAudit?.(event),
      onResourceUpdated: (uri) => middleware?.notifyResourceUpdated(uri),
    });
    const configuredServerTools = Array.isArray(mcpOptions.serverTools)
      ? mcpOptions.serverTools
      : Object.entries(mcpOptions.serverTools || {}).map(([name, value]) => ({
          name,
          ...value,
        }));
    const imageryTools = createImageryServerTools({
      registry: runtime.registry,
      artifactStore: runtime.artifactStore,
      projectRoot: root,
      credentials: {
        googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      },
    });
    middleware = createMcpMiddleware({
      token,
      ...mcpOptions,
      dispatch: runtime.dispatch,
      listSessions: (options) => {
        const sessions = runtime.listSessions(options);
        onSession?.(sessions);
        return sessions;
      },
      getState: runtime.getState,
      resources: { ...runtime.resourceCallbacks, subscribe: true },
      sessionManagement: runtime.sessionManagement,
      serverTools: [...imageryTools, ...configuredServerTools],
    });
    server.middlewares.use(MCP_PATH, middleware);
    server.agentBridge = bridge;
    server.agentMcp = middleware;
    server.agentRuntime = runtime;
    const cleanup = async () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        detach();
        await middleware.close();
        await runtime.close();
        if (server.agentBridge === bridge) delete server.agentBridge;
        if (server.agentMcp === middleware) delete server.agentMcp;
        if (server.agentRuntime === runtime) delete server.agentRuntime;
      })();
      return cleanupPromise;
    };
    server.httpServer.once('close', cleanup);
  };
  return {
    name: 'gev-agent-integration',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const resolvedAgent = resolveAgentToken({ env: process.env });
  const agentToken = resolvedAgent.token;
  if (resolvedAgent.generated)
    console.info(
      `[GEV] Agent MCP runtime token file: ${resolvedAgent.filePath}`,
    );
  const agentPlugin = createAgentIntegrationPlugin({ token: agentToken });
  return createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins(),
      ...(agentPlugin ? [agentPlugin] : []),
      apiNotFoundPlugin(),
    ],
    agentToken: agentToken || undefined,
    agentEnabled: Boolean(agentToken),
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
  });
});
