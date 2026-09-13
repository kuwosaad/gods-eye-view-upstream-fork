/**
 * Compatibility adapter for the OpenAI Realtime transport.
 *
 * The canonical schemas live in src/agent/toolCatalog.js so MCP, Realtime,
 * and future transports share the exact same tool objects.
 */
import { GEV_AGENT_TOOL_CATALOG } from '../../../src/agent/toolCatalog.js';

const GEV_REALTIME_TOOLS = GEV_AGENT_TOOL_CATALOG;

export { GEV_REALTIME_TOOLS };
