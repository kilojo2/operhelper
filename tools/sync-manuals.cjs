const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DATA = path.join(REPO_ROOT, 'src', 'lib', 'manuals-data.js');
const OUTPUT_ASSETS = path.join(REPO_ROOT, 'src', 'manual-assets');
const ALLOWED_BLOCKS = new Set([
  'heading', 'subheading', 'paragraph', 'list', 'ordered-list', 'divider',
  'note', 'link-block', 'table'
]);
const BRAND_LOGO_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="KILLASNAZZ">
  <defs>
    <linearGradient id="killasnazzBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a855f7"/>
      <stop offset="0.52" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#4f46e5"/>
    </linearGradient>
    <filter id="killasnazzShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#170d2b" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#killasnazzBg)"/>
  <path d="M20 14v36h8V37l14 13h11L35 32l17-18H41L28 28V14z" fill="#fff" filter="url(#killasnazzShadow)"/>
  <path d="M20 14h8v36h-8z" fill="#fff" opacity="0.3"/>
</svg>\n`;

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function ensureInside(base, candidate, label) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label}: путь выходит за разрешённую директорию`);
  }
  return path.resolve(candidate);
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function findBalanced(source, start, openChar, closeChar) {
  let depth = 0;
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function evaluateLiteral(literal, label) {
  const value = vm.runInNewContext(`(${literal})`, Object.create(null), {
    timeout: 1000,
    filename: label,
    codeGeneration: { strings: false, wasm: false }
  });
  return JSON.parse(JSON.stringify(value));
}

function extractNavigation(sourceRoot) {
  const file = path.join(sourceRoot, 'lib', 'navigation.ts');
  const source = readUtf8(file);
  const marker = 'export const navigationSections';
  const markerIndex = source.indexOf(marker);
  const assignmentIndex = source.indexOf('=', markerIndex);
  const start = source.indexOf('[', assignmentIndex);
  const end = start >= 0 ? findBalanced(source, start, '[', ']') : -1;
  if (markerIndex < 0 || assignmentIndex < 0 || start < 0 || end < 0) {
    throw new Error('Не удалось прочитать navigationSections из lib/navigation.ts');
  }
  const sections = evaluateLiteral(source.slice(start, end + 1), file);
  if (!Array.isArray(sections) || sections.length !== 3) {
    throw new Error('Ожидалось ровно три раздела навигации');
  }
  return sections.map((section) => ({
    title: String(section.title || '').trim(),
    icon: String(section.icon || '').trim(),
    items: normalizeNavigationItems(section.items)
  }));
}

function normalizeNavigationItems(items) {
  if (!Array.isArray(items)) throw new Error('Некорректный список статей в навигации');
  return items.map((item) => {
    const normalized = {
      title: String(item.title || '').trim(),
      href: String(item.href || '').trim(),
      slug: String(item.slug || '').trim(),
      icon: String(item.icon || '').trim()
    };
    if (!normalized.title || !/^\/[a-z0-9/_-]+$/i.test(normalized.href) ||
        !/^[a-z0-9-]+$/i.test(normalized.slug)) {
      throw new Error(`Некорректный пункт навигации: ${JSON.stringify(normalized)}`);
    }
    if (Array.isArray(item.children) && item.children.length) {
      normalized.children = normalizeNavigationItems(item.children);
    }
    return normalized;
  });
}

function pageFileFor(sourceRoot, href) {
  const relative = href.replace(/^\/+/, '').replace(/\/+$/, '');
  return ensureInside(
    path.join(sourceRoot, 'app'),
    path.join(sourceRoot, 'app', relative, 'page.tsx'),
    `Страница ${href}`
  );
}

function extractPageMeta(pageSource, navigationItem) {
  const metadata = pageSource.match(/export const metadata\s*=\s*\{([\s\S]*?)\};/);
  const metadataBody = metadata ? metadata[1] : '';
  const metadataTitle = metadataBody.match(/\btitle:\s*"([^"]+)"/);
  const metadataDescription = metadataBody.match(/\bdescription:\s*"([^"]*)"/);
  const article = pageSource.match(/<ArticlePage\b([\s\S]*?)>/);
  const attributes = article ? article[1] : '';
  const titleMatch = attributes.match(/\btitle="([^"]+)"/);
  const descriptionMatch = attributes.match(/\bdescription="([^"]*)"/);
  return {
    title: titleMatch ? titleMatch[1].trim() : navigationItem.title,
    sourceTitle: metadataTitle ? metadataTitle[1].trim() :
      (titleMatch ? titleMatch[1].trim() : navigationItem.title),
    description: descriptionMatch ? descriptionMatch[1].trim() :
      (metadataDescription ? metadataDescription[1].trim() : '')
  };
}

function sanitizeFolderName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function extractContentArrays(pageSource, pageFile) {
  const arrays = new Map();
  const pattern = /const\s+(\w+)\s*:\s*ContentBlock\[\]\s*=\s*\[/g;
  let match;
  while ((match = pattern.exec(pageSource))) {
    const start = pattern.lastIndex - 1;
    const end = findBalanced(pageSource, start, '[', ']');
    if (end < 0) throw new Error(`${pageFile}: незакрытый ContentBlock[] ${match[1]}`);
    const blocks = evaluateLiteral(pageSource.slice(start, end + 1), pageFile);
    if (!Array.isArray(blocks)) throw new Error(`${pageFile}: ${match[1]} не является массивом`);
    arrays.set(match[1], blocks.map(normalizeContentBlock));
    pattern.lastIndex = end + 1;
  }
  return arrays;
}

function normalizeContentBlock(block) {
  if (!block || typeof block !== 'object' || !ALLOWED_BLOCKS.has(block.type)) {
    throw new Error(`Неподдерживаемый ContentBlock: ${JSON.stringify(block)}`);
  }
  const normalized = { type: block.type };
  if (block.text != null) normalized.text = String(block.text);
  if (block.emoji != null) normalized.emoji = String(block.emoji);
  if (Array.isArray(block.items)) normalized.items = block.items.map(String);
  if (Array.isArray(block.headers)) normalized.headers = block.headers.map(String);
  if (Array.isArray(block.rows)) {
    normalized.rows = block.rows.map((row) => {
      if (!Array.isArray(row)) throw new Error('Некорректная строка таблицы');
      return row.map(String);
    });
  }
  return normalized;
}

function extractAttribute(tag, name) {
  const expression = tag.match(new RegExp(`\\b${name}=\\{(["'])([\\s\\S]*?)\\1\\}`));
  if (expression) return expression[2];
  const literal = tag.match(new RegExp(`\\b${name}=(["'])([\\s\\S]*?)\\1`));
  return literal ? literal[2] : '';
}

function parseMixedPage(pageSource, pageFile) {
  const arrays = extractContentArrays(pageSource, pageFile);
  if (!arrays.size || !/<(?:Image|img)\b/.test(pageSource)) return null;
  const articleMatch = pageSource.match(/<ArticlePage\b[^>]*>([\s\S]*?)<\/ArticlePage>/);
  if (!articleMatch) throw new Error(`${pageFile}: не найдено содержимое ArticlePage`);

  const blocks = [];
  const tokenPattern = /<MarkdownContent\s+blocks=\{(\w+)\}\s*\/>|<(?:Image|img)\b([\s\S]*?)\/>/g;
  let token;
  let markdownCalls = 0;
  let imageCalls = 0;
  while ((token = tokenPattern.exec(articleMatch[1]))) {
    if (token[1]) {
      const named = arrays.get(token[1]);
      if (!named) throw new Error(`${pageFile}: не найден массив ${token[1]}`);
      blocks.push(...named);
      markdownCalls += 1;
    } else {
      const tag = token[0];
      const src = extractAttribute(tag, 'src');
      if (!src) throw new Error(`${pageFile}: изображение должно иметь статический src`);
      blocks.push({ type: 'image-source', source: src, alt: extractAttribute(tag, 'alt') });
      imageCalls += 1;
    }
  }

  const expectedMarkdownCalls = (articleMatch[1].match(/<MarkdownContent\b/g) || []).length;
  const expectedImageCalls = (articleMatch[1].match(/<(?:Image|img)\b/g) || []).length;
  if (markdownCalls !== expectedMarkdownCalls || imageCalls !== expectedImageCalls) {
    throw new Error(`${pageFile}: не удалось восстановить порядок секций и изображений`);
  }
  return blocks;
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function parseMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  let firstHeadingSkipped = false;

  const isSpecial = (line) => {
    const trimmed = line.trim();
    return !trimmed || /^#{1,6}\s+/.test(trimmed) || /^---+$/.test(trimmed) ||
      /^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) ||
      /^\|.*\|$/.test(trimmed) || /^!\[[^\]]*\]\([^)]+\)$/.test(trimmed);
  };

  while (index < lines.length) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) { index += 1; continue; }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (heading[1].length === 1 && !firstHeadingSkipped) {
        firstHeadingSkipped = true;
      } else {
        blocks.push({
          type: heading[1].length <= 2 ? 'heading' : 'subheading',
          text: heading[2].trim()
        });
      }
      index += 1;
      continue;
    }

    if (/^---+$/.test(line)) {
      blocks.push({ type: 'divider' });
      index += 1;
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      blocks.push({ type: 'image-source', source: image[2].trim(), alt: image[1].trim() });
      index += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'ordered-list', items });
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      const rows = tableLines.map(splitTableRow);
      if (rows.length >= 2 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))) {
        blocks.push({ type: 'table', headers: rows[0], rows: rows.slice(2) });
      } else {
        blocks.push({ type: 'paragraph', text: tableLines.join('\n') });
      }
      continue;
    }

    const paragraph = [];
    while (index < lines.length && !isSpecial(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const text = paragraph.join(' ').trim();
    if (!text) { index += 1; continue; }
    if (/^\*\*ВАЖНО:\*\*/i.test(text)) {
      blocks.push({ type: 'note', text: text.replace(/^\*\*ВАЖНО:\*\*\s*/i, '') });
    } else if (/^https?:\/\/\S+$/i.test(text)) {
      blocks.push({ type: 'link-block', items: [text] });
    } else {
      blocks.push({ type: 'paragraph', text });
    }
  }
  return blocks;
}

function flattenNavigation(sections) {
  const result = [];
  for (const section of sections) {
    for (const item of section.items) {
      result.push({ section: section.title, parent: '', item });
      for (const child of item.children || []) {
        result.push({ section: section.title, parent: item.title, item: child });
      }
    }
  }
  return result;
}

function copyArticleAssets(blocks, context) {
  const copied = new Map();
  let counter = 0;
  return blocks.map((block) => {
    if (block.type !== 'image-source') return block;
    let sourceFile;
    if (block.source.startsWith('/')) {
      sourceFile = ensureInside(
        context.publicDir,
        path.join(context.publicDir, block.source.replace(/^\/+/, '')),
        `${context.slug}: изображение`
      );
    } else {
      sourceFile = ensureInside(
        context.manualDir,
        path.resolve(context.manualDir, block.source),
        `${context.slug}: изображение`
      );
    }
    if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
      throw new Error(`${context.slug}: изображение не найдено: ${block.source}`);
    }
    if (!copied.has(sourceFile)) {
      counter += 1;
      const extension = path.extname(sourceFile).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension)) {
        throw new Error(`${context.slug}: неподдерживаемый тип изображения ${extension}`);
      }
      const fileName = String(counter).padStart(2, '0') + extension;
      const articleAssetDir = ensureInside(
        OUTPUT_ASSETS,
        path.join(OUTPUT_ASSETS, context.slug),
        'Каталог изображений статьи'
      );
      fs.mkdirSync(articleAssetDir, { recursive: true });
      fs.copyFileSync(sourceFile, path.join(articleAssetDir, fileName));
      copied.set(sourceFile, `manual-assets/${context.slug}/${fileName}`);
      context.mediaFiles.add(sourceFile);
    }
    return {
      type: 'image',
      src: copied.get(sourceFile),
      alt: block.alt || path.basename(sourceFile)
    };
  });
}

function searchableText(article) {
  const values = [article.title, article.description];
  for (const block of article.blocks || []) {
    if (block.text) values.push(block.text);
    if (block.items) values.push(...block.items);
    if (block.headers) values.push(...block.headers);
    if (block.rows) values.push(...block.rows.flat());
  }
  return values.join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function buildSnapshot(sourceRoot) {
  const sections = extractNavigation(sourceRoot);
  const entries = flattenNavigation(sections);
  const allManualsDir = path.join(sourceRoot, 'allmanuals');
  const publicDir = path.join(sourceRoot, 'public');
  if (!fs.existsSync(allManualsDir)) throw new Error('Не найдена папка allmanuals');
  if (!fs.existsSync(publicDir)) throw new Error('Не найдена папка public');

  const articles = {};
  const mediaFiles = new Set();
  for (const entry of entries) {
    const pageFile = pageFileFor(sourceRoot, entry.item.href);
    if (!fs.existsSync(pageFile)) throw new Error(`Не найдена страница ${entry.item.href}`);
    const pageSource = readUtf8(pageFile);
    const meta = extractPageMeta(pageSource, entry.item);
    const manualDir = ensureInside(
      allManualsDir,
      path.join(allManualsDir, sanitizeFolderName(meta.sourceTitle)),
      `${entry.item.slug}: папка allmanuals`
    );
    const manualFile = path.join(manualDir, 'manual.md');
    if (!fs.existsSync(manualFile)) {
      throw new Error(`${entry.item.slug}: не найден ${manualFile}`);
    }

    let blocks;
    let kind = 'article';
    if (entry.item.children && entry.item.children.length) {
      kind = 'overview';
      blocks = [{
        type: 'overview',
        items: entry.item.children.map((child) => ({
          slug: child.slug,
          title: child.title,
          icon: child.icon
        }))
      }];
    } else {
      blocks = parseMixedPage(pageSource, pageFile) || parseMarkdown(readUtf8(manualFile));
      blocks = copyArticleAssets(blocks, {
        slug: entry.item.slug,
        manualDir,
        publicDir,
        mediaFiles
      });
    }

    const article = {
      slug: entry.item.slug,
      title: meta.title,
      description: meta.description,
      section: entry.section,
      parent: entry.parent,
      sourceHref: entry.item.href,
      kind,
      blocks
    };
    article.searchText = searchableText(article);
    articles[entry.item.slug] = article;
  }

  const slugs = entries.map((entry) => entry.item.slug);
  if (new Set(slugs).size !== slugs.length) throw new Error('В навигации есть повторяющиеся slug');
  if (Object.keys(articles).length !== entries.length) throw new Error('Не все статьи были обработаны');

  fs.writeFileSync(path.join(OUTPUT_ASSETS, 'logo-purple.svg'), BRAND_LOGO_SVG, 'utf8');

  return {
    version: 1,
    defaultSlug: 'account-login',
    sourceName: 'KILLASNAZZ',
    sections,
    articles,
    stats: {
      sections: sections.length,
      articles: Object.keys(articles).length,
      media: mediaFiles.size
    }
  };
}

function writeSnapshot(snapshot) {
  const json = JSON.stringify(snapshot).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const source = [
    '/* Generated by tools/sync-manuals.cjs. Do not edit manually. */',
    '(function attachManualsData(root) {',
    `  root.ManualsData = ${json};`,
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    ''
  ].join('\n');
  fs.mkdirSync(path.dirname(OUTPUT_DATA), { recursive: true });
  const temporary = OUTPUT_DATA + '.tmp';
  fs.writeFileSync(temporary, source, 'utf8');
  fs.rmSync(OUTPUT_DATA, { force: true });
  fs.renameSync(temporary, OUTPUT_DATA);
}

function main() {
  const sourceArg = getArg('--source') || process.env.MANUALS_SOURCE_DIR || 'E:\\Anon Chat';
  const sourceRoot = path.resolve(sourceArg);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`Проект мануалов не найден: ${sourceRoot}`);
  }
  ensureInside(path.join(REPO_ROOT, 'src'), OUTPUT_ASSETS, 'Каталог назначения');
  fs.rmSync(OUTPUT_ASSETS, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_ASSETS, { recursive: true });
  try {
    const snapshot = buildSnapshot(sourceRoot);
    writeSnapshot(snapshot);
    console.log(
      `Мануалы синхронизированы: ${snapshot.stats.articles} статей, ` +
      `${snapshot.stats.media} изображений, ${snapshot.stats.sections} раздела.`
    );
  } catch (error) {
    fs.rmSync(OUTPUT_ASSETS, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Ошибка синхронизации мануалов:', error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  buildSnapshot,
  normalizeContentBlock,
  parseMarkdown,
  extractNavigation
};
