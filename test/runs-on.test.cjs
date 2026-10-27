const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const read = name => readFileSync(resolve(__dirname, '../.github/workflows', name), 'utf8');
const jobs = workflow => workflow.split('\njobs:\n')[1].split(/\n(?=  [\w-]+:\n)/);

// Workflows that execute caller code from pull requests default to GitHub-hosted runners.
const defaults = {
  'merge.yml': `'["self-hosted","Linux","X64"]'`,
  'wrangler-deploy.yml': `'["self-hosted","Linux","X64"]'`,
  'terraform.yml': `'["self-hosted","Linux","X64"]'`,
  'python-ci.yml': `'"ubuntu-latest"'`,
};
for (const [name, runner] of Object.entries(defaults)) {
  test(`${name} runs every job on the caller-selected runner`, () => {
    const workflow = read(name);
    const escaped = runner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(workflow, new RegExp(`workflow_call:\\n    inputs:\\n(?:      .*\\n|        .*\\n)*      runs-on:\\n        type: string\\n        default: ${escaped}\\n`));
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
