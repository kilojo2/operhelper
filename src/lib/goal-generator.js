/**
 * Shared AI contract for the goal generator.
 * Used by the website, Electron application and browser extension.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GoalGenerator = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const TAGS = Object.freeze([
    { tag: 'feet', label: '#feet' },
    { tag: 'ass', label: '#ass' },
    { tag: 'tits', label: '#tits' },
    { tag: 'face', label: '#face' },
    { tag: 'lips', label: '#lips' },
    { tag: 'finger', label: '#finger' },
    { tag: 'pussy', label: '#pussy' }
  ]);

  const SYSTEM_PROMPT = [
    'Ты — генератор tip-menu goals для совершеннолетней вебкам-модели.',
    'Верни только валидный JSON-объект без markdown и пояснений.',
    'Точная схема: {"goals":[{"en":"English goal with 1-2 emoji","ru":"Точный перевод с 1-2 эмодзи"}]}.',
    'Каждая цель — короткая фраза-действие от лица модели и строго соответствует запрошенной категории.',
    'В JSON должно быть ровно 10 разных элементов; оба поля в каждом элементе обязательны.'
  ].join('\n');

  function normalizeTag(value) {
    const tag = String(value || '').trim().toLocaleLowerCase('en-US');
    return TAGS.some((item) => item.tag === tag) ? tag : '';
  }

  function buildMessages(tag, avoid, retry) {
    const normalizedTag = normalizeTag(tag);
    if (!normalizedTag) throw new Error('Выберите допустимую категорию цели.');
    const exclusions = Array.isArray(avoid)
      ? avoid.map((item) => String(item || '').trim()).filter(Boolean).slice(-30)
      : [];
    const instruction = [
      `Категория: #${normalizedTag}. Сгенерируй 10 новых целей.`,
      exclusions.length ? `Не повторяй эти цели: ${JSON.stringify(exclusions)}.` : '',
      retry ? 'Предыдущий ответ не прошёл проверку. Верни JSON заново и точно по схеме.' : ''
    ].filter(Boolean).join('\n');
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: instruction }
    ];
  }

  function parseResponse(content, aiJson, limit) {
    const parser = aiJson && typeof aiJson.parseGoalItems === 'function'
      ? aiJson : (typeof globalThis !== 'undefined' ? globalThis.AiJson : null);
    if (!parser || typeof parser.parseGoalItems !== 'function') {
      throw new Error('Модуль проверки JSON не загрузился.');
    }
    const items = parser.parseGoalItems(content, limit || 10);
    if (!items.length) throw new Error('ИИ не вернул цели в правильном формате.');
    return items;
  }

  return { TAGS, SYSTEM_PROMPT, normalizeTag, buildMessages, parseResponse };
});
