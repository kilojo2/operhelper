const API_ORIGIN = 'https://operhelper.onrender.com';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    if (!incoming.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    if (!ALLOWED_METHODS.has(request.method)) {
      return json(405, { error: 'Method Not Allowed' });
    }

    const upstream = new URL(incoming.pathname + incoming.search, API_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');
    headers.delete('x-forwarded-for');
    headers.set('Origin', 'https://operhelper.killasnazz.workers.dev');

    const init = {
      method: request.method,
      headers,
      redirect: 'manual'
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    try {
      return await fetch(upstream, init);
    } catch {
      return json(502, {
        ok: false,
        error: 'API-сервер временно недоступен. Повторите попытку через несколько секунд.'
      });
    }
  }
};
