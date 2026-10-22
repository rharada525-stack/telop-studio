import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FX } from '../telop-studio/js/timeline.js';
import { SAMPLES, newDraft, validateDraft, validateStyle, sceneFor, STORAGE_KEY, DEFAULTS_KEY, designStyle, selectDesign, selectFont, captureDesignDefault, applyDesignDefault, applyMotionDesign, validateDefaults, fontForStyle } from '../admin/effects-lab/model.mjs';
import { nativeStyles, XML_PRESETS, DESIGN_VARIANTS, DESIGN_CATEGORIES, FONT_CHOICES, variantStyle } from '../admin/effects-lab/native-presets.mjs';

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


test('11の動きと20のデザインを独立して組み合わせても横長の下配置を維持する', () => {
  assert.equal(Object.keys(XML_PRESETS).length, 11); assert.equal(Object.keys(DESIGN_VARIANTS).length, 20);
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


test('用途別9案は色以外の文字組みも異なり、対応する書体と縦横の推奨サイズを持つ', () => {
  assert.deepEqual(DESIGN_CATEGORIES, { luxury: '豪華', reaction: 'ツッコミ', heading: '見出し', ending: '締め', common: '共通' });
  const groups = Object.groupBy(Object.entries(DESIGN_VARIANTS), ([, design]) => design.category);
  assert.equal(groups.common.length, 8);
  for (const category of ['reaction', 'heading', 'ending']) {
    const designs = groups[category]; assert.equal(designs.length, 3);
    const shapes = new Set();
    for (const [id, design] of designs) {
      assert.ok(FONT_CHOICES[design.fontChoice]);
      shapes.add(JSON.stringify([design.fontChoice, design.aspectStyle.landscape.size, design.style.strokes.map(s => s.w)]));
      for (const aspect of ['portrait', 'landscape']) {
        const draft = selectDesign({ ...newDraft(), aspect, fx: 'xml_drop' }, id);
        const style = designStyle(draft);
        assert.equal(style.size, design.aspectStyle[aspect].size);
        assert.equal(style.max_width, design.aspectStyle[aspect].max_width);
        assert.equal(style.family, FONT_CHOICES[design.fontChoice].family);
        assert.equal(fontForStyle(draft, style).postscriptName, FONT_CHOICES[design.fontChoice].postscriptName);
        assert.ok(style.strokes.length >= 1 && style.strokes.length <= 4);
        assert.equal(style.in, nativeStyles(aspect).xml_drop.in);
        assert.equal(style.rotate || 0, 0);
        if (aspect === 'landscape') assert.deepEqual(sceneFor(draft).items[0].pos, [960, 900]);
      }
    }
    assert.equal(shapes.size, 3, `${category}の3案は色替えだけではない`);
  }
});

test('用途案の切替で前案のサイズや書体上書きを持ち越さず、動きと編集内容を保持する', () => {
  const original = { ...newDraft(), text: '自分の締めの言葉', duration: 4.7, position: 'tr' };
  const initial = selectFont(selectDesign(original, 'reaction_punch'), FONT_CHOICES.yu_bold);
  for (const aspect of ['portrait', 'landscape']) initial.overrides[aspect].xml_pop = {
    size: 230, max_width: 300, max_height: 420, tracking: .1, line_spacing: 1.8,
    family: 'Yu Gothic', weight: 700, font: '古い指定.otf', fill: '#123456',
    in: 'bounce', out: 'shrink', out_d: .4, idle: 'float', rotate: 0, pos: [500, 800],
  };
  const before = JSON.stringify(initial), next = selectDesign(initial, 'ending_thanks');
  assert.equal(JSON.stringify(initial), before);
  assert.equal(next.text, original.text); assert.equal(next.duration, 4.7); assert.equal(next.position, 'tr');
  for (const aspect of ['portrait', 'landscape']) {
    const style = designStyle(next, aspect);
    assert.equal(style.size, DESIGN_VARIANTS.ending_thanks.aspectStyle[aspect].size);
    assert.equal(style.max_width, DESIGN_VARIANTS.ending_thanks.aspectStyle[aspect].max_width);
    assert.equal(style.family, 'Yu Mincho'); assert.equal(style.weight, 600);
    assert.equal(style.tracking, undefined); assert.equal(style.max_height, undefined);
    assert.deepEqual(next.overrides[aspect].xml_pop, { in: 'bounce', out: 'shrink', out_d: .4, idle: 'float', rotate: 0, pos: [500, 800] });
  }
  const userFont = selectFont(next, FONT_CHOICES.noto_bold);
  assert.equal(designStyle(userFont).family, 'Noto Sans JP'); assert.equal(designStyle(userFont).weight, 700);
  assert.equal(designStyle(userFont).size, DESIGN_VARIANTS.ending_thanks.aspectStyle.landscape.size);
});

test('共通8案は既存の書体とサイズ操作を保ち、用途案から戻した時は用途のサイズが残らない', () => {
  const original = selectFont(newDraft(), FONT_CHOICES.yu_bold);
  original.overrides.landscape.xml_pop = { size: 133, max_width: 1400 };
  original.overrides.portrait.xml_pop = { size: 97, max_width: 880 };
  for (const [id, variant] of Object.entries(DESIGN_VARIANTS).filter(([, v]) => v.category === 'common')) {
    assert.equal(variant.fontChoice, undefined); assert.equal(variant.aspectStyle, undefined);
    const changed = selectDesign(original, id);
    assert.equal(designStyle(changed).size, 133); assert.equal(designStyle(changed).max_width, 1400);
    assert.equal(designStyle(changed, 'portrait').size, 97);
    assert.equal(changed.font.postscriptName, 'YuGothic-Bold');
  }
  const ending = selectDesign(original, 'ending_grand');
  ending.overrides.landscape.xml_pop.size = 240;
  const returned = selectDesign(ending, 'gold');
  assert.equal(designStyle(returned).size, 110); assert.equal(designStyle(returned).max_width, 1580);
  assert.equal(returned.font.postscriptName, 'NotoSerifJP-Black', '共通案は現在選択した書体を保持する');
});

test('用途案と手調整した書体・サイズを試作と標準デザインのJSONで保存復元できる', () => {
  const draft = selectFont(selectDesign(newDraft(), 'heading_chapter'), FONT_CHOICES.noto_bold);
  draft.overrides.landscape.xml_pop = { size: 139, max_width: 1550, in: 'slide_up', out_d: .35 };
  draft.overrides.portrait.xml_pop = { size: 103 };
  const restored = validateDraft(JSON.parse(JSON.stringify(draft)), names);
  assert.deepEqual(restored, draft);
  assert.equal(designStyle(restored).size, 139); assert.equal(fontForStyle(restored, designStyle(restored)).postscriptName, 'NotoSansJP-Bold');
  const defaults = validateDefaults(JSON.parse(JSON.stringify({ kind: 'effects-lab-design-defaults', version: 1, defaults: { xml_pop: captureDesignDefault(draft) } })), names);
  const next = selectDesign({ ...newDraft(), text: '別の字幕', duration: 2 }, 'reaction_deadpan');
  next.overrides.landscape.xml_pop = { in: 'drop' };
  const applied = applyDesignDefault(next, defaults);
  assert.equal(applied.design, 'heading_chapter'); assert.equal(designStyle(applied).size, 139);
  assert.equal(designStyle(applied).in, 'drop'); assert.equal(applied.text, '別の字幕'); assert.equal(applied.duration, 2);
  assert.equal(applied.font.postscriptName, 'NotoSansJP-Bold');
  const fresh = selectDesign(applied, 'heading_news');
  assert.equal(designStyle(fresh).size, DESIGN_VARIANTS.heading_news.aspectStyle.landscape.size);
  assert.equal(fresh.font.postscriptName, 'YuGothic-Bold');
  const original = JSON.stringify(DESIGN_VARIANTS.heading_news); const copy = variantStyle('heading_news', 'landscape');
  copy.strokes[0].w = 99; copy.size = 22;
  assert.equal(JSON.stringify(DESIGN_VARIANTS.heading_news), original, '見本を外から書き換えない');
});


test('豪華演出の初回だけ推奨デザインを適用し、ユーザー標準を優先する', () => {
  for (const [fx, kind, design] of [
    ['xml_sparkle_sweep', 'sweep', 'luxury_gold'],
    ['xml_sparkle_burst', 'burst', 'luxury_platinum'],
    ['xml_sparkle_cascade', 'cascade', 'luxury_rose'],
  ]) {
    const original = { ...newDraft(), fx, text: '自分の文章で輝かせたい', duration: 4.5, position: 'auto' };
    const before = JSON.stringify(original), first = applyMotionDesign(original);
    assert.equal(JSON.stringify(original), before);
    assert.equal(first.design, design); assert.equal(first.text, original.text); assert.equal(first.duration, 4.5); assert.equal(first.position, 'auto');
    assert.deepEqual(first.recommendedMotions, [fx]);
    const style = designStyle(first);
    assert.equal(style.sparkle, kind); assert.equal(style.rotate || 0, 0);
    assert.ok(style.size >= 132 && style.size <= 150);
    assert.ok(style.strokes.length >= 1 && style.strokes.length <= 4);
    assert.deepEqual(sceneFor(first).items[0].pos, [960, 900]);
    assert.equal(first.font.postscriptName, FONT_CHOICES[DESIGN_VARIANTS[design].fontChoice].postscriptName);
    const recolored = selectDesign(first, 'ice');
    assert.equal(applyMotionDesign(recolored).design, 'ice', '再度選んでも標準未指定の色替えを戻さない');
    const defaults = { [fx]: captureDesignDefault(selectFont(selectDesign(original, 'rose'), FONT_CHOICES.yu_bold)) };
    const preferred = applyMotionDesign(original, defaults);
    assert.equal(preferred.design, 'rose'); assert.equal(preferred.font.postscriptName, 'YuGothic-Bold');
    assert.deepEqual(preferred.recommendedMotions, [fx]);
    assert.equal(designStyle(preferred).sparkle, kind);
  }
});

test('輝きはデザインや書体を変えても残り、標準デザインには動きを混ぜない', () => {
  const draft = applyMotionDesign({ ...newDraft(), fx: 'xml_sparkle_burst' });
  const changed = selectFont(selectDesign(draft, 'ending_thanks'), FONT_CHOICES.noto_bold);
  assert.equal(designStyle(changed).sparkle, 'burst');
  for (const aspect of ['portrait', 'landscape']) changed.overrides[aspect].xml_sparkle_burst = { sparkle: 'cascade', size: 128, in: 'drop' };
  const plain = selectDesign(changed, 'classic');
  assert.equal(designStyle(plain).sparkle, 'cascade'); assert.equal(designStyle(plain).in, 'drop');
  const preferred = captureDesignDefault(plain);
  for (const aspect of ['portrait', 'landscape']) {
    assert.equal(Object.hasOwn(preferred.overrides[aspect], 'sparkle'), false);
    assert.equal(Object.hasOwn(preferred.overrides[aspect], 'in'), false);
  }
  const otherMotion = { ...newDraft(), fx: 'xml_sparkle_sweep' };
  const applied = applyDesignDefault(otherMotion, { xml_sparkle_sweep: preferred });
  assert.equal(designStyle(applied).sparkle, 'sweep');
  const ordinary = applyDesignDefault(newDraft(), { xml_pop: preferred });
  assert.equal(designStyle(ordinary).sparkle, undefined);
  assert.ok(Object.values(DESIGN_VARIANTS).every(variant => !Object.hasOwn(variant.style, 'sparkle')));
  assert.throws(() => validateDefaults({ kind: 'effects-lab-design-defaults', version: 1,
    defaults: { xml_sparkle_sweep: { ...preferred, overrides: { landscape: { sparkle: 'burst' } } } } }, names));
});

test('推奨デザインの初回履歴と豪華演出は保存復元でき、既存演出の選択動作を変えない', () => {
  const draft = applyMotionDesign({ ...newDraft(), fx: 'xml_sparkle_cascade' });
  assert.deepEqual(validateDraft(JSON.parse(JSON.stringify(draft)), names), draft);
  const restored = validateDraft(JSON.parse(JSON.stringify(draft)), names);
  assert.equal(applyMotionDesign(selectDesign(restored, 'ruby')).design, 'ruby');
  for (const fx of ['xml_pop', 'xml_reaction', 'xml_heading', 'xml_bounce', 'xml_drop', 'xml_float', 'xml_zoom', 'xml_rise']) {
    const original = { ...newDraft(), fx, design: 'violet' };
    assert.equal(applyMotionDesign(original), original);
    assert.equal(applyMotionDesign(original, { [fx]: captureDesignDefault(selectDesign(original, 'pearl')) }).design, 'pearl');
  }
  for (const recommendedMotions of ['xml_sparkle_sweep', ['xml_pop'], ['unknown'], ['xml_sparkle_sweep', 'xml_sparkle_sweep']]) {
    assert.throws(() => validateDraft({ ...newDraft(), recommendedMotions }, names));
  }
  for (const sparkle of ['none', 'sweep', 'burst', 'cascade']) assert.equal(validateStyle({ sparkle }, names).sparkle, sparkle);
  for (const sparkle of ['unknown', true, 1]) assert.throws(() => validateStyle({ sparkle }, names));
});
