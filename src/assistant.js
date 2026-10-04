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
  let saveTimer = null;
  const REPLY_TONES = new Set(['softer', 'bolder', 'shorter']);

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
  function saveChats() {
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
      return true;
    } catch (e) {
      console.warn('Не удалось сохранить чаты:', e);
      return false;
    }
  }
  function scheduleSaveChats() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!saveChats()) setStatus('Не удалось сохранить историю: хранилище браузера переполнено', true);
    }, 300);
  }
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
      history: '', strategy: 'auto', chatMode: 'auto', lastResult: '', replyTone: 'softer',
      expId: null, expResult: '',
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
    $('#chatModeSel').value = c.chatMode || 'auto';
    syncReplyTone(c.replyTone || 'softer');
    $('#analysisDetails').open = false;
    if (c.lastResult) renderResult(c.lastResult);
    else $('#resultArea').classList.add('hidden');
    $('#statusLine').textContent = '';
    renderExpState(c);
    $('#historyInput').focus();
  }

  /* ---------- Модалка «Добавить чат» ---------- */
  function askAddChat() {
    $('#modalOverlay').classList.remove('hidden');
    $('#modalOkBtn').focus();
  }
  function closeModal() {
    $('#modalOverlay').classList.add('hidden');
    $('#addChatBtn').focus();
  }

  /* ---------- Результат анализа ---------- */
  function chipClass(line) {
    const u = (line || '').toUpperCase();
    if (u.startsWith('FAST')) return 'chip fast';
    if (u.startsWith('DONATE')) return 'chip donate';
    return 'chip slow';
  }

  function syncReplyTone(tone) {
    const selected = REPLY_TONES.has(tone) ? tone : 'softer';
    document.querySelectorAll('.tone-option').forEach((btn) => {
      const active = btn.dataset.tone === selected;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    return selected;
  }

  function setReplyControlsBusy(busy) {
    $('#regenerateReplyBtn').disabled = busy;
    document.querySelectorAll('.tone-option').forEach((btn) => { btn.disabled = busy; });
  }

  function renderResult(content) {
    const result = AssistantResult.toViewModel(content);
    $('#resultArea').classList.remove('hidden');

    if (result.analysis) {
      $('#analysisCard').classList.remove('hidden');
      $('#analysisText').textContent = result.analysis;
    } else $('#analysisCard').classList.add('hidden');

    const chip = $('#strategyChip');
    chip.textContent = result.strategy ? result.strategy.split('\n')[0] : '—';
    chip.className = chipClass(result.strategy);
    $('#strategyCard').classList.toggle('hidden', !result.strategy);

    $('#mainAnswer').textContent = result.reply || '(ассистент не вернул блок [ОТВЕТ])';
    $('#altAnswer1').textContent = result.alternatives[0] || '—';
    $('#altAnswer2').textContent = result.alternatives[1] || '—';

    document.querySelectorAll('.copy-answer-btn').forEach((btn) => {
      const target = document.getElementById(btn.dataset.copyTarget || '');
      btn.disabled = !target || !target.textContent.trim() || target.textContent.trim() === '—';
    });

    if (result.forecast) {
      $('#forecastCard').classList.remove('hidden');
      $('#forecastText').textContent = result.forecast;
    } else $('#forecastCard').classList.add('hidden');

    if (result.why) {
      $('#whyCard').classList.remove('hidden');
      $('#whyText').textContent = result.why;
    } else $('#whyCard').classList.add('hidden');

    const hasAnalysis = Boolean(result.analysis || result.strategy || result.forecast || result.why);
    $('#analysisDetails').classList.toggle('hidden', !hasAnalysis);
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
    c.chatMode = $('#chatModeSel').value;
    touch(c); // F-09: время последней активности для автоочистки
    saveChats();

    const cfg = (window.AppState && AppState.config) || {};
    const adultProfile = Prompts.getAdultProfileState(cfg.profile || {});
    if (!adultProfile.confirmed) {
      setStatus('❌ Укажите подтверждённый возраст модели от 18 до 99 лет в настройках', true);
      if (window.switchTab) window.switchTab('settings');
      return;
    }
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
    setReplyControlsBusy(true);
    setStatus('⏳ Ассистент изучает юзера, продумывает его возможные ответы и выбирает лучшую линию...');

    // Фаза 2: подтягиваем похожие успешные диалоги и статистику из базы опыта
    let expBlock = '';
    let expCount = 0;
    try {
      const stage = Prompts.analyzeConversation(hist, c.chatMode).stage;
      const ctx = await window.api.expExamples({
        history: hist,
        strategy: c.strategy,
        stage,
        chatMode: c.chatMode,
        profileName: String(cfg.profile && cfg.profile.name || '')
      });
      if (ctx && ctx.ok) {
        expCount = ctx.count || 0;
        expBlock = [ctx.examplesBlock, ctx.statsBlock, ctx.antiBlock]
          .filter(Boolean).join('\n\n');
      }
    } catch { /* база опыта недоступна — анализ всё равно выполняется */ }

    try {
      const systemPrompt = Prompts.buildSystemPrompt(cfg.profile, invitesRawText);
      const userPrompt = Prompts.buildUserPrompt(hist, c.strategy, expBlock, c.chatMode);
      const baseMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];
      const temperature = typeof cfg.temperature === 'number' ? cfg.temperature : 1.3;
      let res = await window.api.chat({
        model: cfg.model || 'deepseek-chat',
        temperature,
        messages: baseMessages
      });
      if (!res.ok) { setStatus('❌ ' + res.error, true); return; }

      const conversationState = Prompts.analyzeConversation(hist, c.chatMode);
      function inspectDraft(content) {
        const format = Parser.validateAssistantResponse(content);
        const policy = Prompts.validateReplyPolicy(
          format.blocks['ОТВЕТ'] || '', conversationState, cfg.profile || {});
        return {
          valid: format.valid && policy.valid,
          issues: format.issues.concat(policy.issues),
          blocks: format.blocks
        };
      }

      let content = res.content;
      let inspection = inspectDraft(content);
      if (!inspection.valid) {
        setStatus('⏳ Проверяю структуру и мягкость ответа, исправляю замечания...');
        const correction = `Исправь предыдущий черновик. Замечания валидатора: ${inspection.issues.join('; ')}. ` +
          'Верни все обязательные блоки, сохрани стадию и голос модели, убери давление и недопустимый CTA. Ничего не пиши вне блоков.';
        res = await window.api.chat({
          model: cfg.model || 'deepseek-chat',
          temperature: Math.min(0.8, temperature),
          messages: baseMessages.concat([
            { role: 'assistant', content },
            { role: 'user', content: correction }
          ])
        });
        if (!res.ok) { setStatus('❌ ' + res.error, true); return; }
        content = res.content;
        inspection = inspectDraft(content);
      }

      c.lastResult = content;
      saveChats();
      $('#analysisDetails').open = false;
      renderResult(content);
      if (inspection.valid) {
        setStatus('✅ Готово! Ответ проверен по стадии диалога и профилю модели.' +
          (expCount ? ` (опыт: подмешано примеров — ${expCount})` : ''));
      } else {
        setStatus('⚠️ Ответ создан, но автоматическая проверка нашла: ' +
          inspection.issues.join('; ') + '. Проверьте текст перед отправкой.', true);
      }
    } catch (e) {
      setStatus('❌ ' + e.message, true);
    } finally {
      btn.disabled = false;
      setReplyControlsBusy(false);
    }
  }

  function inspectReplyVariants(variants, state, profile) {
    const issues = [];
    [variants.reply, ...variants.alternatives].forEach((reply, index) => {
      const check = Prompts.validateReplyPolicy(reply, state, profile);
      check.issues.forEach((issue) => {
        const label = index === 0 ? 'основной вариант' : `альтернатива ${index}`;
        issues.push(`${label}: ${issue}`);
      });
    });
    return { valid: issues.length === 0, issues };
  }

  async function regenerateReply() {
    const c = getActive();
    if (!c || !c.lastResult) {
      setStatus('Сначала выполните полный анализ диалога.', true);
      return;
    }

    const sourceResult = c.lastResult;
    const current = AssistantResult.toViewModel(sourceResult);
    if (!current.complete) {
      setStatus('Не удалось изменить только ответ: в исходном результате не хватает готовых вариантов.', true);
      return;
    }

    const cfg = (window.AppState && AppState.config) || {};
    const adultProfile = Prompts.getAdultProfileState(cfg.profile || {});
    if (!adultProfile.confirmed) {
      setStatus('Укажите подтверждённый возраст модели от 18 до 99 лет в настройках.', true);
      return;
    }

    const chatId = c.id;
    const tone = syncReplyTone(c.replyTone || 'softer');
    const history = ($('#historyInput').value || c.history || '').trim();
    const prompt = Prompts.buildReplyRegenerationMessages({
      profile: cfg.profile || {},
      history,
      chatMode: c.chatMode || 'auto',
      tone,
      analysis: current.analysis,
      strategy: current.strategy,
      current: {
        reply: current.reply,
        alternatives: current.alternatives
      }
    });

    const button = $('#regenerateReplyBtn');
    const analyzeButton = $('#analyzeBtn');
    button.classList.add('is-loading');
    analyzeButton.disabled = true;
    setReplyControlsBusy(true);
    setStatus('Создаю новую формулировку, не меняя анализ диалога...');

    try {
      const baseMessages = prompt.messages;
      const baseTemperature = typeof cfg.temperature === 'number' ? cfg.temperature : 1.3;
      let variants = null;
      let lastIssues = [];
      let previousContent = '';

      for (let attempt = 0; attempt < 2; attempt++) {
        const messages = attempt === 0 ? baseMessages : baseMessages.concat([
          { role: 'assistant', content: previousContent || '{}' },
          {
            role: 'user',
            content: 'Исправь только JSON. Замечания валидатора: ' + lastIssues.join('; ') +
              '. Верни неповторяющиеся reply и ровно две alternatives, соблюдая ту же стадию и все ограничения.'
          }
        ]);
        const res = await window.api.chat({
          model: cfg.model || 'deepseek-chat',
          temperature: attempt === 0 ? Math.min(1, baseTemperature) : 0.45,
          maxTokens: 800,
          responseFormat: 'json_object',
          messages
        });
        if (!res.ok) throw new Error(res.error || 'Сервис генерации вернул ошибку.');
        previousContent = res.content;

        try {
          const candidate = AssistantResult.parseRegeneratedReply(res.content);
          const policy = inspectReplyVariants(candidate, prompt.state, cfg.profile || {});
          if (policy.valid) {
            variants = candidate;
            break;
          }
          lastIssues = policy.issues;
        } catch (error) {
          lastIssues = [error.message];
        }
      }

      if (!variants) {
        throw new Error('Новая версия не прошла проверку: ' + lastIssues.join('; '));
      }

      const targetChat = chats.find((chat) => chat.id === chatId);
      if (!targetChat || targetChat.lastResult !== sourceResult) {
        throw new Error('Исходный ответ уже изменился. Запустите перегенерацию ещё раз.');
      }
      targetChat.lastResult = AssistantResult.replaceReplyBlocks(sourceResult, variants);
      targetChat.replyTone = tone;
      touch(targetChat);
      saveChats();

      if (activeId === chatId) {
        renderResult(targetChat.lastResult);
        setStatus('Готово. Изменены только три готовые фразы; служебный анализ сохранён.');
      }
    } catch (error) {
      if (activeId === chatId) setStatus(error.message || 'Не удалось обновить ответ.', true);
    } finally {
      button.classList.remove('is-loading');
      analyzeButton.disabled = false;
      setReplyControlsBusy(false);
    }
  }

  /* ---------- Библиотека зазывов ---------- */
  function initLibrary(raw) {
    invitesRawText = raw || '';
    invitesLib = Parser.parseInvites(invitesRawText)
      .filter((item) => Prompts.isSafeInvitePhrase(item.en));
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

  /* ---------- База опыта: сохранение чата и отметка исхода ---------- */
  function renderExpState(c) {
    const saveBtn = $('#expSaveBtn');
    const outBtns = $('#expOutcomeBtns');
    const st = $('#expStatus');
    if (!c.expId) {
      saveBtn.classList.remove('hidden');
      outBtns.classList.add('hidden');
      st.textContent = '';
      return;
    }
    saveBtn.classList.add('hidden');
    outBtns.classList.remove('hidden');
    st.textContent = '💾 В базе опыта, №' + c.expId;
    document.querySelectorAll('#expOutcomeBtns .outcome').forEach((b) =>
      b.classList.toggle('active', b.dataset.outcome === c.expResult));
  }

  async function expSaveCurrent() {
    const c = getActive();
    if (!c) return;
    const hist = ($('#historyInput').value || '').trim();
    if (hist.length < 5) {
      $('#expStatus').textContent = '⚠️ Сначала вставьте историю чата';
      return;
    }
    c.history = hist;
    saveChats();
    const btn = $('#expSaveBtn');
    btn.disabled = true;
    try {
      const cfg = (window.AppState && AppState.config) || {};
      const res = await window.api.expSave({
        history: hist,
        strategy: c.strategy,
        chatMode: c.chatMode || 'auto',
        stage: Prompts.analyzeConversation(hist, c.chatMode).stage,
        profileName: String(cfg.profile && cfg.profile.name || ''),
        platform: ''
      });
      if (!res.ok) throw new Error(res.error || 'Ошибка сохранения');
      c.expId = res.chatId;
      saveChats();
      renderExpState(c);
      $('#expStatus').textContent =
        '💾 Сохранено (№' + res.chatId + ', сообщений: ' + res.msgCount + ') — отметь исход:';
    } catch (e) {
      $('#expStatus').textContent = '❌ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function expSetOutcome(result) {
    const c = getActive();
    if (!c || !c.expId) return;
    try {
      const res = await window.api.expOutcome({ chatId: c.expId, result });
      if (!res.ok) throw new Error(res.error || 'Ошибка');
      c.expResult = result;
      saveChats();
      renderExpState(c);
      $('#expStatus').textContent = '✅ Исход сохранён — благодаря этой метке ассистент учится';
    } catch (e) {
      $('#expStatus').textContent = '❌ ' + e.message;
    }
  }

  /* ---------- Инициализация вкладки ---------- */
  function init() {
    loadChats();
    renderChatList();

    $('#addChatBtn').addEventListener('click', askAddChat);
    document.querySelector('.empty-add').addEventListener('click', askAddChat);
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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#modalOverlay').classList.contains('hidden')) closeModal();
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
    $('#historyInput').addEventListener('input', () => {
      const c = getActive();
      if (!c) return;
      c.history = $('#historyInput').value;
      touch(c);
      scheduleSaveChats();
    });
    $('#historyInput').addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') analyze();
    });
    $('#strategySel').addEventListener('change', () => {
      const c = getActive();
      if (c) { c.strategy = $('#strategySel').value; touch(c); saveChats(); }
    });
    $('#chatModeSel').addEventListener('change', () => {
      const c = getActive();
      if (c) { c.chatMode = $('#chatModeSel').value; touch(c); saveChats(); }
    });
    $('#libSearch').addEventListener('input', (e) => renderLib(e.target.value));

    document.querySelectorAll('.tone-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c = getActive();
        if (!c) return;
        c.replyTone = syncReplyTone(btn.dataset.tone);
        touch(c);
        saveChats();
      });
    });
    $('#regenerateReplyBtn').addEventListener('click', regenerateReply);
    document.querySelectorAll('.copy-answer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.copyTarget || '');
        if (target && target.textContent.trim() && target.textContent.trim() !== '—') {
          window.copyText(target.textContent.trim());
        }
      });
    });

    // База опыта: сохранить чат и отметить исход
    $('#expSaveBtn').addEventListener('click', expSaveCurrent);
    document.querySelectorAll('#expOutcomeBtns .outcome').forEach((btn) =>
      btn.addEventListener('click', () => expSetOutcome(btn.dataset.outcome)));

    if (chats.length) openChat(chats[0].id);
  }

  window.Assistant = { init, initLibrary };
})();
