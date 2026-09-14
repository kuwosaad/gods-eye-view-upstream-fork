import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

function localMcpUrl(value) {
  const url = new URL(value || 'http://127.0.0.1:4173/mcp');
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new TypeError('stdio MCP URL must target localhost');
  if (url.pathname !== '/mcp') throw new TypeError('stdio MCP URL must use /mcp');
  return url;
}
function schemaValue(spec = {}) {
  let value = spec.enum?.length === 1 ? z.literal(spec.enum[0]) : spec.enum?.length ? z.union(spec.enum.map((item) => z.literal(item))) : spec.type === 'string' ? z.string() : spec.type === 'number' || spec.type === 'integer' ? z.number() : spec.type === 'boolean' ? z.boolean() : spec.type === 'array' ? z.array(schemaValue(spec.items)) : z.object(schemaShape(spec));
  if (spec.type === 'integer') value = value.int();
  if (spec.minLength !== undefined) value = value.min(spec.minLength);
  if (spec.maxLength !== undefined) value = value.max(spec.maxLength);
  return value;
}
function schemaShape(schema = {}) {
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(schema.properties || {}).map(([name, spec]) => [name, required.has(name) ? schemaValue(spec) : schemaValue(spec).optional()]));
}

/** Create a stdio MCP proxy for the existing authenticated local HTTP MCP service. */
export function createStdioMcpServer({ token = process.env.GEV_AGENT_TOKEN, url, fetch: fetchImpl = globalThis.fetch, clientInfo = { name: 'gev-stdio-proxy', version: '1' } } = {}) {
  if (!token) throw new TypeError('GEV_AGENT_TOKEN is required');
  const endpoint = localMcpUrl(url);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  const upstreamTransport = new StreamableHTTPClientTransport(endpoint, { fetch: fetchImpl, requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const upstream = new Client(clientInfo, { capabilities: {} });
  const server = new McpServer({ name: 'gods-eye-view-stdio', version: '0.1.1' });
  let registered = false;
  const connect = async () => {
    await upstream.connect(upstreamTransport);
    const listed = await upstream.listTools();
    for (const tool of listed.tools || []) {
      server.registerTool(tool.name, { description: tool.description || '', inputSchema: schemaShape(tool.inputSchema) }, (args, extra) => upstream.callTool({ name: tool.name, arguments: args || {} }, undefined, { signal: extra?.signal }));
    }
    const templates = await upstream.listResourceTemplates().catch(() => ({
      resourceTemplates: [],
    }));
    for (const [index, template] of (
      templates.resourceTemplates || []
    ).entries()) {
      server.registerResource(
        `upstream_template_${index}`,
        new ResourceTemplate(template.uriTemplate, { list: undefined }),
        {
          description: template.description || '',
          ...(template.mimeType ? { mimeType: template.mimeType } : {}),
        },
        (uri) => upstream.readResource({ uri: uri.href }),
      );
    }
    const staticResources = await upstream.listResources().catch(() => ({
      resources: [],
    }));
    for (const [index, resource] of (staticResources.resources || []).entries()) {
      server.registerResource(
        `upstream_resource_${index}`,
        resource.uri,
        {
          description: resource.description || '',
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        },
        () => upstream.readResource({ uri: resource.uri }),
      );
    }
    registered = true;
    return listed;
  };
  const close = async () => { await upstream.close().catch(() => {}); await server.close().catch(() => {}); };
  return { server, upstream, upstreamTransport, endpoint: endpoint.toString(), connect, close, get registered() { return registered; } };
}

export async function runStdioMcpServer(options = {}) {
  const instance = createStdioMcpServer(options);
  await instance.connect();
  const transport = new StdioServerTransport();
  await instance.server.connect(transport);
  return { ...instance, transport };
}
