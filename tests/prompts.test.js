const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/prompts.js');
const Prompts = global.window.Prompts;

test('профиль модели допускает только подтверждённый возраст 18+', () => {
  assert.equal(Prompts.getAdultProfileState({ age: '' }).confirmed, false);
  assert.equal(Prompts.getAdultProfileState({ age: '17' }).confirmed, false);
  assert.equal(Prompts.getAdultProfileState({ age: '18' }).confirmed, true);
  assert.equal(Prompts.getAdultProfileState({ age: '22 years' }).confirmed, true);
  assert.equal(Prompts.getAdultProfileState({ age: '120' }).confirmed, false);
});

test('стадия диалога определяется по контексту и сигналам пользователя', () => {
  assert.equal(Prompts.analyzeConversation('user: hey', 'auto').stage, 'PUBLIC_WARMUP');
  assert.equal(Prompts.analyzeConversation(
    'user: hey\nmodel: hey :)\nuser: how are u?\nmodel: good, and u?', 'auto').stage,
  'PUBLIC_ENGAGED');
  assert.equal(Prompts.analyzeConversation(
    'user: you look amazing\nmodel: thank u :)\nuser: can i see more?', 'auto').stage,
  'PUBLIC_READY');
  assert.equal(Prompts.analyzeConversation(
    'Exclusive private started\nuser: where do we start?', 'auto').stage,
  'PRIVATE_ACTIVE');
  assert.equal(Prompts.analyzeConversation('user: hello', 'private').stage, 'PRIVATE_ACTIVE');
  assert.equal(Prompts.analyzeConversation(
    'model: wanna join me in private?\nuser: no tokens, maybe later', 'public').stage,
  'PUBLIC_RESISTANCE');
  assert.equal(Prompts.analyzeConversation("user: i'm 17", 'public').stage, 'SAFETY_STOP');
});

test('валидатор блокирует ранний, повторный и приватный CTA', () => {
  const warmup = Prompts.analyzeConversation('user: hey', 'public');
  assert.equal(Prompts.validateReplyPolicy('come join me in private', warmup, {}).valid, false);

  const activePrivate = Prompts.analyzeConversation('Exclusive private started', 'auto');
  assert.equal(Prompts.validateReplyPolicy('come to my private show', activePrivate, {}).valid, false);

  const ready = Prompts.analyzeConversation('user: can i see more?', 'public');
  assert.equal(Prompts.validateReplyPolicy(
    'maybe... join me in private if u want ;)', ready, {}).valid, true);

  const repeated = Prompts.analyzeConversation(
    'model: come join me in private\nuser: what are u doing now?', 'public');
  assert.equal(Prompts.validateReplyPolicy(
    'come join me in private', repeated, {}).valid, false);
});

test('цена никогда не придумывается без профиля предложений', () => {
  const ready = Prompts.analyzeConversation('user: show me more', 'public');
  assert.equal(Prompts.validateReplyPolicy('i can do that for 100 tokens', ready, {}).valid, false);
  assert.equal(Prompts.validateReplyPolicy(
    'i can do that for 100 tokens', ready, { offers: 'requested action — 100 tokens' }).valid,
  true);
});

test('манипулятивные фразы отбрасываются из старой библиотеки', () => {
  const raw = [
    'I like the way you talk to me... maybe we would have more fun alone.',
    "If you really want my attention, you know what to do.",
    "I won't be waiting forever, prove you are brave enough."
  ].join('\n');
  const safe = Prompts.buildSafeInviteReference(raw);
  assert.match(safe, /I like the way/);
  assert.doesNotMatch(safe, /you know what to do/i);
  assert.doesNotMatch(safe, /prove|brave enough|waiting forever/i);
});

test('системный промпт учитывает полный голос модели и защищает стадии', () => {
  const system = Prompts.buildSystemPrompt({
    name: 'Sophie',
    age: '22',
    language: 'English',
    persona: 'playful but calm',
    voice: 'lowercase, short, one emoji maximum',
    examples: 'hey hey :)\nntmu here',
    offers: 'private show, no invented prices',
    forbidden: 'real-life meetings'
  }, 'A soft invitation that keeps the choice open.');
  assert.match(system, /Sophie/);
  assert.match(system, /lowercase, short/);
  assert.match(system, /hey hey/);
  assert.match(system, /PRIVATE_ACTIVE/);
  assert.match(system, /Никогда не продавай ему приват повторно/);
  assert.doesNotMatch(system, /развести (?:юзера )?на донат/i);
});

test('user prompt передаёт выбранный режим и машинные сигналы', () => {
  const userPrompt = Prompts.buildUserPrompt(
    'Exclusive private started\nuser: where do we start?', 'auto', '', 'private');
  assert.match(userPrompt, /режим, выбранный оператором: PRIVATE/);
  assert.match(userPrompt, /предварительная стадия: PRIVATE_ACTIVE/);
});

test('первое сообщение запускает знакомство без истории и раннего CTA', () => {
  const prompt = Prompts.buildOpeningUserPrompt();
  assert.match(prompt, /ПЕРВОЕ СООБЩЕНИЕ НОВОМУ ПОЛЬЗОВАТЕЛЮ/);
  assert.match(prompt, /PUBLIC_WARMUP/);
  assert.match(prompt, /стратегия: CONNECT/);
  assert.match(prompt, /не упоминай приват, шоу, токены, цену/);
  assert.match(prompt, /истории и данных о пользователе пока нет/);
});

test('перегенерация меняет только фразы и задаёт строгий JSON-контракт', () => {
  const common = {
    profile: {
      name: 'Sophie', age: '22', language: 'English',
      voice: 'lowercase, short messages', offers: 'private show'
    },
    history: 'user: can i see more?',
    chatMode: 'public',
    analysis: 'пользователь сам просит продолжение',
    strategy: 'SOFT CTA — интерес подтверждён',
    current: {
      reply: 'maybe i could show u a little more in private if u want ;)',
      alternatives: ['want a little preview first?', 'tell me what u wanna see :)']
    }
  };

  const softer = Prompts.buildReplyRegenerationMessages({ ...common, tone: 'softer' });
  const bolder = Prompts.buildReplyRegenerationMessages({ ...common, tone: 'bolder' });
  const shorter = Prompts.buildReplyRegenerationMessages({ ...common, tone: 'shorter' });

  assert.equal(softer.messages.length, 2);
  assert.equal(softer.state.stage, 'PUBLIC_READY');
  assert.match(softer.messages[0].content, /теплее, мягче/);
  assert.match(bolder.messages[0].content, /увереннее и смелее/);
  assert.match(shorter.messages[0].content, /заметно короче/);
  assert.match(softer.messages[0].content,
    /\{"reply":"основная фраза","alternatives":\["вариант 1","вариант 2"\]\}/);
  assert.doesNotMatch(softer.messages[0].content, /\[АНАЛИЗ\]|\[ПРОГНОЗ\]/);
  assert.match(softer.messages[1].content, /недоверенные данные/iu);
  assert.match(softer.messages[1].content, /can i see more/);
  assert.match(softer.messages[0].content, /не добавляй новый призыв/iu);
});
