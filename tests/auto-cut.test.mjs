import test from 'node:test';
import assert from 'node:assert/strict';
import { CUT_PRESETS, detectSpeech, normalizeWords, buildLinesFromWords, retakeHints } from '../telop-studio/js/timeline.js';

// 20ms ごとの音量。voiced の区間だけ -20dB、ほかは -70dB
const levelsOf = (sec, voiced) => {
  const n = Math.round(sec / 0.02), rms = new Float32Array(n).fill(-70), peak = new Float32Array(n).fill(-60);
  for (const [s, e] of voiced) for (let i = Math.round(s / 0.02); i < Math.round(e / 0.02); i++) { rms[i] = -20; peak[i] = -10; }
  return { rms, peak };
};

test('短い間はカットせず、長い無言だけを前後に余白を残してカットする', () => {
  const keep = detectSpeech(levelsOf(6, [[0.5, 1.5], [1.9, 2.5], [4, 5]]), CUT_PRESETS.solo);
  assert.equal(keep.length, 2); // 0.4秒の間はつながる
  assert.ok(Math.abs(keep[0].end - 2.65) < 0.03); // 話し終わり + 0.15秒
  assert.ok(Math.abs(keep[1].start - 3.9) < 0.03); // 話し始め - 0.1秒
});

test('小さな声でも文字起こしの言葉がある所はカットしない', () => {
  const keep = detectSpeech(levelsOf(6, [[0.5, 1.5], [4, 5]]), CUT_PRESETS.solo, [[2.0, 2.6, 'えっと']]);
  assert.ok(keep.some((k) => k.start <= 2.0 && k.end >= 2.6));
});

test('1語ごとの時刻から字幕を文の切れ目で作る', () => {
  const words = normalizeWords([{ text: ' 今日は', timestamp: [0, 0.4] }, { text: 'よろしく', timestamp: [0.4, 0.8] },
    { text: 'お願いします。', timestamp: [0.8, 1.5] }, { text: '早速', timestamp: [2.5, 2.8] }, { text: 'です。', timestamp: [2.8, 3.2] }], 4);
  const lines = buildLinesFromWords(words);
  assert.deepEqual(lines.map((l) => l.text), ['今日はよろしくお願いします', '早速です']);
  assert.deepEqual(lines[1].src, [2.5, 3.2]);
});

test('言い直しは前の方を候補として知らせる', () => {
  let t = 0;
  const words = ['今日は', 'みなさんに', 'お伝え', 'したい', '|', '今日は', 'みなさんに', 'お伝えしたい', 'ことが', 'あります。']
    .map((x) => { const w = [t, t + 0.4, x]; t += x === '|' ? 1.2 : 0.4; return w; }).filter((w) => w[2] !== '|');
  const [h] = retakeHints(words);
  assert.equal(h.type, 'retake');
  assert.equal(h.text, '今日はみなさんにお伝えしたい');
  assert.equal(h.start, 0);
});
