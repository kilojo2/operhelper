/**
 * Operator Helper Web — сервер сайта.
 * Раздаёт интерфейс и проксирует запросы к DeepSeek API,
 * чтобы API-ключ хранился только на сервере и никогда его не покидал.
 *
 * Безопасность:
 *  - F-01: GET /api/config никогда не возвращает сам ключ (только hasKey);
 *          пустой ключ при сохранении = «оставить прежний»; no-store на /api/*;
 *  - F-02: allowlist Host (анти-DNS-rebinding) и проверка Origin на POST;
 *          JSON принимается только с Content-Type: application/json;
 *  - F-03: token bucket на IP (/api/chat — 20 зап./мин, прочие API — 60);
 *          при HOST вне loopback обязателен токен доступа (печатается при старте);
 *  - F-04: конфиг хранится ВНЕ папки проекта (%APPDATA%/operator-helper);
 *  - F-06: nosniff / no-store / X-Frame-Options на всех ответах;
 *  - F-10: журнал запросов /api/* и ошибок в консоли;
 *  - F-11: методы ограничены allowlist'ом GET/HEAD/POST.
 *
 * Запуск:   npm run web   (или: node web/server.js)
 * Адрес:    http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
/* Облако (Railway и т.п.) выставляет PORT и требует слушать 0.0.0.0.
   Локально без PORT продолжаем держать сервер только на этом ПК. */
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
/* Дополнительные доменные имена, под которыми сайт доступен извне
   (например, домен Railway). Через запятую. Формат tolerant: можно с
   протоколом и слэшем — «https://abc.up.railway.app/» тоже сработает:
   ALLOWED_HOSTS=my-app.up.railway.app */
const EXTRA_HOSTS = new Set(
  String(process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // убрать протокол (https://)
      .replace(/\/.*$/, '')                   // убрать путь и слэш на конце
      .replace(/:\d+$/, '')                   // убрать порт
      .replace(/\.$/, ''))                    // убрать точку на конце
    .filter(Boolean)
);
const ROOT = path.resolve(__dirname);                 // web/
const SRC_DIR = path.resolve(__dirname, '..', 'src'); // общий фронтенд с десктопом
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const exp = require('../core/db'); // база опыта (обучение на чатах, Фаза 1)

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MAX_BODY = 512 * 1024; // 512 КБ на запрос (истории чатов бывают длинные)

/* ---------------- Конфиг (F-04: вне папки проекта) ---------------- */
function appDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'operator-helper');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'operator-helper');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'operator-helper');
}
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(appDataDir(), 'web-config.json');
const LEGACY_CONFIG_PATH = path.join(ROOT, 'config.json'); // старое место внутри проекта

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {}; }
  catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg || {}, null, 2), 'utf-8');
}
/** Перенос старого конфига (с ключом!) из папки проекта в %APPDATA%; оригинал удаляется. */
function migrateLegacyConfig() {
  try {
    if (!fs.existsSync(LEGACY_CONFIG_PATH)) return;
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    fs.rmSync(LEGACY_CONFIG_PATH, { force: true });
    console.log(`[security] Конфиг перенесён: ${LEGACY_CONFIG_PATH} -> ${CONFIG_PATH} (старый файл удалён)`);
  } catch (e) {
    console.warn('[security] Не удалось перенести legacy-конфиг:', e.message);
  }
}
migrateLegacyConfig();

/* ---------------- Журнал (F-10) ---------------- */
function log(line) { console.log(`[${new Date().toISOString()}] ${line}`); }


/* ---------------- Ответы и файлы (F-06) ---------------- */
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
const API_HEADERS = Object.assign({}, BASE_HEADERS, {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
});

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, API_HEADERS);
  res.end(JSON.stringify(obj));
}
function ctype(p) {
  const e = path.extname(p).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
  };
  return map[e] || 'application/octet-stream';
}
function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, BASE_HEADERS));
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, Object.assign({ 'Content-Type': ctype(filePath) }, BASE_HEADERS));
    res.end(buf);
  });
}
function safePath(base, urlPath) {
  const baseAbs = path.resolve(base);
  const p = path.normalize(path.join(baseAbs, decodeURIComponent(urlPath)));
  return (p === baseAbs || p.startsWith(baseAbs + path.sep)) ? p : null;
}

/* ---------------- Тело запроса (F-02: только application/json) ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'Слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
  if (ct !== 'application/json') throw new ApiError(415, 'Ожидается Content-Type: application/json');
  const raw = (await readBody(req)).replace(/^\uFEFF/, ''); // tolerate UTF-8 BOM
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new ApiError(400, 'Некорректный JSON в теле запроса'); }
}

/* ---------------- Rate-limit: token bucket на IP (F-03) ---------------- */
const RATE_RULES = [
  { re: /^\/api\/chat$/, capacity: 20, perMinute: 20 }
];
const RATE_DEFAULT = { capacity: 60, perMinute: 60 };
const buckets = new Map();
function clientIp(req) {
  /* За обратным прокси (Railway) реальный IP посетителя приходит в X-Forwarded-For */
  const xff = String(req.headers['x-forwarded-for'] || '');
  if (xff) return xff.split(',')[0].trim();
  return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
/** Возвращает 0 если запрос разрешён, иначе сколько секунд подождать (Retry-After). */
function rateLimit(req, pathname) {
  const rule = RATE_RULES.find((r) => r.re.test(pathname)) || RATE_DEFAULT;
  const key = `${clientIp(req)}|${rule === RATE_DEFAULT ? '*' : rule.re.source}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: rule.capacity, ts: now }; buckets.set(key, b); }
  b.tokens = Math.min(rule.capacity, b.tokens + ((now - b.ts) / 60000) * rule.perMinute);
  b.ts = now;
  if (b.tokens < 1) return Math.max(1, Math.ceil(((1 - b.tokens) / rule.perMinute) * 60));
  b.tokens -= 1;
  return 0;
}
setInterval(() => { // периодическая уборка «мёртвых» бакетов
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of buckets) if (v.ts < cutoff) buckets.delete(k);
}, 10 * 60 * 1000).unref();

/* ---------------- Guard'ы: Host / Origin / токен (F-02, F-03) ---------------- */
function isLoopbackBind() {
  const h = String(HOST).toLowerCase();
  return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1';
}
/* Токен доступа (F-03):
   - ACCESS_TOKEN=<значение> — требовать этот токен всегда (пароль на сайт);
   - ACCESS_TOKEN=off        — отключить проверку даже в сети
                               (режим публичного сайта, напр. за Railway);
   - не задан                — локально проверка выключена,
                               в сети генерируется случайный токен. */
const ENV_TOKEN = String(process.env.ACCESS_TOKEN || '');
const TOKEN_DISABLED = ENV_TOKEN.toLowerCase() === 'off';
const TOKEN_REQUIRED = TOKEN_DISABLED ? false : (!!ENV_TOKEN || !isLoopbackBind());
const ACCESS_TOKEN = TOKEN_DISABLED ? '' : (ENV_TOKEN || crypto.randomBytes(24).toString('hex'));

function hostnameOfHostHeader(header) {
  try {
    const u = new URL(`http://${String(header || '')}`);
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch { return null; }
}
function isLocalHostname(name) {
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '::ffff:127.0.0.1';
}
/** Анти-DNS-rebinding (F-02): разрешены только localhost и IP-литералы
 *  (литералы — лишь при сетевом запуске); любые доменные имена -> 403. */
function hostAllowed(header) {
  const name = hostnameOfHostHeader(header);
  if (!name) return false;
  if (isLocalHostname(name)) return true;
  if (EXTRA_HOSTS.has(name)) return true; // домены облака (Railway и т.п.)
  return net.isIP(name) > 0 && !isLoopbackBind();
}
/** CSRF (F-02): Origin/Referer браузерного POST должен указывать на этот же сервер.
 *  За TLS-прокси (Railway) внешний порт 443 не совпадает с внутренним PORT,
 *  поэтому для разрешённых имён https-origin принимается без сверки порта. */
function originAllowed(req) {
  let src = String(req.headers.origin || '');
  if (!src && req.headers.referer) {
    try { src = new URL(String(req.headers.referer)).origin; } catch { src = ''; }
  }
  if (!src || src === 'null') return true; // не браузерный клиент (curl и т.п.)
  try {
    const u = new URL(src);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const name = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const nameOk = isLocalHostname(name) ||
                   EXTRA_HOSTS.has(name) ||
                   (net.isIP(name) > 0 && !isLoopbackBind());
    if (!nameOk) return false;
    if (u.protocol === 'https:') return true;
    const port = u.port ? parseInt(u.port, 10) : 80;
    return port === PORT;
  } catch { return false; }
}
function tokenOk(req) {
  if (!TOKEN_REQUIRED) return true;
  let qtoken = '';
  try { qtoken = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch { /* ignore */ }
  const provided = String(req.headers['x-access-token'] || '') || qtoken;
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* ---------------- DeepSeek ---------------- */
/* Приоритет ключа: переданный в запросе -> сохранённый в config.json -> переменная окружения */
function resolveApiKey(provided) {
  return (provided && String(provided).trim()) ||
         (loadConfig().apiKey || '') ||
         (process.env.DEEPSEEK_API_KEY || '');
}

async function callDeepSeek({ apiKey, model, temperature, messages, maxTokens }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('API-ключ не задан. Откройте вкладку «Настройки» и впишите ключ DeepSeek.');
  }
  const body = {
    model: model && String(model).trim() ? String(model).trim() : 'deepseek-chat',
    messages,
    temperature: typeof temperature === 'number' ? temperature : 1.3,
    stream: false
  };
  if (maxTokens) body.max_tokens = maxTokens;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  let res;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(apiKey).trim()}` },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('Нет соединения с api.deepseek.com — проверьте интернет.');
  } finally {
    clearTimeout(timer);
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

/* ---------------- Публичный конфиг и валидация ввода (F-01) ---------------- */
function publicConfig() {
  const cfg = loadConfig();
  return {
    hasKey: !!(cfg.apiKey && String(cfg.apiKey).trim()),
    model: cfg.model || 'deepseek-chat',
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 1.3,
    profile: (cfg.profile && typeof cfg.profile === 'object' && !Array.isArray(cfg.profile)) ? cfg.profile : {}
  };
}
function strField(v, max) { return typeof v === 'string' ? v.slice(0, max) : undefined; }
function sanitizeConfigInput(body) {
  const out = {};
  if (body.model !== undefined) out.model = (strField(body.model, 64) || '').trim() || 'deepseek-chat';
  if (body.temperature !== undefined) {
    const t = Number(body.temperature);
    out.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 1.3;
  }
  if (body.profile !== undefined) {
    if (!body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile))
      throw new ApiError(400, 'profile должен быть объектом');
    const p = {};
    for (const k of ['name', 'age', 'look', 'persona', 'allowed', 'forbidden']) p[k] = strField(body.profile[k], 2000) || '';
    out.profile = p;
  }
  return out;
}
/* ---------------- API-маршруты ---------------- */
async function handleApi(req, res, pathname) {
  // F-01: ключ никогда не покидает сервер
  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, publicConfig());
  }
  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await readJson(req); // F-02: только application/json
    const cur = loadConfig();
    const next = Object.assign({}, cur, sanitizeConfigInput(body));
    const newKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    next.apiKey = newKey || cur.apiKey || ''; // пустое/отсутствует = «не менять» (F-01)
    saveConfig(next);
    log(`конфиг обновлён (${newKey ? 'ключ заменён' : 'ключ сохранён прежний'})`);
    return json(res, 200, { ok: true, hasKey: !!next.apiKey });
  }
  if (req.method === 'POST' && pathname === '/api/test-key') {
    const body = await readJson(req);
    // можно проверить как сохранённый/env-ключ, так и только что введённый (до сохранения)
    const typed = body.apiKey && String(body.apiKey).trim();
    const key = typed || resolveApiKey();
    try {
      await callDeepSeek({ apiKey: key, model: body.model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 10 });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await readJson(req);
    const msgs = Array.isArray(body.messages) ? body.messages : null;
    if (!msgs || !msgs.length || msgs.length > 60)
      throw new ApiError(400, 'messages: ожидается непустой массив сообщений (до 60)');
    for (const m of msgs) {
      if (!m || typeof m.content !== 'string' ||
          ['system', 'user', 'assistant'].indexOf(m.role) === -1)
        throw new ApiError(400, 'messages: некорректное сообщение');
    }
    try {
      const content = await callDeepSeek({
        apiKey: resolveApiKey(), // F-01/F-02: только серверный ключ (config или env), body.apiKey игнорируется
        model: body.model, temperature: body.temperature, messages: msgs
      });
      return json(res, 200, { ok: true, content });
    } catch (e) {
      // Ошибки DeepSeek/сети отдаём клиенту управляемо ({ok:false,error}), а не 500-й
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (req.method === 'GET' && pathname === '/api/data') {
    let tipMenu = [];
    try { tipMenu = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tipmenu.json'), 'utf-8')); } catch { /* пусто */ }
    let invitesRaw = '';
    try { invitesRaw = fs.readFileSync(path.join(DATA_DIR, 'Зазывы в приват.txt'), 'utf-8'); } catch { /* пусто */ }
    let goalsCat = null;
    try { goalsCat = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'goals.json'), 'utf-8')); } catch { /* пусто */ }
    let goalBank = {};
    try { goalBank = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'goal-bank.json'), 'utf-8')); } catch { /* пусто */ }
    const cats = (Array.isArray(tipMenu) ? tipMenu : []).filter((c) => c && c.id !== 'goals');
    if (goalsCat && Array.isArray(goalsCat.items)) cats.push(goalsCat);
    return json(res, 200, { invitesRaw, tipMenu: cats, goalBank });
  }
  if (req.method === 'POST' && pathname === '/api/exp/save') {
    const body = await readJson(req);
    if (!body.history || String(body.history).trim().length < 5)
      throw new ApiError(400, 'history: вставьте историю чата (минимум 5 символов)');
    let saved;
    try {
      saved = exp.saveChat({
        history: String(body.history),
        strategy: strField(body.strategy, 20) || '',
        platform: strField(body.platform, 40) || ''
      });
    } catch (e) {
      log('опыт: ошибка сохранения — ' + e.message);
      return json(res, 200, { ok: false, error: 'База опыта недоступна: ' + e.message });
    }
    log(`опыт: сохранён чат #${saved.chatId} (${saved.msgCount} сообщ.)`);
    return json(res, 200, { ok: true, chatId: saved.chatId, msgCount: saved.msgCount });
  }
  if (req.method === 'POST' && pathname === '/api/exp/outcome') {
    const body = await readJson(req);
    const allowed = ['won_private', 'won_tip', 'lost', 'open'];
    if (!allowed.includes(body.result))
      throw new ApiError(400, 'result: недопустимое значение');
    const chatId = Number(body.chatId);
    if (!Number.isFinite(chatId) || chatId <= 0)
      throw new ApiError(400, 'chatId: некорректный');
    let result;
    try {
      result = exp.markOutcome(chatId, body.result, Number(body.revenue || 0));
    } catch (e) {
      return json(res, 200, { ok: false, error: 'База опыта недоступна: ' + e.message });
    }
    return json(res, 200, result);
  }
  if (req.method === 'POST' && pathname === '/api/exp/examples') {
    const body = await readJson(req);
    let ctx;
    try {
      ctx = exp.getExperienceContext({
        history: String(body.history || ''),
        strategy: strField(body.strategy, 20) || ''
      });
    } catch (e) {
      return json(res, 200, { ok: false, count: 0, examplesBlock: '',
        statsBlock: '', antiBlock: '', error: 'База опыта недоступна: ' + e.message });
    }
    return json(res, 200, { ok: true, count: ctx.count,
      examplesBlock: ctx.examplesBlock, statsBlock: ctx.statsBlock, antiBlock: ctx.antiBlock });
  }
  if (req.method === 'GET' && pathname === '/api/exp/stats') {
    let stats;
    try {
      stats = exp.getAnalytics();
    } catch (e) {
      return json(res, 200, { ok: false, error: 'База опыта недоступна: ' + e.message });
    }
    return json(res, 200, { ok: true, stats });
  }
  return json(res, 404, { error: 'Неизвестный API-маршрут' });
}
/* ---------------- HTTP-сервер ---------------- */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']); // F-11: allowlist методов

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* кривой url */ }

  // F-10: журнал API-запросов и ошибок (только путь, без query — там бывает токен)
  res.on('finish', () => {
    if (pathname.startsWith('/api/') || res.statusCode >= 400) {
      log(`${clientIp(req)} ${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - startedAt} ms)`);
    }
  });

  try {
    // F-11: метод вне allowlist
    if (!ALLOWED_METHODS.has(req.method)) {
      res.writeHead(405, Object.assign({
        Allow: 'GET, HEAD, POST',
        'Content-Type': 'text/plain; charset=utf-8'
      }, BASE_HEADERS));
      return res.end('405 Method Not Allowed');
    }
    // F-02: анти-DNS-rebinding по Host
    if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });

    if (pathname.startsWith('/api/')) {
      // F-02: CSRF — источник браузерного POST должен совпадать с сервером
      if (req.method === 'POST' && !originAllowed(req)) return json(res, 403, { error: 'Forbidden origin' });
      // F-03: троттлинг ДО проверки токена (чтобы не брутфорсили токен)
      const retryAfter = rateLimit(req, pathname);
      if (retryAfter) {
        res.setHeader('Retry-After', String(retryAfter));
        return json(res, 429, { error: 'Слишком много запросов — попробуйте позже' });
      }
      // F-03: в сетевом режиме обязателен токен доступа
      if (!tokenOk(req)) {
        return json(res, 401, { error: TOKEN_REQUIRED ? 'Требуется токен доступа' : '', needToken: TOKEN_REQUIRED });
      }

      return await handleApi(req, res, pathname);
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, path.join(SRC_DIR, 'index.html'));
    }
    // Остальная статика (включая шим lib/api-web.js) — общий фронтенд с десктопом
    const fp = safePath(SRC_DIR, pathname);
    if (fp) return sendFile(res, fp);

    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, BASE_HEADERS));
    res.end('404 Not Found');
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status >= 500) console.error('[error]', req.method, req.url, e);
    if (!res.headersSent) {
      return json(res, status, { error: status >= 500 ? 'Внутренняя ошибка сервера' : e.message });
    }
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('🎬 Operator Helper (веб-версия) запущен!');
  console.log(`   Локальный адрес:  http://localhost:${PORT}`);
  console.log(`   Конфиг:           ${CONFIG_PATH}`);
  console.log('   Rate-limit:       /api/chat — 20 зап./мин, прочие API — 60 зап./мин');
  console.log('   Остановить сервер: Ctrl+C');
  if (TOKEN_REQUIRED) {
    console.log('');
    console.log(`⚠️  Сервер открыт ПО СЕТИ (HOST=${HOST}). Для доступа к /api обязателен токен:`);
    console.log(`   Токен доступа: ${ACCESS_TOKEN}`);
    console.log(`   Ссылка для клиентов: http://<IP-этого-ПК>:${PORT}/?token=${ACCESS_TOKEN}`);
  } else if (!isLoopbackBind() && TOKEN_DISABLED) {
    console.log('');
    console.log('⚠️  ACCESS_TOKEN=off: API открыт всем, кто знает адрес сайта.');
  }
  if (EXTRA_HOSTS.size) {
    console.log(`   Разрешённые внешние домены: ${[...EXTRA_HOSTS].join(', ')}`);
  }
});



