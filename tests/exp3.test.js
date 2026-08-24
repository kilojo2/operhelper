/**
 * Тест Фазы 3: аналитика вкладки «Опыт». Запуск: node tests/exp3.test.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

let failed = 0;
const ok = (c, n) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) failed++; };

const tmp = path.join(os.tmpdir(), 'oh-exp3-' + Date.now());
process.env.EXPERIENCE_DB_PATH = tmp;
process.env.EXP_DB_ENGINE = 'json';
const db = require('../core/db');

db.saveChat({ history: 'user: feet fetish show\nmodel: private feet fun <3', strategy: 'slow' });  // 1
db.saveChat({ history: 'user: feet and heels\nmodel: private heels tease ^^', strategy: 'slow' });  // 2
db.saveChat({ history: 'user: hi\nmodel: hey', strategy: 'fast' });                                  // 3
db.markOutcome(1, 'won_private', 25);
db.markOutcome(2, 'won_tip', 40);
db.markOutcome(3, 'lost', 0);

const a = db.getAnalytics();
ok(a.total === 3, `total = 3 (получено ${a.total})`);
ok(a.conversion === 66.7, `конверсия 66.7% (получено ${a.conversion})`);
ok(a.revenue === 65, `доход 65 (получено ${a.revenue})`);
ok(a.avgMsgs === 2, `средняя длина 2 (получено ${a.avgMsgs})`);
ok(a.topTopics.length >= 1 && a.topTopics[0].topic === 'feet' && a.topTopics[0].count === 2,
  `топ-тема feet×2 (${JSON.stringify(a.topTopics[0])})`);
ok(a.weeks.length === 6, `6 недель в динамике (${a.weeks.length})`);
ok(a.weeks[5].total === 3 && a.weeks[5].won === 2,
  `текущая неделя: 3 диалога / 2 победы (${a.weeks[5].total}/${a.weeks[5].won})`);
const slow = a.byStrategy.find((s) => s.strategy === 'slow');
ok(slow && slow.total === 2 && slow.won === 2, 'стратегия slow: 2 диалога, 2 победы');

try { fs.rmSync(tmp + '.json', { force: true }); } catch { /* ignore */ }
console.log(failed ? ('\nИТОГ: ПРОВАЛЕНО ' + failed) : '\nИТОГ: ВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(failed ? 1 : 0);
