const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadSnapshot() {
  const source = fs.readFileSync(path.join(root, 'src', 'lib', 'manuals-data.js'), 'utf8');
  const sandbox = Object.create(null);
  vm.runInNewContext(source, sandbox, { filename: 'manuals-data.js' });
  return { source, data: sandbox.ManualsData };
}

function flatten(items, output = []) {
  for (const item of items) {
    output.push(item);
    if (Array.isArray(item.children)) flatten(item.children, output);
  }
  return output;
}

test('manual snapshot contains the complete deterministic knowledge base', () => {
  const { source, data } = loadSnapshot();
  const navigation = data.sections.flatMap((section) => flatten(section.items));

  assert.equal(data.version, 1);
  assert.equal(data.defaultSlug, 'account-login');
  assert.equal(data.sections.length, 3);
  assert.equal(navigation.length, 50);
  assert.equal(Object.keys(data.articles).length, 50);
  assert.deepEqual(
    Array.from(data.sections, (section) => section.items.length),
    [13, 9, 6]
  );
  assert.equal(data.stats.media, 56);
  assert.doesNotMatch(source, /generatedAt|timestamp|E:\\\\Anon Chat/i);

  for (const item of navigation) {
    assert.ok(data.articles[item.slug], `missing article ${item.slug}`);
    assert.equal(data.articles[item.slug].sourceHref, item.href);
  }
});

test('all article blocks and copied media are safe and locally resolvable', () => {
  const { data } = loadSnapshot();
  const allowed = new Set([
    'heading', 'subheading', 'paragraph', 'list', 'ordered-list', 'divider',
    'note', 'link-block', 'table', 'image', 'overview'
  ]);
  const images = [];

  for (const article of Object.values(data.articles)) {
    assert.ok(article.blocks.length > 0, `${article.slug} has no content`);
    assert.ok(article.searchText.includes(article.title));
    for (const block of article.blocks) {
      assert.ok(allowed.has(block.type), `unsupported block ${block.type}`);
      if (block.type !== 'image') continue;
      assert.match(block.src, /^manual-assets\/[a-z0-9-]+\/[a-z0-9._-]+$/i);
      const absolute = path.resolve(root, 'src', ...block.src.split('/'));
      assert.ok(absolute.startsWith(path.resolve(root, 'src') + path.sep));
      assert.ok(fs.existsSync(absolute), `missing media ${block.src}`);
      images.push(block.src);
    }
  }

  assert.equal(images.length, 56);
  assert.equal(new Set(images).size, 56);
});

test('four platform landing pages are synthesized from child manuals', () => {
  const { data } = loadSnapshot();
  const expected = ['chaturbate-guide', 'stripchat-guide', 'bongacams-guide', 'flirt4free-guide'];

  assert.deepEqual(
    Object.values(data.articles).filter((article) => article.kind === 'overview').map((article) => article.slug),
    expected
  );
  for (const slug of expected) {
    assert.equal(data.articles[slug].blocks.length, 1);
    assert.equal(data.articles[slug].blocks[0].type, 'overview');
    assert.ok(data.articles[slug].blocks[0].items.length > 0);
  }
});

test('sync parser keeps supported Markdown structure and drops unsafe markup', () => {
  const { parseMarkdown, normalizeContentBlock } = require('../tools/sync-manuals.cjs');
  const blocks = parseMarkdown([
    '## Заголовок',
    '',
    'Обычный **текст**.',
    '',
    '- первый',
    '- второй',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '**ВАЖНО:** заметка'
  ].join('\n'));

  assert.deepEqual(Array.from(blocks, (block) => block.type), [
    'heading', 'paragraph', 'list', 'table', 'note'
  ]);
  assert.throws(() => normalizeContentBlock({ type: 'script', content: 'alert(1)' }), /Неподдерживаемый/);
});
