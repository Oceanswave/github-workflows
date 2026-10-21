const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const workflow = readFileSync(resolve(__dirname, '../.github/workflows/terraform.yml'), 'utf8');
const [planJob, applyJob] = workflow.split('\n  apply:\n');
const stepsOf = job => job.split('\n    steps:\n')[1].split(/\n      - /);
const step = (job, name) => stepsOf(job).find(text => text.includes(`name: ${name}\n`));

test('Terraform pins actions and drops credentials', () => {
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  for (const job of [planJob, applyJob]) {
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /permissions:\n      contents: read\n/);
    assert.match(job, /timeout-minutes: \d+/);
    assert.match(job, /terraform_wrapper: false/);
  }
  assert.match(workflow, /terraform-version:\n        type: string\n        default: '\d+\.\d+\.\d+'/);
});

test('Terraform keeps caller inputs and secrets out of script text', () => {
  for (const [, script] of workflow.matchAll(/run: (\|\n(?:          .*\n|\n)*|.*)/g)) assert.doesNotMatch(script, /\$\{\{/);
  assert.doesNotMatch(workflow, /secrets: inherit|upload-artifact|GITHUB_ENV/);
  assert.doesNotMatch(workflow, /^    env:\n(?:      .*\n)*?      \S+: \$\{\{ secrets\./m);
});

test('Only steps that need credentials receive them', () => {
  for (const name of ['Validate inputs', 'Terraform fmt', 'Terraform validate']) {
    assert.doesNotMatch(step(planJob, name), /secrets\./);
  }
  assert.doesNotMatch(step(planJob, 'Terraform init'), /CLOUDFLARE|TF_VARS_JSON/);
  assert.doesNotMatch(step(planJob, 'Summarize plan'), /CLOUDFLARE|TF_VARS_JSON/);
  assert.match(step(planJob, 'Write secret tfvars'), /umask 077 && printf '%s' "\$TF_VARS_JSON" > "\$RUNNER_TEMP\//);
  assert.doesNotMatch(step(planJob, 'Write secret tfvars'), /(echo|cat)[^\n]*\$TF_VARS_JSON/);
});

test('Plan summary reports counts only and apply is gated', () => {
  assert.match(step(planJob, 'Terraform plan'), /terraform plan -out=tfplan -input=false -lock-timeout=5m/);
  assert.match(step(planJob, 'Summarize plan'), /terraform show -json tfplan \| jq/);
  assert.match(applyJob, /needs: plan\n    if: inputs\.apply\n/);
  assert.match(applyJob, /environment: \$\{\{ inputs\.environment \|\| null \}\}/);
  assert.match(applyJob, /group: terraform-\$\{\{ inputs\.working-directory \}\}\n      cancel-in-progress: false/);
  assert.match(step(applyJob, 'Terraform plan and apply'), /terraform plan -out=tfplan[\s\S]*terraform apply -auto-approve -input=false -lock-timeout=5m tfplan/);
});
