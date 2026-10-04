import tipMenu from '../data/tipmenu.json';
import goals from '../data/goals.json';
import goalBank from '../data/goal-bank.json';
import invitesRaw from '../data/Зазывы в приват.txt';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const ALLOWED_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);
const MAX_BODY = 512 * 1024;
const MAX_CHAT_CHARS = 200 * 1024;

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

async function readJson(request) {
  const type = String(request.headers.get('content-type') || '').split(';')[0].trim();
  if (type !== 'application/json') throw new Error('Ожидается Content-Type: application/json');
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new Error('Слишком большое тело запроса');
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new Error('Некорректный JSON в теле запроса'); }
}

async function callDeepSeek(env, options) {
  const key = String(options.apiKey || env.DEEPSEEK_API_KEY || '').trim();
  if (!key) {
    throw new Error('В Cloudflare Runtime Variables & Secrets не настроен DEEPSEEK_API_KEY.');
  }
  const model = ALLOWED_MODELS.has(String(options.model || ''))
    ? String(options.model) : 'deepseek-chat';
  const temperature = Number.isFinite(Number(options.temperature))
    ? Math.min(2, Math.max(0, Number(options.temperature))) : 1.3;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response;
  const requestBody = {
    model,
    temperature,
    stream: false,
    max_tokens: Math.min(4096, Math.max(1, Number(options.maxTokens) || 1800)),
    messages: options.messages
  };
  if (options.responseFormat === 'json_object') {
    requestBody.response_format = { type: 'json_object' };
  }
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('DeepSeek не ответил за 90 секунд.');
    throw new Error('Нет соединения с api.deepseek.com.');
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message : `HTTP ${response.status}`;
    throw new Error(`DeepSeek API: ${message}`);
  }
  const content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (data && data.choices && data.choices[0] && data.choices[0].finish_reason === 'length') {
    throw new Error('DeepSeek обрезал ответ по лимиту. Попробуйте ещё раз.');
  }
  if (!content) throw new Error('DeepSeek вернул пустой ответ.');
  return content;
}

function emptyStats() {
  return {
    total: 0,
    conversion: 0,
    revenue: 0,
    avgMessages: 0,
    topTopics: [],
    weekly: [],
    strategies: []
  };
}

async function handleApi(request, env, pathname) {
  if (request.method === 'GET' && pathname === '/api/config') {
    return json(200, {
      hasKey: !!String(env.DEEPSEEK_API_KEY || '').trim(),
      model: 'deepseek-chat',
      temperature: 1.3,
      profile: {}
    });
  }
  if (request.method === 'POST' && pathname === '/api/config') {
    const body = await readJson(request);
    if (String(body.apiKey || '').trim()) {
      return json(400, {
        ok: false,
        error: 'API-ключ нельзя сохранить из сайта. Добавьте его как Cloudflare Runtime Secret.'
      });
    }
    return json(200, { ok: true, hasKey: !!String(env.DEEPSEEK_API_KEY || '').trim() });
  }
  if (request.method === 'POST' && pathname === '/api/test-key') {
    const body = await readJson(request);
    const started = Date.now();
    try {
      await callDeepSeek(env, {
        apiKey: body.apiKey,
        model: body.model,
        maxTokens: 10,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }]
      });
      return json(200, { ok: true, ms: Date.now() - started });
    } catch (error) {
      return json(200, { ok: false, error: error.message });
    }
  }
  if (request.method === 'GET' && pathname === '/api/data') {
    const categories = (Array.isArray(tipMenu) ? tipMenu : [])
      .filter((category) => category && category.id !== 'goals');
    if (goals && Array.isArray(goals.items)) categories.push(goals);
    return json(200, { invitesRaw, tipMenu: categories, goalBank });
  }
  if (request.method === 'POST' && pathname === '/api/chat') {
    const body = await readJson(request);
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length || messages.length > 20) {
      return json(400, { ok: false, error: 'messages: ожидается непустой массив до 20 сообщений' });
    }
    let totalChars = 0;
    for (const message of messages) {
      if (!message || typeof message.content !== 'string' ||
          !['system', 'user', 'assistant'].includes(message.role)) {
        return json(400, { ok: false, error: 'messages: некорректное сообщение' });
      }
      totalChars += message.content.length;
    }
    if (totalChars > MAX_CHAT_CHARS) {
      return json(413, { ok: false, error: 'Суммарный текст сообщений слишком большой' });
    }
    try {
      const content = await callDeepSeek(env, {
        model: body.model,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        responseFormat: body.responseFormat,
        messages
      });
      return json(200, { ok: true, content });
    } catch (error) {
      return json(502, { ok: false, error: error.message });
    }
  }

  // Без KV/D1 база опыта недолговечна. Генерация продолжает работать без неё.
  if (request.method === 'POST' && pathname === '/api/exp/examples') {
    await readJson(request);
    return json(200, { ok: true, count: 0, examplesBlock: '', statsBlock: '', antiBlock: '' });
  }
  if (request.method === 'GET' && pathname === '/api/exp/stats') {
    return json(200, { ok: true, stats: emptyStats() });
  }
  if (request.method === 'POST' && pathname.startsWith('/api/exp/')) {
    await readJson(request);
    return json(200, {
      ok: false,
      error: 'Постоянная база опыта пока не подключена к Cloudflare KV/D1.'
    });
  }
  return json(404, { error: 'Неизвестный API-маршрут' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!ALLOWED_METHODS.has(request.method)) {
      return json(405, { error: 'Method Not Allowed' }, { Allow: 'GET, HEAD, POST, OPTIONS' });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    try {
      return await handleApi(request, env, url.pathname);
    } catch (error) {
      return json(400, { ok: false, error: error.message || 'Некорректный запрос' });
    }
  }
};
