/**
 * DOM adapters for supported streaming platforms. No adapter ever submits a
 * form or clicks the send button: it only reads visible messages and fills the
 * current draft field.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KillasnazzSiteAdapters = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const CONFIGS = Object.freeze({
    chaturbate: {
      label: 'Chaturbate',
      hosts: [/(^|\.)chaturbate\.com$/i],
      containers: ['[data-testid="chat-messages"]', '#chat-list', '.chat-list', '.chat-messages', '[class*="MessageList"]'],
      messages: ['[data-testid="chat-message"]', '[data-nick]', '.chat-message', '.msg-list-fvm', '[class*="ChatMessage"]'],
      authors: ['[data-testid="username"]', '.username', '.user-name', '.name', '[class*="Username"]'],
      bodies: ['[data-testid="message-text"]', '.message-text', '.msg-text', '.text', '[class*="MessageText"]'],
      composers: ['textarea[data-testid="chat-input"]', '#chat-input', 'textarea[name="message"]', '.chat-input textarea', '[contenteditable="true"][role="textbox"]']
    },
    stripchat: {
      label: 'Stripchat',
      hosts: [/(^|\.)stripchat\.com$/i],
      containers: ['[data-testid="chat-messages"]', '[class*="ChatMessages"]', '[class*="MessagesList"]', '.chat-messages'],
      messages: ['[data-testid="chat-message"]', '[class*="ChatMessage"]', '[class*="chatMessage"]', '.chat-message'],
      authors: ['[data-testid="username"]', '[class*="Username"]', '[class*="userName"]', '.username'],
      bodies: ['[data-testid="message-text"]', '[class*="MessageText"]', '[class*="messageText"]', '.message-text'],
      composers: ['textarea[data-testid="chat-input"]', 'textarea[placeholder*="message" i]', '[contenteditable="true"][role="textbox"]', '[class*="ChatInput"] textarea']
    },
    bongacams: {
      label: 'BongaCams',
      hosts: [/(^|\.)bongacams\.com$/i],
      containers: ['[data-testid="chat-messages"]', '.bc-chat-messages', '.chat-messages', '[class*="ChatMessages"]'],
      messages: ['[data-testid="chat-message"]', '.bc-message', '.chat-message', '[class*="ChatMessage"]'],
      authors: ['[data-testid="username"]', '.bc-message__username', '.username', '[class*="Username"]'],
      bodies: ['[data-testid="message-text"]', '.bc-message__text', '.message-text', '[class*="MessageText"]'],
      composers: ['textarea[data-testid="chat-input"]', '.bc-chat-input textarea', 'textarea[placeholder*="message" i]', '[contenteditable="true"][role="textbox"]']
    }
  });

  function detectPlatform(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    for (const [id, config] of Object.entries(CONFIGS)) {
      if (config.hosts.some((pattern) => pattern.test(host))) return { id, config };
    }
    return null;
  }

  function first(rootNode, selectors) {
    if (!rootNode || typeof rootNode.querySelector !== 'function') return null;
    for (const selector of selectors || []) {
      try {
        const node = rootNode.querySelector(selector);
        if (node) return node;
      } catch { /* invalid/unsupported selector */ }
    }
    return null;
  }

  function firstNonEmptyList(rootNode, selectors) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return [];
    for (const selector of selectors || []) {
      try {
        const nodes = Array.from(rootNode.querySelectorAll(selector));
        if (nodes.length) return nodes;
      } catch { /* invalid/unsupported selector */ }
    }
    return [];
  }

  function cleanText(value, maxLength) {
    return String(value == null ? '' : value)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength || 4000);
  }

  function nodeText(node) {
    return cleanText(node && (node.innerText || node.textContent || ''), 4000);
  }

  function readOneMessage(node, config) {
    const authorNode = first(node, config.authors);
    const bodyNode = first(node, config.bodies);
    const author = cleanText(
      (node && node.dataset && (node.dataset.nick || node.dataset.username || node.dataset.user)) ||
      nodeText(authorNode), 120);
    let text = nodeText(bodyNode);
    if (!text) {
      text = nodeText(node);
      if (author && text.toLowerCase().startsWith(author.toLowerCase())) {
        text = cleanText(text.slice(author.length).replace(/^\s*[:\-–—]\s*/, ''), 4000);
      }
    }
    if (!text || text === author) return null;
    const marker = [node && node.className, node && node.getAttribute && node.getAttribute('data-sender'),
      node && node.getAttribute && node.getAttribute('data-direction')].filter(Boolean).join(' ');
    const direction = /(^|\s|[-_])(own|self|model|outgoing|sent)(\s|[-_]|$)/i.test(marker)
      ? 'outgoing' : 'incoming';
    return { author: author || (direction === 'outgoing' ? 'Model' : 'User'), text, direction };
  }

  function readMessages(documentNode, hostname, limit) {
    const platform = detectPlatform(hostname);
    if (!platform) return { ok: false, error: 'Эта платформа пока работает только в ручном режиме.' };
    const container = first(documentNode, platform.config.containers) || documentNode;
    const nodes = firstNonEmptyList(container, platform.config.messages);
    if (!nodes.length) {
      return { ok: false, platform: platform.config.label, error: 'Не удалось найти сообщения. Вставьте переписку вручную.' };
    }
    const result = [];
    const seen = new Set();
    for (const node of nodes.slice(-Math.min(100, Math.max(1, Number(limit) || 60)))) {
      const message = readOneMessage(node, platform.config);
      if (!message) continue;
      const key = `${message.direction}\u0000${message.author}\u0000${message.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(message);
    }
    if (!result.length) return { ok: false, platform: platform.config.label, error: 'В найденном блоке нет читаемых сообщений.' };
    return { ok: true, platform: platform.config.label, messages: result };
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function insertDraft(documentNode, hostname, value) {
    const text = cleanText(value, 4000);
    if (!text) return { ok: false, error: 'Нечего вставлять.' };
    const platform = detectPlatform(hostname);
    if (!platform) return { ok: false, error: 'Для этой платформы доступно только копирование.' };
    const field = first(documentNode, platform.config.composers);
    if (!field) return { ok: false, platform: platform.config.label, error: 'Поле сообщения не найдено. Скопируйте ответ вручную.' };
    const type = String(field.getAttribute && field.getAttribute('type') || '').toLowerCase();
    if (['password', 'number', 'email', 'tel'].includes(type)) {
      return { ok: false, platform: platform.config.label, error: 'Небезопасное поле отклонено.' };
    }
    if (field.isContentEditable) field.textContent = text;
    else setNativeValue(field, text);
    const InputCtor = typeof InputEvent === 'function' ? InputEvent : Event;
    field.dispatchEvent(new InputCtor('input', { bubbles: true, inputType: 'insertText', data: text }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof field.focus === 'function') field.focus();
    return { ok: true, platform: platform.config.label };
  }

  function toContext(messages) {
    return (Array.isArray(messages) ? messages : []).map((message) => {
      const role = message.direction === 'outgoing' ? 'Модель' : (message.author || 'Пользователь');
      return `${role}: ${cleanText(message.text, 4000)}`;
    }).join('\n');
  }

  return { CONFIGS, detectPlatform, cleanText, readOneMessage, readMessages, insertDraft, toContext };
});
