/**
 * Pure helpers for presenting and selectively regenerating an assistant reply.
 * Works in the browser (window.AssistantResult) and in Node tests.
 */
(function (root, factory) {
  const parser = typeof module === 'object' && module.exports
    ? require('./parser.js')
    : root.Parser;
  const api = factory(parser);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AssistantResult = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Parser) {
  'use strict';

  const MAX_TURN_MESSAGE_LENGTH = 4000;

  function normalizeMultiline(value) {
    return typeof value === 'string'
      ? value.replace(/\r\n?|\u2028|\u2029/g, '\n').trim()
      : '';
  }

  function formatTurnMessage(value, label) {
    if (typeof value !== 'string') {
      throw new TypeError(`${label} must be a string`);
    }

    const normalized = normalizeMultiline(value);
    if (!normalized) {
      throw new TypeError(`${label} must not be empty`);
    }
    if (normalized.length > MAX_TURN_MESSAGE_LENGTH) {
      throw new RangeError(`${label} must not exceed ${MAX_TURN_MESSAGE_LENGTH} characters`);
    }

    const lines = normalized.split('\n');
    return lines[0] + lines.slice(1).map((line) => `\n  ${line}`).join('');
  }

  /**
   * Appends the message sent by the model and the user's next message to a
   * transcript. Continuation lines are indented so text such as "user: ..."
   * inside a multiline message cannot be mistaken for a new transcript role.
   */
  function appendConversationTurn(history, sentReply, userMessage) {
    const normalizedHistory = normalizeMultiline(history);
    const modelLine = `model: ${formatTurnMessage(sentReply, 'sentReply')}`;
    const userLine = `user: ${formatTurnMessage(userMessage, 'userMessage')}`;
    const turn = `${modelLine}\n${userLine}`;
    return normalizedHistory ? `${normalizedHistory}\n${turn}` : turn;
  }

  const REPLY_BLOCKS = ['ОТВЕТ', 'АЛЬТЕРНАТИВА 1', 'АЛЬТЕРНАТИВА 2'];
  const MAX_REPLY_LENGTH = 420;

  function parseBlocks(text) {
    if (Parser && typeof Parser.parseAssistantResponse === 'function') {
      return Parser.parseAssistantResponse(text);
    }
    return {};
  }

  function toViewModel(text) {
    const blocks = parseBlocks(text);
    const reply = blocks['ОТВЕТ'] || '';
    const alternatives = [
      blocks['АЛЬТЕРНАТИВА 1'] || '',
      blocks['АЛЬТЕРНАТИВА 2'] || ''
    ];
    const missingReplyBlocks = REPLY_BLOCKS.filter((name) => !blocks[name]);

    return {
      reply,
      alternatives,
      analysis: blocks['АНАЛИЗ'] || '',
      strategy: blocks['СТРАТЕГИЯ'] || '',
      forecast: blocks['ПРОГНОЗ'] || '',
      why: blocks['ПОЧЕМУ'] || '',
      complete: missingReplyBlocks.length === 0,
      missingReplyBlocks,
      blocks
    };
  }

  function normalizeLine(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function validateReplyVariants(value) {
    const issues = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { valid: false, issues: ['ожидался JSON-объект'], value: null };
    }

    const reply = normalizeLine(value.reply);
    const sourceAlternatives = Array.isArray(value.alternatives) ? value.alternatives : [];
    const alternatives = sourceAlternatives.map(normalizeLine);

    if (!reply) issues.push('поле reply обязательно');
    if (typeof value.reply !== 'string') issues.push('поле reply должно быть строкой');
    if (!Array.isArray(value.alternatives)) {
      issues.push('поле alternatives должно быть массивом');
    } else if (value.alternatives.length !== 2) {
      issues.push('в alternatives должно быть ровно 2 варианта');
    }

    if (reply.length > MAX_REPLY_LENGTH) {
      issues.push(`reply длиннее ${MAX_REPLY_LENGTH} символов`);
    }
    alternatives.forEach((item, index) => {
      if (!item) issues.push(`alternatives[${index}] не должен быть пустым`);
      if (item.length > MAX_REPLY_LENGTH) {
        issues.push(`alternatives[${index}] длиннее ${MAX_REPLY_LENGTH} символов`);
      }
    });

    const all = [reply, ...alternatives];
    if (all.some((item) => /\[[^\[\]\r\n]{2,40}\]/.test(item))) {
      issues.push('текст не должен содержать заголовки служебных блоков');
    }
    const nonEmpty = all.filter(Boolean).map((item) => item.toLocaleLowerCase());
    if (new Set(nonEmpty).size !== nonEmpty.length) {
      issues.push('варианты ответа должны отличаться друг от друга');
    }

    return {
      valid: issues.length === 0,
      issues,
      value: issues.length === 0 ? { reply, alternatives } : null
    };
  }

  function jsonCandidates(source) {
    const raw = String(source || '').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    const result = [raw];
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fence.exec(raw)) !== null) result.push(match[1].trim());

    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      result.push(raw.slice(firstBrace, lastBrace + 1));
    }
    return [...new Set(result.filter(Boolean))];
  }

  function parseRegeneratedReply(source) {
    if (source && typeof source === 'object') {
      const validation = validateReplyVariants(source);
      if (validation.valid) return validation.value;
      throw new Error('Некорректный ответ модели: ' + validation.issues.join('; '));
    }

    let parseIssue = 'ответ модели не является валидным JSON';
    for (const candidate of jsonCandidates(source)) {
      let parsed;
      try { parsed = JSON.parse(candidate); }
      catch { continue; }
      const validation = validateReplyVariants(parsed);
      if (validation.valid) return validation.value;
      parseIssue = validation.issues.join('; ');
    }
    throw new Error('Некорректный ответ модели: ' + parseIssue);
  }

  function replyBlockRanges(text) {
    const source = String(text || '');
    const header = /^\[([^\[\]\r\n]{2,40})\][ \t]*(?:\r?\n)?/gm;
    const headers = [];
    let match;
    while ((match = header.exec(source)) !== null) {
      headers.push({
        name: match[1].trim().toUpperCase(),
        bodyStart: header.lastIndex,
        headerStart: match.index
      });
    }
    return headers.map((item, index) => ({
      ...item,
      bodyEnd: index + 1 < headers.length ? headers[index + 1].headerStart : source.length
    }));
  }

  function replaceReplyBlocks(text, variants) {
    const validation = validateReplyVariants(variants);
    if (!validation.valid) {
      throw new TypeError('Некорректные варианты ответа: ' + validation.issues.join('; '));
    }

    const source = String(text || '');
    const ranges = replyBlockRanges(source);
    const targets = REPLY_BLOCKS.map((name) => {
      const matches = ranges.filter((range) => range.name === name);
      if (matches.length !== 1) {
        throw new Error(`В исходном ответе блок [${name}] должен встречаться ровно один раз`);
      }
      return matches[0];
    });
    const values = [validation.value.reply, ...validation.value.alternatives];

    let result = source;
    targets
      .map((range, index) => ({ ...range, replacement: values[index] }))
      .sort((a, b) => b.bodyStart - a.bodyStart)
      .forEach((range) => {
        const oldBody = source.slice(range.bodyStart, range.bodyEnd);
        const trailingWhitespace = (oldBody.match(/\s*$/) || [''])[0];
        result = result.slice(0, range.bodyStart) + range.replacement + trailingWhitespace +
          result.slice(range.bodyEnd);
      });
    return result;
  }

  return {
    appendConversationTurn,
    toViewModel,
    validateReplyVariants,
    parseRegeneratedReply,
    replaceReplyBlocks,
    REPLY_BLOCKS: REPLY_BLOCKS.slice(),
    MAX_REPLY_LENGTH,
    MAX_TURN_MESSAGE_LENGTH
  };
});
