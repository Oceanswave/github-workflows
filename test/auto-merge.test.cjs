const { test } = require('node:test');
const assert = require('node:assert/strict');
const { autoMerge } = require('../src/auto-merge.cjs');
const sha = 'a'.repeat(40);
const pull = {
  number: 7, node_id: 'PR_test', state: 'open', merged: false, draft: false,
  base: { ref: 'main', repo: { full_name: 'Oceanswave/test' } },
  head: { sha, repo: { full_name: 'Oceanswave/test' } },
  requested_reviewers: [], requested_teams: [], labels: [{ name: 'automerge' }],
  user: { login: 'Oceanswave' }, mergeable: true, mergeable_state: 'clean', auto_merge: null,
};
const check = { name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { databaseId: 15368 } } };
function harness(options = {}) {
  const calls = []; let reads = 0; let enabled = false; let checkReads = 0; let reviewReads = 0;
  const data = structuredClone(options.pull || pull);
  const github = {
    rest: {
      pulls: {
        get: async () => { calls.push('get'); const next = options.reads?.[reads++]; if (next instanceof Error) throw next; return { data: structuredClone(next || { ...data, auto_merge: enabled ? { enabled_by: { login: 'Oceanswave' } } : data.auto_merge }) }; },
        listReviews: async () => options.reviews || [],
        list: async () => options.pulls || [data],
        merge: async args => { calls.push(['merge', args]); if (options.mergeError) throw options.mergeError; return { data: options.mergeResponse || { merged: true } }; },
      },
      actions: { getWorkflowRun: async () => ({ data: options.run }) },
    },
    paginate: async (method, args) => method(args),
    graphql: async (query, args) => {
      if (query.includes('viewer')) return { viewer: { login: options.actor || 'Oceanswave' } };
      if (query.includes('query Reviews')) {
        const page = options.reviewPages?.[reviewReads++ % options.reviewPages.length] || { nodes: options.threads || [], pageInfo: { hasNextPage: false } };
        if (options.reviewError) throw options.reviewError;
        return { node: { reviewDecision: options.reviewDecision || null, reviewThreads: page } };
      }
      if (query.includes('query Checks')) {
        const page = options.checkPages?.[checkReads++ % options.checkPages.length] || { nodes: options.checks || [check], pageInfo: { hasNextPage: false } };
        if (options.checkError) throw options.checkError;
        return { repository: { object: { oid: options.checkSha || args.sha, statusCheckRollup: { contexts: page } } } };
      }
      if (query.includes('mutation Enable')) { calls.push('enable'); if (options.enableError) throw options.enableError; enabled = true; return { enablePullRequestAutoMerge: { pullRequest: { number: 7 } } }; }
      if (query.includes('mutation Disable')) { calls.push('disable'); enabled = false; return {}; }
      throw new Error('Unexpected GraphQL operation');
    },
  };
  const config = { hasExplicitToken: true, pullNumber: '7', expectedHead: sha, requiredChecks: JSON.stringify([{ name: 'verify', appId: 15368 }]), allowProtectedMerge: false, ...options.config };
  return { calls, github, run: () => autoMerge({ github, policyGithub: options.policyGithub, context: { repo: { owner: 'Oceanswave', repo: 'test' }, runId: 42 }, core: { notice() {} }, config }) };
}
const noWrites = calls => assert.equal(calls.filter(item => item === 'enable' || item === 'disable' || Array.isArray(item)).length, 0);
for (const [name, change] of [
  ['merged', { state: 'closed', merged: true }], ['closed', { state: 'closed' }],
  ['draft', { draft: true }], ['review requested', { requested_reviewers: [{ login: 'reviewer' }] }],
  ['team review requested', { requested_teams: [{ slug: 'reviewers' }] }],
  ['fork', { head: { sha, repo: { full_name: 'untrusted/test' } } }],
  ['missing head repository', { head: { sha, repo: null } }],
  ['wrong base', { base: { ref: 'release', repo: { full_name: 'Oceanswave/test' } } }],
  ['stale SHA', { head: { sha: 'b'.repeat(40), repo: { full_name: 'Oceanswave/test' } } }],
  ['unmet protection', { mergeable_state: 'blocked' }], ['unknown merge state', { mergeable_state: 'mystery' }], ['mergeability unavailable', { mergeable: null }],
]) test(`No writes for ${name}`, async () => { const h = harness({ pull: { ...pull, ...change } }); assert.notEqual((await h.run()).outcome, 'eligible'); noWrites(h.calls); });
for (const [name, options] of [
  ['changes requested', { reviews: [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }] }],
  ['required review', { reviewDecision: 'REVIEW_REQUIRED' }],
  ['unresolved discussion', { threads: [{ isResolved: false }] }],
  ['missing check', { checks: [] }], ['wrong app', { checks: [{ ...check, checkSuite: { app: { databaseId: 1 } } }] }],
  ['failed check', { checks: [{ ...check, conclusion: 'FAILURE' }] }],
  ['pending check', { checks: [{ ...check, status: 'IN_PROGRESS', conclusion: null }] }],
  ['duplicate check', { checks: [check, check] }], ['old checks', { checkSha: 'b'.repeat(40) }],
  ['spoofed status', { checks: [{ context: 'verify', state: 'SUCCESS' }] }],
  ['extra failed check', { checks: [check, { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] }],
  ['extra pending check', { checks: [check, { name: 'lint', status: 'IN_PROGRESS' }] }],
  ['failed legacy status', { checks: [check, { context: 'external', state: 'FAILURE' }] }],
  ['missing label', { config: { requiredLabel: 'approved-for-merge' } }],
  ['wrong bot identity', { config: { requireDependabot: true } }],
]) test(`Hold ${name}`, async () => { const h = harness(options); assert.equal((await h.run()).outcome, 'held'); noWrites(h.calls); });
test('Merge eligible PR and confirm resulting state', async () => { const h = harness(); assert.equal((await h.run()).outcome, 'merged'); assert.equal(h.calls.filter(Array.isArray).length, 1); });
test('Latest approval clears older changes request', async () => { const h = harness({ reviews: [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'reviewer' }, state: 'APPROVED' }] }); assert.equal((await h.run()).outcome, 'merged'); });
test('Hold review introduced before write', async () => { const h = harness({ reads: [pull, { ...pull, requested_reviewers: [{ login: 'reviewer' }] }] }); assert.equal((await h.run()).outcome, 'held'); noWrites(h.calls); });
test('Hold head introduced before write', async () => { const h = harness({ reads: [pull, { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } }] }); assert.equal((await h.run()).outcome, 'held'); noWrites(h.calls); });
for (const merged of [true, false]) test(`Confirm terminal merge race (${merged ? 'merged' : 'closed'})`, async () => { const h = harness({ reads: [pull, pull, { ...pull, state: 'closed', merged }], mergeError: new Error('Any API error') }); assert.equal((await h.run()).outcome, merged ? 'already-merged' : 'closed'); assert.equal(h.calls.filter(Array.isArray).length, 1); });
test('Already merged error text is not success while PR remains open', async () => { const h = harness({ mergeError: new Error('Pull request is already merged') }); await assert.rejects(h.run(), /already merged/); });
test('Real authorization failure propagates', async () => { const h = harness({ mergeError: new Error('Resource not accessible by integration') }); await assert.rejects(h.run(), /not accessible/); });
test('Failed initial authoritative read propagates', async () => { const h = harness({ reads: [new Error('read denied')] }); await assert.rejects(h.run(), /read denied/); noWrites(h.calls); });
test('Failed race authoritative read propagates', async () => { const h = harness({ reads: [pull, pull, new Error('recheck denied')], mergeError: new Error('Merge failed') }); await assert.rejects(h.run(), /recheck denied/); });
test('Review API failure propagates', async () => { const h = harness({ reviewError: new Error('reviews denied') }); await assert.rejects(h.run(), /reviews denied/); noWrites(h.calls); });
test('Check API failure propagates', async () => { const h = harness({ checkError: new Error('checks denied') }); await assert.rejects(h.run(), /checks denied/); noWrites(h.calls); });
test('Token actor mismatch fails without writing', async () => { const h = harness({ actor: 'someone', config: { expectedTokenActor: 'Oceanswave' } }); await assert.rejects(h.run(), /token actor/); noWrites(h.calls); });
test('Protected merge uses exact verified SHA and no bypass', async () => { const h = harness(); assert.equal((await h.run()).outcome, 'merged'); const args = h.calls.find(Array.isArray)[1]; assert.equal(args.sha, sha); assert.equal(args.merge_method, 'squash'); assert.equal(Object.keys(args).some(key => /admin|bypass/.test(key)), false); });
test('Protected merge rejection remains a failure', async () => { const h = harness({ mergeResponse: { merged: false, message: 'Required checks unmet' } }); await assert.rejects(h.run(), /Required checks/); });
test('Protected merge transport error remains a failure', async () => { const h = harness({ mergeError: new Error('merge denied') }); await assert.rejects(h.run(), /merge denied/); });
test('Already armed eligible PR uses exact-head protected merge', async () => { const h = harness({ pull: { ...pull, auto_merge: {} } }); assert.equal((await h.run()).outcome, 'merged'); assert.equal(h.calls.find(Array.isArray)[1].sha, sha); });
test('Own pending controller check is excluded by current run URL', async () => { const h = harness({ checks: [check, { name: 'queue / Shared auto-merge', status: 'IN_PROGRESS', checkSuite: { app: { databaseId: 15368 } }, detailsUrl: 'https://github.com/Oceanswave/test/actions/runs/42/job/7' }] }); assert.equal((await h.run()).outcome, 'merged'); });
test('Other run controller check is not ignored', async () => { const h = harness({ checks: [check, { name: 'queue / Shared auto-merge', status: 'IN_PROGRESS', detailsUrl: 'https://github.com/Oceanswave/test/actions/runs/43/job/7' }] }); assert.equal((await h.run()).outcome, 'held'); noWrites(h.calls); });
test('Review pagination includes later unresolved thread', async () => { const h = harness({ reviewPages: [{ nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } }, { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } }] }); assert.equal((await h.run()).outcome, 'held'); noWrites(h.calls); });
test('Check pagination includes required check on later page', async () => { const h = harness({ checkPages: [{ nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } }, { nodes: [check], pageInfo: { hasNextPage: false } }] }); assert.equal((await h.run()).outcome, 'merged'); });
for (const value of ['0', '-1', '1; echo unsafe', '9007199254740992']) test(`Reject invalid number ${value}`, async () => { const h = harness({ config: { pullNumber: value } }); await assert.rejects(h.run(), /valid pull/); noWrites(h.calls); });
test('Branch argument stays API data rather than shell code', async () => { const h = harness({ config: { headBranch: 'branch; echo unsafe' } }); assert.equal((await h.run()).outcome, 'merged'); });
test('Observe mode verifies eligibility without writes', async () => { const h = harness({ config: { dryRun: true } }); assert.equal((await h.run()).outcome, 'eligible'); noWrites(h.calls); });
test('Generated runtime contains the exact tested function', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  const source = readFileSync(resolve(__dirname, '../src/auto-merge.cjs'), 'utf8').replace(/module\.exports = \{ autoMerge \};\s*$/, '').trimEnd();
  const workflow = readFileSync(resolve(__dirname, '../.github/workflows/merge.yml'), 'utf8');
  const embedded = workflow.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
  assert.equal(embedded.slice(0, source.length), source);
  new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', embedded);
});
test('Missing required maintainer token never falls back to GITHUB_TOKEN', async () => { const h = harness({ config: { expectedTokenActor: 'Oceanswave', hasExplicitToken: false } }); await assert.rejects(h.run(), /fallback is forbidden/); noWrites(h.calls); });

for (const [name, conclusion, allowSkipped, appId, outcome] of [
  ['required skipped by default', 'SKIPPED', undefined, 15368, 'held'],
  ['explicit trusted conditional skip', 'SKIPPED', true, 15368, 'merged'],
  ['explicit conditional failure', 'FAILURE', true, 15368, 'held'],
  ['conditional skip from wrong app', 'SKIPPED', true, 1, 'held'],
  ['strict false conditional skip', 'SKIPPED', false, 15368, 'held'],
]) test(name, async () => {
  const h = harness({ checks: [{ ...check, conclusion, checkSuite: { app: { databaseId: appId } } }],
    config: { requiredChecks: JSON.stringify([{ name: 'verify', appId: 15368, allowSkipped }]) } });
  assert.equal((await h.run()).outcome, outcome);
  if (outcome === 'held') noWrites(h.calls);
});
test('Reject ambiguous conditional-check configuration', async () => {
  const h = harness({ config: { requiredChecks: JSON.stringify([{ name: 'verify', appId: 15368, allowSkipped: 'true' }]) } });
  await assert.rejects(h.run(), /explicit checks/); noWrites(h.calls);
});

test('A check from another app cannot impersonate the running controller', async () => {
  const h = harness({ checks: [check, { name: 'queue / Shared auto-merge', status: 'IN_PROGRESS',
    checkSuite: { app: { databaseId: 1 } }, detailsUrl: 'https://github.com/Oceanswave/test/actions/runs/42/job/7' }] });
  assert.equal((await h.run()).outcome, 'held'); noWrites(h.calls);
});

test('Separate read client handles policy while only existing writer merges', async () => {
  const reader = harness();
  const writer = harness({ policyGithub: reader.github, config: { expectedTokenActor: 'Oceanswave' } });
  assert.equal((await writer.run()).outcome, 'merged');
  assert.equal(writer.calls.filter(call => call === 'get').length, 0);
  assert.equal(reader.calls.filter(call => call === 'get').length, 2);
  assert.equal(reader.calls.filter(Array.isArray).length, 0);
  assert.equal(writer.calls.filter(Array.isArray).length, 1);
});
test('Read-client denial never falls back to writer or attempts a merge', async () => {
  const reader = harness({ checkError: new Error('Job policy read denied') });
  const writer = harness({ policyGithub: reader.github });
  await assert.rejects(writer.run(), /Job policy read denied/);
  noWrites(writer.calls); noWrites(reader.calls);
});
test('Writer actor remains checked when policy uses another client', async () => {
  const reader = harness();
  const writer = harness({ policyGithub: reader.github, actor: 'wrong-actor', config: { expectedTokenActor: 'Oceanswave' } });
  await assert.rejects(writer.run(), /token actor/);
  noWrites(writer.calls); noWrites(reader.calls);
});

test('GraphQL permission failures report the exact safe policy field path', async () => {
  const denied = Object.assign(new Error('Resource not accessible'), { errors: [
    { type: 'FORBIDDEN', path: ['repository', 'object', 'statusCheckRollup'], message: 'Resource not accessible' },
  ] });
  const h = harness({ checkError: denied });
  await assert.rejects(h.run(), error => error.message.includes('statusCheckRollup') && error.message.includes('FORBIDDEN'));
  noWrites(h.calls);
});
