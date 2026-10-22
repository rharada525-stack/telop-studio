import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTextXml, plainText, xmlStyleWarnings, motionSamples } from '../admin/effects-lab/text-xml.mjs';
import { NATIVE_PRESETS, XML_PRESETS, nativeStyles } from '../admin/effects-lab/native-presets.mjs';
import { EFFECTS, sceneFor, newDraft, SAMPLES } from '../admin/effects-lab/model.mjs';

test('新旧の演出をラボ内の試作として残し、本体の演出に追加しない', () => {
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
  const items = Object.values(XML_PRESETS).map((preset, i) => ({ text: preset.sample, t: i * 4 + .5, d: 3 }));
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

test('ファミリー名を渡さず、書体のPostScript名を渡し、太字を二重指定しない', () => {
  const options = { items: [{ text: '確認', t: .5, d: 3 }] };
  assert.match(buildTextXml(options), /<parameterid>fontname<\/parameterid><name>Font<\/name><value>YuGothic-Bold<\/value>/);
  assert.match(buildTextXml(options), /<parameterid>fontstyle<\/parameterid><name>Style<\/name><value>1<\/value>/);
  assert.match(buildTextXml({ ...options, fontName: 'NotoSansJP-Black' }), /<value>NotoSansJP-Black<\/value>/);
  assert.match(buildTextXml({ ...options, fontName: 'PCFont-Bold&"Test' }), /<value>PCFont-Bold&amp;&quot;Test<\/value>/);
  for (const fontName of ['', 'Yu Gothic', 'Noto Sans JP', ' 游ゴシック ', 'YuGothic<Bold>', 'x'.repeat(64)]) assert.throws(() => buildTextXml({ ...options, fontName }));
});

test('壊れたprprojの出力をUIから撤去し、XMLの検証範囲を表示する', async () => {
  const html = await readFile(new URL('../admin/effects-lab/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../admin/effects-lab/lab.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html + js, /\.prproj|native-seed|native-project|compressProject/);
  assert.match(html, /文字編集・フォントは確認済み/);
  assert.match(html, /新しい色・配置・動きは実機確認用/);
  assert.match(html, /通常字幕・背景・画面効果・効果音は含みません/);
});

test('3案の色・サイズ・位置・傾きとMotion/Opacityを書き、文字はTextのまま保持する', () => {
  for (const aspect of ['portrait', 'landscape']) {
    const [W, H] = aspect === 'portrait' ? [1080, 1920] : [1920, 1080];
    const styles = nativeStyles(aspect);
    for (const [id, preset] of Object.entries(XML_PRESETS)) {
      const style = styles[id];
      assert.deepEqual(xmlStyleWarnings(style, preset.sample), []);
      const xml = buildTextXml({ W, H, items: [{ text: preset.sample, t: .5, d: 3, style }] });
      assert.match(xml, /<effectid>Text<\/effectid>/);
      assert.match(xml, /<effectid>basic<\/effectid>/);
      assert.match(xml, /<effectid>opacity<\/effectid>/);
      const size = Number((style.size * 480 / H).toFixed(6));
      assert.ok(xml.includes(`<parameterid>fontsize</parameterid><name>Size</name><value>${size}</value>`));
      const [r, g, b] = style.fill.slice(1).match(/../g).map(n => parseInt(n, 16));
      assert.ok(xml.includes(`<red>${r}</red><green>${g}</green><blue>${b}</blue>`));
      assert.match(xml, /<keyframe><when>90<\/when><value>0<\/value><\/keyframe>/);
      assert.doesNotMatch(xml, /<file\b|<pathurl>|\.png|\.mp4|\.mogrt|SourceText|AE\.ADBE/);
      const frames = [...xml.matchAll(/<when>(\d+)<\/when>/g)].map(m => Number(m[1]));
      assert.ok(frames.every(f => f >= 0 && f <= 90));
      // 停止している2秒間に毎フレームのキーを作らない。
      assert.ok(frames.length < 150);
    }
  }
});

test('ポップの跳ね返り・スライドの移動・スラムの揺れと退場を残す', () => {
  const styles = nativeStyles('landscape');
  const pop = motionSamples(styles.xml_pop, 90, 1920, 1080);
  assert.equal(pop[0].scale, '2');
  assert.ok(pop.some(s => Number(s.scale) > 100));
  assert.equal(pop[30].scale, '100');
  assert.equal(pop[30].opacity, '100'); assert.equal(pop[90].opacity, '0');
  const slide = motionSamples({ ...styles.xml_heading, pos: [960, 540] }, 90, 1920, 1080);
  assert.equal(slide[0].center, '<horiz>-0.46875</horiz><vert>0</vert>');
  assert.equal(slide[15].center, '<horiz>0</horiz><vert>0</vert>');
  const slam = motionSamples(styles.xml_reaction, 90, 1920, 1080);
  assert.equal(slam[0].scale, '260'); assert.equal(slam[30].rotation, '-6');
  assert.notEqual(slam[7].center, slam[30].center);
});

test('対応していない装飾を黙って落とさず、保存を止めて理由を返す', () => {
  const style = nativeStyles('landscape').xml_pop;
  for (const change of [{ strokes: [{ w: 8 }] }, { shadows: [{ dx: 1 }] }, { plate: {} }, { fill: ['red', 'blue'] },
    { in: 'wipe' }, { in: 'jelly' }, { out: 'wipe_out' }, { char: 'pop' }, { vertical: true }, { group: true }, { tracking: .1 }]) {
    const invalid = { ...style, ...change };
    assert.ok(xmlStyleWarnings(invalid).length);
    assert.throws(() => buildTextXml({ items: [{ text: '確認', t: .5, d: 3, style: invalid }] }), /まだ渡せません/);
  }
  assert.ok(xmlStyleWarnings(style, '2行\nです').length);
  for (const change of [{ size: NaN }, { pos: [0, Infinity] }, { rotate: '0' }, { out_d: -1 }]) {
    assert.throws(() => buildTextXml({ items: [{ text: '確認', t: .5, d: 3, style: { ...style, ...change } }] }), /不正/);
  }
});

test('XML用の文字は自動折り返しせず、短い表示時間もラボと一致する', () => {
  assert.ok(XML_PRESETS[newDraft().fx]);
  assert.equal(newDraft().separate, false);
  for (const id of Object.keys(XML_PRESETS)) for (const aspect of ['portrait', 'landscape']) {
    const text = '長めの文章でもサイズを縮めて1行のままで表示します';
    const scene = sceneFor({ ...newDraft(), fx: id, aspect, text, duration: .5, separate: false });
    assert.equal(scene.items.length, 1); assert.equal(scene.items[0].text, text);
    assert.equal(scene.items[0].d, .5);
  }
});
