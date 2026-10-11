const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

function tagWithId(source, tagName, id) {
  return source.match(new RegExp(`<${tagName}\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i'))?.[0] || '';
}

test('goal generator keeps its existing mode and adds donation bait inside the same tab', () => {
  const generatorTab = sectionBetween(html, 'id="tab-goalsgen"', 'id="tab-experience"');

  assert.ok(generatorTab, 'generator tab must exist');
  for (const id of [
    'generatorModeGoals',
    'generatorModeBait',
    'goalsGeneratorPanel',
    'donationBaitPanel'
  ]) {
    assert.match(generatorTab, new RegExp(`id=["']${id}["']`));
  }
  assert.match(tagWithId(generatorTab, 'button', 'generatorModeGoals'), /role=["']tab["']/i);
  assert.match(tagWithId(generatorTab, 'button', 'generatorModeBait'), /role=["']tab["']/i);
  assert.match(tagWithId(generatorTab, 'div', 'goalsGeneratorPanel'), /role=["']tabpanel["']/i);
  assert.match(tagWithId(generatorTab, 'div', 'donationBaitPanel'), /role=["']tabpanel["']/i);
  assert.match(generatorTab, /id=["']ggGenerateBtn["']/);
  assert.match(generatorTab, /id=["']ggGrid["']/);
});

test('donation-bait form exposes every condition with bounded native inputs', () => {
  const panel = sectionBetween(html, 'id="donationBaitPanel"', 'id="tab-experience"');
  const targetValues = [...panel.matchAll(/data-target=["']([^"']+)["']/g)].map((match) => match[1]);
  const toneValues = [...panel.matchAll(/data-tone=["']([^"']+)["']/g)].map((match) => match[1]);

  assert.deepEqual(targetValues, ['breast', 'butt', 'other']);
  assert.deepEqual(toneValues, ['soft', 'playful', 'bold']);

  const customTarget = tagWithId(panel, 'input', 'dbCustomTarget');
  assert.match(customTarget, /minlength=["']2["']/i);
  assert.match(customTarget, /maxlength=["']50["']/i);

  const action = tagWithId(panel, 'input', 'dbAction');
  assert.match(action, /minlength=["']2["']/i);
  assert.match(action, /maxlength=["']120["']/i);

  const tokens = tagWithId(panel, 'input', 'dbTokens');
  assert.match(tokens, /type=["']number["']/i);
  assert.match(tokens, /min=["']1["']/i);
  assert.match(tokens, /max=["']999999["']/i);
  assert.match(tokens, /step=["']1["']/i);

  const context = tagWithId(panel, 'textarea', 'dbContext');
  assert.match(context, /maxlength=["']6000["']/i);
  assert.match(panel, /id=["']dbBoundary["']/);
  assert.match(panel, /id=["']dbGenerateBtn["']/);
  assert.match(panel, /id=["']dbStatus["'][^>]*role=["']status["']/i);
});

test('result markup has three source replies, Russian translations and all follow-up scenarios', () => {
  const panel = sectionBetween(html, 'id="donationBaitPanel"', 'id="tab-experience"');

  for (let index = 0; index < 3; index += 1) {
    assert.match(panel, new RegExp(`id=["']dbVariant${index}Text["']`));
    assert.match(panel, new RegExp(`id=["']dbVariant${index}Ru["']`));
    assert.match(panel, new RegExp(`data-copy=["']variant-${index}["']`));
  }

  for (const [name, copyKey] of [
    ['AsksPrice', 'asksPrice'],
    ['Agrees', 'agrees'],
    ['Hesitates', 'hesitates']
  ]) {
    assert.match(panel, new RegExp(`id=["']dbFollow${name}Text["']`));
    assert.match(panel, new RegExp(`id=["']dbFollow${name}Ru["']`));
    assert.match(panel, new RegExp(`data-copy=["']${copyKey}["']`));
  }

  assert.match(panel, /id=["']dbPriceMode["']/);
});

test('donation-bait core loads before app integration and generation uses strict JSON mode', () => {
  const coreIndex = html.indexOf('lib/donation-bait.js');
  const appIndex = html.indexOf('app.js');
  assert.ok(coreIndex >= 0, 'donation-bait core script must be included');
  assert.ok(appIndex >= 0 && coreIndex < appIndex, 'core must load before app.js');

  assert.match(app, /oh_donation_bait_v1/);
  for (const method of ['validateInput', 'buildMessages', 'parseResponse']) {
    assert.match(app, new RegExp(`DonationBait\\.${method}\\s*\\(`));
  }
  assert.match(app, /responseFormat\s*:\s*["']json_object["']/);

  const hasTwoAttemptLoop = /(?:attempt|tryIndex|attemptIndex)\s*<\s*2\b/.test(app);
  const hasRetryConstant = /(?:MAX_?\w*ATTEMPTS|DONATION_?\w*ATTEMPTS)\s*=\s*2\b/.test(app);
  const hasExplicitSingleRetry = /retry/i.test(app) && /(?:attempt|retry)\s*===?\s*1\b/.test(app);
  assert.ok(
    hasTwoAttemptLoop || hasRetryConstant || hasExplicitSingleRetry,
    'generation must allow one initial attempt and exactly one corrective retry'
  );
});

test('AI phrases are rendered as text and copy buttons use source-language nodes', () => {
  assert.match(app, /function\s+setDonationBaitPhrase\s*\(/);
  assert.match(app, /text\.textContent\s*=\s*original/);
  assert.match(app, /translation\.textContent\s*=\s*russian/);
  assert.match(app, /function\s+renderDonationBaitResult\s*\(/);
  assert.doesNotMatch(app, /(?:dbResult|dbVariants|dbFollowups)[\s\S]{0,120}\.innerHTML\s*=/);

  assert.match(app, /dataset\.copy|getAttribute\(\s*["']data-copy["']\s*\)/);
  assert.match(app, /copyText\s*\(/);
  assert.match(app, /return\s+variants\[index\][\s\S]{0,80}\.text/);
  assert.match(app, /return\s+followUps\[key\][\s\S]{0,80}\.text/);
});

test('donation-bait layout defines desktop cards and a responsive mobile collapse', () => {
  for (const selector of ['.db-layout', '.db-variants', '.db-alternatives-grid', '.db-followup-grid']) {
    assert.match(css, new RegExp(selector.replace('.', '\\\.')));
  }

  assert.match(css, /@media\s*\(max-width:\s*\d+px\)[\s\S]*\.db-(?:layout|alternatives-grid|followup-grid)/);
  assert.match(css, /\.db-(?:alternatives-grid|followup-grid)\s*\{[\s\S]{0,240}grid-template-columns\s*:/);
});

test('donation bait stays inside Generator while Manuals is the seventh top-level destination', () => {
  const nav = html.match(/<nav id=["']tabs["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] || '';
  const buttons = nav.match(/<button\b[^>]*class=["'][^"']*\btab\b[^"']*["']/gi) || [];

  assert.equal(buttons.length, 7);
  assert.match(nav, /data-tab=["']manuals["']/i);
  assert.doesNotMatch(nav, /data-tab=["'](?:donation|bait|donation-bait)["']/i);
});
