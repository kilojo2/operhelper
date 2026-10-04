const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MusicPresets = require('../src/lib/music-presets.js');

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    value: (key) => data.get(key)
  };
}

test('new users receive five editable YouTube presets and five empty slots', () => {
  const store = storage();
  const list = MusicPresets.load(store);
  assert.equal(list.length, 10);
  assert.deepEqual(list.slice(0, 5), Array.from(MusicPresets.DEFAULT_URLS));
  assert.deepEqual(list.slice(5), ['', '', '', '', '']);
  assert.deepEqual(JSON.parse(store.value(MusicPresets.STORAGE_KEY)), list);
});

test('one-time migration fills only empty legacy slots and preserves custom links', () => {
  const legacy = new Array(10).fill('');
  legacy[0] = 'https://youtu.be/custom00001';
  legacy[6] = 'https://www.youtube.com/watch?v=custom00002';
  const store = storage({ [MusicPresets.LEGACY_KEY]: JSON.stringify(legacy) });
  const list = MusicPresets.load(store);
  assert.equal(list[0], legacy[0]);
  assert.equal(list[1], MusicPresets.DEFAULT_URLS[1]);
  assert.equal(list[6], legacy[6]);
});

test('saved user changes and intentionally cleared fields are not overwritten', () => {
  const edited = [
    '',
    'https://youtu.be/edited00001',
    ...new Array(8).fill('')
  ];
  const store = storage({ [MusicPresets.STORAGE_KEY]: JSON.stringify(edited) });
  assert.deepEqual(MusicPresets.load(store), edited);

  const next = edited.slice();
  next[2] = 'https://www.youtube.com/watch?v=edited00002';
  MusicPresets.save(store, next);
  assert.deepEqual(MusicPresets.load(store), next);
});

test('all supplied presets are valid YouTube watch links and the module loads before app.js', () => {
  for (const value of MusicPresets.DEFAULT_URLS) {
    const url = new URL(value);
    assert.equal(url.hostname, 'www.youtube.com');
    assert.equal(url.pathname, '/watch');
    assert.match(url.searchParams.get('v') || '', /^[\w-]{11}$/);
  }

  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.ok(html.indexOf('lib/music-presets.js') < html.indexOf('app.js'));
});
