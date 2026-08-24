/**
 * Тест базы опыта (Фаза 1). Запуск: node tests/db.test.js
 * JSON-fallback проверяется всегда; SQLite — если better-sqlite3 доступен.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

let failed = 0;
function ok(cond, name) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  if (!cond) failed++;
}

const SAMPLE = [
  'user: hey beautiful, how are you?',
  'model: hii im great honey, u seem fun ^^',
  'user: what are you into?',
  'model: feet stuff honey, come private and find out <3'
].join('\n');

function runSuite(engine) {
  const tmp = path.join(os.tmpdir(), 'oh-exp-test-' + engine + '-' + Date.now());
  process.env.EXPERIENCE_DB_PATH = tmp;
  process.env.EXP_DB_ENGINE = engine === 'json' ? 'json' : '';
  delete require.cache[require.resolve('../core/db')];
  const db = require('../core/db');

  ok(db.engineName() === engine, `[${engine}] движок активирован (получен: ${db.engineName()})`);

  const saved = db.saveChat({ history: SAMPLE, strategy: 'slow', platform: 'test' });
  ok(saved.chatId > 0, `[${engine}] чат сохранён, id=${saved.chatId}`);
  ok(saved.msgCount === 4, `[${engine}] разобрано 4 сообщения (получено ${saved.msgCount})`);

  const again = db.saveChat({ history: 'просто строка без префиксов' });
  ok(again.msgCount === 1, `[${engine}] история без префиксов -> 1 raw-сообщение`);

  db.markOutcome(saved.chatId, 'won_private', 25);
  let st = db.getStats();
  ok(st.total === 2, `[${engine}] stats.total = 2`);
  ok(st.byStatus.won_private === 1, `[${engine}] исход won_private учтён`);
  ok(st.conversion === 100, `[${engine}] конверсия 100% (получено ${st.conversion})`);
  ok(st.byStrategy.some((s) => s.strategy === 'slow' && s.won === 1),
    `[${engine}] стратегия slow с победой видна в stats`);

  db.markOutcome(saved.chatId, 'lost', 0);
  st = db.getStats();
  ok(st.byStatus.lost === 1 && !st.byStatus.won_private,
    `[${engine}] повторная отметка перезаписывает исход`);

  for (const f of [tmp, tmp + '.json', tmp + '-wal', tmp + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

runSuite('json');
try { require('better-sqlite3'); runSuite('sqlite'); }
catch { console.log('SKIP sqlite (better-sqlite3 недоступен — работает JSON-fallback)'); }

console.log(failed ? ('\nИТОГ: ПРОВАЛЕНО ' + failed) : '\nИТОГ: ВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(failed ? 1 : 0);
