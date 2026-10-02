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
  const ADMIN_TOKEN_KEY = 'oh_admin_token';
  const LOCAL_CONFIG_KEY = 'oh_web_config_v1';

  function loadLocalConfig() {
    try {
      const value = JSON.parse(localStorage.getItem(LOCAL_CONFIG_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function saveLocalConfig(config) {
    const safe = {
      model: config.model || 'deepseek-chat',
      temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 1.3,
      profile: config.profile && typeof config.profile === 'object' ? config.profile : {}
    };
    try { localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(safe)); }
    catch { /* private mode / storage disabled */ }
  }

  // Токен доступа (нужен только при запуске сервера с HOST=0.0.0.0):
  // берётся из ?token=... или #token=... и кладётся в sessionStorage.
  (function captureTokens() {
    try {
      const query = new URLSearchParams(location.search);
      const hash = new URLSearchParams(location.hash.replace(/^#\??/, ''));
      const access = hash.get('token') || query.get('token');
      const admin = hash.get('adminToken') || query.get('adminToken');
      if (access) sessionStorage.setItem(TOKEN_KEY, access);
      if (admin) sessionStorage.setItem(ADMIN_TOKEN_KEY, admin);
      query.delete('token'); query.delete('adminToken');
      hash.delete('token'); hash.delete('adminToken');
      const q = query.toString();
      const h = hash.toString();
      history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + (h ? `#${h}` : ''));
    } catch { /* ignore */ }
  })();

  async function request(url, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    try {
      const t = sessionStorage.getItem(TOKEN_KEY);
      if (t) headers['X-Access-Token'] = t; // F-03: доступ по токену в сетевом режиме
      const admin = sessionStorage.getItem(ADMIN_TOKEN_KEY);
      if (admin) headers['X-Admin-Token'] = admin;
    } catch { /* ignore */ }

    let r;
    try {
      r = await fetch(url, Object.assign({}, opts, { headers }));
    } catch (e) {
      const reason = e && e.message ? `: ${e.message}` : '';
      throw new Error(`Не удалось связаться с сервером${reason}`);
    }

    if (r.status === 401 && !opts.__retriedToken) {
      let body = null;
      try { body = await r.clone().json(); } catch { /* ignore */ }
      if (body && body.needToken) {
        const tok = (prompt('Сервер запущен в сетевом режиме.\nВведите токен доступа (он показан в консоли сервера):') || '').trim();
        if (tok) {
          try { sessionStorage.setItem(TOKEN_KEY, tok); } catch { /* ignore */ }
          return request(url, Object.assign({}, opts, { __retriedToken: true }));
        }
      }
    }
    if (r.status === 403 && !opts.__retriedAdmin) {
      let body = null;
      try { body = await r.clone().json(); } catch { /* ignore */ }
      if (body && body.needAdminToken) {
        const tok = (prompt('Эта операция требует административный токен.\nВведите токен из консоли сервера:') || '').trim();
        if (tok) {
          try { sessionStorage.setItem(ADMIN_TOKEN_KEY, tok); } catch { /* ignore */ }
          return request(url, Object.assign({}, opts, { __retriedAdmin: true }));
        }
      }
    }
    return r;
  }

  async function readApiResponse(r) {
    const text = await r.text();
    const status = `HTTP ${r.status || 0}`;

    if (!text.trim()) {
      const hint = [502, 503, 504].includes(r.status)
        ? ' Сервер или внешний AI-сервис временно недоступен либо не успел ответить.'
        : '';
      throw new Error(`Сервер вернул пустой ответ (${status}).${hint}`);
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      const type = String(r.headers.get('content-type') || '').toLowerCase();
      const hint = type.includes('text/html')
        ? ' Вместо API ответила служебная страница хостинга.'
        : '';
      throw new Error(`Сервер вернул некорректный ответ (${status}).${hint}`);
    }

    if (!r.ok && body && typeof body === 'object' && body.ok === undefined) {
      body.ok = false;
    }
    return body;
  }

  async function post(url, body) {
    const r = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // F-02: сервер принимает только application/json
      body: JSON.stringify(body || {})
    });
    return readApiResponse(r);
  }

  // Помечаем документ — CSS скроет элементы, недоступные в браузере
  document.documentElement.classList.add('web');

  window.api = {
    // Запрос к DeepSeek (сервер подставит свой сохранённый ключ): { model, temperature, messages }
    chat: (payload) => post('/api/chat', payload),

    // Проверка ключа: пустой apiKey = проверить сохранённый на сервере
    testKey: (payload) => post('/api/test-key', payload),

    // Конфиг БЕЗ ключа: { hasKey, model, temperature, profile } (F-01)
    loadConfig: async () => {
      const server = await request('/api/config').then(readApiResponse);
      const local = loadLocalConfig();
      return Object.assign({}, server, local, { hasKey: !!server.hasKey });
    },
    saveConfig: async (cfg) => {
      const result = await post('/api/config', cfg);
      if (!result || result.ok !== false) saveLocalConfig(cfg || {});
      return result;
    },

    getData: () => request('/api/data').then(readApiResponse),

    // Открыть ссылку в новой вкладке браузера
    openExternal: (url) => {
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    },

    // В браузере системный режим «поверх всех окон» недоступен
    setOnTop: () => {},

    // База опыта (обучение на чатах, Фаза 1)
    expSave: (payload) => post('/api/exp/save', payload),
    expOutcome: (payload) => post('/api/exp/outcome', payload),
    expStats: () => request('/api/exp/stats').then(readApiResponse),
    expClear: () => post('/api/exp/clear', {}),

    // Подбор примеров из опыта (Фаза 2)
    expExamples: (payload) => post('/api/exp/examples', payload)
  };
})();
