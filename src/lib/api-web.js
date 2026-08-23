/**
 * HTTP-шим для веб-версии: реализует тот же window.api, что и Electron-preload,
 * но через запросы к нашему серверу. Ключ хранится только на сервере и никогда
 * им не возвращается (F-01); Host/Origin проверяются сервером (F-02);
 * в сетевом режиме требуется токен доступа (F-03).
 *
 * Файл загружается и в десктопе, но там preload уже задал window.api —
 * поэтому первой строкой выходим, чтобы ничего не перезаписать.
 */
(function () {
  'use strict';

  if (window.api) return; // Electron: preload уже всё подключил

  const TOKEN_KEY = 'oh_access_token';

  // Токен доступа (нужен только при запуске сервера с HOST=0.0.0.0):
  // берётся из ?token=... или #token=... и кладётся в sessionStorage.
  (function captureToken() {
    const m = /[?&]token=([A-Za-z0-9]+)/.exec(location.search + '&' + location.hash);
    if (m && m[1]) {
      try { sessionStorage.setItem(TOKEN_KEY, m[1]); } catch { /* ignore */ }
      try { // убираем токен из адресной строки
        const s = location.search.replace(/[?&]token=[A-Za-z0-9]+/, '');
        const h = location.hash.replace(/[?&]token=[A-Za-z0-9]+/, '');
        history.replaceState(null, '',
          location.pathname + (s.length > 1 ? s : '') + (h.length > 1 ? h : ''));
      } catch { /* ignore */ }
    }
  })();

  async function request(url, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    try {
      const t = sessionStorage.getItem(TOKEN_KEY);
      if (t) headers['X-Access-Token'] = t; // F-03: доступ по токену в сетевом режиме
    } catch { /* ignore */ }

    const r = await fetch(url, Object.assign({}, opts, { headers }));

    if (r.status === 401 && !opts.__retried) {
      let body = null;
      try { body = await r.clone().json(); } catch { /* ignore */ }
      if (body && body.needToken) {
        const tok = (prompt('Сервер запущен в сетевом режиме.\nВведите токен доступа (он показан в консоли сервера):') || '').trim();
        if (tok) {
          try { sessionStorage.setItem(TOKEN_KEY, tok); } catch { /* ignore */ }
          return request(url, Object.assign({}, opts, { __retried: true }));
        }
      }
    }
    return r;
  }

  async function post(url, body) {
    const r = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // F-02: сервер принимает только application/json
      body: JSON.stringify(body || {})
    });
    return r.json();
  }

  // Помечаем документ — CSS скроет элементы, недоступные в браузере
  document.documentElement.classList.add('web');

  window.api = {
    // Запрос к DeepSeek (сервер подставит свой сохранённый ключ): { model, temperature, messages }
    chat: (payload) => post('/api/chat', payload),

    // Проверка ключа: пустой apiKey = проверить сохранённый на сервере
    testKey: (payload) => post('/api/test-key', payload),

    // Конфиг БЕЗ ключа: { hasKey, model, temperature, profile } (F-01)
    loadConfig: () => request('/api/config').then((r) => r.json()),
    saveConfig: (cfg) => post('/api/config', cfg),

    getData: () => request('/api/data').then((r) => r.json()),

    // Открыть ссылку в новой вкладке браузера
    openExternal: (url) => {
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    },

    // В браузере системный режим «поверх всех окон» недоступен
    setOnTop: () => {}
  };
})();
