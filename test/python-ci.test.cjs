const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const workflow = readFileSync(resolve(__dirname, '../.github/workflows/python-ci.yml'), 'utf8');
const steps = workflow.split('\n    steps:\n')[1].split(/\n      - /);
const step = name => steps.find(text => text.includes(`name: ${name}\n`));

test('Python CI pins actions and drops credentials', () => {
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  assert.equal(uses.length, 2);
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /permissions:\n      contents: read\n    defaults:/);
  assert.match(workflow, /timeout-minutes: \d+/);
  assert.doesNotMatch(workflow, /secrets[.:]/);
});

test('Python CI keeps caller inputs out of script text', () => {
  for (const [, script] of workflow.matchAll(/run: (\|\n(?:          .*\n|\n)*|.*)/g)) assert.doesNotMatch(script, /\$\{\{/);
  assert.match(step('Install'), /INSTALL_ARGS: \$\{\{ inputs\.install-args \}\}/);
  assert.match(step('Test'), /TEST_COMMAND: \$\{\{ inputs\.test-command \}\}\n        run: bash -euo pipefail -c "\$TEST_COMMAND"/);
});

test('Python CI never runs fork pull requests on self-hosted labels', () => {
  assert.match(workflow, /runs-on:\n        type: string\n        default: '"ubuntu-latest"'/);
  assert.match(workflow, /if: >-\n      !\(contains\(inputs\.runs-on, 'self-hosted'\) &&\n        github\.event_name == 'pull_request' &&\n        github\.event\.pull_request\.head\.repo\.full_name != github\.repository\)\n    runs-on: \$\{\{ fromJSON\(inputs\.runs-on\) \}\}/);
});
