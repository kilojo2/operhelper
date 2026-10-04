/**
 * Defensive JSON extraction for AI responses.
 * Works in a browser and in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AiJson = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_SOURCE_CHARS = 50000;
  const MAX_CANDIDATES = 80;

  function nextNonWhitespace(text, from) {
    for (let i = from; i < text.length; i++) {
      if (!/\s/.test(text[i])) return text[i];
    }
    return '';
  }

  function repairStructuralJson(value) {
    const text = String(value || '').replace(/^\uFEFF/, '').slice(0, MAX_SOURCE_CHARS);
    let out = '';
    let inString = false;
    let escaped = false;
    const stack = [];

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          out += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          const next = nextNonWhitespace(text, i + 1);
          if (next && ![':', ',', '}', ']'].includes(next)) {
            out += '\\"';
            continue;
          }
          inString = false;
          out += ch;
          continue;
        }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
        out += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === '{' || ch === '[') {
        stack.push(ch);
        out += ch;
        continue;
      }
      if (ch === ',') {
        const next = nextNonWhitespace(text, i + 1);
        if (next === '}' || next === ']') continue;
        out += ch;
        continue;
      }
      if (ch === '}' || ch === ']') {
        out += ch;
        const opener = stack.pop();
        const next = nextNonWhitespace(text, i + 1);
        if (ch === '}' && next === '{' && stack[stack.length - 1] === '[') out += ',';
        if ((ch === '}' && opener !== '{') || (ch === ']' && opener !== '[')) return text;
        continue;
      }
      out += ch;
    }
    return out;
  }

  function balancedSlices(value) {
    const text = String(value || '').slice(0, MAX_SOURCE_CHARS);
    const slices = [];
    for (let start = 0; start < text.length && slices.length < MAX_CANDIDATES; start++) {
      if (text[start] !== '[' && text[start] !== '{') continue;
      const stack = [];
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') {
          const opener = stack.pop();
          if ((ch === '}' && opener !== '{') || (ch === ']' && opener !== '[')) break;
          if (!stack.length) {
            slices.push(text.slice(start, i + 1));
            break;
          }
        }
      }
    }
    return slices;
  }

  function candidateStrings(value) {
    const raw = String(value || '').trim().slice(0, MAX_SOURCE_CHARS);
    if (!raw) return [];
    const sources = [raw];
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fence.exec(raw)) && sources.length < 10) sources.push(match[1].trim());
    sources.push(repairStructuralJson(raw));

    const seen = new Set();
    const result = [];
    for (const source of sources) {
      for (const candidate of [source, ...balancedSlices(source)]) {
        const clean = String(candidate || '').trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        result.push(clean);
        if (result.length >= MAX_CANDIDATES) return result;
      }
    }
    return result;
  }

  function arrayFromParsed(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of ['goals', 'items', 'data', 'result']) {
      if (Array.isArray(value[key])) return value[key];
    }
    return typeof value.en === 'string' ? [value] : [];
  }

  function normalizeGoal(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const en = typeof value.en === 'string' ? value.en.replace(/\s+/g, ' ').trim() : '';
    const ru = typeof value.ru === 'string' ? value.ru.replace(/\s+/g, ' ').trim() : '';
    if (!en || !ru || en.length > 220 || ru.length > 320) return null;
    return { en, ru };
  }

  function parseGoalItems(value, limit = 10) {
    const max = Math.min(20, Math.max(1, Number(limit) || 10));
    const goals = [];
    const seen = new Set();

    for (const candidate of candidateStrings(value)) {
      let parsed;
      try { parsed = JSON.parse(candidate); }
      catch {
        try { parsed = JSON.parse(repairStructuralJson(candidate)); }
        catch { continue; }
      }
      for (const item of arrayFromParsed(parsed)) {
        const goal = normalizeGoal(item);
        if (!goal) continue;
        const key = goal.en.toLocaleLowerCase('en-US');
        if (seen.has(key)) continue;
        seen.add(key);
        goals.push(goal);
        if (goals.length >= max) return goals;
      }
    }
    return goals;
  }

  return { parseGoalItems, repairStructuralJson };
});
