import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentConnectionIndicator } from './connectionIndicator.js';

function element() {
  return {
    hidden: false,
    dataset: {},
    attributes: {},
    textContent: '',
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

test('stays hidden until enabled and renders browser client states', () => {
  const node = element();
  const indicator = createAgentConnectionIndicator({ element: node });
  indicator.update({ type: 'open' });
  assert.equal(node.hidden, true);
  indicator.setEnabled(true);
  assert.equal(node.hidden, false);
  assert.equal(node.textContent, 'AGENT CONNECTED');
  assert.equal(node.dataset.tone, 'connected');
  indicator.update({ type: 'reconnecting', attempt: 2 });
  assert.equal(node.textContent, 'AGENT RECONNECTING');
  assert.equal(node.dataset.attempt, '2');
});

test('ignores unknown states and cleans up accessibly', () => {
  const node = element();
  const indicator = createAgentConnectionIndicator({ element: node, enabled: true });
  indicator.update({ type: 'unknown' });
  assert.equal(node.textContent, '');
  indicator.update({ type: 'closed' });
  indicator.destroy();
  assert.equal(node.hidden, true);
  assert.equal(node.attributes['aria-hidden'], 'true');
  assert.equal(node.textContent, '');
});
