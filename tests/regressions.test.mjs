import test from 'node:test';
import assert from 'node:assert/strict';
import { autoEdit } from '../telop-studio/js/autoedit.js';
import { buildItems, buildSegments, toSrt } from '../telop-studio/js/timeline.js';

const linesOf = (texts) => texts.map((text, i) => ({
  id: String(i), text, src: [i, i + 1], fx: '', fxText: '', cut: false,
}));

test('会話のつなぎ言葉に続く2つ目も見出しにし、本文は保持する', () => {
  const texts = ['どうもこんにちは', 'まず1つ目', '氷は先に揺らしておく',
    'えっと2つ目は蓋を開けるのは飲む直前にすること', 'ぜひ試してみてください'];
  const lines = linesOf(texts);
  const n = autoEdit(lines, { mode: 'long' });
  assert.equal(n.point, 2);
  assert.equal(n.cta, 1);
  assert.match(lines[1].fxText, /^その1\/氷は先に/);
  assert.match(lines[3].fxText, /^その2\/蓋を開ける/);
  assert.deepEqual(lines.map(l => l.text), texts);
});

test('ショートの先頭の見出しをつかみで上書きしない', () => {
  const lines = linesOf(['えーと、まず１つ目は氷', 'あの、二つ目は蓋', 'うーんと、次に香り']);
  const n = autoEdit(lines, { mode: 'short' });
  assert.equal(n.hook, 0);
  assert.equal(n.point, 3);
  assert.deepEqual(lines.map(l => l.fxText), ['その1/氷', 'その2/蓋', 'その3/香り']);
});

test('普通の発話を見出しにせず、手動の演出とカット済み行を保つ', () => {
  const lines = linesOf(['えっと今日はコーヒーを飲みます', 'えっと2つ目は蓋', 'まず1つ目は氷']);
  lines[1].fx = 'quote';
  lines[1].fxText = '手動の問いかけ';
  lines[2].cut = true;
  const before = structuredClone(lines);
  const n = autoEdit(lines, { mode: 'long' });
  assert.equal(n.point, 0);
  assert.deepEqual(lines, before);
});

test('SRTは締め・置き換え・別文の演出を含めて発話を1回ずつ出し、カット時刻を反映する', () => {
  const lines = [
    { id: 'a', text: 'どうも{こんにちは}', src: [0, 1], fx: 'hook' },
    { id: 'cut', text: 'えーと', src: [1, 3], cut: true },
    { id: 'b', text: 'まず1つ目', src: [3, 4], fx: 'point', fxText: 'その1/氷は先に' },
    { id: 'c', text: 'ぜひ[試して]みてください', src: [4, 6], fx: 'cta_main', fxText: '' },
  ];
  const segs = buildSegments([{ start: 0, end: 6 }], lines);
  const srt = toSrt(lines, segs);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\nどうもこんにちは\n\n' +
    '2\n00:00:01,000 --> 00:00:02,000\nまず1つ目\n\n' +
    '3\n00:00:02,000 --> 00:00:04,000\nぜひ試してみてください\n');
  // 見た目が変わっても、発話の時刻は描画と一致する。
  for (const fxMap of [{}, { cta_main: 'biz_emph', point: 'corner_label' }]) {
    const items = buildItems(lines, segs, { title: 'タイトル帯', fxMap });
    const closing = items.find(it => it.line === 'c');
    assert.equal(closing.t, 2);
    assert.equal(closing.d, 2);
    assert.ok(!items.some(it => it.line === 'cut'));
  }
});

test('末尾の短い字幕を動画の終端に収め、全カットでも空SRTになる', () => {
  const lines = [{ id: 'last', text: '最後の一言', src: [1.8, 2], fx: 'cta_main' }];
  const segs = [{ start: 0, end: 2, out: 0 }];
  assert.equal(toSrt(lines, segs), '1\n00:00:01,800 --> 00:00:02,000\n最後の一言\n');
  assert.equal(toSrt(lines.map(l => ({ ...l, cut: true })), []), '');
});
