import assert from 'node:assert/strict';
import test from 'node:test';
import { constantTimeEqual, generateRuntimeToken, redact, safeArgumentSummary, createQuotaGuard, canonicalCostClass, quotaDecision } from './security.js';
import { AuditLog } from './audit.js';

test('credentials compare safely and runtime tokens are high entropy', () => {
  const token = generateRuntimeToken();
  assert.equal(token.length >=  forty(), true);
  assert.equal(constantTimeEqual(token, token), true);
  assert.equal(constantTimeEqual(token, `${token}x`), false);
});

function forty() { return 40; }

test('redaction removes secret fields and embedded bearer/query credentials', () => {
  const value = redact({ token: 'abc', nested: { authorization: 'Bearer xyz' }, text: '?api_key=hidden&x=1' });
  assert.deepEqual(value, { token: '[REDACTED]', nested: { authorization: '[REDACTED]' }, text: '?api_key=[REDACTED]&x=1' });
  assert.ok(!safeArgumentSummary(value).includes('hidden'));
});

test('quota guard enforces calls, bytes, and runtime per principal', () => {
  let now = 0;
  const quota = createQuotaGuard({ maxCalls: 2, maxBytes: 10, maxRuntimeMs: 5, windowMs: 100, now: () => now });
  assert.equal(quota.check('a', { bytes: 4, runtimeMs: 2 }).allowed, true);
  assert.equal(quota.check('a', { bytes: 4, runtimeMs: 2 }).allowed, true);
  assert.equal(quota.check('a', { bytes: 1 }).allowed, false);
  now = 101;
  assert.equal(quota.check('a', { bytes: 1 }).allowed, true);
});

test('quota guard keeps cost classes independent for each principal', () => {
  const quota = createQuotaGuard({ limits: {
    free: { maxCalls: 1, maxBytes: 100, maxRuntimeMs: 100 },
    network: { maxCalls: 1, maxBytes: 100, maxRuntimeMs: 100 },
  } });
  assert.equal(quota.check('agent', { costClass: 'free' }).allowed, true);
  assert.equal(quota.check('agent', { costClass: 'free' }).allowed, false);
  assert.equal(quota.check('agent', { costClass: 'network' }).allowed, true);
});

test('quota guard records completed execution time for the next admission', () => {
  const quota = createQuotaGuard({
    limits: { expensive: { maxCalls: 10, maxRuntimeMs: 5 } },
  });
  assert.equal(
    quota.check('agent', { costClass: 'expensive' }).allowed,
    true,
  );
  quota.recordRuntime('agent', { costClass: 'expensive', runtimeMs: 6 });
  assert.equal(
    quota.check('agent', { costClass: 'expensive' }).allowed,
    false,
  );
});

test('cost classes are canonical strings with pure quota decisions', () => {
  assert.equal(canonicalCostClass('unknown'), 'free');
  const decision = quotaDecision({ costClass: 'artifact', limits: { artifact: { maxCalls: 1, maxBytes: 100 } }, usage: {} });
  assert.equal(decision.allowed, true);
  assert.equal(quotaDecision({ costClass: 'artifact', limits: { artifact: { maxCalls: 1 } }, usage: { calls: 1 } }).allowed, false);
});

test('audit log is bounded and stores only safe argument summaries', () => {
  const audit = new AuditLog({ maxRecords: 2, maxBytes: 10_000, now: () => 0 });
  audit.append({ principal: 'agent', sessionId: 's', tool: 'inspect', args: { token: 'secret' } });
  audit.append({ tool: 'two', args: {} });
  audit.append({ tool: 'three', args: {} });
  assert.equal(audit.list().length, 2);
  assert.ok(!JSON.stringify(audit.list()).includes('secret'));
  audit.clear();
  assert.deepEqual(audit.list(), []);
});

test('redaction removes image payloads and filesystem paths', () => {
  const value = safeArgumentSummary({
    output: 'data:image/png;base64,' + 'A'.repeat(256),
    file: '/home/secret/private.png',
    nested: { value: 'Bearer abc123' },
  });
  assert.ok(!value.includes('base64'));
  assert.ok(!value.includes('/home/secret'));
  assert.ok(!value.includes('abc123'));
});
