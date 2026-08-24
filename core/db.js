/**
 * База данных «опыта» — фундамент самообучения ассистента (Фаза 1).
 * Хранит диалоги оператора и их исходы; позже успешные кейсы пойдут
 * примерами в промпт, а статистика конверсий — в динамические подсказки.
 *
 * Движки: better-sqlite3 (основной) -> JSON-файл (авто-fallback;
 * принудительно: EXP_DB_ENGINE=json).
 * Путь: $EXPERIENCE_DB_PATH || %APPDATA%/operator-helper/experience.db
 * (вне папки проекта — по той же причине, что и конфиг, F-04).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function appDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'operator-helper');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'operator-helper');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'operator-helper');
}

const DB_PATH = process.env.EXPERIENCE_DB_PATH || path.join(appDataDir(), 'experience.db');
const FORCE_JSON = String(process.env.EXP_DB_ENGINE || '').toLowerCase() === 'json';

/* ---------------- Разбор вставленной истории на сообщения ---------------- */
const RE_USER = /^(user|юзер|user:|юзер:)\s*[:：]?\s*/i;
const RE_MODEL = /^(model|модель|мод:|мод)\s*[:：]?\s*/i;

function parseHistory(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    if (RE_USER.test(line)) {
      msgs.push({ role: 'user', text: line.replace(RE_USER, '').trim() });
    } else if (RE_MODEL.test(line)) {
      msgs.push({ role: 'model', text: line.replace(RE_MODEL, '').trim() });
    } else if (msgs.length) {
      msgs[msgs.length - 1].text += '\n' + line; // продолжение реплики
    } else {
      msgs.push({ role: 'raw', text: line }); // префиксов нет — храним как есть
    }
  }
  return msgs;
}

/* ---------------- Движок SQLite (better-sqlite3) ---------------- */
function initSqlite() {
  const Database = require('better-sqlite3'); // может отсутствовать — ловим выше
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      strategy TEXT DEFAULT '',
      msg_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE TABLE IF NOT EXISTS outcomes(
      chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      result TEXT NOT NULL,
      revenue REAL DEFAULT 0,
      marked_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return {
    name: 'sqlite',
    saveChat({ history, strategy, platform }) {
      const msgs = parseHistory(history);
      const insChat = db.prepare(
        'INSERT INTO chats(platform, status, strategy, msg_count) VALUES(?, ?, ?, ?)');
      const insMsg = db.prepare(
        'INSERT INTO messages(chat_id, role, text) VALUES(?, ?, ?)');
      const chatId = db.transaction(() => {
        const id = insChat.run(platform || '', 'open', strategy || '', msgs.length).lastInsertRowid;
        for (const m of msgs) insMsg.run(id, m.role, m.text);
        return id;
      })();
      return { chatId: Number(chatId), msgCount: msgs.length };
    },
    markOutcome(chatId, result, revenue) {
      const info = db.prepare(`
        INSERT INTO outcomes(chat_id, result, revenue) VALUES(?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          result = excluded.result, revenue = excluded.revenue,
          marked_at = datetime('now')`).run(chatId, result, revenue || 0);
      db.prepare("UPDATE chats SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(result, chatId);
      return { ok: true, changed: info.changes > 0 };
    },
    getSuccessfulMessages(limitChats) {
      const chats = db.prepare(`
        SELECT c.id, c.strategy, c.msg_count, c.updated_at, o.result
        FROM chats c JOIN outcomes o ON o.chat_id = c.id
        WHERE c.status IN ('won_private','won_tip')
        ORDER BY c.updated_at DESC LIMIT ?`).all(limitChats || 300);
      const getMsgs = db.prepare('SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id');
      return chats.map((c) => ({ ...c, messages: getMsgs.all(c.id) }));
    },
    getLastLost(limitChats) {
      const chats = db.prepare(`
        SELECT c.id, c.strategy, c.updated_at FROM chats c
        WHERE c.status = 'lost' ORDER BY c.updated_at DESC LIMIT ?`).all(limitChats || 1);
      const getMsgs = db.prepare('SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id');
      return chats.map((c) => ({ ...c, messages: getMsgs.all(c.id) }));
    },
    getAllChats() {
      return db.prepare(
        'SELECT id, status, strategy, msg_count, created_at FROM chats ORDER BY id').all();
    },
    getRevenueTotal() {
      return db.prepare('SELECT COALESCE(SUM(revenue), 0) AS s FROM outcomes').get().s;
    },
    getStats() {
      const total = db.prepare('SELECT COUNT(*) AS n FROM chats').get().n;
      const byStatus = {};
      for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM chats GROUP BY status').all())
        byStatus[r.status] = r.n;
      const byStrategy = db.prepare(`
        SELECT COALESCE(NULLIF(strategy, ''), '—') AS strategy, COUNT(*) AS total,
               SUM(CASE WHEN status IN ('won_private','won_tip') THEN 1 ELSE 0 END) AS won
        FROM chats GROUP BY strategy ORDER BY total DESC`).all();
      const marked = (byStatus.won_private || 0) + (byStatus.won_tip || 0) + (byStatus.lost || 0);
      const won = (byStatus.won_private || 0) + (byStatus.won_tip || 0);
      return {
        engine: 'sqlite', total, byStatus, byStrategy,
        conversion: marked ? Math.round(won / marked * 1000) / 10 : 0
      };
    }
  };
}

/* ---------------- Движок JSON (fallback, тот же интерфейс) ---------------- */
function initJson() {
  const JSON_PATH = DB_PATH + '.json';
  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
  const state = { seq: 0, chats: [], messages: [], outcomes: [] };
  try { Object.assign(state, JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'))); }
  catch { /* новый файл */ }
  const persist = () => fs.writeFileSync(JSON_PATH, JSON.stringify(state), 'utf-8');

  return {
    name: 'json',
    saveChat({ history, strategy, platform }) {
      const msgs = parseHistory(history);
      const id = ++state.seq;
      state.chats.push({
        id, platform: platform || '', status: 'open', strategy: strategy || '',
        msg_count: msgs.length,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
      for (const m of msgs) state.messages.push({ chat_id: id, role: m.role, text: m.text });
      persist();
      return { chatId: id, msgCount: msgs.length };
    },
    markOutcome(chatId, result, revenue) {
      chatId = Number(chatId);
      let o = state.outcomes.find((x) => x.chat_id === chatId);
      if (!o) { o = { chat_id: chatId }; state.outcomes.push(o); }
      o.result = result; o.revenue = revenue || 0;
      o.marked_at = new Date().toISOString();
      const chat = state.chats.find((c) => c.id === chatId);
      if (chat) { chat.status = result; chat.updated_at = new Date().toISOString(); }
      persist();
      return { ok: true, changed: !!chat };
    },
    getSuccessfulMessages(limitChats) {
      const wonIds = new Set(state.outcomes
        .filter((o) => o.result === 'won_private' || o.result === 'won_tip')
        .map((o) => o.chat_id));
      return state.chats
        .filter((c) => wonIds.has(c.id))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, limitChats || 300)
        .map((c) => ({
          id: c.id, strategy: c.strategy, msg_count: c.msg_count,
          updated_at: c.updated_at,
          result: (state.outcomes.find((o) => o.chat_id === c.id) || {}).result,
          messages: state.messages.filter((m) => m.chat_id === c.id)
        }));
    },
    getLastLost(limitChats) {
      const lostIds = new Set(state.outcomes
        .filter((o) => o.result === 'lost').map((o) => o.chat_id));
      return state.chats
        .filter((c) => lostIds.has(c.id))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, limitChats || 1)
        .map((c) => ({
          id: c.id, strategy: c.strategy, updated_at: c.updated_at,
          messages: state.messages.filter((m) => m.chat_id === c.id)
        }));
    },
    getAllChats() {
      return state.chats.map((c) => ({
        id: c.id, status: c.status, strategy: c.strategy,
        msg_count: c.msg_count, created_at: c.created_at
      }));
    },
    getRevenueTotal() {
      return state.outcomes.reduce((s, o) => s + (Number(o.revenue) || 0), 0);
    },
    getStats() {
      const byStatus = {};
      for (const c of state.chats) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      const strat = {};
      for (const c of state.chats) {
        const k = c.strategy || '—';
        strat[k] = strat[k] || { strategy: k, total: 0, won: 0 };
        strat[k].total++;
        if (c.status === 'won_private' || c.status === 'won_tip') strat[k].won++;
      }
      const marked = (byStatus.won_private || 0) + (byStatus.won_tip || 0) + (byStatus.lost || 0);
      const won = (byStatus.won_private || 0) + (byStatus.won_tip || 0);
      return {
        engine: 'json', total: state.chats.length, byStatus,
        byStrategy: Object.values(strat).sort((a, b) => b.total - a.total),
        conversion: marked ? Math.round(won / marked * 1000) / 10 : 0
      };
    }
  };
}

/* ---------------- Подбор примеров опыта (Фаза 2) ---------------- */
const STOP_WORDS = new Set((
  'the and you your that this with what when where how are was were have has had not for from they them their will would could should about which there here been being into over under more most some such only very just want wanna need know think thing things really right okay yes yeah hey hi hello babe baby honey girl love good nice much please thanks thank welcome because about again against between during before after above below up down out off over under why who whom its itself yourself themselves ' +
  'это что как так для был была были быть его её они уже ещё когда чтобы если но во не на я со от до по из у же за ну да про при или очень просто хорошо отлично спасибо привет пока давай давайте хочу нравится можно нельзя нужно нужен нужна нужны которые которое которого которому моя мои мой мы ты он она их там здесь тут всё всех весь вся время день дня сейчас потом тогда сказать говорит сказала сделать сделать'
).split(/\s+/));

function extractKeywords(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function compressDialog(messages) {
  const users = messages.filter((m) => m.role === 'user');
  const models = messages.filter((m) => m.role === 'model');
  const pick = (m) => (m ? String(m.text).replace(/\s+/g, ' ').slice(0, 140) : '—');
  const lines = [];
  if (users[0]) lines.push('Юзер: ' + pick(users[0]));
  if (models[0]) lines.push('Модель: ' + pick(models[0]));
  if (models.length > 1) lines.push('Модель (финал): ' + pick(models[models.length - 1]));
  return lines.join('\n');
}

function monthsSince(iso) {
  const t = Date.parse(iso || '');
  if (!t) return 999;
  return (Date.now() - t) / (1000 * 60 * 60 * 24 * 30);
}

/** Скоринг успешных диалогов против нового чата:
 *  +3 за каждое совпадение ключевого слова (фетиши/темы),
 *  +2 за ту же стратегию, +1 если диалог свежее 3 мес (иначе −2),
 *  +1 за похожую длину диалога. */
function findExamplesImpl(implObj, { history, strategy, limit }) {
  const rows = implObj.getSuccessfulMessages(300);
  if (!rows.length) return [];
  const qKeywords = new Set(extractKeywords(history));
  const qLines = String(history || '').split(/\r?\n/).filter(Boolean).length;

  const scored = rows.map((r) => {
    const chatKeywords = new Set(extractKeywords(r.messages.map((m) => m.text).join(' ')));
    let overlap = 0;
    for (const w of qKeywords) if (chatKeywords.has(w)) overlap++;
    let score = overlap * 3;
    if (strategy && r.strategy === strategy) score += 2;
    score += monthsSince(r.updated_at) <= 3 ? 1 : -2;
    const ratio = qLines ? (r.msg_count || 1) / qLines : 1;
    if (ratio > 0.5 && ratio < 2) score += 1;
    return { id: r.id, result: r.result, strategy: r.strategy,
             msg_count: r.msg_count, messages: r.messages, score, overlap };
  });

  return scored
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3);
}

/** Готовые текст-блоки для промпта: примеры, анти-пример, статистика. */
function getExperienceContextImpl(implObj, { history, strategy }) {
  const blocks = { count: 0, examplesBlock: '', statsBlock: '', antiBlock: '' };

  const examples = findExamplesImpl(implObj, { history, strategy, limit: 3 });
  blocks.count = examples.length;
  if (examples.length) {
    const parts = examples.map((ex, i) => {
      const label = ex.result === 'won_tip' ? 'донат' : 'приват';
      return `--- Пример ${i + 1} (исход: ${label}, стратегия: ${ex.strategy || '—'}) ---\n` +
             compressDialog(ex.messages);
    });
    blocks.examplesBlock =
      'ПРОВЕРЕННЫЕ ПРИМЕРЫ ИЗ ОПЫТА ОПЕРАТОРА (реальные диалоги, ЗАКОНЧИВШИЕСЯ РЕЗУЛЬТАТОМ — бери тон, приёмы и структуру, не копируй дословно):\n' +
      parts.join('\n');
  }

  const stats = implObj.getStats();
  if (stats.total > 0) {
    const stratLine = stats.byStrategy
      .map((s) => `${s.strategy}: ${s.total} диалогов, конверсия ${
        s.total ? Math.round(s.won / s.total * 100) : 0}%`)
      .join(' | ');
    blocks.statsBlock =
      `СТАТИСТИКА ПО БАЗЕ ОПЫТА (используй при выборе стратегии): всего диалогов ${stats.total}, ` +
      `конверсия в приват/донат ${stats.conversion}%. По стратегиям: ${stratLine}.`;
  }

  const lost = implObj.getLastLost(1);
  if (lost.length) {
    blocks.antiBlock =
      'АНТИ-ПРИМЕР (в похожем диалоге это привело к сливу юзера — не повторяй таких ошибок):\n' +
      compressDialog(lost[0].messages);
  }

  return blocks;
}

/* ---------------- Аналитика для вкладки «Опыт» (Фаза 3) ---------------- */
function getAnalyticsImpl(implObj) {
  const stats = implObj.getStats();
  const chats = implObj.getAllChats();
  const wonChats = implObj.getSuccessfulMessages(300);

  /* Топ-темы: ключевые слова, встречавшиеся в УСПЕШНЫХ диалогах */
  const freq = {};
  for (const ch of wonChats) {
    const seen = new Set(extractKeywords(ch.messages.map((m) => m.text).join(' ')));
    for (const w of seen) freq[w] = (freq[w] || 0) + 1;
  }
  const topTopics = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([topic, count]) => ({ topic, count }));

  /* Динамика: последние 6 недель (total / won) */
  const weeks = [];
  const now = Date.now();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now - i * 7 * 864e5);
    weeks.push({ label: d.toISOString().slice(0, 10), total: 0, won: 0 });
  }
  for (const c of chats) {
    const t = Date.parse(c.created_at);
    if (!t) continue;
    const idx = 5 - Math.floor((now - t) / (7 * 864e5));
    if (idx >= 0 && idx < 6) {
      weeks[idx].total++;
      if (c.status === 'won_private' || c.status === 'won_tip') weeks[idx].won++;
    }
  }

  const avgMsgs = chats.length
    ? Math.round(chats.reduce((s, c) => s + (c.msg_count || 0), 0) / chats.length * 10) / 10
    : 0;

  return Object.assign({}, stats, {
    topTopics, weeks, avgMsgs, revenue: implObj.getRevenueTotal()
  });
}

/* ---------------- Инициализация и публичный API ---------------- */
let impl = null;
function init() {
  if (impl) return impl;
  if (!FORCE_JSON) {
    try { impl = initSqlite(); }
    catch (e) {
      console.warn('[db] better-sqlite3 недоступен, включаю JSON-хранилище:', e.message);
    }
  }
  if (!impl) impl = initJson();
  console.log(`[db] опыт: движок=${impl.name}, файл=${DB_PATH}${impl.name === 'json' ? '.json' : ''}`);
  return impl;
}

module.exports = {
  DB_PATH,
  parseHistory,
  engineName: () => init().name,
  saveChat: (p) => init().saveChat(p || {}),
  markOutcome: (chatId, result, revenue) => init().markOutcome(chatId, result, revenue),
  getStats: () => init().getStats(),
  getAnalytics: () => getAnalyticsImpl(init()),
  getExperienceContext: (p) => getExperienceContextImpl(init(), p || {})
};

