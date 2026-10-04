/**
 * Локальная база опыта для статической Cloudflare-версии.
 * Данные остаются в localStorage текущего браузера и удаляются пользователем.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrowserExperience = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORE_VERSION = 1;
  const OUTCOMES = new Set(['won_private', 'won_tip', 'lost', 'open']);
  const STOP_WORDS = new Set((
    'the and you your that this with what when where how are was were have has had not for from ' +
    'they them their will would could should about there here been into only very just want wanna ' +
    'need know think really right okay yes yeah hey hello babe baby honey love good nice much please ' +
    'это что как так для был была были быть его она они уже ещё когда чтобы если но не на со от до ' +
    'про при или очень просто хорошо привет хочу нравится можно нужно сейчас потом тогда'
  ).split(/\s+/));

  function cleanText(value, max) {
    return String(value == null ? '' : value).replace(/\u0000/g, '').slice(0, max || 5000);
  }

  function parseHistory(history) {
    const messages = [];
    for (const sourceLine of String(history || '').split(/\r?\n/)) {
      const line = sourceLine.trim();
      if (!line) continue;
      let match = line.match(/^(?:user|member|viewer|fan|customer|client)\s*[:\-]\s*(.+)$/iu);
      if (match) {
        messages.push({ role: 'user', text: cleanText(match[1], 2000) });
        continue;
      }
      match = line.match(/^(?:model|assistant|operator|me)\s*[:\-]\s*(.+)$/iu);
      if (match) messages.push({ role: 'model', text: cleanText(match[1], 2000) });
    }
    if (!messages.length && String(history || '').trim()) {
      messages.push({ role: 'raw', text: cleanText(String(history).trim(), 5000) });
    }
    return messages;
  }

  function keywords(text) {
    return cleanText(text, 20000).toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/giu, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  }

  function stageFamily(stage) {
    const value = String(stage || '').toUpperCase();
    if (value.includes('PRIVATE')) return 'private';
    if (value.includes('AFTERCARE')) return 'aftercare';
    if (value.includes('SAFETY')) return 'safety';
    return 'public';
  }

  function weekKey(timestamp) {
    const date = new Date(timestamp);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    return date.toISOString().slice(0, 10);
  }

  function create(storage, key) {
    const storeKey = key || 'oh_experience_v1';

    function emptyState() {
      return { version: STORE_VERSION, seq: 0, chats: [] };
    }

    function load() {
      try {
        const value = JSON.parse(storage.getItem(storeKey) || 'null');
        if (!value || value.version !== STORE_VERSION || !Array.isArray(value.chats)) return emptyState();
        return value;
      } catch {
        return emptyState();
      }
    }

    function persist(state) {
      storage.setItem(storeKey, JSON.stringify(state));
    }

    function saveChat(payload) {
      const history = cleanText(payload && payload.history, 100000).trim();
      if (history.length < 5) return { ok: false, error: 'Сначала добавьте историю чата' };
      const state = load();
      const messages = parseHistory(history);
      const now = Date.now();
      const id = ++state.seq;
      state.chats.push({
        id,
        history,
        messages,
        strategy: cleanText(payload && payload.strategy, 30),
        stage: cleanText(payload && payload.stage, 40),
        chatMode: cleanText(payload && payload.chatMode, 20),
        profileName: cleanText(payload && payload.profileName, 120),
        platform: cleanText(payload && payload.platform, 120),
        result: 'open',
        createdAt: now,
        updatedAt: now
      });
      persist(state);
      return { ok: true, chatId: id, msgCount: messages.length };
    }

    function setOutcome(payload) {
      const id = Number(payload && payload.chatId);
      const result = cleanText(payload && payload.result, 30);
      if (!OUTCOMES.has(result)) return { ok: false, error: 'Недопустимый исход' };
      const state = load();
      const chat = state.chats.find((item) => item.id === id);
      if (!chat) return { ok: false, error: 'Диалог не найден' };
      chat.result = result;
      chat.updatedAt = Date.now();
      persist(state);
      return { ok: true };
    }

    function buildStats(state) {
      const chats = state.chats;
      const byStatus = { open: 0, won_private: 0, won_tip: 0, lost: 0 };
      const strategyMap = new Map();
      for (const chat of chats) {
        byStatus[chat.result] = (byStatus[chat.result] || 0) + 1;
        const strategy = chat.strategy || '—';
        if (!strategyMap.has(strategy)) strategyMap.set(strategy, { strategy, total: 0, won: 0 });
        const row = strategyMap.get(strategy);
        row.total++;
        if (chat.result === 'won_private' || chat.result === 'won_tip') row.won++;
      }
      const won = byStatus.won_private + byStatus.won_tip;
      const frequency = new Map();
      for (const chat of chats.filter((item) => item.result === 'won_private' || item.result === 'won_tip')) {
        for (const word of new Set(keywords(chat.history))) {
          frequency.set(word, (frequency.get(word) || 0) + 1);
        }
      }
      const topTopics = [...frequency.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([topic, count]) => ({ topic, count }));

      const weekMap = new Map();
      const today = new Date();
      for (let offset = 5; offset >= 0; offset--) {
        const date = new Date(today.getTime() - offset * 7 * 86400000);
        weekMap.set(weekKey(date), { label: weekKey(date), total: 0, won: 0 });
      }
      for (const chat of chats) {
        const week = weekMap.get(weekKey(chat.createdAt));
        if (!week) continue;
        week.total++;
        if (chat.result === 'won_private' || chat.result === 'won_tip') week.won++;
      }
      return {
        total: chats.length,
        conversion: chats.length ? Math.round(won / chats.length * 1000) / 10 : 0,
        revenue: 0,
        avgMsgs: chats.length
          ? Math.round(chats.reduce((sum, chat) => sum + chat.messages.length, 0) / chats.length * 10) / 10
          : 0,
        byStatus,
        byStrategy: [...strategyMap.values()].sort((a, b) => b.total - a.total),
        topTopics,
        weeks: [...weekMap.values()]
      };
    }

    function rank(chat, query) {
      if (stageFamily(chat.stage) !== stageFamily(query.stage)) return -100;
      if (chat.profileName && query.profileName && chat.profileName !== query.profileName) return -50;
      const queryWords = new Set(keywords(query.history));
      const chatWords = new Set(keywords(chat.history));
      let overlap = 0;
      for (const word of queryWords) if (chatWords.has(word)) overlap++;
      let score = overlap * 3;
      if (query.strategy && chat.strategy === query.strategy) score += 2;
      if (query.profileName && chat.profileName === query.profileName) score += 2;
      if (Date.now() - chat.updatedAt < 90 * 86400000) score += 1;
      return score;
    }

    function experienceContext(payload) {
      const query = payload || {};
      const state = load();
      const successful = state.chats
        .filter((chat) => chat.result === 'won_private' || chat.result === 'won_tip')
        .map((chat) => ({ chat, score: rank(chat, query) }))
        .filter((item) => item.score >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      const examplesBlock = successful.length
        ? 'ПРОВЕРЕННЫЕ ПРИМЕРЫ ИЗ ЛОКАЛЬНОГО ОПЫТА (сохраняй принцип и голос, не копируй дословно и не переноси откровенность между стадиями):\n' +
          successful.map(({ chat }, index) =>
            `--- Пример ${index + 1} (стадия: ${chat.stage || 'не указана'}, исход: ${chat.result}) ---\n` +
            cleanText(chat.history, 1400)).join('\n')
        : '';

      const lost = state.chats
        .filter((chat) => chat.result === 'lost')
        .map((chat) => ({ chat, score: rank(chat, query) }))
        .filter((item) => item.score >= 0)
        .sort((a, b) => b.score - a.score)[0];
      const antiBlock = lost
        ? 'ПОХОЖИЙ НЕУДАЧНЫЙ ДИАЛОГ (не копируй его давление или ошибки):\n' + cleanText(lost.chat.history, 1000)
        : '';

      const stats = buildStats(state);
      const statsBlock = stats.total
        ? `ЛОКАЛЬНАЯ СТАТИСТИКА: ${stats.total} диалогов, отмеченная конверсия ${stats.conversion}%. ` +
          'Это слабая подсказка, а не повод давить на пользователя.'
        : '';
      return {
        ok: true,
        count: successful.length,
        examplesBlock,
        statsBlock,
        antiBlock
      };
    }

    function stats() {
      return { ok: true, stats: buildStats(load()) };
    }

    function clear() {
      const state = load();
      const deleted = state.chats.length;
      persist(emptyState());
      return { ok: true, deleted };
    }

    return { saveChat, setOutcome, experienceContext, stats, clear, parseHistory };
  }

  return { create, parseHistory, stageFamily };
});
