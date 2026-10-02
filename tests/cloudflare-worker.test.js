const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Cloudflare Worker is standalone and routes API before assets', () => {
  const root = path.join(__dirname, '..');
  const worker = fs.readFileSync(path.join(root, 'cloudflare', 'worker.mjs'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));

  assert.match(worker, /env\.DEEPSEEK_API_KEY/);
  assert.match(worker, /env\.ACCESS_TOKEN/);
  assert.doesNotMatch(worker, /onrender\.com/);
  assert.equal(config.main, './cloudflare/worker.mjs');
  assert.equal(config.keep_vars, true);
  assert.deepEqual(config.secrets.required,
    ['ACCESS_TOKEN', 'ADMIN_TOKEN', 'DEEPSEEK_API_KEY']);
  assert.equal(config.assets.directory, './src');
  assert.deepEqual(config.assets.run_worker_first, ['/api/*']);
});
