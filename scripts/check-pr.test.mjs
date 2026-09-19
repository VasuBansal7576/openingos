import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assessChecks, inspectPR } from './check-pr.mjs';

const head = { headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false };
const pass = { name: 'delivery-guard-tests', bucket: 'pass' };
const expected = [pass.name];

for (const [name, checks, status] of [
  ['green', [pass], 'pass'],
  ['empty', [], 'blocked'],
  ['malformed', null, 'blocked'],
  ['missing agreed check', [{ ...pass, name: 'Greptile' }], 'blocked'],
  ['pending', [{ ...pass, bucket: 'pending' }], 'pending'],
  ['failed', [{ ...pass, bucket: 'fail' }], 'blocked'],
  ['cancelled', [{ ...pass, bucket: 'cancel' }], 'blocked'],
  ['skipped expected check', [{ ...pass, bucket: 'skipping' }], 'blocked'],
  ['unknown bucket', [{ ...pass, bucket: 'unknown' }], 'blocked'],
  ['additional failing check', [pass, { name: 'integration', bucket: 'fail' }], 'blocked'],
  ['additional pending check', [pass, { name: 'review', bucket: 'pending' }], 'pending'],
  ['duplicate name with failure', [pass, { ...pass, bucket: 'fail' }], 'blocked'],
  ['optional skipped check', [pass, { name: 'optional', bucket: 'skipping' }], 'pass'],
]) {
  test(name, () => assert.equal(assessChecks(head, checks, head, expected).status, status));
}

test('changing head invalidates green', () => {
  assert.equal(assessChecks(head, [pass], { ...head, headRefOid: 'b'.repeat(40) }, expected).status, 'blocked');
});

test('missing head, draft, and closed PRs cannot pass', () => {
  for (const invalid of [null, {}, { ...head, isDraft: true }, { ...head, state: 'CLOSED' }]) {
    assert.equal(assessChecks(invalid, [pass], invalid, expected).status, 'blocked');
  }
});

test('expected checks cannot be empty or invalid', () => {
  for (const invalid of [[], null, [''], [4]]) {
    assert.equal(assessChecks(head, [pass], head, invalid).status, 'blocked');
  }
});

test('inspection reads head before and after all checks without a required-only filter', () => {
  const calls = [];
  const answers = [head, [pass], head];
  const result = inspectPR('owner/repo', '12', expected, (args) => {
    calls.push(args);
    return answers.shift();
  });
  assert.equal(result.status, 'pass');
  assert.deepEqual(calls.map((args) => args[1]), ['view', 'checks', 'view']);
  assert.ok(calls.every((args) => !args.includes('--required')));
});

test('query failures propagate instead of passing', () => {
  assert.throws(() => inspectPR('owner/repo', '12', expected, () => { throw new Error('API unavailable'); }), /API unavailable/);
});

test('CLI rejects missing agreed checks before querying GitHub', () => {
  const result = spawnSync(process.execPath, ['scripts/check-pr.mjs', '--repo', 'owner/repo', '--pr', '12'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});
