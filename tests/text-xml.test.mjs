import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTextXml, plainText } from '../admin/effects-lab/text-xml.mjs';
import { NATIVE_PRESETS, nativeStyles } from '../admin/effects-lab/native-presets.mjs';
import { EFFECTS, sceneFor, newDraft, SAMPLES } from '../admin/effects-lab/model.mjs';

test('既存の3案はラボ内の試作として残し、本体の演出に追加しない', () => {
  for (const [id, preset] of Object.entries(NATIVE_PRESETS)) for (const aspect of ['portrait', 'landscape']) {
    assert.ok(EFFECTS[id]); assert.equal(SAMPLES[id], preset.sample);
    const scene = sceneFor({ ...newDraft(), fx: id, aspect, text: preset.sample });
    assert.ok(scene.items.some(item => item.style === id));
    assert.ok(nativeStyles(aspect)[id]);
  }
});

test('日本語・改行・XMLの特殊文字を文字として格納し、画像などを参照しない', () => {
  const xml = buildTextXml({ name: '日本語 & <検証>', items: [{ text: '{大切}\n[なこと] & <文字> 😀', t: .5, d: 3 }] });
  assert.match(xml, /<xmeml version="5">/);
  assert.match(xml, /<name>日本語 &amp; &lt;検証&gt;<\/name>/);
  assert.match(xml, /<parameterid>str<\/parameterid><name>Text<\/name><value>大切&#13;なこと &amp; &lt;文字&gt; 😀<\/value>/);
  assert.match(xml, /<effectid>Text<\/effectid>/);
  assert.match(xml, /<start>15<\/start><end>105<\/end>/);
  assert.doesNotMatch(xml, /<file\b|<pathurl>|\.png|\.mp4|\.mogrt|AE\.ADBE|<filter>|<keyframe>/);
  assert.equal(plainText('前\u0000\u000b後\r\n次'), '前後\n次');
});

test('3個の時間と縦横の解像度を保持し、元のデータを変更しない', () => {
  const items = Object.values(NATIVE_PRESETS).map((preset, i) => ({ text: preset.sample, t: i * 4 + .5, d: 3 }));
  const before = JSON.stringify(items);
  for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
    const xml = buildTextXml({ W, H, items });
    assert.match(xml, new RegExp(`<width>${W}</width><height>${H}</height>`));
    assert.deepEqual([...xml.matchAll(/<start>(\d+)<\/start><end>(\d+)<\/end>/g)].map(m => m.slice(1).map(Number)), [[15, 105], [135, 225], [255, 345]]);
    assert.equal((xml.match(/<generatoritem\b/g) || []).length, 3);
    assert.match(xml, /<duration>345<\/duration><rate>/);
  }
  assert.equal(JSON.stringify(items), before);
});

test('空文字・逆転する時間・重なり・不正な解像度を黙って補正しない', () => {
  const valid = { text: '文字', t: .5, d: 3 };
  for (const change of [{ text: ' {} [] ' }, { t: -1 }, { d: 0 }, { t: NaN }, { d: .001 }, { t: 3600 }]) {
    assert.throws(() => buildTextXml({ items: [{ ...valid, ...change }] }));
  }
  assert.throws(() => buildTextXml({ W: 0, items: [valid] }));
  assert.throws(() => buildTextXml({ items: [valid, valid] }));
});

test('フォントの固定指定をやめ、PCフォントの実名と特殊文字をXMLへ渡せる', () => {
  const options = { items: [{ text: '確認', t: .5, d: 3 }] };
  assert.match(buildTextXml(options), /<parameterid>fontname<\/parameterid><name>Font<\/name><value>Yu Gothic<\/value>/);
  assert.match(buildTextXml({ ...options, fontName: 'PCFont-Bold & <test>' }), /<value>PCFont-Bold &amp; &lt;test&gt;<\/value>/);
  assert.throws(() => buildTextXml({ ...options, fontName: '' }));
});

test('壊れたprprojの出力をUIから撤去し、XMLの検証範囲を表示する', async () => {
  const html = await readFile(new URL('../admin/effects-lab/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../admin/effects-lab/lab.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html + js, /\.prproj|native-seed|native-project|compressProject/);
  assert.match(html, /文字と表示時間のみ/);
  assert.match(html, /現行Premiereでの文字編集は未確認/);
});
