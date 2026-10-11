(function attachManuals(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Manuals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createManuals(root) {
  'use strict';

  const STORAGE_KEY = 'oh_manuals_v1';
  const state = {
    initialized: false,
    activeSlug: '',
    query: '',
    expandedSections: new Set(),
    expandedParents: new Set(),
    searchTimer: null
  };

  const byId = (id) => root.document && root.document.getElementById(id);

  function element(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function normalizeSearch(value) {
    return String(value || '')
      .toLocaleLowerCase('ru-RU')
      .replace(/ё/g, 'е')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getData() {
    const data = root.ManualsData;
    return data && data.version === 1 && data.articles && Array.isArray(data.sections)
      ? data : null;
  }

  function loadState(data) {
    let saved = {};
    try { saved = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { saved = {}; }
    state.activeSlug = data.articles[saved.lastSlug] ? saved.lastSlug : data.defaultSlug;
    state.expandedSections = new Set(
      Array.isArray(saved.expandedSections) ? saved.expandedSections : data.sections.map((section) => section.title)
    );
    state.expandedParents = new Set(Array.isArray(saved.expandedParents) ? saved.expandedParents : []);
    expandActivePath(data);
  }

  function saveState() {
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        lastSlug: state.activeSlug,
        expandedSections: Array.from(state.expandedSections),
        expandedParents: Array.from(state.expandedParents)
      }));
    } catch { /* localStorage can be unavailable in private contexts */ }
  }

  function expandActivePath(data) {
    const article = data.articles[state.activeSlug];
    if (!article) return;
    state.expandedSections.add(article.section);
    if (article.parent) {
      const parent = Object.values(data.articles).find((candidate) =>
        candidate.kind === 'overview' && candidate.title === article.parent
      );
      if (parent) state.expandedParents.add(parent.slug);
    }
  }

  function isSafeExternalUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch { return false; }
  }

  function openExternal(url) {
    if (!isSafeExternalUrl(url)) return;
    if (root.api && typeof root.api.openExternal === 'function') root.api.openExternal(url);
  }

  function appendHighlightedText(parent, text, query) {
    const source = String(text || '');
    const needle = normalizeSearch(query);
    if (!needle) {
      parent.appendChild(root.document.createTextNode(source));
      return;
    }
    const normalized = normalizeSearch(source);
    let cursor = 0;
    let normalizedCursor = 0;
    while (normalizedCursor < normalized.length) {
      const found = normalized.indexOf(needle, normalizedCursor);
      if (found < 0) break;
      const rawFound = source.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').indexOf(needle, cursor);
      if (rawFound < 0) break;
      if (rawFound > cursor) parent.appendChild(root.document.createTextNode(source.slice(cursor, rawFound)));
      const mark = element('mark', 'manual-highlight', source.slice(rawFound, rawFound + needle.length));
      parent.appendChild(mark);
      cursor = rawFound + needle.length;
      normalizedCursor = found + needle.length;
    }
    if (cursor < source.length) parent.appendChild(root.document.createTextNode(source.slice(cursor)));
  }

  function appendTextWithLinks(parent, text, query) {
    const parts = String(text || '').split(/(https?:\/\/[^\s]+)/g);
    parts.forEach((part) => {
      if (isSafeExternalUrl(part)) {
        const link = element('a', 'manual-external-link', part);
        link.href = part;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.addEventListener('click', (event) => {
          event.preventDefault();
          openExternal(part);
        });
        parent.appendChild(link);
      } else {
        appendHighlightedText(parent, part, query);
      }
    });
  }

  function appendInline(parent, text, query) {
    const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g);
    parts.forEach((part) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        const strong = element('strong');
        appendTextWithLinks(strong, part.slice(2, -2), query);
        parent.appendChild(strong);
      } else {
        appendTextWithLinks(parent, part, query);
      }
    });
  }

  function scoreArticle(article, normalizedQuery) {
    if (!normalizedQuery) return 0;
    const words = normalizedQuery.split(' ').filter(Boolean);
    const title = normalizeSearch(article.title);
    const body = normalizeSearch(article.searchText);
    if (!words.every((word) => body.includes(word))) return 0;
    let score = 10;
    if (title === normalizedQuery) score += 220;
    else if (title.startsWith(normalizedQuery)) score += 150;
    else if (title.includes(normalizedQuery)) score += 100;
    score += words.filter((word) => title.includes(word)).length * 20;
    return score;
  }

  function searchArticles(data, query, limit) {
    const normalized = normalizeSearch(query);
    if (normalized.length < 2) return [];
    return Object.values(data.articles)
      .map((article) => ({ article, score: scoreArticle(article, normalized) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.article.title.localeCompare(right.article.title, 'ru'))
      .slice(0, limit || 10)
      .map((entry) => entry.article);
  }

  function buildSnippet(article, query) {
    const text = String(article.searchText || '').replace(/\*\*/g, '');
    const normalizedText = normalizeSearch(text);
    const normalizedQuery = normalizeSearch(query);
    const position = normalizedText.indexOf(normalizedQuery.split(' ')[0] || '');
    const start = Math.max(0, position < 0 ? 0 : position - 65);
    const snippet = text.slice(start, start + 175).trim();
    return (start > 0 ? '…' : '') + snippet + (start + 175 < text.length ? '…' : '');
  }

  function renderSearchResults(data) {
    const container = byId('manualsSearchResults');
    if (!container) return;
    container.replaceChildren();
    const query = state.query.trim();
    if (normalizeSearch(query).length < 2) {
      container.classList.add('hidden');
      return;
    }
    const results = searchArticles(data, query, 10);
    if (!results.length) {
      const empty = element('div', 'manual-search-empty', 'Ничего не найдено');
      container.appendChild(empty);
    } else {
      results.forEach((article) => {
        const button = element('button', 'manual-search-result');
        button.type = 'button';
        const meta = element('span', 'manual-search-result-meta', article.section);
        const title = element('strong');
        appendHighlightedText(title, article.title, query);
        const snippet = element('small');
        appendHighlightedText(snippet, buildSnippet(article, query), query);
        button.append(meta, title, snippet);
        button.addEventListener('click', () => {
          openArticle(article.slug);
          container.classList.add('hidden');
        });
        container.appendChild(button);
      });
    }
    container.classList.remove('hidden');
  }

  function navButton(article, depth) {
    const button = element('button', 'manual-nav-item' + (article.slug === state.activeSlug ? ' active' : ''));
    button.type = 'button';
    button.dataset.slug = article.slug;
    button.style.setProperty('--manual-depth', String(depth || 0));
    const glyph = element('span', 'manual-nav-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    const label = element('span', 'manual-nav-label', article.title);
    button.append(glyph, label);
    button.addEventListener('click', () => openArticle(article.slug));
    return button;
  }

  function renderTree(data) {
    const tree = byId('manualsTree');
    if (!tree) return;
    tree.replaceChildren();
    data.sections.forEach((section, sectionIndex) => {
      const wrapper = element('section', 'manual-tree-section');
      const sectionButton = element('button', 'manual-section-toggle');
      sectionButton.type = 'button';
      sectionButton.setAttribute('aria-expanded', String(state.expandedSections.has(section.title)));
      const number = element('span', 'manual-section-number', String(sectionIndex + 1).padStart(2, '0'));
      const title = element('strong', '', section.title);
      const chevron = element('span', 'manual-tree-chevron', '⌄');
      sectionButton.append(number, title, chevron);
      const items = element('div', 'manual-section-items');
      items.classList.toggle('hidden', !state.expandedSections.has(section.title));

      section.items.forEach((item) => {
        const article = data.articles[item.slug];
        if (!article) return;
        if (!item.children || !item.children.length) {
          items.appendChild(navButton(article, 0));
          return;
        }
        const group = element('div', 'manual-nav-group');
        const row = element('div', 'manual-nav-parent-row');
        const parentButton = navButton(article, 0);
        const toggle = element('button', 'manual-parent-toggle', '⌄');
        toggle.type = 'button';
        toggle.title = 'Показать подразделы';
        toggle.setAttribute('aria-expanded', String(state.expandedParents.has(item.slug)));
        const children = element('div', 'manual-nav-children');
        children.classList.toggle('hidden', !state.expandedParents.has(item.slug));
        item.children.forEach((child) => {
          const childArticle = data.articles[child.slug];
          if (childArticle) children.appendChild(navButton(childArticle, 1));
        });
        toggle.addEventListener('click', () => {
          if (state.expandedParents.has(item.slug)) state.expandedParents.delete(item.slug);
          else state.expandedParents.add(item.slug);
          saveState();
          renderTree(data);
        });
        row.append(parentButton, toggle);
        group.append(row, children);
        items.appendChild(group);
      });

      sectionButton.addEventListener('click', () => {
        if (state.expandedSections.has(section.title)) state.expandedSections.delete(section.title);
        else state.expandedSections.add(section.title);
        saveState();
        renderTree(data);
      });
      wrapper.append(sectionButton, items);
      tree.appendChild(wrapper);
    });
  }

  function renderBreadcrumb(article, data, container) {
    const breadcrumb = element('nav', 'manual-breadcrumb');
    breadcrumb.setAttribute('aria-label', 'Путь к статье');
    const home = element('button', '', 'Мануалы');
    home.type = 'button';
    home.addEventListener('click', () => openArticle(data.defaultSlug));
    breadcrumb.appendChild(home);
    breadcrumb.appendChild(element('span', '', '/'));
    breadcrumb.appendChild(element('span', '', article.section));
    if (article.parent) {
      breadcrumb.appendChild(element('span', '', '/'));
      breadcrumb.appendChild(element('span', '', article.parent));
    }
    container.appendChild(breadcrumb);
  }

  function renderOverview(block, data, container) {
    const grid = element('div', 'manual-overview-grid');
    (block.items || []).forEach((item, index) => {
      const article = data.articles[item.slug];
      if (!article) return;
      const button = element('button', 'manual-overview-card');
      button.type = 'button';
      const number = element('span', 'manual-overview-number', String(index + 1).padStart(2, '0'));
      const copy = element('span', 'manual-overview-copy');
      copy.append(element('strong', '', article.title));
      if (article.description) copy.append(element('small', '', article.description));
      const arrow = element('span', 'manual-overview-arrow', '→');
      button.append(number, copy, arrow);
      button.addEventListener('click', () => openArticle(article.slug));
      grid.appendChild(button);
    });
    container.appendChild(grid);
  }

  function renderBlock(block, data, container) {
    let node;
    switch (block.type) {
      case 'heading':
      case 'subheading':
        node = element(block.type === 'heading' ? 'h2' : 'h3', 'manual-content-' + block.type);
        appendInline(node, (block.emoji ? block.emoji + ' ' : '') + (block.text || ''), state.query);
        container.appendChild(node);
        break;
      case 'paragraph':
        node = element('p', 'manual-paragraph');
        appendInline(node, block.text || '', state.query);
        container.appendChild(node);
        break;
      case 'list':
      case 'ordered-list': {
        node = element(block.type === 'list' ? 'ul' : 'ol', 'manual-list ' + block.type);
        (block.items || []).forEach((item) => {
          const li = element('li');
          appendInline(li, item, state.query);
          node.appendChild(li);
        });
        container.appendChild(node);
        break;
      }
      case 'divider':
        container.appendChild(element('hr', 'manual-divider'));
        break;
      case 'note': {
        node = element('aside', 'manual-note');
        node.appendChild(element('strong', '', 'Важно'));
        const text = element('p');
        appendInline(text, block.text || '', state.query);
        node.appendChild(text);
        container.appendChild(node);
        break;
      }
      case 'link-block': {
        node = element('div', 'manual-link-block');
        if (block.text) {
          const text = element('p');
          appendInline(text, block.text, state.query);
          node.appendChild(text);
        }
        (block.items || []).forEach((url) => {
          if (!isSafeExternalUrl(url)) return;
          const link = element('a', 'manual-link-button', url);
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.addEventListener('click', (event) => {
            event.preventDefault();
            openExternal(url);
          });
          node.appendChild(link);
        });
        container.appendChild(node);
        break;
      }
      case 'table': {
        const wrapper = element('div', 'manual-table-wrap');
        const table = element('table', 'manual-table');
        if (block.headers && block.headers.length) {
          const head = element('thead');
          const row = element('tr');
          block.headers.forEach((value) => {
            const cell = element('th');
            appendInline(cell, value, state.query);
            row.appendChild(cell);
          });
          head.appendChild(row);
          table.appendChild(head);
        }
        const body = element('tbody');
        (block.rows || []).forEach((values) => {
          const row = element('tr');
          values.forEach((value) => {
            const cell = element('td');
            appendInline(cell, value, state.query);
            row.appendChild(cell);
          });
          body.appendChild(row);
        });
        table.appendChild(body);
        wrapper.appendChild(table);
        container.appendChild(wrapper);
        break;
      }
      case 'image': {
        const figure = element('figure', 'manual-figure');
        const image = element('img');
        image.src = block.src;
        image.alt = block.alt || '';
        image.loading = 'lazy';
        image.decoding = 'async';
        figure.appendChild(image);
        if (block.alt) figure.appendChild(element('figcaption', '', block.alt));
        container.appendChild(figure);
        break;
      }
      case 'overview':
        renderOverview(block, data, container);
        break;
      default:
        break;
    }
  }

  function renderArticle(data) {
    const article = data.articles[state.activeSlug];
    const container = byId('manualsArticle');
    if (!article || !container) return;
    container.replaceChildren();
    renderBreadcrumb(article, data, container);
    const header = element('header', 'manual-article-header');
    header.appendChild(element('span', 'manual-article-kicker', article.parent || article.section));
    header.appendChild(element('h1', '', article.title));
    if (article.description) header.appendChild(element('p', '', article.description));
    container.appendChild(header);
    const content = element('div', 'manual-article-content');
    article.blocks.forEach((block) => renderBlock(block, data, content));
    container.appendChild(content);
    const footer = element('footer', 'manual-article-footer');
    footer.append(
      element('span', '', 'DJIBUR WORKTEAM'),
      element('span', '', 'Operator knowledge base')
    );
    container.appendChild(footer);
    container.scrollTop = 0;
  }

  function closeMobileSidebar() {
    const sidebar = byId('manualsSidebar');
    const overlay = byId('manualsOverlay');
    const button = byId('manualsMenuBtn');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.add('hidden');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function toggleMobileSidebar() {
    const sidebar = byId('manualsSidebar');
    const overlay = byId('manualsOverlay');
    const button = byId('manualsMenuBtn');
    if (!sidebar || !overlay || !button) return;
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
  }

  function openArticle(slug) {
    const data = getData();
    if (!data || !data.articles[slug]) return;
    state.activeSlug = slug;
    expandActivePath(data);
    saveState();
    renderTree(data);
    renderArticle(data);
    if (root.matchMedia && root.matchMedia('(max-width: 900px)').matches) closeMobileSidebar();
  }

  function init() {
    if (state.initialized) return true;
    const data = getData();
    const mount = byId('tab-manuals');
    if (!data || !mount) return false;
    loadState(data);
    renderTree(data);
    renderArticle(data);

    const search = byId('manualsSearch');
    const results = byId('manualsSearchResults');
    search.addEventListener('input', () => {
      state.query = search.value;
      root.clearTimeout(state.searchTimer);
      state.searchTimer = root.setTimeout(() => renderSearchResults(data), 150);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        search.value = '';
        state.query = '';
        results.classList.add('hidden');
        renderArticle(data);
      }
    });
    root.document.addEventListener('click', (event) => {
      const searchWrap = byId('manualsSearchWrap');
      if (searchWrap && !searchWrap.contains(event.target)) results.classList.add('hidden');
    });
    byId('manualsMenuBtn').addEventListener('click', toggleMobileSidebar);
    byId('manualsOverlay').addEventListener('click', closeMobileSidebar);
    root.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMobileSidebar();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const page = byId('tab-manuals');
        if (!page || page.classList.contains('hidden')) return;
        event.preventDefault();
        search.focus();
        search.select();
      }
    });
    state.initialized = true;
    return true;
  }

  function onShow() {
    if (!state.initialized) init();
  }

  return Object.freeze({ init, onShow, openArticle, normalizeSearch, searchArticles, isSafeExternalUrl });
});
