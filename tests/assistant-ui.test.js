const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const assistant = fs.readFileSync(path.join(root, 'src', 'assistant.js'), 'utf8');

test('assistant result UI exposes one primary reply, two alternatives and tone controls', () => {
  const result = html.match(/<div id="resultArea"[\s\S]*?<\/details>\s*<\/div>/)?.[0] || '';
  assert.match(result, /id="mainAnswer"/);
  assert.match(result, /id="altAnswer1"/);
  assert.match(result, /id="altAnswer2"/);
  assert.equal((result.match(/class="[^"]*copy-answer-btn/g) || []).length, 3);
  assert.deepEqual(
    [...result.matchAll(/data-tone="([^"]+)"/g)].map((match) => match[1]),
    ['softer', 'bolder', 'shorter']
  );
  assert.match(result, /id="regenerateReplyBtn"/);
  assert.match(result, /Перегенерировать только ответ/);
});

test('all service analysis is collapsed into one details block', () => {
  const details = html.match(/<details id="analysisDetails"[\s\S]*?<\/details>/)?.[0] || '';
  assert.match(details, /Служебный анализ/);
  for (const id of ['strategyCard', 'analysisCard', 'forecastCard', 'whyCard']) {
    assert.match(details, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /<details id="analysisDetails"[^>]*\sopen(?:\s|>)/);
});

test('reply-only regeneration uses JSON mode, validation and preserves the analysis blocks', () => {
  assert.match(assistant, /function regenerateReply\(\)/);
  assert.match(assistant, /responseFormat:\s*'json_object'/);
  assert.match(assistant, /maxTokens:\s*800/);
  assert.match(assistant, /inspectReplyVariants\(candidate/);
  assert.match(assistant, /AssistantResult\.replaceReplyBlocks\(sourceResult, variants\)/);
  assert.doesNotMatch(assistant, /altsWrap['"]?\)\.innerHTML/);
  assert.ok(html.indexOf('lib/assistant-result.js') < html.indexOf('assistant.js'));
});

test('new answer layout has desktop and mobile presentation rules', () => {
  assert.match(css, /\.answer-card\.best \.answer-text/);
  assert.match(css, /\.tone-options/);
  assert.match(css, /\.analysis-details\[open\] \.details-chevron/);
  assert.match(css, /@media \(max-width: 540px\)[\s\S]*\.regenerate-reply-btn \{ width: 100%; \}/);
});

test('continuation UI accepts the sent reply and only the new user message', () => {
  const card = html.match(/<section id="continuationCard"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(card, /id="sentReplyInput"/);
  assert.match(card, /id="newUserMessageInput"/);
  assert.match(card, /id="continueChatBtn"/);
  assert.match(card, /Прошлая история уже сохранена/);
  assert.match(card, /Всю переписку повторно вставлять не нужно/);
  assert.match(css, /\.continuation-grid/);
  assert.match(css, /\.continue-chat-btn/);
});

test('continuation generation commits the appended history only after a successful response', () => {
  assert.match(assistant, /function continueConversation\(\)/);
  assert.match(assistant,
    /AssistantResult\.appendConversationTurn\(baseHistory, sentReply, userMessage\)/);
  assert.match(assistant, /historyOverride:\s*nextHistory/);
  assert.match(assistant, /commitHistoryOnSuccess:\s*true/);
  assert.match(assistant, /targetChat\.history\s*!==\s*opts\.expectedHistory/);
  assert.ok(
    assistant.indexOf('targetChat.history !== opts.expectedHistory') <
      assistant.indexOf('targetChat.history = hist'),
    'history snapshot must be checked before commit'
  );
  assert.match(assistant, /c\.sentReplyDraft\s*=\s*value/);
  assert.match(assistant, /e\.preventDefault\(\);[\s\S]*continueConversation\(\)/);
});

test('assistant can generate a first message without pasted history', () => {
  assert.match(html, /id="generateFirstMessageBtn"/);
  assert.match(html, /Первое сообщение/);
  assert.match(css, /\.first-message-btn/);
  assert.match(assistant, /function generateOpeningMessage\(\)/);
  assert.match(assistant, /historyOverride:\s*''\s*,\s*opening:\s*true/);
  assert.match(assistant, /Prompts\.buildOpeningUserPrompt\(\)/);
  assert.match(assistant, /!hist\s*&&\s*!opts\.opening/);
});

test('chat list supports accessible inline renaming', () => {
  assert.match(html, /<symbol id="ui-edit"/);
  assert.match(html, /id="chatTitle" maxlength="80"/);
  assert.match(assistant, /const MAX_CHAT_TITLE_LENGTH = 80/);
  assert.match(assistant, /function startChatRename\(c, item, name, button\)/);
  assert.match(assistant, /renameBtn\.setAttribute\('aria-label'/);
  assert.match(assistant, /event\.key === 'Enter'/);
  assert.match(assistant, /event\.key === 'Escape'/);
  assert.match(assistant, /input\.addEventListener\('blur', \(\) => finish\(true\)/);
  assert.match(css, /\.chat-rename-btn/);
  assert.match(css, /\.chat-rename-input/);
});
