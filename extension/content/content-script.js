(function () {
  'use strict';

  const adapters = window.KillasnazzSiteAdapters;
  const PROFILE_KEY = 'oh_web_config_v1';
  let observerTimer = null;

  function notifyChatChanged() {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'KILLASNAZZ_CHAT_UPDATED' }).catch(() => {});
    }, 700);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'KILLASNAZZ_READ_CHAT') {
      const result = adapters.readMessages(document, location.hostname, message.limit);
      if (result.ok) result.context = adapters.toContext(result.messages);
      sendResponse(result);
      return false;
    }
    if (message.type === 'KILLASNAZZ_INSERT_DRAFT') {
      sendResponse(adapters.insertDraft(document, location.hostname, message.text));
      return false;
    }
    if (message.type === 'KILLASNAZZ_IMPORT_PROFILE' &&
        location.origin === 'https://operhelper.killasnazz.workers.dev') {
      try {
        const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
        sendResponse({ ok: true, config: value && typeof value === 'object' ? value : {} });
      } catch {
        sendResponse({ ok: false, error: 'Профиль сайта повреждён или недоступен.' });
      }
      return false;
    }
    return false;
  });

  if (adapters.detectPlatform(location.hostname) && document.documentElement) {
    const observer = new MutationObserver(notifyChatChanged);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
