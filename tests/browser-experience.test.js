const test = require('node:test');
const assert = require('node:assert/strict');
const BrowserExperience = require('../src/lib/browser-experience.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

test('локальная веб-база сохраняет исходы и возвращает релевантный опыт', () => {
  const store = BrowserExperience.create(memoryStorage(), 'test-experience');
  const saved = store.saveChat({
    history: 'user: i love feet\nmodel: what do u like most about them? :)',
    strategy: 'slow',
    stage: 'PUBLIC_ENGAGED',
    profileName: 'Sophie'
  });
  assert.equal(saved.ok, true);
  assert.equal(store.setOutcome({ chatId: saved.chatId, result: 'won_private' }).ok, true);

  const matching = store.experienceContext({
    history: 'user: your feet look beautiful',
    strategy: 'slow',
    stage: 'PUBLIC_READY',
    profileName: 'Sophie'
  });
  assert.equal(matching.count, 1);
  assert.match(matching.examplesBlock, /i love feet/);

  const wrongStage = store.experienceContext({
    history: 'user: your feet look beautiful',
    strategy: 'slow',
    stage: 'PRIVATE_ACTIVE',
    profileName: 'Sophie'
  });
  assert.equal(wrongStage.count, 0);

  const wrongModel = store.experienceContext({
    history: 'user: your feet look beautiful',
    strategy: 'slow',
    stage: 'PUBLIC_READY',
    profileName: 'Anna'
  });
  assert.equal(wrongModel.count, 0);
});

test('локальная веб-база строит аналитику, антипример и очищается', () => {
  const store = BrowserExperience.create(memoryStorage(), 'test-stats');
  const won = store.saveChat({
    history: 'user: hello\nmodel: hey :)', strategy: 'slow', stage: 'PUBLIC_WARMUP'
  });
  store.setOutcome({ chatId: won.chatId, result: 'won_tip' });
  const lost = store.saveChat({
    history: 'user: hello\nmodel: come private now', strategy: 'fast', stage: 'PUBLIC_WARMUP'
  });
  store.setOutcome({ chatId: lost.chatId, result: 'lost' });

  const stats = store.stats().stats;
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.won_tip, 1);
  assert.equal(stats.byStatus.lost, 1);
  assert.equal(stats.conversion, 50);
  assert.equal(stats.weeks.length, 6);

  const context = store.experienceContext({
    history: 'user: hello', strategy: 'slow', stage: 'PUBLIC_WARMUP'
  });
  assert.match(context.antiBlock, /come private now/);

  assert.equal(store.clear().deleted, 2);
  assert.equal(store.stats().stats.total, 0);
});

test('парсер локального опыта не путает обычные слова с ролями', () => {
  const parsed = BrowserExperience.parseHistory(
    'user experience matters\nmodel citizen\nuser: real message\nmodel: real reply');
  assert.deepEqual(parsed, [
    { role: 'user', text: 'real message' },
    { role: 'model', text: 'real reply' }
  ]);
});
