# Shared GitHub workflows

Reusable merge logic for repositories owned by Oceanswave. Build, deployment,
dependency-validation and label authorization stay in each calling repository.

```yaml
jobs:
  merge:
    permissions:
      contents: write
      pull-requests: write
    uses: Oceanswave/github-workflows/.github/workflows/merge.yml@v1
    with:
      pull-number: ${{ format('{0}', github.event.pull_request.number) }}
      expected-head: ${{ github.event.pull_request.head.sha }}
      required-checks: '[{"name":"verify","appId":15368}]'
```

The workflow uses the caller's GitHub token by default. Callers that already
require a maintainer token to preserve downstream merge events may pass only
that existing token as `secrets.token`, with `expected-token-actor`. Never use
`secrets: inherit`. The caller must retain its existing permissions and delivery
event contract; adoption does not authorize adding credentials or permissions.

The helper reads live PR, reviews, discussion resolution and current-head check
metadata. It holds drafts, requested reviews, changes requests, unresolved
threads, forks, stale heads, unavailable mergeability, and incomplete or failed
CI. Required check names **and app IDs** are explicit caller inputs. Legacy
commit statuses cannot establish an app-pinned required check. API read errors
fail the job; unavailable policy information never grants eligibility.

Eligible PRs are rechecked and squash-merged through GitHub's ordinary REST
endpoint with the exact verified head SHA. No persistent auto-merge request is
armed. Closed or merged PRs skip; an API failure is suppressed only after an
authoritative reread confirms a terminal state. GitHub protections remain the
final merge boundary. Callers schedule fresh attempts after relevant CI/review
events. There is no atomic API transaction spanning reviews/checks and merge;
checks and reviews can still change between the final read and write. Configure
server rules to enforce critical requirements and treat a rejected merge as a
failure. Merge queues need a separately reviewed integration.

The privileged job runs on GitHub-hosted Ubuntu and never checks out or executes
PR code, downloads artifacts, restores caches, or expands secrets. PR fields
enter APIs as data, never executable shell or interpolated JavaScript. The
official `actions/github-script` action is pinned to an immutable audited SHA.
Its v9 Node 24 runtime requires runner 2.327.1 or newer; GitHub-hosted runners
supply that runtime. Self-hosted application builds remain caller-specific.

## Test and promote

```sh
node --test test/*.test.cjs
node scripts/build-workflow.cjs --check
```

`src/auto-merge.cjs` is the canonical source; `scripts/build-workflow.cjs` embeds
that same code into the workflow so runtime does not fetch a mutable script.
Tests use synthetic PRs, checks and races. The `observe` CI job exercises the
actual reusable workflow with a read-only token and `dry-run: true`.

Review and test a candidate at its immutable commit SHA. Pilot the candidate in
observe mode, then verify an authorized eligible PR and its downstream CI
handoff. Only after those pass, promote the `v1` **branch** to that exact commit.
Record old SHA, candidate SHA, CI URLs and pilot outcomes in the promotion PR.
Do not create a same-name tag: GitHub resolves tags before branches. Roll back
by moving `v1` to the recorded prior tested commit and verifying the next run.
Promotion and rollback are owner operations; no workflow automatically updates
the shared ref or changes repository security settings.

`@v1` deliberately propagates promoted fixes on subsequent caller runs. Anyone
able to modify that ref can affect every caller and its passed token. Immutable
upstream action pins, review, candidate CI and phased adoption reduce that blast
radius; ref protection would be a separate explicit owner decision. Callers may
pin a SHA when propagation is unwanted.

## Upstream choices

The design uses [GitHub reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations),
the pinned MIT-licensed [official github-script action](https://github.com/actions/github-script),
and GitHub's [SHA-guarded merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).
Project-specific eligibility needs the small policy gate here.
[peter-evans/enable-pull-request-automerge](https://github.com/peter-evans/enable-pull-request-automerge)
recommends native commands for simple cases and arms auto-merge;
[pascalgn/automerge-action](https://github.com/pascalgn/automerge-action)
adds its own retries/readiness behavior but still needs these additional holds.
Copied starter workflows do not propagate subsequent fixes. No third-party
implementation was copied into this repository.
