/**
 * База данных «опыта» — фундамент самообучения ассистента (Фаза 1).
 * Хранит диалоги оператора и их исходы; позже успешные кейсы пойдут
 * примерами в промпт, а статистика конверсий — в динамические подсказки.
 *
 * Движки: встроенный node:sqlite (основной) -> JSON-файл (явный fallback;
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
const ALLOW_JSON_FALLBACK = String(process.env.ALLOW_JSON_FALLBACK || '') === '1';
const VALID_RESULTS = new Set(['won_private', 'won_tip', 'lost', 'open']);

function validateOutcome(chatId, result, revenue) {
  const id = Number(chatId);
  const amount = Number(revenue || 0);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Некорректный chatId');
  if (!VALID_RESULTS.has(result)) throw new Error('Недопустимый исход чата');
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e9)
    throw new Error('Некорректное значение дохода');
  return { chatId: id, result, revenue: amount };
}

/* ---------------- Разбор вставленной истории на сообщения ---------------- */
const RE_USER = /^(?:user|юзер)\s*[:：]\s*/i;
const RE_MODEL = /^(?:model|модель|мод)\s*[:：]\s*/i;

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

/* ---------------- Движок SQLite (встроенный node:sqlite, Node 22.5+) ---------------- */
function initSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      strategy TEXT DEFAULT '',
      stage TEXT DEFAULT '',
      chat_mode TEXT DEFAULT '',
      profile_name TEXT DEFAULT '',
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
  const chatColumns = new Set(db.prepare('PRAGMA table_info(chats)').all().map((row) => row.name));
  if (!chatColumns.has('stage')) db.exec("ALTER TABLE chats ADD COLUMN stage TEXT DEFAULT ''");
  if (!chatColumns.has('chat_mode')) db.exec("ALTER TABLE chats ADD COLUMN chat_mode TEXT DEFAULT ''");
  if (!chatColumns.has('profile_name')) db.exec("ALTER TABLE chats ADD COLUMN profile_name TEXT DEFAULT ''");
  db.exec('PRAGMA user_version = 2');

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* исходная ошибка важнее */ }
      throw e;
    }
  }

  return {
    name: 'sqlite',
    saveChat({ history, strategy, platform, stage, chatMode, profileName }) {
      const msgs = parseHistory(history);
      const insChat = db.prepare(
        'INSERT INTO chats(platform, status, strategy, stage, chat_mode, profile_name, msg_count) VALUES(?, ?, ?, ?, ?, ?, ?)');
      const insMsg = db.prepare(
        'INSERT INTO messages(chat_id, role, text) VALUES(?, ?, ?)');
      const chatId = transaction(() => {
        const id = insChat.run(platform || '', 'open', strategy || '', stage || '',
          chatMode || '', profileName || '', msgs.length).lastInsertRowid;
        for (const m of msgs) insMsg.run(id, m.role, m.text);
        return id;
      });
      return { chatId: Number(chatId), msgCount: msgs.length };
    },
    markOutcome(chatId, result, revenue) {
      const value = validateOutcome(chatId, result, revenue);
      if (!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(value.chatId))
        throw new Error('Чат не найден');
      const changed = transaction(() => {
        const info = db.prepare(`
          INSERT INTO outcomes(chat_id, result, revenue) VALUES(?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            result = excluded.result, revenue = excluded.revenue,
            marked_at = datetime('now')`).run(value.chatId, value.result, value.revenue);
        db.prepare("UPDATE chats SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(value.result, value.chatId);
        return info.changes > 0;
      });
      return { ok: true, changed };
    },
    getSuccessfulMessages(limitChats) {
      const chats = db.prepare(`
        SELECT c.id, c.strategy, c.stage, c.chat_mode, c.profile_name,
               c.msg_count, c.updated_at, o.result
        FROM chats c JOIN outcomes o ON o.chat_id = c.id
        WHERE c.status IN ('won_private','won_tip')
        ORDER BY c.updated_at DESC LIMIT ?`).all(limitChats || 300);
      const getMsgs = db.prepare('SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id');
      return chats.map((c) => ({ ...c, messages: getMsgs.all(c.id) }));
    },
    getLastLost(limitChats) {
      const chats = db.prepare(`
        SELECT c.id, c.strategy, c.stage, c.chat_mode, c.profile_name, c.updated_at FROM chats c
        WHERE c.status = 'lost' ORDER BY c.updated_at DESC LIMIT ?`).all(limitChats || 1);
      const getMsgs = db.prepare('SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id');
      return chats.map((c) => ({ ...c, messages: getMsgs.all(c.id) }));
    },
    getAllChats() {
      return db.prepare(
        'SELECT id, status, strategy, stage, chat_mode, profile_name, msg_count, created_at FROM chats ORDER BY id').all();
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
    },
    clearAll() {
      const deleted = db.prepare('SELECT COUNT(*) AS n FROM chats').get().n;
      transaction(() => {
        db.prepare('DELETE FROM outcomes').run();
        db.prepare('DELETE FROM messages').run();
        db.prepare('DELETE FROM chats').run();
        db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('chats','messages')").run();
      });
      return { ok: true, deleted };
    }
  };
}

/* ---------------- Движок JSON (fallback, тот же интерфейс) ---------------- */
function initJson(jsonPath) {
  const JSON_PATH = jsonPath || (DB_PATH + '.json');
  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
  const state = { seq: 0, chats: [], messages: [], outcomes: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
    if (!saved || !Array.isArray(saved.chats) || !Array.isArray(saved.messages) ||
        !Array.isArray(saved.outcomes)) {
      throw new Error('неверная структура JSON-базы');
    }
    state.seq = Number.isSafeInteger(saved.seq) && saved.seq >= 0 ? saved.seq : 0;
    state.chats = saved.chats;
    state.messages = saved.messages;
    state.outcomes = saved.outcomes;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Не удалось прочитать JSON-базу ${JSON_PATH}: ${e.message}`);
  }
  const persist = () => {
    const tempPath = `${JSON_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state), 'utf-8');
    fs.renameSync(tempPath, JSON_PATH);
  };

  return {
    name: 'json',
    file: JSON_PATH,
    saveChat({ history, strategy, platform, stage, chatMode, profileName }) {
      const msgs = parseHistory(history);
      const id = ++state.seq;
      state.chats.push({
        id, platform: platform || '', status: 'open', strategy: strategy || '',
        stage: stage || '', chat_mode: chatMode || '', profile_name: profileName || '',
        msg_count: msgs.length,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
      for (const m of msgs) state.messages.push({ chat_id: id, role: m.role, text: m.text });
      persist();
      return { chatId: id, msgCount: msgs.length };
    },
    markOutcome(chatId, result, revenue) {
      const valid = validateOutcome(chatId, result, revenue);
      chatId = valid.chatId;
      const chat = state.chats.find((c) => c.id === chatId);
      if (!chat) throw new Error('Чат не найден');
      let o = state.outcomes.find((x) => x.chat_id === chatId);
      if (!o) { o = { chat_id: chatId }; state.outcomes.push(o); }
      o.result = valid.result; o.revenue = valid.revenue;
      o.marked_at = new Date().toISOString();
      chat.status = valid.result;
      chat.updated_at = new Date().toISOString();
      persist();
      return { ok: true, changed: true };
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
          id: c.id, strategy: c.strategy, stage: c.stage || '', chat_mode: c.chat_mode || '',
          profile_name: c.profile_name || '', msg_count: c.msg_count,
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
          id: c.id, strategy: c.strategy, stage: c.stage || '', chat_mode: c.chat_mode || '',
          profile_name: c.profile_name || '', updated_at: c.updated_at,
          messages: state.messages.filter((m) => m.chat_id === c.id)
        }));
    },
    getAllChats() {
      return state.chats.map((c) => ({
        id: c.id, status: c.status, strategy: c.strategy, stage: c.stage || '',
        chat_mode: c.chat_mode || '', profile_name: c.profile_name || '',
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
    },
    clearAll() {
      const deleted = state.chats.length;
      state.seq = 0;
      state.chats = [];
      state.messages = [];
      state.outcomes = [];
      persist();
      return { ok: true, deleted };
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

function stageFamily(stage) {
  const value = String(stage || '').toUpperCase();
  if (value.includes('PRIVATE')) return 'private';
  if (value.includes('AFTERCARE')) return 'aftercare';
  if (value.includes('SAFETY')) return 'safety';
  return 'public';
}

function scoreExperienceRow(row, query) {
  const q = query || {};
  if (q.stage && row.stage && stageFamily(q.stage) !== stageFamily(row.stage)) return null;
  if (q.profileName && row.profile_name && q.profileName !== row.profile_name) return null;
  const qKeywords = new Set(extractKeywords(q.history));
  const chatKeywords = new Set(extractKeywords(row.messages.map((m) => m.text).join(' ')));
  let overlap = 0;
  for (const word of qKeywords) if (chatKeywords.has(word)) overlap++;
  let score = overlap * 3;
  if (q.strategy && row.strategy === q.strategy) score += 2;
  if (q.stage && row.stage && stageFamily(q.stage) === stageFamily(row.stage)) score += 2;
  if (q.profileName && row.profile_name === q.profileName) score += 2;
  score += monthsSince(row.updated_at) <= 3 ? 1 : -2;
  const qLines = String(q.history || '').split(/\r?\n/).filter(Boolean).length;
  const ratio = qLines ? (row.msg_count || 1) / qLines : 1;
  if (ratio > 0.5 && ratio < 2) score += 1;
  return { ...row, score, overlap };
}

/** Скоринг успешных диалогов против нового чата:
 *  +3 за каждое совпадение ключевого слова (фетиши/темы),
 *  +2 за ту же стратегию, +1 если диалог свежее 3 мес (иначе −2),
 *  +1 за похожую длину диалога. */
function findExamplesImpl(implObj, { history, strategy, stage, profileName, limit }) {
  const rows = implObj.getSuccessfulMessages(300);
  if (!rows.length) return [];
  const query = { history, strategy, stage, profileName };
  const scored = rows.map((row) => scoreExperienceRow(row, query)).filter(Boolean);

  return scored
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3);
}

/** Готовые текст-блоки для промпта: примеры, анти-пример, статистика. */
function getExperienceContextImpl(implObj, { history, strategy, stage, profileName }) {
  const blocks = { count: 0, examplesBlock: '', statsBlock: '', antiBlock: '' };

  const query = { history, strategy, stage, profileName };
  const examples = findExamplesImpl(implObj, { ...query, limit: 3 });
  blocks.count = examples.length;
  if (examples.length) {
    const parts = examples.map((ex, i) => {
      const label = ex.result === 'won_tip' ? 'донат' : 'приват';
      return `--- Пример ${i + 1} (исход: ${label}, стратегия: ${ex.strategy || '—'}, стадия: ${ex.stage || 'не указана'}) ---\n` +
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

  const lost = implObj.getLastLost(100)
    .map((row) => scoreExperienceRow(row, query))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 1);
  if (lost.length && lost[0].score >= 0) {
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
  if (FORCE_JSON) {
    impl = initJson();
  } else {
    try {
      impl = initSqlite();
    } catch (e) {
      if (!ALLOW_JSON_FALLBACK) {
        throw new Error(`SQLite недоступен: ${e.message}. ` +
          'Исправьте путь/модуль или явно задайте ALLOW_JSON_FALLBACK=1.');
      }
      console.warn('[db] SQLite недоступен, разрешённый JSON fallback:', e.message);
      impl = initJson();
    }
  }
  console.log(`[db] опыт: движок=${impl.name}, файл=${
    impl.name === 'json' ? (impl.file || DB_PATH + '.json') : DB_PATH}`);
  return impl;
}

module.exports = {
  DB_PATH,
  parseHistory,
  engineName: () => init().name,
  saveChat: (p) => init().saveChat(p || {}),
  markOutcome: (chatId, result, revenue) => init().markOutcome(chatId, result, revenue),
  clearAll: () => init().clearAll(),
  getStats: () => init().getStats(),
  getAnalytics: () => getAnalyticsImpl(init()),
  getExperienceContext: (p) => getExperienceContextImpl(init(), p || {})
};
