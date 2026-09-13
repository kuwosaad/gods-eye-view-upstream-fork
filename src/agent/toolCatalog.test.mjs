import assert from 'node:assert/strict';
import test from 'node:test';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import {
  GEV_AGENT_TOOL_CATALOG,
  GEV_AGENT_TOOL_METADATA,
  getAgentToolMetadata,
  isAgentToolReadOnly,
} from './toolCatalog.js';

test('agent transports share the existing canonical tool catalog', () => {
  assert.strictEqual(GEV_AGENT_TOOL_CATALOG, GEV_REALTIME_TOOLS);
  assert.equal(GEV_AGENT_TOOL_CATALOG.length, 28);
  assert.equal(
    new Set(GEV_AGENT_TOOL_CATALOG.map((tool) => tool.name)).size,
    GEV_AGENT_TOOL_CATALOG.length,
  );
});

test('every canonical tool has separate capability and cost metadata', () => {
  assert.equal(Object.keys(GEV_AGENT_TOOL_METADATA).length, 28);
  for (const tool of GEV_AGENT_TOOL_CATALOG) {
    const metadata = getAgentToolMetadata(tool.name);
    assert.ok(metadata, tool.name + ' is classified');
    assert.equal(typeof metadata.readOnly, 'boolean');
    assert.match(metadata.capability, /^[a-z-]+$/);
    assert.match(metadata.costClass, /^(free|network|artifact|expensive)$/);
  }
  assert.equal(isAgentToolReadOnly('get_current_view_state'), true);
  assert.equal(isAgentToolReadOnly('analyst_query'), true);
  assert.equal(isAgentToolReadOnly('set_layer_visibility'), false);
  assert.equal(isAgentToolReadOnly('unknown_tool'), false);
});

test('metadata cannot mutate the canonical policy index', () => {
  assert.throws(() => {
    GEV_AGENT_TOOL_METADATA.fly_to_location.costClass = 'cheap';
  }, TypeError);
  assert.equal(getAgentToolMetadata('fly_to_location').costClass, 'network');
});
