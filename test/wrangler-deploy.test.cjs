const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const workflow = readFileSync(resolve(__dirname, '../.github/workflows/wrangler-deploy.yml'), 'utf8');
const steps = workflow.split('\n    steps:\n')[1].split(/\n      - /);
const step = name => steps.find(text => text.includes(`name: ${name}\n`));

test('Wrangler deploy pins actions and drops credentials', () => {
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /permissions:\n      contents: read\n    environment:/);
  assert.match(workflow, /timeout-minutes: \d+/);
});

test('Wrangler deploy keeps caller inputs out of script text', () => {
  for (const [, script] of workflow.matchAll(/run: (\|\n(?:          .*\n|\n)*|.*)/g)) assert.doesNotMatch(script, /\$\{\{/);
  assert.doesNotMatch(workflow, /secrets: inherit|secret put|secret bulk/);
  assert.match(workflow, /wrangler-version:\n        type: string\n        default: '\d+\.\d+\.\d+'/);
});

test('Wrangler dry run and tests never receive Cloudflare secrets', () => {
  assert.doesNotMatch(step('Wrangler deploy (dry run)'), /secrets\./);
  assert.match(step('Wrangler deploy (dry run)'), /if: inputs\.dry-run\n[\s\S]*deploy --dry-run/);
  assert.doesNotMatch(step('Test'), /secrets\./);
  assert.match(step('Wrangler deploy'), /if: \$\{\{ !inputs\.dry-run \}\}/);
  assert.match(step('Validate inputs and credentials'), /if \[\[ "\$DRY_RUN" != 'true' \]\]/);
});
