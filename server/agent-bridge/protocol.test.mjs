import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GEV_PROTOCOL_VERSION,
  encodeMessage,
  parseMessage,
  protocolError,
  validateMessage,
} from './protocol.js';

test('accepts the existing command and response envelopes', () => {
  const command = { type: 'gev:command', id: 'c:1', name: 'get_state', args: {}, mutation: false };
  assert.deepEqual(parseMessage(encodeMessage(command)), command);
  const response = { type: 'gev:response', id: 'c:1', result: { ready: true } };
  assert.deepEqual(parseMessage(JSON.stringify(response)), response);
});

test('validates hello, cancel, event, and ping/pong envelopes', () => {
  for (const message of [
    { type: 'gev:hello', version: GEV_PROTOCOL_VERSION, sessionId: 'main', capabilities: ['camera'] },
    { type: 'gev:cancel', id: 'c:1' },
    { type: 'gev:event', sessionId: 'main', event: 'selection', payload: { id: 2 } },
    { type: 'gev:ping', id: 'p:1' },
    { type: 'gev:pong', id: 'p:1' },
  ]) assert.deepEqual(validateMessage(message), message);
});

test('returns stable errors for malformed, unknown-version, and oversized messages', () => {
  assert.throws(() => validateMessage({ type: 'gev:command', id: 'x', name: 'x', args: [] }), { code: 'INVALID_MESSAGE' });
  assert.throws(() => parseMessage(JSON.stringify({ type: 'gev:hello', version: 99, sessionId: 'x', capabilities: [] })), { code: 'PROTOCOL_VERSION_UNSUPPORTED' });
  assert.throws(() => parseMessage('x'.repeat(300_000)), { code: 'MESSAGE_TOO_LARGE' });
  assert.throws(() => validateMessage({ type: 'gev:error', code: 'MADE_UP', message: 'no' }), { code: 'INVALID_MESSAGE' });
});

test('constructs versioned protocol errors', () => {
  assert.deepEqual(protocolError('CANCELLED', 'stopped'), {
    type: 'gev:error', version: 1, code: 'CANCELLED', message: 'stopped',
  });
});
