const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const read = name => readFileSync(resolve(__dirname, '../.github/workflows', name), 'utf8');
const jobs = workflow => workflow.split('\njobs:\n')[1].split(/\n(?=  [\w-]+:\n)/);

for (const name of ['merge.yml', 'wrangler-deploy.yml', 'terraform.yml', 'python-ci.yml']) {
  test(`${name} runs every job on the caller-selected runner`, () => {
    const workflow = read(name);
    assert.match(workflow, /workflow_call:\n    inputs:\n(?:      .*\n|        .*\n)*      runs-on:\n        type: string\n        default: '\["self-hosted","Linux","X64"\]'\n/);
    const blocks = jobs(workflow);
    assert.ok(blocks.length > 0);
    for (const job of blocks) {
      assert.deepEqual([...job.matchAll(/^    runs-on: (.*)$/gm)].map(match => match[1]), ['${{ fromJSON(inputs.runs-on) }}']);
    }
  });
}

test('CI observe job passes a GitHub-hosted runner to the shared merge workflow', () => {
  const observe = jobs(read('ci.yml')).find(job => job.startsWith('  observe:'));
  assert.match(observe, /uses: \.\/\.github\/workflows\/merge\.yml\n    with:\n(?:      .*\n)*      runs-on: '"ubuntu-latest"'\n/);
});
