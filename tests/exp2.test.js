/**
 * Тест Фазы 2: подбор примеров опыта и сборка блоков для промпта.
 * Запуск: node tests/exp2.test.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

let failed = 0;
function ok(cond, name) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  if (!cond) failed++;
}

const tmp = path.join(os.tmpdir(), 'oh-exp2-' + Date.now());
process.env.EXPERIENCE_DB_PATH = tmp;
process.env.EXP_DB_ENGINE = 'json';
const db = require('../core/db');

/* Пустая база -> блоки пустые, анализ не ломается */
let ctx = db.getExperienceContext({ history: 'user: into feet?', strategy: 'slow' });
ok(ctx.count === 0 && !ctx.examplesBlock && !ctx.statsBlock,
  'пустая база: примеров нет, блоки пустые');

/* Наполняем опыт */
db.saveChat({ history: 'user: into feet fetish\nmodel: come private for feet <3', strategy: 'slow' });
db.saveChat({ history: 'user: love anal games\nmodel: private anal show baby', strategy: 'fast' });
db.saveChat({ history: 'user: hi there\nmodel: hey honey', strategy: 'slow' });
db.markOutcome(1, 'won_private', 0);
db.markOutcome(2, 'won_tip', 0);
db.markOutcome(3, 'lost', 0);

ctx = db.getExperienceContext({ history: 'user: do you enjoy feet fetish play?', strategy: 'slow' });
ok(ctx.count >= 1, `подобраны примеры (count=${ctx.count})`);
ok(ctx.examplesBlock.includes('ПРОВЕРЕННЫЕ ПРИМЕРЫ'), 'блок примеров содержит заголовок');
ok(ctx.examplesBlock.includes('feet'), 'релевантный пример про feet найден');
const feetPos = ctx.examplesBlock.indexOf('feet fetish');
const analPos = ctx.examplesBlock.indexOf('anal');
ok(feetPos !== -1 && (analPos === -1 || feetPos < analPos),
  'релевантный пример ранжирован выше нерелевантного');
ok(ctx.statsBlock.includes('СТАТИСТИКА'), 'блок статистики присутствует');
ok(ctx.antiBlock.includes('АНТИ-ПРИМЕР'), 'анти-пример из слитого чата присутствует');
ok(!ctx.examplesBlock.includes('hi there'), 'несовпадающий диалог не попал в примеры');

try { fs.rmSync(tmp + '.json', { force: true }); } catch { /* ignore */ }

console.log(failed ? ('\nИТОГ: ПРОВАЛЕНО ' + failed) : '\nИТОГ: ВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(failed ? 1 : 0);
