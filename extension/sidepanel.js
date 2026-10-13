(function () {
  'use strict';

  const API_BASE = 'https://operhelper.killasnazz.workers.dev';
  const STORAGE_KEY = 'killasnazz_extension_v1';
  const DEFAULT_PROFILE = Object.freeze({
    name: '', age: '', language: 'English', look: '', persona: '', voice: '',
    examples: '', offers: '', allowed: '', forbidden: ''
  });
  const state = {
    profile: { ...DEFAULT_PROFILE }, model: 'deepseek-chat', temperature: 1.3,
    assistant: { history: '', mode: 'auto', strategy: 'auto', rawResult: '', tone: 'softer' },
    goals: { tag: 'feet', generated: [] },
    donation: { target: 'breast', customTarget: '', action: '', tokens: '', context: '', boundary: '', tone: 'playful', result: null }
  };
  let remoteData = { invitesRaw: '', goalBank: {} };
  let lastAutoContext = '';
  let saveTimer = null;
  let toastTimer = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function storageGet(key) {
    return new Promise((resolve) => chrome.storage.local.get(key, (value) => resolve(value || {})));
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    }));
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => storageSet({ [STORAGE_KEY]: state }).catch(() => {}), 250);
  }

  async function restoreState() {
    const stored = (await storageGet(STORAGE_KEY))[STORAGE_KEY];
    if (!stored || typeof stored !== 'object') return;
    state.profile = { ...DEFAULT_PROFILE, ...(stored.profile || {}) };
    state.model = stored.model === 'deepseek-reasoner' ? stored.model : 'deepseek-chat';
    state.temperature = Number.isFinite(Number(stored.temperature)) ? Number(stored.temperature) : 1.3;
    state.assistant = { ...state.assistant, ...(stored.assistant || {}) };
    state.goals = { ...state.goals, ...(stored.goals || {}) };
    state.donation = { ...state.donation, ...(stored.donation || {}) };
  }

  async function api(path, options) {
    let response;
    try {
      response = await fetch(API_BASE + path, options);
    } catch (error) {
      throw new Error('Не удалось связаться с сервером: ' + (error.message || 'ошибка сети'));
    }
    const text = await response.text();
    if (!text.trim()) throw new Error(`Сервер вернул пустой ответ (HTTP ${response.status}).`);
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`Сервер вернул некорректный ответ (HTTP ${response.status}).`); }
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  function chat(payload) {
    return api('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
  }

  function setStatus(id, message, kind) {
    const node = $(id);
    node.textContent = message || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showToast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add('hidden'), 1500);
  }

  async function copyText(text) {
    const value = String(text || '').trim();
    if (!value) return;
    await navigator.clipboard.writeText(value);
    showToast('Скопировано');
  }

  function activeTab() {
    return new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true },
      (tabs) => resolve(tabs && tabs[0] ? tabs[0] : null)));
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    }));
  }

  async function readCurrentChat(silent) {
    try {
      const tab = await activeTab();
      if (!tab || !tab.id) throw new Error('Активная вкладка не найдена.');
      const result = await sendTabMessage(tab.id, { type: 'KILLASNAZZ_READ_CHAT', limit: 60 });
      if (!result || !result.ok) throw new Error(result && result.error || 'Чат не найден.');
      $('#platformName').textContent = result.platform;
      $('#connectionText').textContent = `Сообщений: ${result.messages.length}. Отправка остаётся ручной.`;
      $('#connectionDot').classList.add('online');
      const history = String(result.context || '');
      const assistantField = $('#assistantHistory');
      if (!assistantField.value.trim() || assistantField.value === lastAutoContext) {
        assistantField.value = history;
        state.assistant.history = history;
      }
      const donationField = $('#donationContext');
      if (!donationField.value.trim() || donationField.value === lastAutoContext) {
        donationField.value = history.slice(-6000);
        state.donation.context = donationField.value;
      }
      lastAutoContext = history;
      scheduleSave();
      if (!silent) showToast('Переписка обновлена');
      return true;
    } catch (error) {
      $('#platformName').textContent = 'Ручной режим';
      $('#connectionText').textContent = 'Вставьте переписку вручную';
      $('#connectionDot').classList.remove('online');
      if (!silent) setStatus('#assistantStatus', error.message || 'Не удалось прочитать чат.', 'error');
      return false;
    }
  }

  async function insertIntoChat(text) {
    const value = String(text || '').trim();
    if (!value) return;
    try {
      const tab = await activeTab();
      if (!tab || !tab.id) throw new Error('Активная вкладка не найдена.');
      const result = await sendTabMessage(tab.id, { type: 'KILLASNAZZ_INSERT_DRAFT', text: value });
      if (!result || !result.ok) throw new Error(result && result.error || 'Поле ввода не найдено.');
      showToast('Вставлено. Проверьте и отправьте вручную');
    } catch (error) {
      await copyText(value);
      setStatus('#assistantStatus', (error.message || 'Не удалось вставить.') + ' Ответ скопирован.', 'error');
    }
  }

  function collectProfile() {
    const ageText = $('#profileAge').value.trim();
    const age = Number(ageText);
    if (!Number.isInteger(age) || age < 18 || age > 99) throw new Error('Укажите возраст модели от 18 до 99 лет.');
    return {
      name: $('#profileName').value.trim(), age: ageText,
      language: $('#profileLanguage').value.trim() || 'English',
      look: $('#profileLook').value.trim(), persona: $('#profilePersona').value.trim(),
      voice: $('#profileVoice').value.trim(), examples: $('#profileExamples').value.trim(),
      offers: $('#profileOffers').value.trim(), allowed: $('#profileAllowed').value.trim(),
      forbidden: $('#profileForbidden').value.trim()
    };
  }

  function fillProfile() {
    const p = state.profile;
    const map = { profileName: 'name', profileAge: 'age', profileLanguage: 'language', profileLook: 'look',
      profilePersona: 'persona', profileVoice: 'voice', profileExamples: 'examples', profileOffers: 'offers',
      profileAllowed: 'allowed', profileForbidden: 'forbidden' };
    Object.entries(map).forEach(([id, key]) => { $('#' + id).value = p[key] || ''; });
    $('#profileModel').value = state.model;
    $('#profileTemperature').value = state.temperature;
  }

  async function saveProfile() {
    try {
      state.profile = collectProfile();
      state.model = $('#profileModel').value;
      state.temperature = Math.min(2, Math.max(0, Number($('#profileTemperature').value) || 1.3));
      await storageSet({ [STORAGE_KEY]: state });
      setStatus('#profileStatus', 'Профиль сохранён локально в расширении.', 'success');
    } catch (error) { setStatus('#profileStatus', error.message, 'error'); }
  }

  async function importProfile() {
    try {
      const tabs = await new Promise((resolve) => chrome.tabs.query({ url: API_BASE + '/*' }, resolve));
      if (!tabs || !tabs.length) {
        await chrome.tabs.create({ url: API_BASE + '/' });
        throw new Error('Сайт открыт в новой вкладке. Повторите импорт после его загрузки.');
      }
      const result = await sendTabMessage(tabs[0].id, { type: 'KILLASNAZZ_IMPORT_PROFILE' });
      if (!result || !result.ok) throw new Error(result && result.error || 'Профиль не найден.');
      const config = result.config || {};
      state.profile = { ...DEFAULT_PROFILE, ...(config.profile || {}) };
      state.model = config.model === 'deepseek-reasoner' ? config.model : 'deepseek-chat';
      state.temperature = Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 1.3;
      fillProfile();
      await storageSet({ [STORAGE_KEY]: state });
      setStatus('#profileStatus', 'Профиль импортирован. Дальше копия хранится отдельно.', 'success');
    } catch (error) { setStatus('#profileStatus', error.message, 'error'); }
  }

  function assistantInspection(content, history, mode) {
    const format = window.Parser.validateAssistantResponse(content);
    const conversation = window.Prompts.analyzeConversation(history, mode);
    const reply = format.blocks['ОТВЕТ'] || '';
    const policy = window.Prompts.validateReplyPolicy(reply, conversation, state.profile);
    return { valid: format.valid && policy.valid, issues: format.issues.concat(policy.issues) };
  }

  function renderAssistant(raw) {
    if (!raw) return;
    const result = window.AssistantResult.toViewModel(raw);
    $('#assistantMain').textContent = result.reply || '—';
    $('#assistantAlt1').textContent = result.alternatives[0] || '—';
    $('#assistantAlt2').textContent = result.alternatives[1] || '—';
    $('#assistantAnalysis').textContent = [result.analysis, result.strategy, result.forecast, result.why]
      .filter(Boolean).join('\n\n');
    $('#assistantResult').classList.remove('hidden');
  }

  async function generateAssistant(opening) {
    const button = opening ? $('#openingBtn') : $('#analyzeBtn');
    const history = $('#assistantHistory').value.trim();
    if (!opening && !history) return setStatus('#assistantStatus', 'Вставьте или заберите переписку.', 'error');
    const adult = window.Prompts.getAdultProfileState(state.profile);
    if (!adult.confirmed) {
      $('#settingsPanel').open = true;
      return setStatus('#assistantStatus', 'Сначала подтвердите возраст модели в профиле.', 'error');
    }
    state.assistant.history = history;
    state.assistant.mode = $('#assistantMode').value;
    state.assistant.strategy = $('#assistantStrategy').value;
    button.disabled = true;
    setStatus('#assistantStatus', opening ? 'Создаю первое сообщение…' : 'Анализирую диалог…');
    try {
      const system = window.Prompts.buildSystemPrompt(state.profile, remoteData.invitesRaw || '');
      const user = opening ? window.Prompts.buildOpeningUserPrompt() :
        window.Prompts.buildUserPrompt(history, state.assistant.strategy, '', state.assistant.mode);
      const base = [{ role: 'system', content: system }, { role: 'user', content: user }];
      let response = await chat({ model: state.model, temperature: state.temperature, messages: base });
      let content = response.content;
      let inspection = assistantInspection(content, history, opening ? 'public' : state.assistant.mode);
      if (!inspection.valid) {
        setStatus('#assistantStatus', 'Исправляю структуру ответа…');
        response = await chat({
          model: state.model, temperature: Math.min(.8, state.temperature),
          messages: base.concat([
            { role: 'assistant', content },
            { role: 'user', content: 'Исправь ответ. Замечания: ' + inspection.issues.join('; ') + '. Верни все обязательные блоки без текста снаружи.' }
          ])
        });
        content = response.content;
        inspection = assistantInspection(content, history, opening ? 'public' : state.assistant.mode);
      }
      state.assistant.rawResult = content;
      scheduleSave();
      renderAssistant(content);
      setStatus('#assistantStatus', inspection.valid ? 'Готово. Проверьте фразу перед отправкой.' :
        'Ответ получен, но требует ручной проверки: ' + inspection.issues.join('; '), inspection.valid ? 'success' : 'error');
    } catch (error) { setStatus('#assistantStatus', error.message || 'Ошибка генерации.', 'error'); }
    finally { button.disabled = false; }
  }

  function inspectVariants(variants, prompt) {
    const issues = [];
    [variants.reply, ...variants.alternatives].forEach((text, index) => {
      const check = window.Prompts.validateReplyPolicy(text, prompt.state, state.profile);
      check.issues.forEach((issue) => issues.push(`${index ? 'альтернатива ' + index : 'основной ответ'}: ${issue}`));
    });
    return issues;
  }

  async function regenerateAssistant() {
    if (!state.assistant.rawResult) return setStatus('#assistantStatus', 'Сначала сгенерируйте полный ответ.', 'error');
    const current = window.AssistantResult.toViewModel(state.assistant.rawResult);
    if (!current.complete) return setStatus('#assistantStatus', 'В исходном ответе не хватает вариантов.', 'error');
    const button = $('#regenerateBtn');
    button.disabled = true;
    setStatus('#assistantStatus', 'Меняю только готовые фразы…');
    try {
      const prompt = window.Prompts.buildReplyRegenerationMessages({
        profile: state.profile, history: $('#assistantHistory').value.trim(), chatMode: $('#assistantMode').value,
        tone: $('#replyTone').value, analysis: current.analysis, strategy: current.strategy,
        current: { reply: current.reply, alternatives: current.alternatives }
      });
      let previous = '';
      let issues = [];
      let variants = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages = attempt ? prompt.messages.concat([
          { role: 'assistant', content: previous || '{}' },
          { role: 'user', content: 'Исправь только JSON. Замечания: ' + issues.join('; ') + '. Верни reply и ровно две разные alternatives.' }
        ]) : prompt.messages;
        const response = await chat({ model: state.model, temperature: attempt ? .35 : Math.min(1, state.temperature), maxTokens: 800, responseFormat: 'json_object', messages });
        previous = response.content;
        try {
          const candidate = window.AssistantResult.parseRegeneratedReply(previous);
          issues = inspectVariants(candidate, prompt);
          if (!issues.length) { variants = candidate; break; }
        } catch (error) { issues = [error.message]; }
      }
      if (!variants) throw new Error('Новая версия не прошла проверку: ' + issues.join('; '));
      state.assistant.rawResult = window.AssistantResult.replaceReplyBlocks(state.assistant.rawResult, variants);
      state.assistant.tone = $('#replyTone').value;
      scheduleSave();
      renderAssistant(state.assistant.rawResult);
      setStatus('#assistantStatus', 'Готово. Анализ сохранён, изменены только фразы.', 'success');
    } catch (error) { setStatus('#assistantStatus', error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function renderGoalTags() {
    const box = $('#goalTags');
    box.textContent = '';
    window.GoalGenerator.TAGS.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'pill' + (state.goals.tag === item.tag ? ' active' : '');
      button.textContent = item.label;
      button.addEventListener('click', () => { state.goals.tag = item.tag; scheduleSave(); renderGoalTags(); renderGoals(); });
      box.appendChild(button);
    });
  }

  function goalItems() {
    const bank = remoteData.goalBank && remoteData.goalBank[state.goals.tag];
    const ready = bank && Array.isArray(bank.items) ? bank.items : [];
    const generated = (state.goals.generated || []).filter((item) => item.tag === state.goals.tag);
    return ready.concat(generated);
  }

  function makeTextCard(source, translation, label) {
    const card = document.createElement('article'); card.className = 'list-card';
    const title = document.createElement('strong'); title.textContent = label || '';
    const text = document.createElement('p'); text.textContent = source || '—';
    const ru = document.createElement('p'); ru.className = 'translation'; ru.textContent = translation || '';
    const actions = document.createElement('div'); actions.className = 'list-actions';
    const copy = document.createElement('button'); copy.className = 'small-action'; copy.type = 'button'; copy.textContent = 'Копировать';
    copy.addEventListener('click', () => copyText(source));
    const insert = document.createElement('button'); insert.className = 'small-action accent'; insert.type = 'button'; insert.textContent = 'Вставить';
    insert.addEventListener('click', () => insertIntoChat(source));
    actions.append(copy, insert); card.append(title, text, ru, actions); return card;
  }

  function renderGoals() {
    const box = $('#goalsList'); box.textContent = '';
    const items = goalItems();
    if (!items.length) { box.textContent = 'Для категории пока нет заготовок.'; return; }
    items.forEach((item, index) => box.appendChild(makeTextCard(item.en, item.ru, index < items.length - (state.goals.generated || []).filter((g) => g.tag === state.goals.tag).length ? 'Готовая цель' : 'AI-цель')));
  }

  async function generateGoals() {
    const button = $('#generateGoalsBtn'); button.disabled = true;
    setStatus('#goalsStatus', 'Генерирую цели…');
    try {
      const avoid = goalItems().map((item) => item.en).filter(Boolean).slice(-30);
      let items = [];
      let lastError = null;
      for (let attempt = 0; attempt < 2 && items.length < 8; attempt++) {
        try {
          const response = await chat({ model: state.model, temperature: attempt ? .2 : .75, maxTokens: 1800,
            responseFormat: 'json_object', messages: window.GoalGenerator.buildMessages(state.goals.tag, avoid.concat(items.map((i) => i.en)), attempt > 0) });
          const parsed = window.GoalGenerator.parseResponse(response.content, window.AiJson, 10);
          const seen = new Set(avoid.concat(items.map((i) => i.en)).map((v) => v.toLocaleLowerCase('en-US')));
          parsed.forEach((item) => { const key = item.en.toLocaleLowerCase('en-US'); if (!seen.has(key)) { seen.add(key); items.push(item); } });
        } catch (error) { lastError = error; }
      }
      if (!items.length) throw lastError || new Error('Не удалось получить новые цели.');
      state.goals.generated = (state.goals.generated || []).concat(items.slice(0, 10).map((item) => ({ ...item, tag: state.goals.tag })));
      scheduleSave(); renderGoals();
      setStatus('#goalsStatus', `Добавлено целей: ${Math.min(10, items.length)}.`, 'success');
    } catch (error) { setStatus('#goalsStatus', error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function collectDonation() {
    return { target: $('#donationTarget').value, customTarget: $('#donationCustomTarget').value.trim(),
      action: $('#donationAction').value.trim(), tokens: $('#donationTokens').value.trim(),
      context: $('#donationContext').value.trim(), boundary: $('#donationBoundary').value.trim(), tone: $('#donationTone').value };
  }

  function isRussianProfile() { return /^(ru|rus|russian|рус|русский)/i.test(String(state.profile.language || '').trim()); }

  function renderDonation(result) {
    if (!result) return;
    const variants = $('#donationVariants'); variants.textContent = '';
    result.variants.forEach((item, index) => variants.appendChild(makeTextCard(item.text, isRussianProfile() ? '' : item.ru, index ? `Альтернатива ${index}` : 'Рекомендуемая фраза')));
    const follow = $('#donationFollowups'); follow.textContent = '';
    const labels = { asksPrice: 'Спросит цену', agrees: 'Согласится', hesitates: 'Засомневается или откажется' };
    Object.entries(labels).forEach(([key, label]) => {
      const item = result.followUps[key]; follow.appendChild(makeTextCard(item.text, isRussianProfile() ? '' : item.ru, label));
    });
    $('#donationResult').classList.remove('hidden');
  }

  async function generateDonation() {
    const input = collectDonation();
    const validation = window.DonationBait.validateInput(input, state.profile);
    if (!validation.valid) return setStatus('#donationStatus', validation.issues.join('; '), 'error');
    state.donation = { ...state.donation, ...input };
    const prepared = window.DonationBait.buildMessages(validation.value, state.profile);
    const button = $('#generateDonationBtn'); button.disabled = true;
    setStatus('#donationStatus', 'Готовлю безопасное предложение…');
    let lastError = null;
    let previous = '';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const messages = attempt ? prepared.messages.concat([
            { role: 'assistant', content: previous || '{}' },
            { role: 'user', content: 'Исправь JSON и все нарушения валидатора: ' + (lastError && lastError.message || 'неверный формат') + '. Верни только объект по исходной схеме.' }
          ]) : prepared.messages;
          const response = await chat({ model: state.model, temperature: attempt ? .25 : Math.min(1, state.temperature), maxTokens: 1800, responseFormat: 'json_object', messages });
          previous = response.content;
          const result = window.DonationBait.parseResponse(previous, prepared);
          state.donation.result = result; scheduleSave(); renderDonation(result);
          setStatus('#donationStatus', 'Готово. Проверьте фразу перед отправкой.', 'success');
          return;
        } catch (error) { lastError = error; setStatus('#donationStatus', attempt ? 'Ответ снова не прошёл проверку…' : 'Исправляю формат и ограничения…'); }
      }
      throw lastError || new Error('Не удалось получить корректный ответ.');
    } catch (error) { setStatus('#donationStatus', error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function fillForms() {
    fillProfile();
    $('#assistantHistory').value = state.assistant.history || '';
    $('#assistantMode').value = state.assistant.mode || 'auto';
    $('#assistantStrategy').value = state.assistant.strategy || 'auto';
    $('#replyTone').value = state.assistant.tone || 'softer';
    const d = state.donation;
    $('#donationTarget').value = d.target || 'breast'; $('#donationCustomTarget').value = d.customTarget || '';
    $('#donationAction').value = d.action || ''; $('#donationTokens').value = d.tokens || '';
    $('#donationContext').value = d.context || ''; $('#donationBoundary').value = d.boundary || '';
    $('#donationTone').value = d.tone || 'playful';
    $('#customTargetRow').classList.toggle('hidden', $('#donationTarget').value !== 'other');
    renderGoalTags(); renderGoals(); renderAssistant(state.assistant.rawResult); renderDonation(d.result);
  }

  function bind() {
    $$('.mode-tab').forEach((button) => button.addEventListener('click', () => {
      $$('.mode-tab').forEach((item) => item.classList.toggle('active', item === button));
      $$('.panel-page').forEach((panel) => panel.classList.toggle('hidden', panel.id !== 'panel-' + button.dataset.panel));
    }));
    $('#refreshChatBtn').addEventListener('click', () => readCurrentChat(false));
    $('#readChatBtn').addEventListener('click', () => readCurrentChat(false));
    $('#analyzeBtn').addEventListener('click', () => generateAssistant(false));
    $('#openingBtn').addEventListener('click', () => generateAssistant(true));
    $('#regenerateBtn').addEventListener('click', regenerateAssistant);
    $('#generateGoalsBtn').addEventListener('click', generateGoals);
    $('#generateDonationBtn').addEventListener('click', generateDonation);
    $('#saveProfileBtn').addEventListener('click', saveProfile);
    $('#importProfileBtn').addEventListener('click', importProfile);
    $('#donationTarget').addEventListener('change', () => $('#customTargetRow').classList.toggle('hidden', $('#donationTarget').value !== 'other'));
    ['assistantHistory', 'assistantMode', 'assistantStrategy'].forEach((id) => $('#' + id).addEventListener('input', () => {
      state.assistant.history = $('#assistantHistory').value; state.assistant.mode = $('#assistantMode').value;
      state.assistant.strategy = $('#assistantStrategy').value; scheduleSave();
    }));
    ['donationTarget', 'donationCustomTarget', 'donationAction', 'donationTokens', 'donationContext', 'donationBoundary', 'donationTone']
      .forEach((id) => $('#' + id).addEventListener('input', () => { state.donation = { ...state.donation, ...collectDonation() }; scheduleSave(); }));
    document.addEventListener('click', (event) => {
      const copy = event.target.closest('[data-copy-target]');
      if (copy) copyText($('#' + copy.dataset.copyTarget).textContent);
      const insert = event.target.closest('[data-insert-target]');
      if (insert) insertIntoChat($('#' + insert.dataset.insertTarget).textContent);
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'KILLASNAZZ_CHAT_UPDATED') {
        clearTimeout(window.__killasnazzRefreshTimer);
        window.__killasnazzRefreshTimer = setTimeout(() => readCurrentChat(true), 900);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    await restoreState();
    try { remoteData = await api('/api/data'); }
    catch (error) { setStatus('#assistantStatus', 'Заготовки недоступны: ' + error.message, 'error'); }
    fillForms();
    await readCurrentChat(true);
  });
})();
