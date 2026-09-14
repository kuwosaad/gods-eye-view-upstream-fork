#!/usr/bin/env node
import { runStdioMcpServer } from '../server/mcp/stdio.js';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const instance = await runStdioMcpServer({
  url: option('--url'),
  token: process.env.GEV_AGENT_TOKEN,
});

const shutdown = () => instance.close().catch(() => {});
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
