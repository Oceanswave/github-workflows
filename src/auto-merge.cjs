'use strict';

// This exact module is embedded into the reusable workflow. Never load caller
// code, artifacts, dependencies, or caches in the privileged controller.
// GitHub computes mergeability asynchronously, so right after CI completes a PR can briefly
// read as unknown or blocked. Re-read with a short backoff before holding on merge state.
const MERGE_STATE_RETRIES = 4;
const MERGE_STATE_DELAY_MS = 5000;
// Opt-in: callers may let checks that are still queued or running finish instead of holding at once.
// The cap keeps the job inside its timeout; failed checks and every other gate still hold immediately.
const MAX_PENDING_WAIT_SECONDS = 900;
const PENDING_DELAY_MS = 15000;
const PENDING_MAX_DELAY_MS = 60000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function autoMerge({ github, policyGithub = github, context, core, config, sleep = delay }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const hold = reason => { core.notice(`Held: ${reason}`); return { outcome: 'held', reason }; };
  const terminal = pull => pull.merged || pull.state === 'closed';
  const finish = pull => ({ outcome: pull.merged ? 'already-merged' : 'closed', number: pull.number });
  const required = JSON.parse(config.requiredChecks);
  if (owner !== 'Oceanswave' || !Array.isArray(required) || !required.length ||
      required.some(check => !check || typeof check.name !== 'string' || !check.name ||
        !Number.isSafeInteger(check.appId) || check.appId < 1 ||
        (check.allowSkipped !== undefined && typeof check.allowSkipped !== 'boolean'))) {
    throw new Error('An Oceanswave caller and explicit checks with app IDs are required.');
  }
  const waitSeconds = Number(config.pendingWaitSeconds || 0);
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0) throw new Error('pending-wait-seconds must be a whole number of seconds.');
  if (waitSeconds > MAX_PENDING_WAIT_SECONDS) core.warning(`pending-wait-seconds is capped at ${MAX_PENDING_WAIT_SECONDS}.`);
  const pendingWaitMs = Math.min(waitSeconds, MAX_PENDING_WAIT_SECONDS) * 1000;
  let number = config.pullNumber;
  let expectedHead = config.expectedHead;
  if (config.headBranch) {
    const pulls = await policyGithub.paginate(policyGithub.rest.pulls.list, {
      owner, repo, state: 'open', base: 'main', head: `${owner}:${config.headBranch}`, per_page: 100,
    });
    if (!pulls.length) return hold('branch has no open pull request');
    if (pulls.length !== 1) throw new Error('Branch resolved to multiple pull requests.');
    number = String(pulls[0].number);
  }
  if (!/^[1-9][0-9]*$/.test(String(number)) || !Number.isSafeInteger(Number(number))) {
    throw new Error('A valid pull request number is required.');
  }
  if (expectedHead && !/^[0-9a-f]{40}$/.test(expectedHead)) throw new Error('A full expected head SHA is required.');
  if (config.expectedTokenActor) {
    if (!config.hasExplicitToken) throw new Error('The existing named maintainer token is required; GITHUB_TOKEN fallback is forbidden.');
    const { viewer } = await github.graphql('query { viewer { login } }');
    if (viewer.login !== config.expectedTokenActor) throw new Error('Automation token actor does not match the existing caller contract.');
  }
  const getPull = async () => (await policyGithub.rest.pulls.get({ owner, repo, pull_number: Number(number) })).data;
  const readGraphql = async (...args) => {
    try { return await policyGithub.graphql(...args); }
    catch (error) {
      if (Array.isArray(error.errors)) {
        const details = error.errors.map(({ type, path, message }) => ({ type, path, message }));
        error.message += `\nPolicy read details: ${JSON.stringify(details)}`;
      }
      throw error;
    }
  };
  const inspect = async pull => {
    if (terminal(pull)) return finish(pull);
    if (pull.state !== 'open') return hold('unknown pull request state');
    if (pull.draft) return hold('draft pull request');
    if (pull.base?.repo?.full_name !== repository || pull.base.ref !== 'main' ||
        pull.head?.repo?.full_name !== repository) return hold('fork or unexpected repository/base');
    if (expectedHead && pull.head.sha !== expectedHead) return hold('stale head SHA');
    if ((pull.requested_reviewers?.length || 0) || (pull.requested_teams?.length || 0)) return hold('requested review remains');
    if (config.requiredLabel && !pull.labels?.some(label => label.name === config.requiredLabel)) return hold('required label is absent');
    if (config.excludeDependabot && pull.user?.login === 'dependabot[bot]') return hold('Dependabot belongs to its separate validator');
    if (config.requireDependabot && (pull.user?.login !== 'dependabot[bot]' || pull.user?.id !== 49699333 || pull.user?.type !== 'Bot')) return hold('Dependabot identity does not match');
    let settlingHold = null;
    if (pull.mergeable !== true || !['clean', 'unstable', 'has_hooks'].includes(pull.mergeable_state)) {
      const settling = pull.mergeable === null || ['unknown', 'blocked'].includes(pull.mergeable_state);
      const reason = 'GitHub reports unmet merge requirements';
      if (!settling) return hold(reason);
      settlingHold = { outcome: 'held', reason, settling };
      // A required check that is still running also reads as blocked. Only when waiting is
      // opted in, look past the merge state so a pending check can be waited out.
      if (!pendingWaitMs) return settlingHold;
    }
    const reviews = await policyGithub.paginate(policyGithub.rest.pulls.listReviews, { owner, repo, pull_number: Number(number), per_page: 100 });
    const latest = new Map();
    for (const review of reviews) {
      if (review.author_association === 'NONE' && review.state === 'COMMENTED') continue;
      if (review.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review.state);
    }
    if ([...latest.values()].includes('CHANGES_REQUESTED')) return hold('changes requested');
    let cursor = null;
    do {
      const result = await readGraphql(`query Reviews($id: ID!, $cursor: String) {
        node(id: $id) { ... on PullRequest {
          reviewDecision
          reviewThreads(first: 100, after: $cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
        } }
      }`, { id: pull.node_id, cursor });
      if (!result.node?.reviewThreads) throw new Error('Review metadata is unavailable.');
      if (result.node.reviewDecision === 'CHANGES_REQUESTED' || result.node.reviewDecision === 'REVIEW_REQUIRED') return hold('review decision is incomplete');
      if (result.node.reviewThreads.nodes.some(thread => !thread.isResolved)) return hold('unresolved review thread');
      cursor = result.node.reviewThreads.pageInfo.hasNextPage ? result.node.reviewThreads.pageInfo.endCursor : null;
      if (result.node.reviewThreads.pageInfo.hasNextPage && !cursor) throw new Error('Review pagination is incomplete.');
    } while (cursor);
    const checks = [];
    cursor = null;
    do {
      const result = await readGraphql(`query Checks($owner: String!, $repo: String!, $sha: GitObjectID!, $cursor: String) {
        repository(owner: $owner, name: $repo) { object(oid: $sha) { ... on Commit {
          oid
          statusCheckRollup { contexts(first: 100, after: $cursor) {
            nodes {
              ... on CheckRun { name status conclusion detailsUrl checkSuite { app { databaseId } } }
              ... on StatusContext { context state targetUrl }
            }
            pageInfo { hasNextPage endCursor }
          } }
        } } }
      }`, { owner, repo, sha: pull.head.sha, cursor });
      const commit = result.repository?.object;
      if (commit?.oid === pull.head.sha && !commit.statusCheckRollup && !cursor) return { outcome: 'held', reason: 'current-head checks are not reported yet', pending: true };
      if (commit?.oid !== pull.head.sha || !commit.statusCheckRollup?.contexts) return hold('current-head checks are unavailable');
      const page = commit.statusCheckRollup.contexts;
      checks.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo.hasNextPage && !cursor) throw new Error('Check pagination is incomplete.');
    } while (cursor);
    // A failure anywhere holds at once; a check that has not finished is only remembered so
    // a failure later in the list still wins over waiting.
    let pending = null;
    for (const requirement of required) {
      const reason = `required check ${requirement.name} from app ${requirement.appId} has not passed`;
      const matches = checks.filter(check => check.name === requirement.name && check.checkSuite?.app?.databaseId === requirement.appId);
      if (matches.length > 1) return hold(reason);
      if (!matches.length || matches[0].status !== 'COMPLETED') pending ??= reason;
      else if (!['SUCCESS', ...(requirement.allowSkipped ? ['SKIPPED'] : [])].includes(matches[0].conclusion)) return hold(reason);
    }
    for (const check of checks) {
      // Only this job can be pending; every other CI/status context must pass.
      const own = check.checkSuite?.app?.databaseId === 15368 &&
        (check.name === 'Shared auto-merge' || check.name?.endsWith(' / Shared auto-merge')) &&
        check.detailsUrl?.startsWith(`https://github.com/${repository}/actions/runs/${context.runId}/`);
      if (own) continue;
      if (check.name) {
        const reason = `check ${check.name} is incomplete or failed`;
        if (check.status !== 'COMPLETED') pending ??= reason;
        else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)) return hold(reason);
      }
      if (check.context) {
        const reason = `status ${check.context} is incomplete or failed`;
        if (['PENDING', 'EXPECTED'].includes(check.state)) pending ??= reason;
        else if (check.state !== 'SUCCESS') return hold(reason);
      }
    }
    if (pending) return { outcome: 'held', reason: pending, pending: true };
    return settlingHold || { outcome: 'eligible' };
  };
  // Read and inspect, re-reading while GitHub may still be settling the merge state.
  const settle = async () => {
    for (let attempt = 1; ; attempt++) {
      const pull = await getPull();
      const { settling, ...result } = await inspect(pull);
      if (!settling) return { pull, result };
      if (attempt > MERGE_STATE_RETRIES) return { pull, result: hold(result.reason) };
      core.info(`Merge state ${pull.mergeable_state ?? 'not computed'}; re-reading (${attempt}/${MERGE_STATE_RETRIES}).`);
      await sleep(MERGE_STATE_DELAY_MS * attempt);
    }
  };
  // Re-read while the only holds are checks that have not finished, until they do or the budget runs out.
  const awaitChecks = async budgetMs => {
    for (let attempt = 1, waited = 0; ; attempt++) {
      const { pull, result: { pending, ...result } } = await settle();
      if (!pending) return { pull, result };
      const remaining = budgetMs - waited;
      if (remaining <= 0) return { pull, result: hold(result.reason) };
      const ms = Math.min(PENDING_DELAY_MS * attempt, PENDING_MAX_DELAY_MS, remaining);
      core.info(`Waiting ${ms / 1000}s: ${result.reason} (${waited / 1000}s of ${budgetMs / 1000}s used).`);
      await sleep(ms);
      waited += ms;
    }
  };
  let { pull, result } = await awaitChecks(pendingWaitMs);
  if (result.outcome !== 'eligible') return result;
  if (config.dryRun) return { outcome: 'eligible', number: pull.number };
  const head = pull.head.sha;
  expectedHead = expectedHead || head;
  // Re-read every mutable hold and current-head check immediately before write; no waiting here.
  ({ pull, result } = await awaitChecks(0));
  if (result.outcome !== 'eligible') return result;
  try {
    const { data: merged } = await github.rest.pulls.merge({
      owner, repo, pull_number: Number(number), merge_method: 'squash', sha: head,
    });
    if (!merged.merged) throw new Error(merged.message || 'GitHub refused the protected merge.');
    return { outcome: 'merged', number: Number(number), sha: merged.sha, branchDeleted: await deleteBranch(pull) };
  } catch (error) {
    // Error strings never establish success. Confirm terminal state after races.
    const current = await getPull();
    if (terminal(current)) return finish(current);
    throw error;
  }

  // GitHub's delete_branch_on_merge does not fire for merges made with an Actions token,
  // so honor the repository setting here. The merge already succeeded: never fail on this.
  async function deleteBranch(merged) {
    try {
      const { data: settings } = await policyGithub.rest.repos.get({ owner, repo });
      const ref = merged.head?.ref;
      if (!settings.delete_branch_on_merge || !ref || ref === settings.default_branch) return false;
      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${ref}` });
      return true;
    } catch (error) {
      if (error.status === 422 || error.status === 404) return false;  // already gone
      core.warning(`Merged, but the head branch was not deleted: ${error.message}`);
      return false;
    }
  }
}

module.exports = { autoMerge };
