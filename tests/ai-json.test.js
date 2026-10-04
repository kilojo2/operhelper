const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AiJson = require('../src/lib/ai-json.js');

test('parses the current JSON object schema and the legacy array schema', () => {
  const objectItems = AiJson.parseGoalItems(JSON.stringify({
    goals: [{ en: 'A fresh goal ✨', ru: 'Новая цель ✨' }]
  }));
  const arrayItems = AiJson.parseGoalItems(JSON.stringify([
    { en: 'Legacy goal 👀', ru: 'Старая цель 👀' }
  ]));
  assert.deepEqual(objectItems, [{ en: 'A fresh goal ✨', ru: 'Новая цель ✨' }]);
  assert.deepEqual(arrayItems, [{ en: 'Legacy goal 👀', ru: 'Старая цель 👀' }]);
});

test('extracts JSON from markdown without greedy square-bracket matching', () => {
  const response = [
    'Here is [the requested result]:',
    '```json',
    '{"goals":[{"en":"Category goal 🍑","ru":"Цель категории 🍑"}]}',
    '```',
    'No extra [data].'
  ].join('\n');
  assert.deepEqual(AiJson.parseGoalItems(response), [
    { en: 'Category goal 🍑', ru: 'Цель категории 🍑' }
  ]);
});

test('repairs common AI JSON mistakes and salvages valid goal objects', () => {
  const missingComma = '[{"en":"First goal ✨","ru":"Первая цель ✨"}{"en":"Second goal 🍑","ru":"Вторая цель 🍑"},]';
  assert.equal(AiJson.parseGoalItems(missingComma).length, 2);

  const unescapedQuotes = '{"goals":[{"en":"Show my "peach" 🍑","ru":"Показать "персик" 🍑"}]}';
  assert.deepEqual(AiJson.parseGoalItems(unescapedQuotes), [
    { en: 'Show my "peach" 🍑', ru: 'Показать "персик" 🍑' }
  ]);
});

test('validates required fields, removes duplicates and applies the limit', () => {
  const goals = [
    { en: 'One ✨', ru: 'Один ✨' },
    { en: 'one ✨', ru: 'Дубль ✨' },
    { en: '', ru: 'Нет EN' },
    { en: 'No translation', ru: '' },
    { en: 'Two 👀', ru: 'Два 👀' }
  ];
  assert.deepEqual(AiJson.parseGoalItems(JSON.stringify({ goals }), 2), [
    { en: 'One ✨', ru: 'Один ✨' },
    { en: 'Two 👀', ru: 'Два 👀' }
  ]);
});

test('goal generation enables DeepSeek JSON mode and an automatic retry', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  for (const file of ['main.js', 'web/server.js', 'cloudflare/worker.mjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /response_format\s*=\s*\{\s*type:\s*'json_object'\s*\}/);
  }
  assert.match(app, /responseFormat:\s*'json_object'/);
  assert.match(app, /requestAiGoalBatch\(cfg, true\)/);
  assert.doesNotMatch(app, /match\(\/\\\[\[\\s\\S\]\*\\\]\//);
});
