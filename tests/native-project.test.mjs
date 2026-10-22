import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { makeTextData, buildNativeProject, compressProject, TICKS, unsupported } from '../admin/effects-lab/native-project.mjs';
import { NATIVE_PRESETS, nativeStyles } from '../admin/effects-lab/native-presets.mjs';
import { EFFECTS, sceneFor, newDraft, SAMPLES } from '../admin/effects-lab/model.mjs';
const seed = JSON.parse(await readFile(new URL('../admin/effects-lab/native-seed.json', import.meta.url), 'utf8'));
function reader(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = p => v.getUint32(p, true), ptr = p => p + u(p);
  const table = p => { const vt = p - v.getInt32(p, true), n = (v.getUint16(vt, true) - 4) / 2; return Object.fromEntries(Array.from({ length: n }, (_, i) => [i, v.getUint16(vt + 4 + i * 2, true)]).filter(([, offset]) => offset).map(([i, offset]) => [i, p + offset])); };
  const vector = p => Array.from({ length: u(p) }, (_, i) => ptr(p + 4 + i * 4));
  const string = p => new TextDecoder().decode(bytes.slice(p + 4, p + 4 + u(p)));
  return { v, u, ptr, table, vector, string };
}
test('標準テキスト3案は本体と異なるラボ内だけの演出で、動画・画像を作らない', () => {
  for (const [id, preset] of Object.entries(NATIVE_PRESETS)) for (const aspect of ['portrait', 'landscape']) {
    assert.ok(EFFECTS[id]); assert.equal(SAMPLES[id], preset.sample);
    const scene = sceneFor({ ...newDraft(), fx: id, aspect, text: preset.sample });
    assert.ok(scene.items.some(item => item.style === id)); assert.equal(scene.style, id);
    assert.deepEqual(unsupported(nativeStyles(aspect)[id]), []);
  }
});
test('文字・改行・絵文字・強調は正しいUTF8のテキストrunとフォント表に保存される', () => {
  const bytes = makeTextData('前半{強調😀}\n後半', { ...nativeStyles('landscape').native_emphasis, accent: '#ff4766' });
  const r = reader(bytes), wrapper = r.table(r.ptr(12)), text = r.table(r.ptr(wrapper[0]));
  const runs = r.vector(r.ptr(text[0])).map(p => r.table(p));
  assert.equal(r.u(0), bytes.length - 12); assert.equal(r.u(8), 0x11223344);
  assert.deepEqual(runs.map(run => r.string(r.ptr(run[0]))), ['前半', '強調😀', '\r後半']);
  assert.deepEqual(r.vector(r.ptr(text[1])).map(r.string), ['NotoSansJP-Black']);
  const style = r.table(r.ptr(runs[0][1]));
  assert.equal(r.v.getFloat32(style[1], true), 100);
  assert.equal(r.vector(r.ptr(style[17])).length, 2);
});
test('複数のテキストが別クリップ・別参照で並び、元データを変更しない', async () => {
  const before = JSON.stringify(seed), items = Object.entries(NATIVE_PRESETS).map(([id, preset], i) => ({ text: preset.sample, style: nativeStyles('landscape')[id], t: i * 4 + .5, d: 3 }));
  const xml = buildNativeProject(seed, { name: '日本語 & <検証>', W: 1920, H: 1080, items });
  const blob = await compressProject(xml);
  assert.equal(gunzipSync(new Uint8Array(await blob.arrayBuffer())).toString('utf8'), xml);
  assert.equal((xml.match(/<VideoClipTrackItem\b/g) || []).length, 3);
  const ids = [...xml.matchAll(/\bObjectID="([^"]+)"/g)].map(m => m[1]);
  const uids = [...xml.matchAll(/\bObjectUID="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size); assert.equal(uids.length, new Set(uids).size);
  for (const [, id] of xml.matchAll(/\bObjectRef="([^"]+)"/g)) assert.ok(ids.includes(id), `missing ${id}`);
  for (const [, id] of xml.matchAll(/\bObjectURef="([^"]+)"/g)) assert.ok(uids.includes(id), `missing UID ${id}`);
  // 各クリップのインスタンスとマスターが、どちらも標準テキストを保持する。
  assert.equal((xml.match(/<MatchName>AE.ADBE Text<\/MatchName>/g) || []).length, 6);
  assert.match(xml, new RegExp(`<Start>${Math.round(.5 * TICKS)}<`));
  assert.match(xml, /日本語 &amp; &lt;検証&gt;/);
  assert.doesNotMatch(xml, /__NATIVE_TEXT__|\.png|\.mp4|\.mogrt|WEBFREE|[A-Z]:\\/i);
  assert.equal(JSON.stringify(seed), before);
});
test('未対応の動きや影・縦書きを黙って画像化せず、明示して拒否する', () => {
  const style = nativeStyles('landscape').native_emphasis;
  for (const change of [{ char: 'pop' }, { in: 'pop' }, { plate: {} }, { shadows: [{}] }, { vertical: true }, { fill: ['#fff', '#000'] }]) assert.throws(() => makeTextData('テスト', { ...style, ...change }));
});
