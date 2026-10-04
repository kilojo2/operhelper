const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('sidebar navigation uses one consistent SVG icon set without text glyphs', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
  const nav = html.match(/<nav id="tabs">([\s\S]*?)<\/nav>/)?.[1] || '';
  const buttons = nav.match(/<button class="tab(?: active)?"/g) || [];
  const references = [...nav.matchAll(/<use href="#(nav-[\w-]+)"><\/use>/g)].map((match) => match[1]);

  assert.equal(buttons.length, 6);
  assert.deepEqual(references, [
    'nav-chat', 'nav-headphones', 'nav-list', 'nav-wand', 'nav-chart', 'nav-sliders'
  ]);
  for (const id of references) assert.match(html, new RegExp(`<symbol id="${id}"`));
  assert.doesNotMatch(nav, /[✦♪◇⌁↗⚙]/);
  assert.doesNotMatch(nav, /<span class="tab-icon"[^>]*>\s*[^<\s]/);
  assert.match(css, /\.tab-icon svg\s*\{/);
  assert.match(css, /stroke:\s*currentColor/);
});
