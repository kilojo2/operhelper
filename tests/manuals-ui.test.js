const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'src', 'lib', 'manuals.js'), 'utf8');

function loadData() {
  const sandbox = Object.create(null);
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'src', 'lib', 'manuals-data.js'), 'utf8'),
    sandbox
  );
  return sandbox.ManualsData;
}

test('Manuals is the seventh navigation destination and loads before app integration', () => {
  const nav = html.match(/<nav id="tabs">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.equal((nav.match(/<button class="tab(?: active)?"/g) || []).length, 7);
  assert.match(nav, /data-tab="manuals"/);
  assert.match(nav, /<use href="#nav-book"><\/use>/);
  assert.match(html, /<section id="tab-manuals"[^>]*class="[^"]*manuals-page/);

  const dataIndex = html.indexOf('lib/manuals-data.js');
  const moduleIndex = html.indexOf('lib/manuals.js');
  const appIndex = html.indexOf('app.js');
  assert.ok(dataIndex >= 0 && dataIndex < moduleIndex && moduleIndex < appIndex);
  assert.match(app, /Manuals\.init\(\)/);
  assert.match(app, /Manuals\.onShow\(\)/);
});

test('manual UI includes inner navigation, search, persistence and responsive drawer', () => {
  for (const id of [
    'manualsSearch', 'manualsSearchResults', 'manualsMenuBtn', 'manualsSidebar',
    'manualsTree', 'manualsOverlay', 'manualsArticle'
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(moduleSource, /oh_manuals_v1/);
  assert.match(moduleSource, /localStorage\.setItem/);
  assert.match(moduleSource, /ctrlKey\s*\|\|\s*event\.metaKey/);
  assert.match(css, /\.manuals-sidebar\.open/);
  assert.match(css, /\.manuals-overlay\.hidden/);
  assert.match(css, /grid-template-columns:\s*repeat\(7,/);
  assert.match(css, /\.manual-table-wrap[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.manual-figure img[^}]*max-height:/);
});

test('search finds titles and body text with stable ordering', () => {
  const Manuals = require('../src/lib/manuals.js');
  const data = loadData();
  const login = Manuals.searchArticles(data, 'вход аккаунт', 10);
  const body = Manuals.searchArticles(data, 'obs', 10);

  assert.equal(login[0].slug, 'account-login');
  assert.ok(body.length > 0);
  assert.deepEqual(Manuals.searchArticles(data, 'x', 10), []);
  assert.equal(Manuals.normalizeSearch(' ЁЖ  '), 'еж');
});

test('manual renderer accepts only http and https external URLs and never injects source HTML', () => {
  const Manuals = require('../src/lib/manuals.js');
  assert.equal(Manuals.isSafeExternalUrl('https://example.com/path'), true);
  assert.equal(Manuals.isSafeExternalUrl('http://example.com'), true);
  assert.equal(Manuals.isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(Manuals.isSafeExternalUrl('file:///etc/passwd'), false);
  assert.doesNotMatch(moduleSource, /\.innerHTML\s*=/);
  assert.match(moduleSource, /root\.api\.openExternal\(url\)/);
  assert.match(moduleSource, /textContent\s*=/);
});

