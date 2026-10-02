const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('Cloudflare Worker proxies API and serves static assets', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'cloudflare', 'worker.mjs')).href;
  const worker = (await import(moduleUrl)).default;
  const originalFetch = global.fetch;
  let upstreamRequest = null;
  let assetRequested = false;

  try {
    global.fetch = async (input, init) => {
      upstreamRequest = { input: String(input), init };
      return Response.json({ ok: true });
    };
    const env = {
      ASSETS: {
        fetch: async () => {
          assetRequested = true;
          return new Response('asset');
        }
      }
    };

    const apiResponse = await worker.fetch(new Request(
      'https://operhelper.killasnazz.workers.dev/api/config?x=1',
      { headers: { 'X-Access-Token': 'test-token' } }
    ), env);
    assert.equal(apiResponse.status, 200);
    assert.equal(upstreamRequest.input, 'https://operhelper.onrender.com/api/config?x=1');
    assert.equal(upstreamRequest.init.headers.get('X-Access-Token'), 'test-token');
    assert.equal(upstreamRequest.init.headers.get('Origin'),
      'https://operhelper.killasnazz.workers.dev');

    const assetResponse = await worker.fetch(new Request(
      'https://operhelper.killasnazz.workers.dev/styles.css'
    ), env);
    assert.equal(await assetResponse.text(), 'asset');
    assert.equal(assetRequested, true);
  } finally {
    global.fetch = originalFetch;
  }
});
