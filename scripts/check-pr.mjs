import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// Read-only snapshot check. Review findings and merge permission are separate gates.
export function assessChecks(before, checks, after, expected) {
  const blocked = (reason) => ({ status: 'blocked', reason });
  const validHead = (pr) => pr && typeof pr.headRefOid === 'string' && /^[a-f0-9]{40}$/i.test(pr.headRefOid);
  if (!validHead(before) || !validHead(after)) return blocked('Missing or invalid PR head.');
  if (before.headRefOid !== after.headRefOid) return blocked('PR head changed during inspection; inspect again.');
  if (before.state !== 'OPEN' || after.state !== 'OPEN' || before.isDraft !== false || after.isDraft !== false) {
    return blocked('Expected an open, ready-for-review PR.');
  }
  if (!Array.isArray(expected) || expected.length === 0 || expected.some((name) => typeof name !== 'string' || !name.trim())) {
    return blocked('Provide the agreed expected check names; an empty gate cannot pass.');
  }
  if (!Array.isArray(checks) || checks.length === 0) return blocked('No checks reported; this is not a pass.');
  const buckets = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);
  if (checks.some((check) => !check || typeof check.name !== 'string' || !buckets.has(check.bucket))) {
    return blocked('Invalid or unknown check result.');
  }
  const missing = expected.filter((name) => !checks.some((check) => check.name === name));
  if (missing.length) return blocked(`Expected checks missing: ${missing.join(', ')}`);
  const failed = checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel' || (expected.includes(check.name) && check.bucket === 'skipping'));
  if (failed.length) return blocked(`Checks need attention: ${failed.map((check) => `${check.name} (${check.bucket})`).join(', ')}`);
  const pending = checks.filter((check) => check.bucket === 'pending');
  if (pending.length) return { status: 'pending', reason: `Waiting for: ${pending.map((check) => check.name).join(', ')}` };
  return { status: 'pass', reason: 'Observed CI passed; review and runtime evidence still require inspection.', head: after.headRefOid };
}

export function inspectPR(repo, pr, expected, runGh) {
  const view = () => runGh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,state,isDraft']);
  const before = view();
  const checks = runGh(['pr', 'checks', pr, '--repo', repo, '--json', 'name,bucket,link,workflow'], true);
  const after = view();
  return assessChecks(before, checks, after, expected);
}

function ghJson(args, checksCommand = false) {
  let output;
  try {
    output = execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // gh returns 1 for failed checks and 8 for pending checks, with valid JSON.
    // Authentication, network, and parser failures must still block completion.
    if (!checksCommand || ![1, 8].includes(error.status) || !error.stdout?.trim()) {
      throw new Error('GitHub query failed or timed out; CI is unverified.');
    }
    output = error.stdout;
  }
  return JSON.parse(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      repo: { type: 'string' }, pr: { type: 'string' }, expect: { type: 'string', multiple: true },
    } });
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo ?? '') || !/^[1-9][0-9]*$/.test(values.pr ?? '') || !values.expect?.length) {
      throw new Error('Usage: node scripts/check-pr.mjs --repo OWNER/REPO --pr NUMBER --expect CHECK_NAME [--expect CHECK_NAME]');
    }
    const result = inspectPR(values.repo, values.pr, values.expect, ghJson);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'pass' ? 0 : result.status === 'pending' ? 8 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CI inspection failed.');
    process.exitCode = 1;
  }
}
