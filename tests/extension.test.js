const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const adapters = require('../extension/shared/site-adapters.js');
const GoalGenerator = require('../src/lib/goal-generator.js');
const AiJson = require('../src/lib/ai-json.js');

test('extension uses a stable minimal Manifest V3 configuration', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.key.length > 100);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.deepEqual(manifest.content_scripts[0].matches.slice(1), [
    'https://*.chaturbate.com/*', 'https://*.stripchat.com/*', 'https://*.bongacams.com/*'
  ]);
});

test('extension contains no automatic chat submission', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content', 'content-script.js'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'extension', 'shared', 'site-adapters.js'), 'utf8');
  assert.doesNotMatch(content, /\.submit\s*\(|requestSubmit|\.click\s*\(/);
  assert.doesNotMatch(adapter, /\.submit\s*\(|requestSubmit|\.click\s*\(|key\s*:\s*['"]Enter/);
});

test('site adapters identify the three supported platforms', () => {
  assert.equal(adapters.detectPlatform('www.chaturbate.com').id, 'chaturbate');
  assert.equal(adapters.detectPlatform('stripchat.com').id, 'stripchat');
  assert.equal(adapters.detectPlatform('ru.bongacams.com').id, 'bongacams');
  assert.equal(adapters.detectPlatform('example.com'), null);
});

test('site adapter fills a draft and never sends it', () => {
  const previous = {
    HTMLTextAreaElement: global.HTMLTextAreaElement, HTMLInputElement: global.HTMLInputElement,
    Event: global.Event, InputEvent: global.InputEvent
  };
  class FakeEvent { constructor(type) { this.type = type; } }
  class FakeTextarea {
    constructor() { this.value = ''; this.events = []; this.focused = false; this.isContentEditable = false; }
    getAttribute(name) { return name === 'type' ? '' : null; }
    dispatchEvent(event) { this.events.push(event.type); return true; }
    focus() { this.focused = true; }
  }
  Object.defineProperty(FakeTextarea.prototype, 'value', { configurable: true, get() { return this._value || ''; }, set(value) { this._value = value; } });
  global.HTMLTextAreaElement = FakeTextarea; global.HTMLInputElement = class {};
  global.Event = FakeEvent; global.InputEvent = FakeEvent;
  const field = new FakeTextarea();
  const document = { querySelector(selector) { return selector.includes('textarea') ? field : null; } };
  try {
    const result = adapters.insertDraft(document, 'stripchat.com', 'hello there');
    assert.equal(result.ok, true); assert.equal(field.value, 'hello there');
    assert.deepEqual(field.events, ['input', 'change']); assert.equal(field.focused, true);
  } finally { Object.assign(global, previous); }
});

test('goal generator shares one strict prompt contract', () => {
  const messages = GoalGenerator.buildMessages('feet', ['old goal'], false);
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /#feet/);
  assert.throws(() => GoalGenerator.buildMessages('unknown', [], false));
  const parsed = GoalGenerator.parseResponse('{"goals":[{"en":"Show feet","ru":"Показать ножки"}]}', AiJson, 10);
  assert.deepEqual(parsed, [{ en: 'Show feet', ru: 'Показать ножки' }]);
});
