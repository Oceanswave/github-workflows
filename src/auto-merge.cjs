'use strict';

// This exact module is embedded into the reusable workflow. Never load caller
// code, artifacts, dependencies, or caches in the privileged controller.
async function autoMerge({ github, context, core, config }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const hold = reason => { core.notice(`Held: ${reason}`); return { outcome: 'held', reason }; };
  const terminal = pull => pull.merged || pull.state === 'closed';
  const finish = pull => ({ outcome: pull.merged ? 'merged' : 'closed', number: pull.number });
  const required = JSON.parse(config.requiredChecks);
  if (owner !== 'Oceanswave' || !Array.isArray(required) || !required.length ||
      required.some(check => !check || typeof check.name !== 'string' || !check.name ||
        !Number.isSafeInteger(check.appId) || check.appId < 1)) {
    throw new Error('An Oceanswave caller and explicit checks with app IDs are required.');
  }
  let number = config.pullNumber;
  let expectedHead = config.expectedHead;
  if (config.headBranch) {
    const pulls = await github.paginate(github.rest.pulls.list, {
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
  const getPull = async () => (await github.rest.pulls.get({ owner, repo, pull_number: Number(number) })).data;
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
    if (pull.mergeable !== true || !['clean', 'unstable', 'has_hooks'].includes(pull.mergeable_state)) return hold('GitHub reports unmet merge requirements');
    const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: Number(number), per_page: 100 });
    const latest = new Map();
    for (const review of reviews) {
      if (review.author_association === 'NONE' && review.state === 'COMMENTED') continue;
      if (review.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review.state);
    }
    if ([...latest.values()].includes('CHANGES_REQUESTED')) return hold('changes requested');
    let cursor = null;
    do {
      const result = await github.graphql(`query Reviews($id: ID!, $cursor: String) {
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
      const result = await github.graphql(`query Checks($owner: String!, $repo: String!, $sha: GitObjectID!, $cursor: String) {
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
      if (commit?.oid !== pull.head.sha || !commit.statusCheckRollup?.contexts) return hold('current-head checks are unavailable');
      const page = commit.statusCheckRollup.contexts;
      checks.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo.hasNextPage && !cursor) throw new Error('Check pagination is incomplete.');
    } while (cursor);
    for (const requirement of required) {
      const matches = checks.filter(check => check.name === requirement.name && check.checkSuite?.app?.databaseId === requirement.appId);
      if (matches.length !== 1 || matches[0].status !== 'COMPLETED' || matches[0].conclusion !== 'SUCCESS') return hold(`required check ${requirement.name} from app ${requirement.appId} has not passed`);
    }
    for (const check of checks) {
      // Only this job can be pending; every other CI/status context must pass.
      const own = (check.name === 'Shared auto-merge' || check.name?.endsWith(' / Shared auto-merge')) &&
        check.detailsUrl?.startsWith(`https://github.com/${repository}/actions/runs/${context.runId}/`);
      if (own) continue;
      if (check.name && (check.status !== 'COMPLETED' || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion))) return hold(`check ${check.name} is incomplete or failed`);
      if (check.context && check.state !== 'SUCCESS') return hold(`status ${check.context} is incomplete or failed`);
    }
    return { outcome: 'eligible' };
  };
  let pull = await getPull();
  let result = await inspect(pull);
  if (result.outcome !== 'eligible') return result;
  if (config.dryRun) return { outcome: 'eligible', number: pull.number };
  const head = pull.head.sha;
  expectedHead = expectedHead || head;
  // Re-read every mutable hold and current-head check immediately before write.
  pull = await getPull();
  result = await inspect(pull);
  if (result.outcome !== 'eligible') return result;
  try {
    const { data: merged } = await github.rest.pulls.merge({
      owner, repo, pull_number: Number(number), merge_method: 'squash', sha: head,
    });
    if (!merged.merged) throw new Error(merged.message || 'GitHub refused the protected merge.');
    return { outcome: 'merged', number: Number(number), sha: merged.sha };
  } catch (error) {
    // Error strings never establish success. Confirm terminal state after races.
    const current = await getPull();
    if (terminal(current)) return finish(current);
    throw error;
  }
}

module.exports = { autoMerge };
