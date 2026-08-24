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
  getStats: () => init().getStats()
};

