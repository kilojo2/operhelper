const test = require('node:test');
const assert = require('node:assert/strict');
const AssistantResult = require('../src/lib/assistant-result.js');
const Parser = require('../src/lib/parser.js');

const SOURCE = [
  '[АНАЛИЗ]',
  'Пользователь вовлечён и задаёт вопрос.',
  '[СТРАТЕГИЯ]',
  'SLOW — продолжить лёгкий флирт.',
  '[ОТВЕТ]',
  'Original reply',
  '[АЛЬТЕРНАТИВА 1]',
  'Original alternative one',
  '[АЛЬТЕРНАТИВА 2]',
  'Original alternative two',
  '[ПРОГНОЗ]',
  'Скорее всего ответит вопросом.',
  '[ПОЧЕМУ]',
  'Фраза сохраняет естественный темп.'
].join('\n');

test('structures the seven-block response for the result UI', () => {
  const result = AssistantResult.toViewModel(SOURCE);
  assert.equal(result.reply, 'Original reply');
  assert.deepEqual(result.alternatives, [
    'Original alternative one',
    'Original alternative two'
  ]);
  assert.equal(result.analysis, 'Пользователь вовлечён и задаёт вопрос.');
  assert.match(result.strategy, /^SLOW/);
  assert.equal(result.forecast, 'Скорее всего ответит вопросом.');
  assert.equal(result.why, 'Фраза сохраняет естественный темп.');
  assert.equal(result.complete, true);
  assert.deepEqual(result.missingReplyBlocks, []);
});

test('replaces only the three visible reply blocks and preserves service analysis', () => {
  const before = Parser.parseAssistantResponse(SOURCE);
  const updated = AssistantResult.replaceReplyBlocks(SOURCE, {
    reply: 'A softer reply',
    alternatives: ['A shorter option', 'A bolder option']
  });
  const after = Parser.parseAssistantResponse(updated);

  assert.equal(after['ОТВЕТ'], 'A softer reply');
  assert.equal(after['АЛЬТЕРНАТИВА 1'], 'A shorter option');
  assert.equal(after['АЛЬТЕРНАТИВА 2'], 'A bolder option');
  for (const block of ['АНАЛИЗ', 'СТРАТЕГИЯ', 'ПРОГНОЗ', 'ПОЧЕМУ']) {
    assert.equal(after[block], before[block], `${block} must not change`);
  }
});

test('parses and normalizes a regeneration JSON response', () => {
  const parsed = AssistantResult.parseRegeneratedReply([
    '```json',
    '{"reply":"  Main   reply  ","alternatives":["First option","Second   option"]}',
    '```'
  ].join('\n'));
  assert.deepEqual(parsed, {
    reply: 'Main reply',
    alternatives: ['First option', 'Second option']
  });
});

test('rejects malformed, incomplete, duplicated, and block-injecting variants', () => {
  assert.throws(() => AssistantResult.parseRegeneratedReply('{bad json'), /валидным JSON/);
  assert.throws(() => AssistantResult.parseRegeneratedReply({
    reply: 'Only reply', alternatives: ['Just one']
  }), /ровно 2 варианта/);
  assert.equal(AssistantResult.validateReplyVariants({
    reply: 'Only reply', alternatives: ['Just one']
  }).valid, false);
  assert.equal(AssistantResult.validateReplyVariants({
    reply: 'Same', alternatives: ['same', 'Other']
  }).valid, false);
  assert.equal(AssistantResult.validateReplyVariants({
    reply: '[АНАЛИЗ] injected', alternatives: ['One', 'Two']
  }).valid, false);
});

test('refuses to rewrite an incomplete source response', () => {
  assert.throws(() => AssistantResult.replaceReplyBlocks('[ОТВЕТ]\nOnly block', {
    reply: 'New reply', alternatives: ['One', 'Two']
  }), /АЛЬТЕРНАТИВА 1/);
});
