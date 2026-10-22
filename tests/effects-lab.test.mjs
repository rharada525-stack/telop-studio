import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FX } from '../telop-studio/js/timeline.js';
import { SAMPLES, newDraft, validateDraft, validateStyle, sceneFor, STORAGE_KEY, DEFAULTS_KEY, designStyle, selectDesign, selectFont, captureDesignDefault, applyDesignDefault, validateDefaults, fontForStyle } from '../admin/effects-lab/model.mjs';
import { nativeStyles, XML_PRESETS, DESIGN_VARIANTS, FONT_CHOICES } from '../admin/effects-lab/native-presets.mjs';

const raw = JSON.parse(await readFile(new URL('../telop-studio/styles.json', import.meta.url)));
const names = [...Object.keys(raw).filter(key => !key.startsWith('_')), ...Object.keys(nativeStyles('portrait'))];

test('全演出・全デザインセット・縦横を本体の時刻とスタイルで試せる', () => {
  for (const aspect of ['portrait', 'landscape']) for (const set of ['standard', 'entertainment', 'business']) for (const fx of Object.keys(FX)) {
    const draft = { ...newDraft(), aspect, set, fx, text: SAMPLES[fx], separate: true };
    const scene = sceneFor(draft);
    assert.ok(scene.items.length > 0);
    assert.ok(scene.items.every(item => item.t >= 0 && item.t + item.d <= scene.total + 1e-8));
    assert.ok(scene.items.every(item => item.style === '__screen' || item.style === 'subtitle@A' || names.includes(item.style)));
    assert.ok(names.includes(scene.style));
  }
});
test('置き換え字幕と画面効果だけの確認で余計な字幕を出さない', () => {
  const draft = { ...newDraft(), separate: false };
  assert.ok(!sceneFor(draft).items.some(item => item.style.startsWith('subtitle')));
  draft.fx = ''; draft.screen = 'zoom_lines';
  const scene = sceneFor(draft);
  assert.deepEqual(scene.items.map(item => item.style), ['__screen', 'speedlines']);
});
test('試作のJSON往復は縦横とグループのパーツを保持し、本体の定義を変えない', () => {
  const before = JSON.stringify(raw), draft = newDraft();
  draft.overrides.portrait.point_body = { ...raw.point_body, size: 100 };
  draft.overrides.landscape.keyword = { ...raw.keyword, size: 120 };
  assert.deepEqual(validateDraft(JSON.parse(JSON.stringify(draft)), names), draft);
  assert.equal(JSON.stringify(raw), before);
  assert.notEqual(STORAGE_KEY, 'telop-studio:defaultDesign');
});
test('プロジェクトJSON・不正なスタイルや極端な数値を受け入れない', () => {
  for (const value of [{}, { ...newDraft(), duration: 0 }, { ...newDraft(), set: 'missing' }]) assert.throws(() => validateDraft(value, names));
  for (const style of [{ size: 100000 }, { size: 'bad' }, { strokes: [{ w: 900 }] }, { shadows: [{ dx: 0, dy: 0, blur: -10 }] }, { char: 'unknown' }, { pos: [0] }, { group: true, label_style: 'missing' }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => validateStyle(style, names));
});
test('ラボはPagesの公開対象の外にあり、本体画面には入口がない', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const index = await readFile(new URL('../telop-studio/index.html', import.meta.url), 'utf8');
  assert.match(workflow, /path: telop-studio\s/);
  assert.doesNotMatch(index, /effects-lab|演出ラボ/);
});


test('8つの動きと8つのデザインを独立して組み合わせても横長の下配置を維持する', () => {
  assert.equal(Object.keys(XML_PRESETS).length, 8); assert.equal(Object.keys(DESIGN_VARIANTS).length, 8);
  const motions = new Set();
  for (const [fx, preset] of Object.entries(XML_PRESETS)) for (const design of Object.keys(DESIGN_VARIANTS)) {
    const draft = { ...newDraft(), fx, text: preset.sample, design };
    const style = designStyle(draft);
    motions.add(style.in);
    assert.equal(style.in, preset.style.in);
    assert.equal(style.rotate || 0, 0);
    assert.deepEqual(sceneFor(draft).items[0].pos, [960, 900]);
    assert.deepEqual(style.fill, DESIGN_VARIANTS[design].style.fill);
  }
  assert.equal(motions.size, 8);
});

test('デザインを替えても文章・時間・動き・書体・配置の調整を保持する', () => {
  const original = { ...newDraft(), text: '自分の言葉', duration: 2.5, position: 'tr' };
  original.overrides.landscape.xml_pop = { in: 'slide_up', out_d: .3, size: 132, rotate: 0, fill: '#ff0000', strokes: [{ w: 3, color: '#000000' }], accent: '#ff0000', accent_scale: 1.2 };
  original.overrides.portrait.xml_pop = { size: 95, fill: '#ffff00' };
  const before = JSON.stringify(original), next = selectDesign(original, 'gold');
  assert.equal(JSON.stringify(original), before);
  assert.equal(next.text, original.text); assert.equal(next.duration, 2.5); assert.equal(next.position, 'tr'); assert.deepEqual(next.font, original.font);
  assert.deepEqual(next.overrides.landscape.xml_pop, { in: 'slide_up', out_d: .3, size: 132, rotate: 0 });
  assert.equal(designStyle(next).size, 132); assert.equal(designStyle(next).in, 'slide_up');
  assert.deepEqual(designStyle(next).fill, DESIGN_VARIANTS.gold.style.fill);
  assert.equal(designStyle(next, 'portrait').size, 95);
});

test('旧JSONの見た目を維持し、デザイン選択とフォントはJSON往復で保持する', () => {
  const legacy = newDraft(); delete legacy.design; delete legacy.font;
  legacy.overrides.landscape.xml_pop = { family: 'Yu Gothic', weight: 700, fill: '#123456', in: 'fade_up' };
  const migrated = validateDraft(legacy, names);
  assert.equal(migrated.design, ''); assert.equal(migrated.font, null);
  assert.equal(designStyle(migrated).fill, '#123456'); assert.equal(designStyle(migrated).family, 'Yu Gothic');
  assert.equal(fontForStyle(migrated, designStyle(migrated)).postscriptName, 'YuGothic-Bold');
  const rich = selectFont(selectDesign(migrated, 'ruby'), FONT_CHOICES.noto_serif);
  assert.deepEqual(validateDraft(JSON.parse(JSON.stringify(rich)), names), rich);
  assert.equal(designStyle(rich).family, 'Noto Serif JP'); assert.equal(designStyle(rich).weight, 900);
});

test('書体を変更すると古い全体スタイルの書体より優先し、XMLと同じ書体になる', () => {
  const draft = newDraft(); draft.overrides.landscape.xml_pop = { family: 'Noto Sans JP', weight: 900, size: 120 };
  const chosen = selectFont(draft, FONT_CHOICES.yu_mincho);
  chosen.overrides.landscape.xml_pop.family = 'Noto Sans JP'; chosen.overrides.landscape.xml_pop.weight = 900;
  assert.equal(designStyle(chosen).family, 'Yu Mincho'); assert.equal(designStyle(chosen).weight, 600);
  assert.equal(fontForStyle(chosen, designStyle(chosen)).postscriptName, 'YuMincho-Demibold');
  assert.equal(fontForStyle({ ...chosen, fx: 'note' }, { font: 'NotoSansJP-Black.otf' }).postscriptName, 'NotoSansJP-Black', '従来の演出にはXML演出で選んだ書体を混ぜない');
  const unknown = { ...draft, font: null };
  assert.equal(fontForStyle(unknown, { family: '不明なPCフォント', weight: 700 }), null);
  for (const font of [{ family: 'Noto Sans JP', weight: 900, postscriptName: 'Noto Sans JP' }, { family: 'A', weight: 0, postscriptName: 'A' }]) assert.throws(() => selectFont(draft, font));
});

test('演出ごとの標準は見た目だけを保存し、バックアップから復元しても時刻や文字を変えない', () => {
  const draft = selectFont(selectDesign(newDraft(), 'gold'), FONT_CHOICES.yu_bold);
  draft.overrides.landscape.xml_pop = { size: 120, in: 'bounce', out: 'shrink', rotate: 10, pos: [600, 700], fill: '#ffcc22', accent: '#ff0000' };
  const preferred = captureDesignDefault(draft);
  assert.deepEqual(preferred.overrides.landscape, { size: 120, fill: '#ffcc22', accent: '#ff0000' });
  const defaults = validateDefaults(JSON.parse(JSON.stringify({ kind: 'effects-lab-design-defaults', version: 1, defaults: { xml_pop: preferred } })), names);
  const next = { ...newDraft(), text: '別の文章', duration: 5, position: 'tr' };
  next.overrides.landscape.xml_pop = { in: 'slide_up', size: 90 };
  const applied = applyDesignDefault(next, defaults);
  assert.equal(applied.text, next.text); assert.equal(applied.duration, 5); assert.equal(applied.position, 'tr');
  assert.equal(designStyle(applied).in, 'slide_up'); assert.equal(designStyle(applied).size, 120); assert.equal(applied.design, 'gold');
  assert.equal(applyDesignDefault({ ...next, fx: 'xml_drop' }, defaults).design, 'classic');
  assert.equal(applyDesignDefault(next, {}).design, 'classic');
  assert.notEqual(DEFAULTS_KEY, STORAGE_KEY); assert.match(DEFAULTS_KEY, /^telop-studio:effects-lab:/);
});

test('標準デザインJSONに未知の演出や動き指定を混ぜられない', () => {
  const entry = captureDesignDefault(newDraft());
  for (const defaults of [{ unknown: entry }, { xml_pop: { ...entry, design: 'unknown' } }, { xml_pop: { ...entry, overrides: { landscape: { in: 'bounce' } } } }]) {
    assert.throws(() => validateDefaults({ kind: 'effects-lab-design-defaults', version: 1, defaults }, names));
  }
  assert.throws(() => validateDefaults(newDraft(), names));
  assert.throws(() => validateDraft({ ...newDraft(), design: 'unknown' }, names));
});
