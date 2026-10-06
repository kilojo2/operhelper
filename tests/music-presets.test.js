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

test('each music slot receives a persistent and bounded volume level', () => {
  const store = storage();
  const initial = MusicPresets.loadVolumes(store);
  assert.equal(initial.length, MusicPresets.SLOT_COUNT);
  assert.deepEqual(initial, new Array(MusicPresets.SLOT_COUNT).fill(MusicPresets.DEFAULT_VOLUME));

  initial[0] = 0;
  initial[1] = 37.6;
  initial[2] = 500;
  initial[3] = -20;
  MusicPresets.saveVolumes(store, initial);
  const saved = MusicPresets.loadVolumes(store);
  assert.deepEqual(saved.slice(0, 4), [0, 38, 100, 0]);
  assert.equal(MusicPresets.normalizeVolume('not a number'), MusicPresets.DEFAULT_VOLUME);
});

test('mini player enables YouTube API volume control and renders a slider', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  assert.match(app, /enablejsapi', '1'/);
  assert.match(app, /new YT\.Player\(fr/);
  assert.match(app, /youtubePlayer\.setVolume\(nextVolume\)/);
  assert.match(app, /class="m-volume" type="range"/);
  assert.match(css, /\.music-volume/);
  assert.match(html, /script-src 'self' https:\/\/www\.youtube\.com/);
});
