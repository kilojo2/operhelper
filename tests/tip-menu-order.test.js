const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TipMenuOrder = require('../src/lib/tip-menu-order.js');

const root = path.join(__dirname, '..');
const categories = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tipmenu.json'), 'utf8'));

test('tip menu exposes five stages from warm-up to finale', () => {
  assert.deepEqual(TipMenuOrder.STAGES.map((stage) => stage.id), [
    'warmup', 'flirt', 'tease', 'explicit', 'finale'
  ]);
  assert.deepEqual(TipMenuOrder.STAGES.map((stage) => stage.number), ['01', '02', '03', '04', '05']);
});

test('classifier keeps intensity landmarks in the expected stages', () => {
  const examples = {
    warmup: ['💌 PM', '👀 Eyes contact', '💦 Cum tax', '🍆 Dick rate'],
    flirt: ['👅 Show tongue', '🦶 Show feet', '🙆‍♀️ Show armpits', '👗 Change outfit'],
    tease: ['👙 Panties tease', '🍑 Shake ass', '🍒 Oil tits', '👋🍑 Spank ass (×3 / ×5 / ×10)'],
    explicit: ['🥵 Get naked', '🍓 Spread pussy open', '🤠 Ride pillow'],
    finale: ['🤠🍆 Ride dildo', '🍑💎 Butt plug', '💦 Squirt', '🖖💧 Masturbate until cum']
  };

  for (const [stage, items] of Object.entries(examples)) {
    for (const item of items) assert.equal(TipMenuOrder.stageIdFor(item), stage, item);
  }
});

test('sorting is stable, monotonic and never loses menu entries', () => {
  const rank = new Map(TipMenuOrder.STAGES.map((stage, index) => [stage.id, index]));

  for (const category of categories) {
    const sorted = TipMenuOrder.sort(category.items);
    assert.equal(sorted.length, category.items.length, category.id);
    assert.deepEqual([...sorted].sort(), [...category.items].sort(), category.id);

    const levels = sorted.map((item) => rank.get(TipMenuOrder.stageIdFor(item)));
    for (let index = 1; index < levels.length; index += 1) {
      assert.ok(levels[index] >= levels[index - 1], `${category.id}: ${index}`);
    }

    for (const stage of TipMenuOrder.STAGES) {
      const before = category.items.filter((item) => TipMenuOrder.stageIdFor(item) === stage.id);
      const after = sorted.filter((item) => TipMenuOrder.stageIdFor(item) === stage.id);
      assert.deepEqual(after, before, `${category.id}: stable ${stage.id}`);
    }
  }
});

test('tip menu page loads and uses the ordering module', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

  assert.ok(html.indexOf('lib/tip-menu-order.js') < html.indexOf('app.js'));
  assert.match(html, /id="tmProgression"/);
  assert.match(app, /let tmActive = 'classic'/);
  assert.match(app, /category\.id !== 'goals'/);
  assert.match(app, /order\.stageIdFor\(item\) === stage\.id/);
  assert.match(css, /\.tm-stage-heading/);
  assert.match(css, /\.tm-progression/);
});
