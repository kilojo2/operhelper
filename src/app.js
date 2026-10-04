/**
 * Оркестратор приложения: вкладки, настройки, музыка, тип-меню, буфер обмена.
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  window.AppState = { config: {}, data: { invitesRaw: '', tipMenu: [] } };

  /* ---------- Тост и копирование в буфер ---------- */
  let toastTimer = null;
  function showToast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Скопировано ✓');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Скопировано ✓');
    }
  }
  window.copyText = copyText;

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  /* ---------- Вкладки ---------- */
  window.switchTab = function switchTab(name) {
    $$('.tab').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $$('.tab-page').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + name));
    if (name === 'experience' && window.ExperienceTab) ExperienceTab.load();
  };

  function initTabs() {
    $$('.tab').forEach(btn =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  }

  function initExperience() {
    const btn = $('#clearExperienceBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить всю базу опыта и статистику без возможности восстановления?')) return;
      btn.disabled = true;
      const status = $('#clearExperienceStatus');
      try {
        const res = await window.api.expClear();
        if (!res || !res.ok) throw new Error((res && res.error) || 'Ошибка очистки');
        status.textContent = `Удалено диалогов: ${res.deleted || 0}. Локальные рабочие чаты сохранены.`;
        await ExperienceTab.load();
      } catch (e) {
        status.textContent = '❌ ' + e.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ---------- Поверх всех окон (только десктоп) ---------- */
  function initOnTop() {
    const el = $('#onTop');
    if (!el) return; // в веб-версии элемент скрыт/отсутствует
    el.addEventListener('change', (e) => {
      window.api.setOnTop(e.target.checked);
      showToast(e.target.checked ? '📌 Окно поверх всех' : 'Обычный режим окна');
    });
  }

  /* ---------- Вкладка «Опыт» (аналитика) ---------- */
  const ExperienceTab = {
    async load() {
      const box = $('#expKpis');
      try {
        const res = await window.api.expStats();
        if (!res.ok) throw new Error(res.error || 'Ошибка загрузки');
        ExperienceTab.render(res.stats || {});
      } catch (e) {
        box.innerHTML = '<div class="pane-note">❌ ' + escHtml(e.message) + '</div>';
      }
    },

    render(s) {
      const won = (s.byStatus && ((s.byStatus.won_private || 0) + (s.byStatus.won_tip || 0))) || 0;
      const kpis = [
        ['Всего диалогов', s.total || 0],
        ['Конверсия', (s.conversion || 0) + '%'],
        ['Победы', won],
        ['Ср. длина диалога', s.avgMsgs || 0],
        ['Доход (оценка)', s.revenue || 0]
      ];
      $('#expKpis').innerHTML = kpis.map(([l, v]) =>
        `<div class="kpi"><div class="kpi-v">${escHtml(v)}</div><div class="kpi-l">${escHtml(l)}</div></div>`).join('');

      const rows = s.byStrategy || [];
      const st = $('#expStrategyTable');
      if (!s.total) {
        st.innerHTML = '<div class="pane-note">Пока нет данных — сохраняй чаты в опыт и отмечай исходы</div>';
      } else {
        st.innerHTML =
          '<div class="str-row str-head"><span>Стратегия</span><span>Диалогов</span><span>Побед</span><span>Конверсия</span></div>' +
          rows.map((r) => {
            const conv = r.total ? Math.round(r.won / r.total * 100) : 0;
            return `<div class="str-row"><span>${escHtml(r.strategy)}</span><span>${r.total}</span><span>${r.won}</span><span class="${conv >= 50 ? 'good' : 'mid'}">${conv}%</span></div>`;
          }).join('');
      }

      const topics = s.topTopics || [];
      $('#expTopics').innerHTML = (s.total && topics.length)
        ? topics.map((t) => `<span class="topic-chip">${escHtml(t.topic)} <b>×${t.count}</b></span>`).join('')
        : '<span class="hint">Появятся после сохранения успешных чатов</span>';

      const weeks = s.weeks || [];
      const maxT = Math.max(1, ...weeks.map((w) => w.total));
      $('#expWeeks').innerHTML = s.total
        ? weeks.map((w) => {
            const hT = Math.round(w.total / maxT * 100);
            const hW = w.total ? Math.round(w.won / maxT * 100) : 0;
            return `<div class="week-col"><div class="week-bars">` +
              `<div class="bar-total" style="height:${hT}%"></div>` +
              `<div class="bar-won" style="height:${hW}%"></div></div>` +
              `<div class="week-l">${w.total} / ${w.won}</div>` +
              `<div class="week-d">${escHtml(String(w.label || '').slice(5))}</div></div>`;
          }).join('')
        : '';
    }
  };
  window.ExperienceTab = ExperienceTab;

  /* ---------- Настройки ---------- */
  function fillSettings(cfg) {
    // F-01: сервер никогда не возвращает сам ключ — поле всегда пустое,
    // плейсхолдер подсказывает, сохранён ли ключ ранее
    const keyInput = $('#apiKeyInput');
    keyInput.value = '';
    keyInput.placeholder = cfg.hasKey ? '•••• (ключ сохранён)' : 'sk-...';
    $('#modelSel').value = cfg.model || 'deepseek-chat';
    const t = typeof cfg.temperature === 'number' ? cfg.temperature : 1.3;
    $('#tempRange').value = t;
    $('#tempVal').textContent = t;
    const p = cfg.profile || {};
    $('#pfName').value = p.name || '';
    $('#pfAge').value = p.age || '';
    $('#pfLanguage').value = p.language || 'English';
    $('#pfLook').value = p.look || '';
    $('#pfPersona').value = p.persona || '';
    $('#pfVoice').value = p.voice || '';
    $('#pfExamples').value = p.examples || '';
    $('#pfOffers').value = p.offers || '';
    $('#pfAllowed').value = p.allowed || '';
    $('#pfForbidden').value = p.forbidden || '';
  }

  function collectSettings() {
    const ageText = $('#pfAge').value.trim();
    const age = Number(ageText);
    if (ageText && (!Number.isInteger(age) || age < 18 || age > 99)) {
      throw new Error('Возраст модели должен быть целым числом от 18 до 99');
    }
    return {
      apiKey: $('#apiKeyInput').value.trim(),
      model: $('#modelSel').value,
      temperature: parseFloat($('#tempRange').value),
      profile: {
        name: $('#pfName').value.trim(),
        age: ageText,
        language: $('#pfLanguage').value.trim() || 'English',
        look: $('#pfLook').value.trim(),
        persona: $('#pfPersona').value.trim(),
        voice: $('#pfVoice').value.trim(),
        examples: $('#pfExamples').value.trim(),
        offers: $('#pfOffers').value.trim(),
        allowed: $('#pfAllowed').value.trim(),
        forbidden: $('#pfForbidden').value.trim()
      }
    };
  }

  function initSettings() {
    fillSettings(AppState.config);

    $('#tempRange').addEventListener('input',
      (e) => { $('#tempVal').textContent = e.target.value; });

    $('#toggleKeyBtn').addEventListener('click', () => {
      const inp = $('#apiKeyInput');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      $('#toggleKeyBtn').textContent = inp.type === 'password' ? '👁 Показать' : '🙈 Скрыть';
    });

    $('#testKeyBtn').addEventListener('click', async () => {
      const st = $('#testKeyStatus');
      const typedKey = $('#apiKeyInput').value.trim();
      st.className = ''; st.textContent = typedKey ? '⏳ Проверяю...' : '⏳ Проверяю сохранённый ключ...';
      try {
        const res = await window.api.testKey({
          apiKey: typedKey, // пусто = проверить ключ, хранящийся на сервере / в main-процессе (F-01)
          model: $('#modelSel').value
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'Проверка не удалась');
        AppState.config.hasKey = true;
        $('#apiKeyInput').placeholder = '•••• (ключ сохранён)';
        st.className = 'ok'; st.textContent = '✅ Ключ работает (' + res.ms + ' мс)';
      } catch (e) {
        st.className = 'err'; st.textContent = '❌ ' + e.message;
      }
    });

    $('#saveSettingsBtn').addEventListener('click', async () => {
      const typedKey = $('#apiKeyInput').value.trim();
      const s = $('#saveStatus');
      try {
        const next = Object.assign({}, AppState.config, collectSettings());
        const res = await window.api.saveConfig(next);
        if (res && res.ok === false) throw new Error(res.error || 'Ошибка сохранения');
        delete next.apiKey;
        if (typedKey) next.hasKey = true;
        AppState.config = next;
        $('#apiKeyInput').value = '';
        if (next.hasKey) $('#apiKeyInput').placeholder = '•••• (ключ сохранён)';
        s.className = 'ok';
        s.textContent = '✅ Настройки сохранены';
      } catch (e) {
        s.className = 'err';
        s.textContent = '❌ ' + e.message;
      }
      setTimeout(() => { s.textContent = ''; }, 2500);
    });
  }

  /* ---------- Музыка ---------- */
  function loadMusic() {
    return window.MusicPresets.load(localStorage);
  }
  function saveMusic(arr) { window.MusicPresets.save(localStorage, arr); }

  function ytId(url) {
    try {
      const raw = String(url || '').trim();
      const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
      const host = parsed.hostname.toLowerCase();
      let id = '';
      if (host === 'youtu.be') id = parsed.pathname.split('/').filter(Boolean)[0] || '';
      else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        if (parsed.pathname === '/watch') id = parsed.searchParams.get('v') || '';
        else id = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})(?:\/|$)/)?.[1] || '';
      }
      return /^[\w-]{11}$/.test(id) ? id : '';
    } catch { return ''; }
  }

  function initMusic() {
    const grid = $('#musicGrid');
    grid.innerHTML = '';
    const list = loadMusic();

    list.forEach((url, i) => {
      const card = document.createElement('div');
      card.className = 'music-card';
      card.innerHTML =
        '<div class="music-top">' +
        '<div class="music-num">' + (i + 1) + '</div>' +
        '<input class="m-url" placeholder="https://www.youtube.com/watch?v=..." spellcheck="false"></div>' +
        '<div class="music-btns">' +
        '<button class="btn small ghost m-open">🌐 Открыть в браузере</button>' +
        '<button class="btn small ghost m-play">▶ Мини-плеер</button></div>';

      const input = card.querySelector('.m-url');
      input.value = url || '';
      input.addEventListener('input', () => { list[i] = input.value.trim(); saveMusic(list); });

      card.querySelector('.m-open').addEventListener('click', () => {
        const u = input.value.trim();
        if (!ytId(u)) { showToast('⚠️ Вставьте корректную ссылку YouTube'); return; }
        window.api.openExternal(u.startsWith('http') ? u : 'https://' + u);
      });

      const playBtn = card.querySelector('.m-play');
      playBtn.addEventListener('click', () => {
        const exist = card.querySelector('iframe');
        if (exist) { exist.remove(); playBtn.textContent = '▶ Мини-плеер'; return; }
        const id = ytId(input.value.trim());
        if (!id) { showToast('⚠️ Некорректная ссылка YouTube'); return; }
        const fr = document.createElement('iframe');
        fr.className = 'music-frame';
        fr.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&loop=1&playlist=' + id;
        fr.allow = 'autoplay; encrypted-media';
        fr.allowFullscreen = true;
        card.appendChild(fr);
        playBtn.textContent = '⏹ Стоп';
      });

      grid.appendChild(card);
    });
  }

  /* ---------- Тип-меню ---------- */
  let tmActive = 'all';
  let tmQuery = '';

  function initTipMenu() {
    const cats = AppState.data.tipMenu || [];
    const pills = $('#tmCats');
    pills.innerHTML = '';

    const mkPill = (id, label) => {
      const b = document.createElement('button');
      b.className = 'pill' + (tmActive === id ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        tmActive = id;
        $$('#tmCats .pill').forEach(p => p.classList.toggle('active', p === b));
        renderTipMenu();
      });
      return b;
    };

    pills.appendChild(mkPill('all', '✨ Все категории'));
    cats.forEach(c => pills.appendChild(mkPill(c.id, (c.icon || '') + ' ' + c.name)));

    $('#tmSearch').addEventListener('input', (e) => {
      tmQuery = e.target.value.toLowerCase().trim();
      renderTipMenu();
    });
    renderTipMenu();
  }

  function renderTipMenu() {
    const grid = $('#tmGrid');
    grid.innerHTML = '';
    const cats = AppState.data.tipMenu || [];
    let count = 0;

    for (const c of cats) {
      if (tmActive !== 'all' && tmActive !== c.id) continue;
      const all = c.items || [];
      const textOf = (t) => typeof t === 'string'
        ? t
        : ((t.en || '') + ' ' + (t.ru || ''));
      const items = all.filter(t => !tmQuery || textOf(t).toLowerCase().includes(tmQuery));
      if (!items.length) continue;

      const h = document.createElement('h3');
      h.style.gridColumn = '1 / -1';
      h.style.margin = '10px 0 2px';
      h.style.fontSize = '14px';
      h.textContent = (c.icon || '') + ' ' + c.name;
      grid.appendChild(h);

      for (const t of items) {
        const div = document.createElement('div');
        div.className = 'tm-item';
        const span = document.createElement('span');
        let copyText;
        if (typeof t === 'string') {
          span.textContent = t;
          copyText = t;
        } else {
          const en = document.createElement('div');
          en.className = 'tm-en';
          en.textContent = t.en || t.ru || '';
          const ru = document.createElement('div');
          ru.className = 'tm-ru';
          ru.textContent = t.ru || '';
          span.append(en, ru);
          copyText = t.en || t.ru || '';
        }
        const btn = document.createElement('button');
        btn.className = 'tm-copy';
        btn.textContent = 'copy';
        btn.addEventListener('click', () => window.copyText(copyText));
        div.append(span, btn);
        grid.appendChild(div);
        count++;
      }
    }
    if (!count) grid.innerHTML = '<div class="pane-note">Ничего не найдено</div>';
  }

  /* ---------- Генератор целей (хештеги) ---------- */
  const GG_TAGS = [
    { tag: 'feet', label: '#feet 🦶' },
    { tag: 'ass', label: '#ass 🍑' },
    { tag: 'tits', label: '#tits 🍒' },
    { tag: 'face', label: '#face 😍' },
    { tag: 'lips', label: '#lips 👄' },
    { tag: 'finger', label: '#finger 🖖' },
    { tag: 'pussy', label: '#pussy 🍓' }
  ];
  const MY_GOALS_KEY = 'oh_my_goals_v1';
  let ggTag = null;
  let ggItems = [];

  function loadMyGoals() {
    try { return JSON.parse(localStorage.getItem(MY_GOALS_KEY)) || []; }
    catch { return []; }
  }
  function saveMyGoals(list) {
    localStorage.setItem(MY_GOALS_KEY, JSON.stringify(list));
  }

  function initGoalsGen() {
    const pills = $('#ggTags');
    pills.innerHTML = GG_TAGS.map((t) =>
      `<button class="pill" data-tag="${t.tag}">${t.label}</button>`).join('');
    pills.querySelectorAll('.pill').forEach((b) =>
      b.addEventListener('click', () => {
        ggTag = b.dataset.tag;
        pills.querySelectorAll('.pill').forEach((p) => p.classList.toggle('active', p === b));
        $('#ggStatus').textContent = '';
        renderGoalsGen();
      }));
    $('#ggGenerateBtn').addEventListener('click', generateAiGoals);
    $('#ggCopyAllBtn').addEventListener('click', copyAllMyGoals);
    renderMyGoals();
  }

  function renderGoalsGen() {
    const bank = (window.AppState.data && AppState.data.goalBank) || {};
    const cat = bank[ggTag] || { items: [] };
    ggItems = (cat.items || []).map((i) => ({ en: i.en, ru: i.ru, ai: false }));
    $('#ggTitle').textContent = (cat.label || '#' + ggTag) +
      ' — ' + ggItems.length + ' готовых целей';
    renderGgGrid();
  }

  function renderGgGrid() {
    const grid = $('#ggGrid');
    grid.innerHTML = ggItems.map((it, idx) =>
      `<div class="gg-item${it.ai ? ' gg-ai' : ''}">` +
      `<div class="gg-en">${escHtml(it.en)}${it.ai ? ' <span class="chip fast">✨ AI</span>' : ''}</div>` +
      `<div class="gg-ru">${escHtml(it.ru)}</div>` +
      `<div class="gg-btns">` +
      `<button class="tm-copy" data-act="copy" data-idx="${idx}">📋 copy</button>` +
      `<button class="tm-copy" data-act="save" data-idx="${idx}">⭐ в мои</button>` +
      `</div></div>`).join('');
    grid.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        const it = ggItems[Number(b.dataset.idx)];
        if (!it) return;
        if (b.dataset.act === 'copy') window.copyText(it.en);
        else addToMyGoals(it);
      }));
  }

  const GOAL_JSON_SYSTEM = [
    'Ты — генератор tip-menu goals для совершеннолетней вебкам-модели.',
    'Верни только валидный JSON-объект без markdown и пояснений.',
    'Точная схема: {"goals":[{"en":"English goal with 1-2 emoji","ru":"Точный перевод с 1-2 эмодзи"}]}.',
    'Каждая цель — короткая фраза-действие от лица модели и строго соответствует запрошенной категории.',
    'В JSON должно быть ровно 10 разных элементов; оба поля в каждом элементе обязательны.'
  ].join('\n');

  async function requestAiGoalBatch(cfg, retry) {
    const avoid = ggItems.slice(-30).map((item) => item.en).filter(Boolean);
    const instruction = [
      `Категория: #${ggTag}. Сгенерируй 10 новых целей.`,
      avoid.length ? `Не повторяй эти цели: ${JSON.stringify(avoid)}.` : '',
      retry ? 'Предыдущий ответ не прошёл проверку. Верни JSON заново и точно по схеме.' : ''
    ].filter(Boolean).join('\n');
    const response = await window.api.chat({
      model: cfg.model || 'deepseek-chat',
      temperature: retry ? 0.2 : 0.75,
      maxTokens: 1800,
      responseFormat: 'json_object',
      messages: [
        { role: 'system', content: GOAL_JSON_SYSTEM },
        { role: 'user', content: instruction }
      ]
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : 'Ошибка генерации');
    }
    return window.AiJson.parseGoalItems(response.content, 10);
  }

  async function generateAiGoals() {
    if (!ggTag) { $('#ggStatus').textContent = '⚠️ Сначала выбери хештег'; return; }
    const btn = $('#ggGenerateBtn');
    btn.disabled = true;
    $('#ggStatus').textContent = '⏳ DeepSeek придумывает свежие цели...';
    try {
      if (!window.AiJson) throw new Error('Модуль проверки JSON не загрузился');
      const cfg = (window.AppState && AppState.config) || {};
      let generated = [];
      let firstError = null;
      try { generated = await requestAiGoalBatch(cfg, false); }
      catch (error) { firstError = error; }
      if (generated.length < 8) {
        $('#ggStatus').textContent = '⏳ Исправляю формат ответа...';
        try {
          const retried = await requestAiGoalBatch(cfg, true);
          generated = generated.concat(retried);
        } catch (retryError) {
          if (!generated.length) throw (retryError || firstError);
        }
      }

      const existing = new Set(ggItems.map((item) => String(item.en || '').toLocaleLowerCase('en-US')));
      const fresh = [];
      for (const item of generated) {
        const key = item.en.toLocaleLowerCase('en-US');
        if (existing.has(key)) continue;
        existing.add(key);
        fresh.push({ en: item.en, ru: item.ru, ai: true });
        if (fresh.length === 10) break;
      }
      if (!fresh.length) {
        throw new Error('ИИ не смог вернуть новые цели в правильном формате. Нажми ещё раз.');
      }
      ggItems = ggItems.concat(fresh);
      renderGgGrid();
      $('#ggStatus').textContent = `✨ AI добавил целей: ${fresh.length}`;
    } catch (e) {
      $('#ggStatus').textContent = '❌ ' + (e && e.message ? e.message : 'Не удалось сгенерировать цели');
    } finally {
      btn.disabled = false;
    }
  }

  function addToMyGoals(it) {
    const list = loadMyGoals();
    if (list.some((g) => g.en === it.en)) {
      $('#ggStatus').textContent = '⭐ Эта цель уже в моих';
      return;
    }
    list.push({ tag: ggTag || '', en: it.en, ru: it.ru });
    saveMyGoals(list);
    renderMyGoals();
    $('#ggStatus').textContent = '⭐ Добавлено в мои цели (' + list.length + ')';
  }

  function renderMyGoals() {
    const list = loadMyGoals();
    const box = $('#myGoalsList');
    box.innerHTML = list.length
      ? list.map((g, i) =>
          `<div class="lib-row"><div class="lib-en">${escHtml(g.en)}</div>` +
          `<div class="lib-ru">${escHtml(g.ru)}</div>` +
          `<button class="btn small ghost" data-i="${i}" data-act="copy">📋</button>` +
          `<button class="btn small ghost" data-i="${i}" data-act="del">✖</button></div>`).join('')
      : '<div class="pane-note">Отмечай ⭐ у целей — они соберутся сюда для стрима</div>';
    box.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        const list2 = loadMyGoals();
        const g = list2[Number(b.dataset.i)];
        if (!g) return;
        if (b.dataset.act === 'copy') window.copyText(g.en);
        else { list2.splice(Number(b.dataset.i), 1); saveMyGoals(list2); renderMyGoals(); }
      }));
    const cnt = $('#myGoalsCount');
    if (cnt) cnt.textContent = list.length ? list.length + ' шт.' : '';
  }

  function copyAllMyGoals() {
    const list = loadMyGoals();
    if (!list.length) { $('#ggStatus').textContent = '⚠️ Список пуст'; return; }
    window.copyText(list.map((g, i) => (i + 1) + '. ' + g.en).join('\n'));
  }

  /* ---------- Запуск ---------- */
  window.addEventListener('DOMContentLoaded', async () => {
    // 1) Сначала привязываем интерфейс — кнопки работают даже если сервер недоступен
    try {
      initTabs();
      initExperience();
      initOnTop();
      Assistant.init();
    } catch (e) { console.error('Ошибка инициализации интерфейса:', e); }

    // 2) Затем подтягиваем конфиг и данные — сбой здесь больше не ломает кнопки
    try { AppState.config = await window.api.loadConfig() || {}; }
    catch (e) { console.warn('Конфиг недоступен:', e); AppState.config = {}; }

    try { AppState.data = await window.api.getData(); }
    catch (e) {
      console.warn('Заготовки недоступны:', e);
      AppState.data = { invitesRaw: '', tipMenu: [] };
    }

    // 3) Отрисовка данных
    try {
      initSettings();
      initMusic();
      initTipMenu();
      initGoalsGen();
      Assistant.initLibrary(AppState.data.invitesRaw || '');
    } catch (e) { console.error('Ошибка отрисовки данных:', e); }
  });
})();
