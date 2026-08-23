/**
 * Смоук-тест безопасности веб-сервера (проверки F-01, F-02, F-03, F-06, F-11).
 * Поднимает сервер на свободном порту с временным конфигом и прогоняет проверки.
 * Запуск: node tests/security.test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0;
function ok(cond, name) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  if (!cond) failed++;
}

/** Запрос с произвольными заголовками (fetch не даёт переопределить Host/Origin). */
function rawReq(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: headers || {} },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitServer(port, tries) {
  for (let i = 0; i < (tries || 50); i++) {
    try {
      const r = await rawReq(port, 'GET', '/api/config');
      if (r.status) return;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся');
}

(async () => {
  // временный конфиг с «ключом»
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sec-'));
  const cfgPath = path.join(tmpDir, 'web-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    apiKey: 'sk-TESTKEY1234567890',
    model: 'deepseek-chat',
    temperature: 1.3,
    profile: { name: 'Sophie' }
  }));

  // свободный порт
  const port = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });

  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', CONFIG_PATH: cfgPath
    }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

  try {
    await waitServer(port);

    /* ---- F-01: ключ никогда не возвращается ---- */
    let r = await rawReq(port, 'GET', '/api/config');
    let body = JSON.parse(r.body);
    ok(r.status === 200, 'GET /api/config -> 200');
    ok(!('apiKey' in body), 'F-01: ответ не содержит apiKey');
    ok(body.hasKey === true, 'F-01: hasKey = true при сохранённом ключе');
    ok(body.model === 'deepseek-chat' && body.profile && body.profile.name === 'Sophie',
      'F-01: модель и профиль отдаются как обычно');

    /* ---- F-06: заголовки ---- */
    ok(String(r.headers['cache-control']).includes('no-store'), 'F-06: Cache-Control: no-store на /api/*');
    ok(r.headers['x-content-type-options'] === 'nosniff', 'F-06: X-Content-Type-Options: nosniff');
    ok(r.headers['x-frame-options'] === 'DENY', 'F-06: X-Frame-Options: DENY');

    /* ---- F-02: DNS rebinding по Host ---- */
    r = await rawReq(port, 'GET', '/api/config', { Host: 'evil.example.com' });
    ok(r.status === 403, 'F-02: чужой Host (rebinding) -> 403, получено ' + r.status);

    r = await rawReq(port, 'GET', '/api/config', { Host: `localhost:${port}` });
    ok(r.status === 200, 'F-02: localhost в Host по-прежнему разрешён');

    /* ---- F-11: методы вне allowlist ---- */
    r = await rawReq(port, 'PUT', '/api/config');
    ok(r.status === 405, 'F-11: PUT -> 405');
    r = await rawReq(port, 'DELETE', '/api/data');
    ok(r.status === 405, 'F-11: DELETE -> 405');

    /* ---- F-02: CSRF через text/plain (PoC из аудита) ---- */
    r = await rawReq(port, 'POST', '/api/config',
      { 'Content-Type': 'text/plain' },
      '{"apiKey":"sk-HACKED","profile":{"name":"AUDIT_CSRF_PROOF"}}');
    ok(r.status === 415, 'F-02: POST text/plain -> 415, получено ' + r.status);

    /* ---- F-02: CSRF с чужим Origin ---- */
    r = await rawReq(port, 'POST', '/api/config',
      { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' }, '{}');
    ok(r.status === 403, 'F-02: POST с чужим Origin -> 403, получено ' + r.status);

    /* ---- F-01: пустой ключ при сохранении = «не менять» ---- */
    r = await rawReq(port, 'POST', '/api/config',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ apiKey: '', profile: { name: 'Renamed' } }));
    body = JSON.parse(r.body);
    ok(r.status === 200 && body.ok === true && body.hasKey === true,
      'F-01: пустое поле ключа принимается, hasKey остаётся true');
    let saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    ok(saved.apiKey === 'sk-TESTKEY1234567890', 'F-01: старый ключ НЕ перезаписан пустым');
    ok(saved.profile.name === 'Renamed', 'профиль при этом обновился');

    /* ---- новый ключ сохраняется ---- */
    r = await rawReq(port, 'POST', '/api/config',
      { 'Content-Type': 'application/json' }, JSON.stringify({ apiKey: 'sk-NEWKEY9999' }));
    saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    ok(saved.apiKey === 'sk-NEWKEY9999', 'новый ключ записывается в конфиг');

    /* ---- валидация /api/chat (без обращения к DeepSeek) ---- */
    r = await rawReq(port, 'POST', '/api/chat',
      { 'Content-Type': 'application/json' }, JSON.stringify({ messages: 'oops' }));
    ok(r.status === 400, 'валидация chat: messages не массив -> 400');
    r = await rawReq(port, 'POST', '/api/chat',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ apiKey: 'sk-ATTACKER', messages: [{ role: 'user', content: 'hi' }] }));
    ok(!r.body.includes('sk-ATTACKER'),
      'chat: подменный ключ из тела игнорируется (используется серверный)');

    /* ---- F-03: rate-limit (дефолтный бакет 60/мин на /api/data) ---- */
    let got429 = false;
    for (let i = 0; i < 70; i++) {
      const rr = await rawReq(port, 'GET', '/api/data');
      if (rr.status === 429) { got429 = true; break; }
    }
    ok(got429, 'F-03: превышение частоты запросов -> 429');
  } finally {
    child.kill();
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 300);
  }

  console.log(failed ? ('\nИТОГ: ПРОВАЛЕНО ' + failed) : '\nИТОГ: ВСЕ ТЕСТЫ ПРОШЛИ');
  process.exit(failed ? 1 : 0);
})();


