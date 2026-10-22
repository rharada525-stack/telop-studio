import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedPaint, makeTextData } from '../admin/effects-lab/source-text.mjs';

// Source Textの読み手としてnative-readerと同じフィールドを解釈する。
// 既存スタイルのバイナリや配色はテスト素材にも含めない。
function decode(data) {
  const b = Buffer.from(data);
  assert.equal(b.readUInt32LE(0), b.length - 12);
  assert.equal(b.readUInt32LE(8), 0x11223344);
  const ref = p => p + b.readUInt32LE(p);
  const table = p => {
    const vt = p - b.readInt32LE(p), n = (b.readUInt16LE(vt) - 4) / 2;
    return Object.fromEntries(Array.from({ length: n }, (_, k) => [k, b.readUInt16LE(vt + 4 + k * 2)])
      .filter(([, offset]) => offset).map(([k, offset]) => [k, p + offset]));
  };
  const vector = p => Array.from({ length: b.readUInt32LE(p) }, (_, i) => ref(p + 4 + i * 4));
  const string = p => b.toString('utf8', p + 4, p + 4 + b.readUInt32LE(p));
  const int = (f, k, fallback = 0) => f[k] === undefined ? fallback : b.readUInt32LE(f[k]);
  const float = (f, k, fallback) => f[k] === undefined ? fallback : b.readFloatLE(f[k]);
  const color = p => {
    const f = table(p);
    return '#' + [0, 1, 2].map(k => int(f, k, 255).toString(16).padStart(2, '0')).join('');
  };
  const gradient = (f, modeKey, dataKey) => {
    if (int(f, modeKey) !== 1) return null;
    const g = table(ref(f[dataKey]));
    return {
      angle: float(g, 0, 90),
      stops: vector(ref(g[1])).map(p => { const s = table(p); return { color: color(ref(s[0])), position: float(s, 1, 0), midpoint: float(s, 2, .5) }; }),
      opacity: vector(ref(g[2])).map(p => { const s = table(p); return { value: float(s, 0, 1), position: float(s, 1, 0), midpoint: float(s, 2, .5) }; }),
    };
  };
  const root = table(ref(12)), paragraph = table(ref(root[0]));
  const runs = vector(ref(paragraph[0])).map(p => {
    const run = table(p), c = table(ref(run[1]));
    const strokes = [];
    if (int(c, 5)) strokes.push({ width: float(c, 6, 4), color: color(ref(c[4])), alignment: int(c, 24), gradient: gradient(c, 22, 23) });
    for (const p of vector(ref(c[17]))) {
      const s = table(p);
      if (int(s, 1)) strokes.push({ width: float(s, 2, 4), color: color(ref(s[0])), alignment: int(s, 5), gradient: gradient(s, 3, 4) });
    }
    return { text: string(ref(run[0])), size: float(c, 1, 100), color: color(ref(c[2])), gradient: gradient(c, 20, 21), strokes };
  });
  return { runs, fonts: vector(ref(paragraph[1])).map(string), align: int(paragraph, 4), multiStroke: int(paragraph, 26) };
}

const style = { size: 110, fill: '#ffffff', strokes: [{ w: 7, color: '#182a3c' }, { w: 12, color: '#ffffff' }, { w: 15, color: '#182a3c' }] };

test('縦グラデーションの2〜8色を等間隔・不透明なネイティブの塗りとして保存する', () => {
  const palette = ['#102030', '#2468ab', '#f1e2d3', '#abc123', '#456789', '#fedcba', '#123abc', '#d4e5f6'];
  for (let n = 2; n <= 8; n++) {
    const stops = palette.slice(0, n), fill = { stops, angle: 0 }, input = { ...style, fill };
    const before = JSON.stringify(input), result = decode(makeTextData('編集できる文字 😀', input, 'NotoSansJP-Black'));
    assert.equal(JSON.stringify(input), before, '保存元のデザインを書き換えない');
    assert.equal(result.runs.length, 1, '文字を画像や複数レイヤーへ分解しない');
    assert.equal(result.runs[0].text, '編集できる文字 😀');
    assert.deepEqual(result.fonts, ['NotoSansJP-Black']);
    assert.equal(result.align, 2); assert.equal(result.multiStroke, 1);
    const g = result.runs[0].gradient;
    assert.equal(g.angle, 90, 'ブラウザの上→下をPremiereの90度へ変換する');
    assert.deepEqual(g.stops.map(s => s.color), stops);
    g.stops.forEach((s, i) => { assert.ok(Math.abs(s.position - i / (n - 1)) < 1e-7); assert.equal(s.midpoint, .5); });
    assert.deepEqual(g.opacity, [{ value: 1, position: 0, midpoint: .5 }, { value: 1, position: 1, midpoint: .5 }]);
    assert.deepEqual(result.runs[0].strokes.map(s => [s.width, s.color, s.alignment, s.gradient]), style.strokes.map(s => [s.w, s.color, 2, null]));
  }
});

test('最初と追加のフチのグラデーションを別々に保持し、文字とフォントは編集可能なままにする', () => {
  const gradient = { stops: ['#123456', '#abcdef', '#654321'] };
  const input = { ...style, strokes: [{ w: 6, color: gradient }, { w: 10, color: '#ffffff' }, { w: 14, color: gradient }] };
  const result = decode(makeTextData('フチの確認', input, 'YuGothic-Bold'));
  assert.deepEqual(result.fonts, ['YuGothic-Bold']);
  assert.equal(result.runs[0].gradient, null);
  assert.equal(result.runs[0].text, 'フチの確認');
  for (const i of [0, 2]) {
    const stroke = result.runs[0].strokes[i];
    assert.equal(stroke.alignment, 2);
    assert.deepEqual(stroke.gradient.stops.map(s => s.color), gradient.stops);
    assert.equal(stroke.gradient.angle, 90);
  }
  assert.equal(result.runs[0].strokes[1].gradient, null);
});

test('フチなしのグラデーションも単独の文字として表現できる', () => {
  const result = decode(makeTextData('塗りだけ', { size: 96, fill: { stops: ['#AaBbCc', '#123456'], angle: 0 }, strokes: [] }));
  assert.deepEqual(result.runs[0].strokes, []);
  assert.deepEqual(result.runs[0].gradient.stops.map(s => s.color), ['#aabbcc', '#123456']);
  assert.equal(result.runs[0].size, 96);
});

test('未対応の角度・透明度・色形式を無言で単色に変換しない', () => {
  const valid = { stops: ['#ffffff', '#000000'], angle: 0 };
  for (const paint of ['#fff', '#ffffffff', 'red', null, [], ['#ffffff', '#000000'],
    { stops: ['#ffffff'] }, { stops: Array(9).fill('#ffffff') }, { stops: ['#ffffff', 'red'] },
    { ...valid, angle: 90 }, { ...valid, angle: NaN }, { ...valid, angle: '0' },
    { ...valid, opacity: .5 }, { ...valid, type: 'radial' }]) {
    assert.equal(isSupportedPaint(paint), false);
    assert.throws(() => makeTextData('確認', { ...style, fill: paint }), /XMLの色/);
    assert.throws(() => makeTextData('確認', { ...style, strokes: [{ w: 2, color: paint }] }), /XMLの色/);
  }
  assert.equal(isSupportedPaint('#AbCdEf'), true);
  assert.equal(isSupportedPaint(valid), true);
  assert.equal(isSupportedPaint({ stops: valid.stops }), true);
});
