(function attachTipMenuOrder(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TipMenuOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTipMenuOrder() {
  'use strict';

  const STAGES = Object.freeze([
    Object.freeze({ id: 'warmup', number: '01', name: 'Разогрев', description: 'Общение и лёгкое внимание' }),
    Object.freeze({ id: 'flirt', number: '02', name: 'Лёгкий флирт', description: 'Позы, образ и первые тизеры' }),
    Object.freeze({ id: 'tease', number: '03', name: 'Тизер тела', description: 'Более смелые действия без полного раскрытия' }),
    Object.freeze({ id: 'explicit', number: '04', name: 'Откровенно', description: 'Обнажение и интимные позы' }),
    Object.freeze({ id: 'finale', number: '05', name: 'Игрушки и финал', description: 'Самые интенсивные действия' })
  ]);

  const STAGE_BY_ID = Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage.id, stage])));

  function textOf(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return [item.en, item.ru].filter(Boolean).join(' ');
  }

  function normalize(item) {
    return textOf(item).toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
  }

  function stageIdFor(item) {
    const text = normalize(item);

    // Taxes and ratings are conversational menu items, even when their names
    // contain words that would otherwise belong to the final stage.
    if (/\b(?:tax|rate)\b/.test(text)) return 'warmup';

    if (/\b(?:dildo|butt plug|control(?: my)? toy|play with toy|finger pussy|fuck pussy|favorite pattern|soft pattern|make me cum|squirt|masturbat|until cum|close to orgasm|special finish|yummy pussy play|play until|help me feel good)\b/.test(text)) {
      return 'finale';
    }

    if (/\b(?:get naked|full naked|stay naked|naked \d|undress|spread pussy|doggy|ride pillow|pillow ride|rub on pillow|touch myself|show myself closer)\b/.test(text)) {
      return 'explicit';
    }

    if (/\b(?:panties|lingerie|show butt|flash ass|shake ass|shake my hips|shake shake|flash tits|show tits|flash a tiny bit|handbra|chest with hands|squeeze|boobs?|boobies|oil|spit|bounce|slap|spank|make my (?:ass|skin)|make it pink|lift the edge of my top|turn my back and sway)\b/.test(text)) {
      return 'tease';
    }

    if (/\b(?:show tongue|lick fingers|lick my fingers|suck fingers|lick \/ bite my lips|play with lips|touch my lips|ahegao|spin|turn around|stand up|show feet|show my feet|show feetsies|armpits?|show outfit|show my outfit|show what i'm wearing|heels|stockings|change (?:outfit|clothes)|fix my hair|pose|movement|turn a little toward)\b/.test(text)) {
      return 'flirt';
    }

    return 'warmup';
  }

  function stageFor(item) {
    return STAGE_BY_ID[stageIdFor(item)];
  }

  function group(items) {
    const buckets = new Map(STAGES.map((stage) => [stage.id, []]));
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const stageId = stageIdFor(item);
      buckets.get(stageId).push({ item, index, stage: STAGE_BY_ID[stageId] });
    });
    return STAGES.map((stage) => ({
      stage,
      items: buckets.get(stage.id).map((entry) => entry.item)
    })).filter((entry) => entry.items.length);
  }

  function sort(items) {
    return group(items).flatMap((entry) => entry.items);
  }

  return Object.freeze({ STAGES, textOf, stageIdFor, stageFor, group, sort });
});
