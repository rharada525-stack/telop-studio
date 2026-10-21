import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditHistory, resetSubtitles } from '../telop-studio/js/edit-history.js';

test('複数段階の取り消し・やり直しと、取り消し後の別編集', () => {
  const h = createEditHistory();
  h.reset({ text: '元の字幕' });
  h.commit({ text: '修正1' });
  h.commit({ text: '修正2' });
  assert.equal(h.undo().text, '修正1');
  assert.equal(h.undo().text, '元の字幕');
  assert.equal(h.canUndo, false);
  assert.equal(h.redo().text, '修正1');
  h.commit({ text: '別の修正' });
  assert.equal(h.canRedo, false);
  assert.equal(h.undo().text, '修正1');
});

test('同じ入力欄の連続入力をまとめ、欄を離れた後は別の編集にする', () => {
  const h = createEditHistory();
  h.reset('');
  h.commit('こ', 'field1');
  h.commit('こん', 'field1');
  h.commit('こんにちは', 'field1');
  h.endGroup();
  h.commit('こんにちは！', 'field1');
  assert.equal(h.undo(), 'こんにちは');
  assert.equal(h.undo(), '');
  assert.equal(h.canUndo, false);
});

test('入力欄自身の取り消しで元に戻っても、次の入力を取り消せる', () => {
  const h = createEditHistory();
  h.reset('元');
  h.commit('元ABC', 'field');
  h.commit('元', 'field');
  assert.equal(h.canUndo, false);
  h.commit('元DEF', 'field');
  assert.equal(h.undo(), '元');
});

test('履歴はコピーを保持し、上限を超えた古いものを破棄し、別セーブではリセットする', () => {
  const h = createEditHistory(2);
  const initial = { text: '0' };
  h.reset(initial);
  initial.text = '外から変更';
  h.commit({ text: '1' }); h.commit({ text: '2' }); h.commit({ text: '3' });
  const result = h.undo();
  result.text = '外から変更';
  assert.equal(h.redo().text, '3');
  assert.equal(h.undo().text, '2');
  assert.equal(h.undo().text, '1');
  assert.equal(h.canUndo, false);
  h.reset({ text: '別セーブ' });
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
});

test('全字幕の初期化は文章・時間・話者・追加した行と字幕以外の設定を残し、1操作で戻せる', () => {
  const before = {
    words: [[1, 2, '直した'], [2, 3, '文章']],
    lines: [
      { id: 'a', src: [1, 3], text: '直した{文章}', speaker: 'A', cut: true, fx: 'hook', fxText: '別の演出', fxPos: 'tr', screen: 'zoom' },
      { id: 'added', src: [4, 5], text: '追加した字幕', speaker: 'B', fx: 'point', screen: 'dark' },
    ],
    settings: { speakers: [{ id: 'A', name: '司会', design: { family: 'custom' } }, { id: 'B', name: 'ゲスト', design: { family: 'another' } }],
      designSet: 'business', fxMap: { point: 'corner_label' }, autoHighlight: false,
      aspect: 'landscape', title: 'タイトル帯', gap: 0.5, audio: { voice: 80, sfx: 30 } },
    autoEdit: { mode: 'long', strength: 'low' },
  };
  const initial = structuredClone(before);
  const design = { family: 'default', strokes: [] };
  const reset = resetSubtitles(before, design);
  assert.deepEqual(reset.lines.map(l => [l.id, l.text, l.src, l.speaker]), before.lines.map(l => [l.id, l.text, l.src, l.speaker]));
  assert.deepEqual(reset.words, before.words);
  assert.ok(reset.lines.every(l => !l.cut && !l.fx && !l.fxText && l.fxPos === 'auto' && l.screen === 'auto'));
  assert.deepEqual(reset.settings.speakers.map(s => s.design), [design, design]);
  assert.equal(reset.settings.designSet, 'standard');
  assert.deepEqual(reset.settings.fxMap, {});
  for (const key of ['title', 'gap', 'audio', 'aspect']) assert.deepEqual(reset.settings[key], before.settings[key]);
  assert.deepEqual(before, initial);
  const h = createEditHistory(); h.reset(before); h.commit(reset);
  assert.deepEqual(h.undo(), before);
  assert.deepEqual(h.redo(), reset);
});
