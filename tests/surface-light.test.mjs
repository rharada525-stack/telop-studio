import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTextXml, motionSamples, xmlStyleWarnings } from '../admin/effects-lab/text-xml.mjs';
import { nativeStyles } from '../admin/effects-lab/native-presets.mjs';
import { getSurfaceLightSamples, sampleSurfaceLightAt, surfaceCropSamples, SURFACE_LIGHT_TYPES } from '../admin/effects-lab/surface-light.mjs';

const base = nativeStyles('landscape').xml_pop;
const options = (surfaceLight = 'sweep', changes = {}) => ({ style: { ...base, surfaceLight }, bounds: { width: 720, height: 150 }, t: .5, d: 3, W: 1920, H: 1080, ...changes });
const near = (actual, expected, epsilon = 1e-5) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);

// Nested sequence/clipitemを正規表現の最初の閉じタグで切らず、親子関係ごと検証する。
function xmlTree(xml) {
  const root = { tag: '', children: [], text: '' }, stack = [root];
  for (const token of xml.matchAll(/<([^>]+)>|([^<]+)/g)) {
    if (token[2]) { stack.at(-1).text += token[2]; continue; }
    const tag = token[1];
    if (/^[?!]/.test(tag)) continue;
    if (tag.startsWith('/')) { assert.equal(stack.pop().tag, tag.slice(1).trim()); continue; }
    const node = { tag: tag.match(/^[\w-]+/)[0], id: tag.match(/\bid="([^"]+)"/)?.[1], children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!tag.endsWith('/')) stack.push(node);
  }
  assert.equal(stack.length, 1);
  return root.children[0];
}
const child = (node, tag) => node.children.find(item => item.tag === tag);
const value = (node, tag) => child(node, tag)?.text;
const all = (node, tag) => [...(node.tag === tag ? [node] : []), ...node.children.flatMap(item => all(item, tag))];
const byId = (node, id) => all(node, 'clipitem').find(item => item.id === id);
const video = node => child(child(node, 'media'), 'video');
const filters = clip => clip.children.filter(item => item.tag === 'filter').map(item => child(item, 'effect'));
const parameter = (clip, id) => filters(clip).flatMap(item => item.children.filter(node => node.tag === 'parameter')).find(item => value(item, 'parameterid') === id);
const keys = param => param.children.filter(item => item.tag === 'keyframe').map(item => [Number(value(item, 'when')), Number(value(item, 'value'))]);
const sourceBytes = node => all(node, 'parameter').filter(item => value(item, 'name') === 'Source Text').map(item => Buffer.from(value(item, 'value'), 'base64'));

test('1回/2回の光が本文全幅を横切り、開始前・終了後・再シークで同じ表示になる', () => {
  for (const type of SURFACE_LIGHT_TYPES) {
    const input = options(type), before = JSON.stringify(input), light = getSurfaceLightSamples(input);
    assert.equal(light.startFrame, 15); assert.equal(light.endFrame, 105);
    assert.equal(light.samples.length, 91);
    let passes = 0;
    light.samples.forEach((sample, i) => {
      assert.equal(sample.frame, i + 15);
      near(sample.right - sample.left, light.bandWidth);
      assert.ok(sample.opacity >= 0 && sample.opacity <= 1);
      if (i && sample.opacity && light.samples[i - 1].opacity && sample.left + sample.right >= 0 && light.samples[i - 1].left + light.samples[i - 1].right < 0) passes++;
      assert.deepEqual(sampleSurfaceLightAt(light, sample.frame / 30), i < 90 ? sample : null);
    });
    assert.equal(passes, type === 'sweep' ? 1 : 2);
    assert.equal(light.samples[0].opacity, 0); assert.equal(light.samples.at(-1).opacity, 0);
    assert.equal(sampleSurfaceLightAt(light, 14 / 30), null); assert.equal(sampleSurfaceLightAt(light, 3.6), null);
    const middle = sampleSurfaceLightAt(light, 1.2);
    sampleSurfaceLightAt(light, 3); sampleSurfaceLightAt(light, .5);
    assert.deepEqual(sampleSurfaceLightAt(light, 1.2), middle);
    assert.deepEqual(getSurfaceLightSamples(input), light);
    assert.equal(JSON.stringify(input), before);
  }
});

test('短い本文と縦長でも光を本文の時間内に保ち、Cropは拡大せず0〜100%を使う', () => {
  for (const type of SURFACE_LIGHT_TYPES) for (const frames of [1, 2, 3, 7, 30, 90, 300]) for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
    const light = getSurfaceLightSamples(options(type, { t: .2, d: frames / 30, W, H, bounds: { width: W - 10, height: 150 } }));
    assert.equal(light.samples.length, frames + 1);
    const crop = surfaceCropSamples(light, W);
    assert.equal(crop[0].frame, 0); assert.equal(crop.at(-1).frame, frames);
    for (const sample of crop) for (const key of ['leftcrop', 'rightcrop', 'opacity']) assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0 && sample[key] <= 100);
    assert.equal(crop[0].opacity, 0); assert.equal(crop.at(-1).opacity, 0);
  }
  const narrow = getSurfaceLightSamples(options('sweep', { bounds: { width: 100, height: 150 } }));
  const wide = getSurfaceLightSamples(options('sweep', { bounds: { width: 1400, height: 150 } }));
  assert.ok(narrow.bandWidth < wide.bandWidth);
});

test('無効な演出・時間・本文サイズを曖昧な値に補正しない', () => {
  for (const surfaceLight of [undefined, '', 'none']) assert.equal(getSurfaceLightSamples({ style: { surfaceLight } }), null);
  for (const change of [{ style: { ...base, surfaceLight: 'bad' } }, { bounds: undefined }, { bounds: { width: NaN, height: 100 } }, { bounds: { width: 9000, height: 100 } }, { t: -1 }, { d: .001 }, { d: Infinity }, { W: 0 }]) {
    assert.throws(() => getSurfaceLightSamples({ ...options(), ...change }));
  }
  assert.equal(sampleSurfaceLightAt(null, 0), null);
});

test('XMLは編集可能な本文1個を共有し、原色/光沢へ同じsequenceを参照する', () => {
  const input = options('double'), item = { text: '輝く & 明日へ', t: input.t, d: input.d, style: input.style, bounds: input.bounds, fontName: 'NotoSansJP-Black' };
  const before = JSON.stringify(item);
  const xml = buildTextXml({ items: [item] }), root = xmlTree(xml), main = child(root, 'sequence');
  const mainTrack = child(video(main), 'track');
  assert.equal(mainTrack.children.filter(item => item.tag === 'clipitem').length, 1);
  const mainClip = byId(root, 'surface-main-1');
  assert.equal(value(mainClip, 'start'), '15'); assert.equal(value(mainClip, 'end'), '105');
  const baseClip = byId(root, 'surface-base-1'), shine = byId(root, 'surface-shine-1');
  assert.equal(value(shine, 'compositemode'), 'screen');
  const definition = child(baseClip, 'sequence'), reference = child(shine, 'sequence');
  assert.equal(definition.id, 'surface-text-1'); assert.equal(reference.id, definition.id);
  assert.ok(child(definition, 'media')); assert.equal(reference.children.length, 0);
  const source = byId(root, 'graphic-surface-body-1');
  assert.equal(value(source, 'start'), '0'); assert.equal(value(source, 'end'), '90');
  const encoded = sourceBytes(root);
  assert.equal(encoded.length, 1);
  assert.ok(encoded[0].includes(Buffer.from('輝く & 明日へ'))); assert.ok(encoded[0].includes(Buffer.from('NotoSansJP-Black')));
  assert.doesNotMatch(xml, /<pathurl>|\.png|\.mp4|\.mogrt/);
  assert.equal(JSON.stringify(item), before);
});

test('XML Crop/強度はCanvasと同じ値で、登場・退場は最外側だけに1回掛かる', () => {
  const input = options('double'), style = { ...input.style, in: 'slide_left', out: 'fade', rotate: 0, pos: [960, 900] };
  const xml = buildTextXml({ items: [{ text: '光沢', t: input.t, d: input.d, style, bounds: input.bounds }] }), root = xmlTree(xml);
  const shine = byId(root, 'surface-shine-1');
  const crop = surfaceCropSamples(getSurfaceLightSamples({ ...input, style }), input.W);
  for (const id of ['leftcrop', 'rightcrop', 'opacity']) assert.deepEqual(keys(parameter(shine, id)), crop.map(sample => [sample.frame, sample[id]]));
  for (const clipId of ['surface-base-1', 'graphic-surface-body-1']) {
    const clip = byId(root, clipId);
    assert.equal(value(parameter(clip, 'scale'), 'value'), '100'); assert.equal(value(parameter(clip, 'opacity'), 'value'), '100');
    assert.equal(all(clip, 'keyframe').length, 0);
  }
  const main = byId(root, 'surface-main-1'), expected = motionSamples(style, 90, 1920, 1080);
  assert.equal(value(parameter(main, 'center'), 'value'), '');
  assert.equal(value(child(parameter(main, 'center'), 'value'), 'vert'), '0.333333');
  assert.equal(value(parameter(main, 'opacity'), 'value'), expected[0].opacity);
  assert.deepEqual(keys(parameter(main, 'opacity')).at(-1), [90, 0]);
  assert.ok(keys(parameter(main, 'scale')).length === 0);
  assert.ok(parameter(main, 'center').children.some(item => item.tag === 'keyframe'));
});

test('バッチ内の共有本文を混ぜず、キラキラの文字は別トラックのまま保持する', () => {
  const items = ['sweep', 'double'].map((surfaceLight, i) => ({ text: `本文${i + 1}`, t: i * 4 + .5, d: 3,
    style: { ...base, surfaceLight, sparkle: i ? 'twinkle' : 'none' }, bounds: { width: 600, height: 140 }, fontName: i ? 'YuMincho-Demibold' : 'NotoSansJP-Black' }));
  const root = xmlTree(buildTextXml({ items })), main = child(root, 'sequence'), tracks = video(main).children.filter(item => item.tag === 'track');
  assert.equal(tracks[0].children.filter(item => item.tag === 'clipitem').length, 2);
  assert.ok(tracks.length > 1);
  const ids = all(root, 'clipitem').map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  items.forEach((item, i) => {
    const body = sourceBytes(byId(root, `surface-main-${i + 1}`));
    assert.equal(body.length, 1); assert.ok(body[0].includes(Buffer.from(item.text))); assert.ok(body[0].includes(Buffer.from(item.fontName)));
    assert.equal(child(byId(root, `surface-shine-${i + 1}`), 'sequence').id, `surface-text-${i + 1}`);
  });
  for (const track of tracks.slice(1)) for (const clip of track.children.filter(item => item.tag === 'clipitem')) {
    const body = sourceBytes(clip); assert.equal(body.length, 1); assert.ok(body[0].includes(Buffer.from('SegoeUISymbol')));
  }
});

test('フチなしでも光沢はSourceTextを共有し、無効時の従来XMLと入力検証を保つ', () => {
  const style = { ...base, strokes: [], surfaceLight: 'sweep' }, item = { text: '単色', t: 0, d: 1, style, bounds: { width: 300, height: 140 } };
  const xml = buildTextXml({ items: [item] });
  assert.equal(sourceBytes(xmlTree(xml)).length, 1); assert.doesNotMatch(xml, /<generatoritem/);
  const disabled = buildTextXml({ items: [{ ...item, style: { ...style, surfaceLight: 'none' } }] });
  assert.match(disabled, /<generatoritem/); assert.doesNotMatch(disabled, /surface-main|Source Text/);
  assert.throws(() => buildTextXml({ items: [{ ...item, bounds: undefined }] }), /幅と高さ/);
  assert.throws(() => buildTextXml({ items: [{ ...item, style: { ...style, surfaceLight: 'unknown' } }] }), /未対応/);
  assert.ok(xmlStyleWarnings({ ...style, surfaceLight: 'unknown' }).some(reason => reason.includes('表面')));
});
