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

For a caller whose existing maintainer token cannot read private CI metadata,
`use-job-token-for-policy-read: true` uses the ephemeral job token for all PR,
review and check reads. The existing named token still supplies actor validation
and the exact-head merge. The caller must explicitly grant its job `contents:
read`, `pull-requests: read`, `checks: read` and `statuses: read`; adding these
permissions requires the owner's scoped approval. This option adds no stored
credential, does not expand the maintainer token, and never falls back to it
when a policy read is denied. The default preserves the existing single-client
contract. Private eligibility needs both check-run and commit-status read access.

The helper reads live PR, reviews, discussion resolution and current-head check
metadata. It holds drafts, requested reviews, changes requests, unresolved
threads, forks, stale heads, unavailable mergeability, and incomplete or failed
CI. Required check names **and app IDs** are explicit caller inputs. Legacy
commit statuses cannot establish an app-pinned required check. API read errors
fail the job; unavailable policy information never grants eligibility.

Required checks default to completed `SUCCESS`. A caller whose trusted CI
classifier deliberately skips an unchanged component can explicitly add
`"allowSkipped":true` to that component's requirement. Only completed `SKIPPED`
from the configured app is additionally accepted; failures, pending checks,
missing checks and app mismatches still hold. Keep the classifier/safety check
strictly required and review each conditional-check exception in the caller.

GitHub computes mergeability asynchronously, so a PR can briefly read as
`unknown` or `blocked` right after CI completes. The helper re-reads such a state up
to four times with a growing delay (5, 10, 15 and 20 seconds) before holding. Other
states, such as merge conflicts, hold immediately.

### Waiting for checks that are still running

When two workflows on one push both gate a merge, the helper can run while the
other workflow's checks are still queued or in progress, hold, and never be
asked again. Callers should **re-run the helper when the other workflow
completes**, for example from a `workflow_run` (`types: [completed]`) caller
that passes `head-branch` and `expected-head:
${{ github.event.workflow_run.head_sha }}`. That event-driven re-evaluation is
the primary fix.

As a fallback, `pending-wait-seconds` (default `0`, capped at `900`) lets the
helper wait out checks that have not finished yet. When it is above zero and the
**only** remaining holds are check runs or commit statuses that are not complete
(queued, in progress, pending/expected, a required check that has not appeared
yet, or a `blocked` merge state while such a check runs), the helper re-reads
and re-inspects with a growing delay (15, 30, 45, then 60 seconds) until they
finish or the budget is spent, then holds as before. A failed check holds
immediately even while others are still running, and every other gate (owner,
app-pinned required checks, token actor, stale head, reviews, threads, labels,
Dependabot, fork) is unchanged. The final pre-merge recheck never waits. The job
timeout is 20 minutes to cover the maximum wait; a waiting helper holds a
runner, so keep the budget modest.

Eligible PRs are rechecked and squash-merged through GitHub's ordinary REST
endpoint with the exact verified head SHA. No persistent auto-merge request is
armed. GitHub's `delete_branch_on_merge` does not fire for merges made with an
Actions token, so after a successful merge the helper deletes the same-repository
head branch itself when the repository has that setting on (the caller's existing
`contents: write` covers it). A deletion failure is logged and never fails the merge. Closed or merged PRs skip; an API failure is suppressed only after an
authoritative reread confirms a terminal state. GitHub protections remain the
final merge boundary. Callers schedule fresh attempts after relevant CI/review
events. There is no atomic API transaction spanning reviews/checks and merge;
checks and reviews can still change between the final read and write. Configure
server rules to enforce critical requirements and treat a rejected merge as a
failure. Merge queues need a separately reviewed integration.

The privileged job runs on the caller-selected runner (self-hosted by default;
see [Runners](#runners)) and never checks out or executes PR code, downloads
artifacts, restores caches, or expands secrets. PR fields enter APIs as data,
never executable shell or interpolated JavaScript. The official
`actions/github-script` action is pinned to an immutable audited SHA. Its v9
Node 24 runtime requires runner 2.327.1 or newer; GitHub-hosted runners and the
registered Oceanswave self-hosted runners are newer. Self-hosted application
builds remain caller-specific.

## Runners

Every reusable workflow takes a `runs-on` input: a JSON array of runner labels,
passed to each job as `runs-on: ${{ fromJSON(inputs.runs-on) }}`. The default
(except Python CI, which defaults to `"ubuntu-latest"`),
`'["self-hosted","Linux","X64"]'`, matches the labels every registered
Oceanswave runner carries. To use a GitHub-hosted runner, pass a JSON string,
which `fromJSON` also accepts:

```yaml
    with:
      runs-on: '"ubuntu-latest"'
```

Oceanswave is a personal account, so self-hosted runners are registered per
repository. A caller repository without its own registered runner must pass
`runs-on: '"ubuntu-latest"'`, or its jobs queue indefinitely. This repository
has no self-hosted runner, so its own CI passes `ubuntu-latest`. macOS/Xcode
jobs stay GitHub-hosted. A public repository using self-hosted runners must
require approval for workflow runs from all outside contributors. Callers pin
this repository by commit SHA, so existing callers keep their current runner
until they move their pin.

## Wrangler deploy

`wrangler-deploy.yml` deploys a Cloudflare Worker from `working-directory` with
`npx --yes wrangler@<wrangler-version> deploy`, so no `package.json` is needed.

```yaml
jobs:
  deploy:
    permissions:
      contents: read
    uses: Oceanswave/github-workflows/.github/workflows/wrangler-deploy.yml@v1
    with:
      working-directory: workers/api
      environment: production
      test-command: npm ci && npm test
      wrangler-args: --env production
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Inputs: `working-directory` (required); `environment` (optional GitHub
deployment environment); `node-version` (`22`); `test-command` (run in the
working directory before deploying); `wrangler-version` (exact version, pinned
by default); `wrangler-args` (whitespace-split, no shell quoting); and `dry-run`
(`false`). `dry-run: true` runs `wrangler deploy --dry-run` and needs no
Cloudflare secrets, which suits pull requests. Otherwise the job fails before
testing if either secret is empty. Pass both secrets by name; never use
`secrets: inherit`. They reach only the deploy step, never the test command.
The workflow never sets Worker secret values; manage those in Cloudflare. The
`deployment-url` output is the first deployed target Wrangler reports, or empty.

## Terraform

`terraform.yml` always runs a `plan` job (`fmt -check`, `init`, `validate`,
`plan -out=tfplan -input=false -lock-timeout=5m`) in `working-directory`, and an
`apply` job only when `apply: true`.

```yaml
jobs:
  terraform:
    permissions:
      contents: read
    uses: Oceanswave/github-workflows/.github/workflows/terraform.yml@v1
    with:
      working-directory: infra
      backend-config: backend.r2.hcl
      apply: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
      environment: production
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      TF_STATE_ACCESS_KEY_ID: ${{ secrets.TF_STATE_ACCESS_KEY_ID }}
      TF_STATE_SECRET_ACCESS_KEY: ${{ secrets.TF_STATE_SECRET_ACCESS_KEY }}
      TF_VARS_JSON: ${{ secrets.TF_VARS_JSON }}
```

Inputs: `working-directory` (required); `terraform-version` (exact version,
`1.9.8`); `apply` (`false`); `environment` (GitHub environment for the apply
job only, so protection rules gate apply but not plan); and `backend-config`
(file path relative to the working directory, passed as `-backend-config`).

All secrets are optional and exported only when non-empty, only to the steps
that need them: `CLOUDFLARE_API_TOKEN` as `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as `TF_VAR_cloudflare_account_id` (plan and apply);
`TF_STATE_ACCESS_KEY_ID` / `TF_STATE_SECRET_ACCESS_KEY` as `AWS_ACCESS_KEY_ID`
/ `AWS_SECRET_ACCESS_KEY` for an S3-compatible (for example R2) backend. Put
the bucket, endpoint and `skip_*` flags in the backend config file.
`TF_VARS_JSON` must be a JSON object; it is written with `umask 077` to a
`*.auto.tfvars.json` under `$RUNNER_TEMP`, outside the checkout, passed as
`-var-file`, and removed at the end of the job. Every string value in it is
masked, so keep non-secret variables in committed tfvars instead. Never use
`secrets: inherit`.

The step summary shows only add/change/replace/destroy counts. The plan log
itself is Terraform's normal output, so mark secret variables and outputs
`sensitive`. The plan file is never uploaded; the apply job re-plans and applies
that fresh plan with `-auto-approve`, serialized per working directory by the
`terraform-<working-directory>` concurrency group without cancellation.

## Python CI

Installs a Python package and runs its test command. It gets a read-only token,
no secrets and no persisted checkout credentials. Because it executes pull request
code, its `runs-on` defaults to `"ubuntu-latest"` (unlike the other workflows), and
a fork pull request is skipped rather than run on self-hosted labels.

```yaml
jobs:
  test:
    uses: Oceanswave/github-workflows/.github/workflows/python-ci.yml@<sha>
    with:
      runs-on: '"ubuntu-latest"'
      python-version: '3.12'          # default
      install-args: -e .[test]        # default; split on whitespace, passed to pip install
      test-command: |                 # default: python -m pytest -q
        python -m pytest -q tests
```

`test-command` runs under `bash -euo pipefail` in `working-directory` (default
`.`). Inputs reach the shell only through environment variables. The check run is
named `<caller job> / Python CI`, for example `test / Python CI`; use that name in
required status checks and in the merge helper's `required-checks`.

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
