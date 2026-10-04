/**
 * Общие парсеры: структурированный ответ ассистента и библиотека зазывов.
 * Работает и в браузере (window.Parser), и в Node-тестах (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Parser = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const REQUIRED_ASSISTANT_BLOCKS = [
    'АНАЛИЗ', 'СТРАТЕГИЯ', 'ОТВЕТ', 'АЛЬТЕРНАТИВА 1',
    'АЛЬТЕРНАТИВА 2', 'ПРОГНОЗ', 'ПОЧЕМУ'
  ];

  /* Разбор ответа модели на блоки [ЗАГОЛОВОК] ... содержимое */
  function parseAssistantResponse(text) {
    const out = {};
    if (!text) return out;
    const re = /\[([^\[\]]{2,40})\]\s*([\s\S]*?)(?=\n\[|$)/g;
    let m;
    while ((m = re.exec(String(text))) !== null) {
      out[m[1].trim().toUpperCase()] = m[2].trim();
    }
    return out;
  }

  function validateAssistantResponse(text) {
    const blocks = parseAssistantResponse(text);
    const counts = {};
    const re = /\[([^\[\]]{2,40})\]\s*/g;
    let match;
    while ((match = re.exec(String(text || ''))) !== null) {
      const name = match[1].trim().toUpperCase();
      counts[name] = (counts[name] || 0) + 1;
    }
    const missing = REQUIRED_ASSISTANT_BLOCKS.filter((name) => !blocks[name]);
    const duplicates = REQUIRED_ASSISTANT_BLOCKS.filter((name) => counts[name] > 1);
    const issues = [];
    if (missing.length) issues.push('нет блоков: ' + missing.join(', '));
    if (duplicates.length) issues.push('повторяются блоки: ' + duplicates.join(', '));
    if ((blocks['ОТВЕТ'] || '').length > 420) issues.push('блок ОТВЕТ длиннее 420 символов');
    return { valid: issues.length === 0, issues, missing, duplicates, blocks };
  }

  /* Библиотека зазывов: файл состоит из пар "EN строка" + "RU перевод",
     разделённых пустыми строками; русские строки без пары — заголовки. */
  function parseInvites(raw) {
    const items = [];
    if (!raw) return items;
    let pendingEn = null;
    for (const line of String(raw).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const hasRu = /[А-Яа-яЁё]/.test(t);
      if (!hasRu) {
        if (pendingEn) items.push({ en: pendingEn, ru: '' });
        pendingEn = t;
      } else if (pendingEn) {
        items.push({ en: pendingEn, ru: t });
        pendingEn = null;
      } else {
        items.push({ en: '', ru: t }); // русский заголовок раздела
      }
    }
    if (pendingEn) items.push({ en: pendingEn, ru: '' });
    return items.filter(i => i.en && i.en.length > 12);
  }

  return {
    parseAssistantResponse,
    validateAssistantResponse,
    parseInvites,
    REQUIRED_ASSISTANT_BLOCKS: REQUIRED_ASSISTANT_BLOCKS.slice()
  };
});
