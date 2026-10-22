import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FX } from '../telop-studio/js/timeline.js';
import { SAMPLES, newDraft, validateDraft, validateStyle, sceneFor, STORAGE_KEY } from '../admin/effects-lab/model.mjs';
import { nativeStyles } from '../admin/effects-lab/native-presets.mjs';

const raw = JSON.parse(await readFile(new URL('../telop-studio/styles.json', import.meta.url)));
const names = [...Object.keys(raw).filter(key => !key.startsWith('_')), ...Object.keys(nativeStyles('portrait'))];

test('全演出・全デザインセット・縦横を本体の時刻とスタイルで試せる', () => {
  for (const aspect of ['portrait', 'landscape']) for (const set of ['standard', 'entertainment', 'business']) for (const fx of Object.keys(FX)) {
    const draft = { ...newDraft(), aspect, set, fx, text: SAMPLES[fx] };
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
