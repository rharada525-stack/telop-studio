import test from 'node:test';
import assert from 'node:assert/strict';
import { SPARKLE_FPS, SPARKLE_TYPES, isSparkleType, getSparkleClips, sampleSparkleAt } from '../admin/effects-lab/sparkles.mjs';

const base = { style: { sparkle: 'sweep', pos: [960, 900], size: 110 }, bounds: { width: 1200, height: 140 }, t: .5, d: 3, W: 1920, H: 1080 };
const radiusOf = clip => (clip.style.size * Math.SQRT1_2 + Math.max(...clip.style.strokes.map(stroke => stroke.w)))
  * Math.max(...clip.motion.map(sample => sample.scale)) / 100;

test('5つのキラキラは再現可能で、開始順・移動・形の構成が異なる', () => {
  const signatures = [];
  for (const type of SPARKLE_TYPES) {
    assert.equal(isSparkleType(type), true);
    const input = structuredClone({ ...base, style: { ...base.style, sparkle: type } }), before = structuredClone(input);
    const clips = getSparkleClips(input);
    assert.deepEqual(clips, getSparkleClips(input)); assert.deepEqual(input, before);
    assert.equal(clips.length, { sweep: 10, burst: 12, cascade: 12, celebration: 24, twinkle: 24 }[type]);
    assert.equal(new Set(clips.map(clip => clip.id)).size, clips.length);
    assert.ok(clips.every(clip => clip.fontName === 'SegoeUISymbol' && ['✦', '✧'].includes(clip.text)));
    assert.ok(clips.every(clip => clip.style.family === 'Segoe UI Symbol' && clip.style.weight === 400));
    assert.ok(clips.some(clip => clip.text === '✧'));
    assert.ok(clips.every(clip => clip.startFrame >= Math.round(base.t * 30) + 6));
    signatures.push(JSON.stringify(clips.map(clip => [clip.startFrame, clip.motion.at(-1).center, clip.motion.at(-1).rotation])));
  }
  assert.equal(new Set(signatures).size, 5);
});

test('祝祭は12個ずつの星が2回弾け、従来のburstより大きい大小の輝きを持つ', () => {
  const clips = getSparkleClips({ ...base, style: { ...base.style, sparkle: 'celebration' } });
  assert.equal(clips.length, 24);
  const firstWave = clips.slice(0, 12), secondWave = clips.slice(12);
  assert.ok(Math.max(...firstWave.map(clip => clip.endFrame)) <= Math.min(...secondWave.map(clip => clip.startFrame)), '2つの山の間に間を作る');
  for (const wave of [firstWave, secondWave]) {
    const sizes = wave.map(clip => clip.style.size);
    assert.ok(Math.max(...sizes) >= Math.min(...sizes) * 1.5, '大きな星と小さな星を組み合わせる');
  }
  const peakSize = clips => Math.max(...clips.map(clip => clip.style.size * Math.max(...clip.motion.map(sample => sample.scale)) / 100));
  const original = getSparkleClips({ ...base, style: { ...base.style, sparkle: 'burst' } });
  assert.ok(peakSize(clips) > peakSize(original) * 1.3);
});

test('宝石風は周囲を3巡して星が二度輝き、長い区間でも24クリップ以内に収める', () => {
  const clips = getSparkleClips({ ...base, style: { ...base.style, sparkle: 'twinkle' } });
  assert.equal(clips.length, 24);
  for (const clip of clips) {
    const peaks = clip.motion.filter((sample, i, motion) => i > 0 && i < motion.length - 1
      && sample.opacity > motion[i - 1].opacity && sample.opacity > motion[i + 1].opacity);
    assert.equal(peaks.length, 2, `${clip.id}は二度輝く`);
    assert.ok(peaks.every(peak => peak.opacity > 50));
  }
  for (let cycle = 1; cycle < 3; cycle++) {
    assert.ok(clips[cycle * 8].startFrame > clips[(cycle - 1) * 8 + 7].startFrame, '8個ごとの巡回が時間順に続く');
  }
  for (const sparkle of ['celebration', 'twinkle']) assert.equal(getSparkleClips({ ...base, d: 60, style: { ...base.style, sparkle } }).length, 24);
});

test('本文の周縁を飾り、中心の文章には星を重ねない', () => {
  for (const type of SPARKLE_TYPES) {
    const clips = getSparkleClips({ ...base, style: { ...base.style, sparkle: type } });
    for (const clip of clips) for (const sample of clip.motion) {
      const outsideText = Math.abs(sample.center.x - 960) > base.bounds.width / 2 || Math.abs(sample.center.y - 900) > base.bounds.height / 2;
      assert.ok(outsideText, `${type} ${clip.id} 本文の外側に配置する`);
    }
  }
});

test('横長の下配置で安全枠に押された大きな星も、フチ込みの字面を本文へ重ねない', () => {
  for (const type of SPARKLE_TYPES) for (const width of [700, 1200, 1580]) {
    const input = { ...base, style: { sparkle: type, pos: [960, 900], size: 140 }, bounds: { width, height: 140 } };
    const clips = getSparkleClips(input);
    assert.ok(clips.length >= 8, '配置を移すことで星の数を保つ');
    for (const clip of clips) {
      const radius = radiusOf(clip);
      for (const sample of clip.motion) {
        const { x, y } = sample.center;
        const intersects = x + radius > 960 - width / 2 && x - radius < 960 + width / 2
          && y + radius > 830 && y - radius < 970;
        assert.equal(intersects, false, `${type}/${width}/${clip.id}/${sample.frame}の星全体を本文外に置く`);
        assert.ok(x - radius >= 96 - 1e-6 && x + radius <= 1824 + 1e-6);
        assert.ok(y - radius >= 54 - 1e-6 && y + radius <= 1026 + 1e-6);
      }
    }
    assert.ok(clips.some(clip => clip.motion.every(sample => sample.center.y < 830)), '上側の余白を利用する');
  }
});

test('本文が安全枠を埋める場合は文字を覆う星を生成しない', () => {
  for (const type of SPARKLE_TYPES) assert.deepEqual(getSparkleClips({
    ...base, style: { ...base.style, sparkle: type, pos: [960, 540] }, bounds: { width: 1920, height: 1080 },
  }), []);
});

test('横長下配置・縦長・端にある本文でも回転と多重フチが5%の安全枠に収まる', () => {
  for (const [W, H] of [[1920, 1080], [1080, 1920], [640, 360], [1280, 720], [24, 24]]) {
    for (const pos of [[W / 2, H * .84], [0, 0], [W, H]]) for (const type of SPARKLE_TYPES) {
      const clips = getSparkleClips({ ...base, W, H, style: { sparkle: type, pos, size: 400 }, bounds: { width: W * 1.2, height: H * .2 } });
      for (const clip of clips) {
        assert.ok(clip.style.size >= 1 && clip.style.size <= 68);
        const radius = radiusOf(clip);
        for (const sample of clip.motion) {
          assert.ok(sample.center.x - radius >= W * .05 - 1e-6);
          assert.ok(sample.center.x + radius <= W * .95 + 1e-6);
          assert.ok(sample.center.y - radius >= H * .05 - 1e-6);
          assert.ok(sample.center.y + radius <= H * .95 + 1e-6);
          assert.ok(sample.scale >= 0 && sample.scale <= 152);
          assert.ok(sample.opacity >= 0 && sample.opacity <= 100);
          assert.ok(Number.isFinite(sample.rotation));
        }
      }
    }
  }
});

test('1frameや端数の区間でも本文から出ず、見えない空クリップを作らない', () => {
  for (const t of [0, .017, .1, .499, 37.237]) for (const d of [0, .001, 1 / 30, 2 / 30, .1, .24, .333, 3]) {
    for (const type of SPARKLE_TYPES) {
      const clips = getSparkleClips({ ...base, t, d, style: { ...base.style, sparkle: type } });
      const parentStart = Math.round(t * 30), parentEnd = Math.round((t + d) * 30);
      if (parentStart === parentEnd) { assert.deepEqual(clips, []); continue; }
      for (const clip of clips) {
        assert.ok(clip.startFrame >= parentStart && clip.endFrame <= parentEnd);
        assert.ok(clip.endFrame > clip.startFrame);
        assert.equal(Math.round(clip.t * 30), clip.startFrame);
        assert.equal(Math.round((clip.t + clip.d) * 30), clip.endFrame);
        assert.equal(clip.motion.length, clip.endFrame - clip.startFrame + 1);
        assert.equal(clip.motion.at(-1).opacity, 0);
        assert.ok(clip.motion.slice(0, -1).some(sample => sample.opacity > 0 && sample.scale > 0));
        clip.motion.forEach((sample, i) => assert.equal(sample.frame, i));
      }
    }
  }
});

test('同じ30fpsサンプルを正再生・逆シーク・ループで参照し、終端では消す', () => {
  const clip = getSparkleClips(base)[3], first = clip.startFrame, last = clip.endFrame;
  const at = frame => sampleSparkleAt(clip, frame / SPARKLE_FPS);
  const forward = Array.from({ length: last - first }, (_, i) => at(first + i));
  const reverse = Array.from({ length: last - first }, (_, i) => at(last - 1 - i)).reverse();
  assert.deepEqual(forward, reverse); assert.deepEqual(forward[0], at(first));
  assert.deepEqual(forward, clip.motion.slice(0, -1));
  assert.equal(at(first - 1), null); assert.equal(at(last), null);
  assert.equal(sampleSparkleAt(clip, NaN), null);
  assert.deepEqual(sampleSparkleAt(clip, first / 30 + .5 / 30), forward[0]);
});

test('装飾なしは空配列、未知タイプや不正な描画範囲はエラーにする', () => {
  for (const sparkle of [undefined, null, '', 'none']) assert.deepEqual(getSparkleClips({ style: { sparkle } }), []);
  for (const sparkle of [false, 0, true, {}, 'unknown']) {
    assert.equal(isSparkleType(sparkle), false);
    assert.throws(() => getSparkleClips({ ...base, style: { ...base.style, sparkle } }));
  }
  for (const change of [{ t: -1 }, { d: -1 }, { d: NaN }, { t: 3600 }, { W: 0 }, { H: 8193 }, { bounds: null }, { bounds: { width: NaN, height: 100 } }]) {
    assert.throws(() => getSparkleClips({ ...base, ...change }));
  }
  assert.deepEqual(getSparkleClips({ ...base, W: 1, H: 1 }), [], '飾りを置く余白がない画面では生成しない');
});
