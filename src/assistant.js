/**
 * Логика вкладки «Ассистент»: чаты-сессии, анализ истории через DeepSeek,
 * отображение результата, библиотека заготовок.
 */
(function () {
  'use strict';

  const CHATS_KEY = 'oh_chats_v2';
  const CHATS_RETENTION_DAYS = 30; // F-09: автоочистка историй старше N дней
  const $ = (s) => document.querySelector(s);

  let chats = [];
  let activeId = null;
  let invitesLib = [];
  let invitesRawText = '';

  /* ---------- Хранилище чатов (localStorage) ---------- */
  function loadChats() {
    try { chats = JSON.parse(localStorage.getItem(CHATS_KEY)) || []; }
    catch { chats = []; }
    // F-09: приватность — автоочистка историй старше CHATS_RETENTION_DAYS
    const cutoff = Date.now() - CHATS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const kept = chats.filter((c) => (typeof c.updatedAt === 'number' ? c.updatedAt : Date.now()) >= cutoff);
    if (kept.length !== chats.length) {
      chats = kept;
      try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); } catch { /* ignore */ }
    }
  }
  function saveChats() { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); }
  function touch(c) { if (c) c.updatedAt = Date.now(); }
  // F-09: ручная очистка всех переписок (PII третьих лиц)
  function clearAllChats() {
    chats = [];
    activeId = null;
    saveChats();
    renderChatList();
    $('#resultArea').classList.add('hidden');
    $('#chatSession').classList.add('hidden');
    $('#noChatPlaceholder').classList.remove('hidden');
  }
  function getActive() { return chats.find(c => c.id === activeId) || null; }

  function newChatObj() {
    return {
      id: 'c' + Date.now() + Math.floor(Math.random() * 10000),
      title: 'Чат ' + (chats.length + 1),
      history: '', strategy: 'auto', lastResult: '',
      createdAt: Date.now(), updatedAt: Date.now()
    };
  }

  /* ---------- Рендер ---------- */
  function renderChatList() {
    const box = $('#chatList');
    box.innerHTML = '';
    for (const c of chats) {
      const div = document.createElement('div');
      div.className = 'chat-item' + (c.id === activeId ? ' active' : '');
      const dot = document.createElement('span'); dot.className = 'dot';
      const name = document.createElement('span'); name.className = 'name';
      name.textContent = c.title;
      div.append(dot, name);
      div.addEventListener('click', () => openChat(c.id));
      box.appendChild(div);
    }
  }

  function openChat(id) {
    activeId = id;
    renderChatList();
    const c = getActive();
    if (!c) return;
    $('#noChatPlaceholder').classList.add('hidden');
    $('#chatSession').classList.remove('hidden');
    $('#chatTitle').value = c.title;
    $('#historyInput').value = c.history || '';
    $('#strategySel').value = c.strategy || 'auto';
    if (c.lastResult) renderResult(c.lastResult);
    else $('#resultArea').classList.add('hidden');
    $('#statusLine').textContent = '';
    $('#historyInput').focus();
  }

  /* ---------- Модалка «Добавить чат» ---------- */
  function askAddChat() { $('#modalOverlay').classList.remove('hidden'); }
  function closeModal() { $('#modalOverlay').classList.add('hidden'); }

  /* ---------- Результат анализа ---------- */
  function chipClass(line) {
    const u = (line || '').toUpperCase();
    if (u.startsWith('FAST')) return 'chip fast';
    if (u.startsWith('DONATE')) return 'chip donate';
    return 'chip slow';
  }

  function renderResult(content) {
    const b = Parser.parseAssistantResponse(content);
    $('#resultArea').classList.remove('hidden');

    if (b['АНАЛИЗ']) {
      $('#analysisCard').classList.remove('hidden');
      $('#analysisText').textContent = b['АНАЛИЗ'];
    } else $('#analysisCard').classList.add('hidden');

    const chip = $('#strategyChip');
    chip.textContent = b['СТРАТЕГИЯ'] ? b['СТРАТЕГИЯ'].split('\n')[0] : '—';
    chip.className = chipClass(b['СТРАТЕГИЯ']);

    document.querySelector('.answer-card.best .answer-text').textContent =
      b['ОТВЕТ'] || '(ассистент не вернул блок [ОТВЕТ])';

    const wrap = $('#altsWrap');
    wrap.innerHTML = '';
    ['АЛЬТЕРНАТИВА 1', 'АЛЬТЕРНАТИВА 2'].forEach((key, i) => {
      const val = b[key];
      const card = document.createElement('div');
      card.className = 'card answer-card alt';
      const head = document.createElement('div');
      head.className = 'card-head';
      head.innerHTML = '<h3>🔁 Альтернатива ' + (i + 1) + '</h3>' +
        '<button class="btn small ghost copy-btn">📋 Копировать</button>';
      const txt = document.createElement('div');
      txt.className = 'answer-text';
      txt.textContent = val || '—';
      card.append(head, txt);
      head.querySelector('.copy-btn')
          .addEventListener('click', () => window.copyText(val || ''));
      wrap.appendChild(card);
    });

    if (b['ПРОГНОЗ']) {
      $('#forecastCard').classList.remove('hidden');
      $('#forecastText').textContent = b['ПРОГНОЗ'];
    } else $('#forecastCard').classList.add('hidden');

    if (b['ПОЧЕМУ']) {
      $('#whyCard').classList.remove('hidden');
      $('#whyText').textContent = b['ПОЧЕМУ'];
    } else $('#whyCard').classList.add('hidden');
  }

  /* ---------- Анализ через DeepSeek ---------- */
  function setStatus(msg, isErr) {
    const el = $('#statusLine');
    el.textContent = msg || '';
    el.className = isErr ? 'err' : '';
  }

  async function analyze() {
    const c = getActive();
    if (!c) return;
    const hist = $('#historyInput').value.trim();
    if (!hist) { setStatus('⚠️ Сначала вставьте историю чата', true); return; }

    c.history = hist;
    c.strategy = $('#strategySel').value;
    touch(c); // F-09: время последней активности для автоочистки
    saveChats();

    const cfg = (window.AppState && AppState.config) || {};
    // F-01: признак наличия ключа — cfg.hasKey (сам ключ интерфейсу недоступен).
    // В веб-версии ключ может задаваться переменной окружения DEEPSEEK_API_KEY на
    // сервере (cfg.hasKey об этом не знает) — не блокируем, сервер вернёт ошибку сам.
    const isWeb = document.documentElement.classList.contains('web');
    if (!isWeb && !cfg.hasKey && !(cfg.apiKey && String(cfg.apiKey).trim())) {
      setStatus('❌ Нет API-ключа DeepSeek — откройте вкладку «Настройки»', true);
      if (window.switchTab) window.switchTab('settings');
      return;
    }

    const btn = $('#analyzeBtn');
    btn.disabled = true;
    setStatus('⏳ Ассистент изучает юзера, продумывает его возможные ответы и выбирает лучшую линию...');

    try {
      const res = await window.api.chat({
        model: cfg.model || 'deepseek-chat',
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 1.3,
        messages: [
          { role: 'system', content: Prompts.buildSystemPrompt(cfg.profile, invitesRawText) },
          { role: 'user', content: Prompts.buildUserPrompt(hist, c.strategy) }
        ]
      });
      if (!res.ok) { setStatus('❌ ' + res.error, true); return; }
      c.lastResult = res.content;
      saveChats();
      renderResult(res.content);
      setStatus('✅ Готово! Скопируйте «Лучший ответ» и отправьте юзеру.');
    } catch (e) {
      setStatus('❌ ' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Библиотека зазывов ---------- */
  function initLibrary(raw) {
    invitesRawText = raw || '';
    invitesLib = Parser.parseInvites(invitesRawText);
    $('#libCount').textContent = invitesLib.length + ' фраз';
    renderLib('');
  }

  function renderLib(q) {
    q = (q || '').toLowerCase();
    const box = $('#libList');
    box.innerHTML = '';
    const list = invitesLib.filter(i =>
      !q || (i.en + ' ' + (i.ru || '')).toLowerCase().includes(q));
    for (const item of list) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      const en = document.createElement('div'); en.className = 'lib-en'; en.textContent = item.en;
      const ru = document.createElement('div'); ru.className = 'lib-ru'; ru.textContent = item.ru || '';
      const btn = document.createElement('button');
      btn.className = 'btn small ghost'; btn.textContent = '📋';
      btn.title = 'Копировать английский вариант';
      btn.addEventListener('click', () => window.copyText(item.en));
      row.append(en, ru, btn);
      box.appendChild(row);
    }
    if (!list.length) box.innerHTML = '<div class="pane-note">Ничего не найдено</div>';
  }

  /* ---------- Инициализация вкладки ---------- */
  function init() {
    loadChats();
    renderChatList();

    $('#addChatBtn').addEventListener('click', askAddChat);
    $('#modalBackBtn').addEventListener('click', closeModal);
    $('#modalOkBtn').addEventListener('click', () => {
      closeModal();
      const c = newChatObj();
      chats.unshift(c);
      saveChats();
      openChat(c.id);
    });
    $('#modalOverlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    $('#deleteChatBtn').addEventListener('click', () => {
      const c = getActive();
      if (!c) return;
      if (confirm('Удалить чат «' + c.title + '» вместе с историей?')) {
        chats = chats.filter(x => x.id !== c.id);
        activeId = null;
        saveChats();
        renderChatList();
        $('#chatSession').classList.add('hidden');
        $('#noChatPlaceholder').classList.remove('hidden');
      }
    });

    $('#chatTitle').addEventListener('input', () => {
      const c = getActive();
      if (c) { c.title = $('#chatTitle').value.trim() || 'Без имени'; touch(c); saveChats(); renderChatList(); }
    });

    // F-09: кнопка «Очистить все чаты»
    $('#clearAllChatsBtn').addEventListener('click', () => {
      if (!chats.length) { alert('Сохранённых чатов нет.'); return; }
      if (confirm('Удалить ВСЕ чаты вместе с историями безвозвратно?')) clearAllChats();
    });

    $('#analyzeBtn').addEventListener('click', analyze);
    $('#historyInput').addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') analyze();
    });
    $('#strategySel').addEventListener('change', () => {
      const c = getActive();
      if (c) { c.strategy = $('#strategySel').value; saveChats(); }
    });
    $('#libSearch').addEventListener('input', (e) => renderLib(e.target.value));

    document.querySelector('.copy-main-btn').addEventListener('click', () =>
      window.copyText(document.getElementById('mainAnswer').textContent));

    if (chats.length) openChat(chats[0].id);
  }

  window.Assistant = { init, initLibrary };
})();


