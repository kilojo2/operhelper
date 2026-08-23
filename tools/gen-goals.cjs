/**
 * Генерирует data/goals.json из исходника «Цели.txt».
 * Формат исходника: тройки строк "EN" + "RU" + служебное "copy".
 * Запуск: node tools/gen-goals.cjs
 * Перегенерировать нужно только если изменился сам файл целей.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'Цели.txt');
const OUT = path.join(__dirname, '..', 'data', 'goals.json');

const lines = fs.readFileSync(SRC, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const items = [];
let pendingEn = null;
for (const t of lines) {
  if (/^copy$/i.test(t)) continue;        // служебные кнопки источника
  if (/^goals$/i.test(t)) continue;       // заголовок файла
  const isRu = /[А-Яа-яЁё]/.test(t);
  if (!isRu) {
    if (pendingEn) items.push({ en: pendingEn, ru: '' });
    pendingEn = t;
  } else if (pendingEn) {
    items.push({ en: pendingEn, ru: t });
    pendingEn = null;
  }
}
if (pendingEn) items.push({ en: pendingEn, ru: '' });

const clean = items.filter((i) => i.en && i.en.length > 3);

fs.writeFileSync(OUT, JSON.stringify({
  id: 'goals',
  icon: '🎯',
  name: 'Goals (цели стрима)',
  items: clean
}, null, 1), 'utf8');

console.log('goals.json создан. Всего целей:', clean.length,
  '| без перевода:', clean.filter((i) => !i.ru).length);
