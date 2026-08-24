/**
 * Тест банка целей генератора. Запуск из корня: node tests/goals.test.js
 */
const fs = require('fs');
let failed = 0;
const ok = (c, n) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) failed++; };

const bank = JSON.parse(fs.readFileSync('data/goal-bank.json', 'utf8'));
const TAGS = ['feet', 'ass', 'tits', 'face', 'lips', 'finger', 'pussy'];
ok(TAGS.every((t) => bank[t] && Array.isArray(bank[t].items)), 'все 7 категорий на месте');
let total = 0, bad = 0;
for (const t of TAGS) {
  for (const i of bank[t].items) {
    total++;
    if (!i.en || !i.ru || typeof i.en !== 'string' || typeof i.ru !== 'string') bad++;
  }
}
ok(bad === 0, `все ${total} целей имеют EN и RU текст`);
ok(total >= 70, `в банке минимум 70 целей (${total})`);

console.log(failed ? ('\nИТОГ: ПРОВАЛЕНО ' + failed) : '\nИТОГ: ВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(failed ? 1 : 0);
