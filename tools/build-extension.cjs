const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extension');
const output = path.join(root, 'dist', 'shine-extension');
const expectedOutput = path.resolve(root, 'dist', 'shine-extension');

function assertSafeOutput() {
  if (path.resolve(output) !== expectedOutput || !output.startsWith(path.join(root, 'dist') + path.sep)) {
    throw new Error(`Небезопасный путь сборки: ${output}`);
  }
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function validateBuild() {
  const manifestPath = path.join(output, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('Ожидался Manifest V3.');
  if (!manifest.key || !manifest.side_panel || !manifest.background) throw new Error('Манифест расширения неполон.');
  if ((manifest.host_permissions || []).includes('<all_urls>')) throw new Error('Запрещено разрешение <all_urls>.');
  for (const file of walk(output).filter((name) => /\.(?:html|js)$/i.test(name))) {
    const text = fs.readFileSync(file, 'utf8');
    if (/<script\b[^>]*\bsrc\s*=\s*["']https?:/i.test(text)) throw new Error(`Удалённый скрипт: ${file}`);
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) throw new Error(`Небезопасное выполнение кода: ${file}`);
  }
  return manifest;
}

function build() {
  assertSafeOutput();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(source, output, { recursive: true });
  const vendor = path.join(output, 'vendor');
  fs.mkdirSync(vendor, { recursive: true });
  const sharedFiles = [
    ['src/lib/parser.js', 'parser.js'],
    ['src/lib/assistant-result.js', 'assistant-result.js'],
    ['src/lib/ai-json.js', 'ai-json.js'],
    ['src/lib/goal-generator.js', 'goal-generator.js'],
    ['src/lib/donation-bait.js', 'donation-bait.js'],
    ['src/prompts.js', 'prompts.js']
  ];
  for (const [from, to] of sharedFiles) fs.copyFileSync(path.join(root, from), path.join(vendor, to));
  const manifest = validateBuild();
  console.log(`Расширение ${manifest.version} собрано: ${output}`);
  return { root, output, manifest };
}

if (require.main === module) build();
module.exports = { build, validateBuild, output };
