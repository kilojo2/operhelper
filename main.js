/**
 * Operator Helper — главный процесс Electron.
 * Окно приложения, IPC, запросы к DeepSeek API, хранение конфига.
 */
const { app, BrowserWindow, ipcMain, shell, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_TIMEOUT_MS = 90000;
const ALLOWED_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);
const MAX_CHAT_CHARS = 200 * 1024;
let mainWindow = null;

/* ---------------- Конфиг (F-04: ключ шифруется через Electron safeStorage) ---------------- */
function configPath() {
  return path.join(app.getPath('userData'), 'helper-config.json');
}

/** Шифрование секрета (DPAPI в Windows). Fallback — base64 + предупреждение в консоль. */
function sealSecret(plain) {
  try {
    if (safeStorage.isEncryptionAvailable())
      return { encrypted: true, data: safeStorage.encryptString(plain).toString('base64') };
  } catch { /* fallback ниже */ }
  console.warn('[security] safeStorage недоступен — API-ключ будет сохранён В ОТКРЫТОМ ВИДЕ!');
  return { encrypted: false, data: Buffer.from(plain, 'utf-8').toString('base64') };
}
function unsealSecret(secret) {
  if (!secret || typeof secret.data !== 'string') return '';
  try {
    const buf = Buffer.from(secret.data, 'base64');
    return secret.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf-8');
  } catch { return ''; }
}
function persistConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) || {}; }
  catch { return {}; }
  // Однократная миграция: старый ключ открытым текстом -> зашифрованное хранилище
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) {
    cfg.apiKeySecret = sealSecret(cfg.apiKey.trim());
    delete cfg.apiKey;
    persistConfig(cfg);
  }
  return cfg;
}
function getStoredApiKey(cfg) {
  const c = cfg || loadConfig();
  if (c.apiKeySecret) return unsealSecret(c.apiKeySecret);
  return typeof c.apiKey === 'string' ? c.apiKey : '';
}
/** F-01: пустое/отсутствующее поле apiKey = «оставить прежний ключ». */
function saveConfig(incoming) {
  const cur = loadConfig();
  const data = incoming && typeof incoming === 'object' ? incoming : {};
  const next = Object.assign({}, cur);
  if (ALLOWED_MODELS.has(data.model)) next.model = data.model;
  if (Number.isFinite(data.temperature)) next.temperature = Math.max(0, Math.min(2, data.temperature));
  if (data.profile && typeof data.profile === 'object') {
    next.profile = {};
    for (const key of ['name', 'age', 'look', 'persona', 'allowed', 'forbidden'])
      next.profile[key] = String(data.profile[key] || '').slice(0, 5000);
  }
  const newKey = incoming && typeof incoming.apiKey === 'string' ? incoming.apiKey.trim() : '';
  if (newKey) next.apiKeySecret = sealSecret(newKey);
  delete next.apiKey; // в файле ключ живёт только внутри зашифрованного apiKeySecret
  persistConfig(next);
}

/* ---------------- DeepSeek API ---------------- */
async function callDeepSeek({ apiKey, model, temperature, messages, maxTokens }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('API-ключ не задан. Откройте вкладку «Настройки» и впишите ключ DeepSeek.');
  }
  if (!Array.isArray(messages) || !messages.length || messages.length > 20)
    throw new Error('Некорректный список сообщений');
  const safeMessages = messages.map((m) => ({
    role: ['system', 'user', 'assistant'].includes(m && m.role) ? m.role : 'user',
    content: String(m && m.content || '')
  }));
  if (safeMessages.reduce((n, m) => n + m.content.length, 0) > MAX_CHAT_CHARS)
    throw new Error('Сообщение слишком большое');
  const safeModel = ALLOWED_MODELS.has(model) ? model : 'deepseek-chat';
  const safeTemperature = Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 1.3;
  const safeMaxTokens = Number.isFinite(maxTokens)
    ? Math.max(1, Math.min(4096, Math.floor(maxTokens))) : 1800;
  const body = {
    model: safeModel,
    messages: safeMessages,
    temperature: safeTemperature,
    max_tokens: safeMaxTokens,
    stream: false
  };

  let res;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(apiKey).trim()}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError')
      throw new Error('DeepSeek не ответил за 90 секунд. Попробуйте ещё раз.');
    throw new Error('Нет соединения с api.deepseek.com — проверьте интернет.');
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
    throw new Error(`DeepSeek API: ${msg}`);
  }
  if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Пустой ответ от DeepSeek.');
  }
  return data.choices[0].message.content;
}

/* ---------------- Данные (заготовки) ---------------- */
function readDataFile(name) {
  try { return fs.readFileSync(path.join(__dirname, 'data', name), 'utf-8'); }
  catch { return ''; }
}
ipcMain.handle('data:get', () => {
  let tipMenu = [];
  try { tipMenu = JSON.parse(readDataFile('tipmenu.json')); } catch { /* пусто */ }
  let goalsCat = null;
  try { goalsCat = JSON.parse(readDataFile('goals.json')); } catch { /* пусто */ }
  let goalBank = {};
  try { goalBank = JSON.parse(readDataFile('goal-bank.json')); } catch { /* пусто */ }
  const cats = (Array.isArray(tipMenu) ? tipMenu : []).filter((c) => c && c.id !== 'goals');
  if (goalsCat && Array.isArray(goalsCat.items)) cats.push(goalsCat);
  return {
    invitesRaw: readDataFile('Зазывы в приват.txt'),
    tipMenu: cats,
    goalBank
  };
});

/* ---------------- База опыта (обучение на чатах, Фаза 1) ---------------- */
const exp = require('./core/db');
ipcMain.handle('exp:save', (_e, payload) => {
  try {
    const p = payload || {};
    if (!p.history || String(p.history).trim().length < 5)
      return { ok: false, error: 'История чата пуста' };
    return { ok: true, ...exp.saveChat({
      history: String(p.history), strategy: p.strategy, platform: p.platform }) };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('exp:outcome', (_e, payload) => {
  try {
    const p = payload || {};
    return { ok: true, ...exp.markOutcome(
      Number(p.chatId), String(p.result || 'open'), Number(p.revenue || 0)) };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('exp:stats', () => {
  try { return { ok: true, stats: exp.getAnalytics() }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('exp:clear', () => {
  try { return exp.clearAll(); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('exp:examples', (_e, payload) => {
  try {
    const p = payload || {};
    return { ok: true, ...exp.getExperienceContext({
      history: String(p.history || ''), strategy: String(p.strategy || '') }) };
  } catch (err) {
    return { ok: false, error: err.message, count: 0,
      examplesBlock: '', statsBlock: '', antiBlock: '' };
  }
});

/* ---------------- IPC ---------------- */
ipcMain.handle('deepseek:chat', async (_e, payload) => {
  try {
    const p = Object.assign({}, payload || {});
    // F-01: интерфейсу ключ недоступен — подставляем сохранённый в main-процессе
    p.apiKey = getStoredApiKey();
    const content = await callDeepSeek(p);
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('deepseek:test', async (_e, payload) => {
  const t0 = Date.now();
  try {
    const p = Object.assign({}, payload || {});
    if (!p.apiKey || !String(p.apiKey).trim()) p.apiKey = getStoredApiKey(); // пусто = проверяем сохранённый
    await callDeepSeek(Object.assign(p, {
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 10
    }));
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// F-01/F-04: наружу отдаём конфиг БЕЗ ключа — только признак hasKey;
// сам ключ шифруется safeStorage и не покидает main-процесс
ipcMain.handle('config:load', () => {
  const cfg = loadConfig();
  const pub = Object.assign({}, cfg);
  delete pub.apiKey;
  delete pub.apiKeySecret;
  pub.hasKey = !!getStoredApiKey(cfg);
  return pub;
});
// F-01: пустое поле ключа при сохранении = «не менять сохранённый»
ipcMain.handle('config:save', (_e, cfg) => {
  try { saveConfig(cfg); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'https:' &&
        (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be'))
      shell.openExternal(parsed.href);
  } catch { /* неверная ссылка */ }
});

ipcMain.handle('window:setOnTop', (_e, flag) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!flag);
});

/* ---------------- Окно ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // F-07: навигационные guard'ы (defense-in-depth)
  // Переходы главного окна наружу запрещены
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  // Popup'ы запрещены (ссылки открываются только через shell.openExternal из main)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Все запросы разрешений (геолокация, уведомления и т.п.) отклоняются
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn('[security] Запрос разрешения отклонён:', permission);
    callback(false);
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!mainWindow) createWindow(); });
