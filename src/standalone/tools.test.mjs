import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./tools.js', import.meta.url), 'utf8');

test('standalone agent bootstrap exposes and tears down the MCP connection indicator', () => {
  const agentBlock = source.slice(
    source.indexOf(
      'if (import.meta.env.GEV_AGENT_ENABLED && import.meta.env.GEV_AGENT_TOKEN)',
    ),
  );
  assert.match(agentBlock, /createAgentConnectionIndicator/);
  assert.match(agentBlock, /enabled: true/);
  assert.ok(
    agentBlock.includes(
      'onStateChange: (state) => connectionIndicator?.update(state)',
    ),
  );
  assert.ok(agentBlock.includes('defer(() => connectionIndicator?.destroy())'));
});

test('invalid agentSession query values fall back without aborting application bootstrap', () => {
  assert.match(source, /typeof querySession === 'string'/);
  assert.match(source, /AGENT_SESSION_RE\.test\(querySession\)/);
  assert.match(source, /\? querySession\s*:\s*'default'/);
});
