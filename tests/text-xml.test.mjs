import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTextXml, plainText, xmlStyleWarnings, motionSamples } from '../admin/effects-lab/text-xml.mjs';
import { NATIVE_PRESETS, XML_PRESETS, DESIGN_VARIANTS, FONT_CHOICES, nativeStyles } from '../admin/effects-lab/native-presets.mjs';
import { EFFECTS, sceneFor, newDraft, SAMPLES, designStyle, selectDesign, fontForStyle } from '../admin/effects-lab/model.mjs';

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

test('全演出の時間と縦横の解像度を保持し、元のデータを変更しない', () => {
  const items = Object.values(XML_PRESETS).map((preset, i) => ({ text: preset.sample, t: i * 4 + .5, d: 3 }));
  const before = JSON.stringify(items);
  for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
    const xml = buildTextXml({ W, H, items });
    assert.match(xml, new RegExp(`<width>${W}</width><height>${H}</height>`));
    assert.deepEqual([...xml.matchAll(/<start>(\d+)<\/start><end>(\d+)<\/end>/g)].map(m => m.slice(1).map(Number)), items.map(item => [Math.round(item.t * 30), Math.round((item.t + item.d) * 30)]));
    assert.equal((xml.match(/<generatoritem\b/g) || []).length, items.length);
    assert.match(xml, new RegExp(`<duration>${Math.round((items.at(-1).t + 3) * 30)}</duration><rate>`));
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
  assert.match(html, /Premiereで文字編集・フォント・多重フチを確認済み/);
  assert.match(html, /通常字幕・背景・画面効果・効果音は含みません/);
});

function sourceData(xml) {
  const encoded = xml.match(/<name>Source Text<\/name><hash>[^<]+<\/hash><value>([^<]+)<\/value>/)?.[1];
  assert.ok(encoded, 'Source Textを持つ');
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.readUInt32LE(0), bytes.length - 12);
  assert.equal(bytes.readUInt32LE(8), 0x11223344);
  const table = p => {
    const vt = p - bytes.readInt32LE(p), count = (bytes.readUInt16LE(vt) - 4) / 2;
    return Object.fromEntries(Array.from({ length: count }, (_, i) => [i, bytes.readUInt16LE(vt + 4 + i * 2)]).filter(([, off]) => off).map(([i, off]) => [i, p + off]));
  };
  const ref = p => p + bytes.readUInt32LE(p);
  const string = p => bytes.toString('utf8', p + 4, p + 4 + bytes.readUInt32LE(p));
  const root = table(12 + bytes.readUInt32LE(12)), paragraph = table(ref(root[0]));
  const runs = ref(paragraph[0]), part = table(ref(runs + 4)), character = table(ref(part[1]));
  const fonts = ref(paragraph[1]);
  const rgb = p => { const t = table(ref(p)); return [0, 1, 2].map(k => bytes.readUInt32LE(t[k])); };
  return { bytes, table, ref, character, paragraph, runCount: bytes.readUInt32LE(runs), fontCount: bytes.readUInt32LE(fonts),
    text: string(ref(part[0])), font: string(ref(fonts + 4)), rgb };
}

function assertPaint(d, fields, colorKey, modeKey, gradientKey, expected) {
  const rgb = color => color.slice(1).match(/../g).map(n => parseInt(n, 16));
  const gradient = typeof expected !== 'string';
  assert.equal(d.bytes.readUInt32LE(fields[modeKey]), Number(gradient));
  assert.deepEqual(d.rgb(fields[colorKey]), rgb(gradient ? expected.stops[0] : expected));
  if (!gradient) { assert.equal(fields[gradientKey], undefined); return; }
  const g = d.table(d.ref(fields[gradientKey])), stops = d.ref(g[1]);
  assert.equal(d.bytes.readFloatLE(g[0]), 90, '縦グラデーションの向きを保持する');
  assert.equal(d.bytes.readUInt32LE(stops), expected.stops.length);
  expected.stops.forEach((color, i) => {
    const stop = d.table(d.ref(stops + 4 + i * 4));
    assert.deepEqual(d.rgb(stop[0]), rgb(color));
    assert.ok(Math.abs(d.bytes.readFloatLE(stop[1]) - i / (expected.stops.length - 1)) < 1e-6);
  });
}

function assertEditableStyle(d, style, fontName, text) {
  assert.equal(d.runCount, 1, '装飾ごとに文字を複製しない');
  assert.equal(d.fontCount, 1); assert.equal(d.font, fontName); assert.equal(d.text, text);
  assert.equal(d.bytes.readFloatLE(d.character[1]), style.size);
  assert.equal(d.bytes.readUInt32LE(d.character[3]), 1, '文字の塗りが有効');
  assertPaint(d, d.character, 2, 20, 21, style.fill);
  assert.equal(d.bytes.readUInt32LE(d.character[5]), Number(!!style.strokes.length));
  if (style.strokes.length) {
    assert.equal(d.bytes.readFloatLE(d.character[6]), style.strokes[0].w);
    assert.equal(d.bytes.readUInt32LE(d.character[24]), 2);
    assertPaint(d, d.character, 4, 22, 23, style.strokes[0].color);
  }
  const strokes = d.ref(d.character[17]);
  assert.equal(d.bytes.readUInt32LE(strokes), Math.max(0, style.strokes.length - 1));
  style.strokes.slice(1).forEach((stroke, i) => {
    const fields = d.table(d.ref(strokes + 4 + i * 4));
    assert.equal(d.bytes.readUInt32LE(fields[1]), 1);
    assert.equal(d.bytes.readFloatLE(fields[2]), stroke.w);
    assert.equal(d.bytes.readUInt32LE(fields[5]), 2);
    assertPaint(d, fields, 0, 3, 4, stroke.color);
  });
}

test('フチ付き3案は1クリップ1文字レイヤーと編集可能なフチ・Motion/Opacityを持つ', () => {
  for (const aspect of ['portrait', 'landscape']) {
    const [W, H] = aspect === 'portrait' ? [1080, 1920] : [1920, 1080];
    const styles = nativeStyles(aspect);
    for (const [id, preset] of Object.entries(XML_PRESETS)) {
      const style = styles[id];
      assert.deepEqual(xmlStyleWarnings(style, preset.sample), []);
      const xml = buildTextXml({ W, H, items: [{ text: preset.sample, t: .5, d: 3, style }], fontName: 'NotoSansJP-Black' });
      assert.equal((xml.match(/<clipitem /g) || []).length, 1);
      assert.equal((xml.match(/<name>Source Text<\/name>/g) || []).length, 1);
      assert.match(xml, /<mediaSource>GraphicAndType<\/mediaSource>/);
      assert.match(xml, /<effectid>basic<\/effectid>/);
      assert.match(xml, /<effectid>opacity<\/effectid>/);
      const d = sourceData(xml);
      assert.equal(d.font, 'NotoSansJP-Black'); assert.equal(d.text, preset.sample);
      assert.equal(d.bytes.readFloatLE(d.character[1]), style.size);
      assert.equal(d.bytes.readUInt32LE(d.paragraph[4]), 2, '段落中央揃え');
      assert.equal(d.bytes.readUInt32LE(d.paragraph[26]), 1, '多重フチの描画を有効にする');
      const rgb = style.fill.slice(1).match(/../g).map(n => parseInt(n, 16));
      assert.deepEqual(d.rgb(d.character[2]), rgb);
      assert.equal(d.bytes.readFloatLE(d.character[6]), style.strokes[0].w);
      const strokes = d.ref(d.character[17]);
      assert.equal(d.bytes.readUInt32LE(strokes), style.strokes.length - 1);
      style.strokes.slice(1).forEach((stroke, i) => {
        const t = d.table(d.ref(strokes + 4 + i * 4));
        assert.equal(d.bytes.readFloatLE(t[2]), stroke.w);
        assert.equal(d.bytes.readUInt32LE(t[5]), 2, 'フチを外側へ描く');
        assert.deepEqual(d.rgb(t[0]), stroke.color.slice(1).match(/../g).map(n => parseInt(n, 16)));
      });
      assert.match(xml, /<keyframe><when>90<\/when><value>0<\/value><\/keyframe>/);
      assert.doesNotMatch(xml, /<pathurl>|\.png|\.mp4|\.mogrt/);
      const frames = [...xml.matchAll(/<when>(\d+)<\/when>/g)].map(m => Number(m[1]));
      assert.ok(frames.every(f => f >= 0 && f <= 90));
      assert.ok(frames.length < 150);
    }
  }
});

test('フチを外した場合も、従来のText generatorとPostScript名を維持する', () => {
  const style = { ...nativeStyles('landscape').xml_pop, strokes: [] };
  const xml = buildTextXml({ items: [{ text: '確認', t: .5, d: 3, style }], fontName: 'YuGothic-Bold' });
  assert.match(xml, /<generatoritem /);
  assert.match(xml, /<effectid>Text<\/effectid>/);
  assert.match(xml, /<value>YuGothic-Bold<\/value>/);
  assert.doesNotMatch(xml, /GraphicAndType/);
});

test('フチのないグラデーションも単色へ落とさず、編集可能なSource Textで渡す', () => {
  const style = { ...nativeStyles('landscape').xml_pop, strokes: [], fill: { stops: ['#fff2bd', '#b26b10', '#ffe989'], angle: 0 } };
  const xml = buildTextXml({ items: [{ text: 'グラデーション', t: .5, d: 3, style, fontName: 'NotoSansJP-Black' }], fontName: 'YuGothic-Bold' });
  const d = sourceData(xml);
  assert.equal(d.font, 'NotoSansJP-Black');
  assert.equal(d.text, 'グラデーション');
  assert.equal(d.bytes.readUInt32LE(d.character[20]), 1);
  assert.equal(d.bytes.readUInt32LE(d.character[5]), 0);
  assert.doesNotMatch(xml, /<generatoritem|<pathurl>|\.png|\.mp4|\.mogrt/);
  assert.throws(() => buildTextXml({ items: [{ text: '確認', t: 0, d: 1, style, fontName: 'Noto Sans JP' }] }), /PostScript/);
});

test('デザインの塗り・フチの未対応グラデーション指定を保存時に検出する', () => {
  const base = nativeStyles('landscape').xml_pop;
  for (const paint of [{ stops: ['#ffffff', '#000000'], angle: 90 }, { stops: ['#ffffff'] }, { stops: ['#ffffff', '#000000'], type: 'radial' }]) {
    for (const style of [{ ...base, fill: paint }, { ...base, strokes: [{ w: 7, color: paint }] }]) {
      assert.ok(xmlStyleWarnings(style).length);
      assert.throws(() => buildTextXml({ items: [{ text: '確認', t: 0, d: 1, style }] }), /まだ渡せません/);
    }
  }
});

test('17デザインと8演出で書体・サイズ・単色/グラデーション・1〜4本のフチを編集可能な文字へ渡す', () => {
  assert.equal(Object.keys(DESIGN_VARIANTS).length, 17);
  assert.equal(Object.keys(XML_PRESETS).length, 8);
  for (const aspect of ['portrait', 'landscape']) for (const fx of Object.keys(XML_PRESETS)) for (const [id, variant] of Object.entries(DESIGN_VARIANTS)) {
    const initial = { ...newDraft(), fx, aspect, text: '編集できるテロップ' };
    const draft = selectDesign(initial, id), style = designStyle(draft);
    const expectedFont = variant.fontChoice ? FONT_CHOICES[variant.fontChoice] : initial.font;
    const font = fontForStyle(draft, style);
    assert.equal(font.postscriptName, expectedFont.postscriptName);
    assert.equal(style.family, expectedFont.family); assert.equal(style.weight, expectedFont.weight);
    assert.equal(style.size, variant.aspectStyle?.[aspect]?.size ?? nativeStyles(aspect)[fx].size);
    assert.deepEqual(style.fill, variant.style.fill); assert.deepEqual(style.strokes, variant.style.strokes);
    assert.deepEqual(xmlStyleWarnings(style, draft.text), []);
    const [W, H] = aspect === 'landscape' ? [1920, 1080] : [1080, 1920];
    const xml = buildTextXml({ W, H, items: [{ text: draft.text, t: .5, d: 3, style, fontName: font.postscriptName }], fontName: 'FallbackFont-Regular' });
    assertEditableStyle(sourceData(xml), style, expectedFont.postscriptName, draft.text);
    if (aspect === 'landscape') assert.deepEqual(style.pos, [960, 900]);
    assert.equal(style.rotate || 0, 0);
    assert.equal((xml.match(/<clipitem /g) || []).length, 1);
    assert.equal((xml.match(/<name>Source Text<\/name>/g) || []).length, 1);
    assert.match(xml, /<effectid>basic<\/effectid>/);
    assert.doesNotMatch(xml, /<generatoritem|<pathurl>|\.png|\.mp4|\.mogrt/);
  }
});

test('用途別の書体が混在する全17案バッチで各クリップのPostScript名・装飾・時間を保持する', () => {
  const snapshot = { ...newDraft(), fx: 'xml_reaction', text: '同じ文章で比べます', duration: 2.5 };
  const items = Object.keys(DESIGN_VARIANTS).map((id, i) => {
    const draft = selectDesign(snapshot, id), style = designStyle(draft);
    return { text: draft.text, t: i * (snapshot.duration + 1) + .5, d: snapshot.duration, style, fontName: fontForStyle(draft, style).postscriptName };
  });
  assert.equal(items.length, 17);
  assert.equal(new Set(items.map(item => item.fontName)).size, 5, '推奨の5書体を混在させる');
  const before = JSON.stringify(items);
  const xml = buildTextXml({ name: '全デザイン17案', items, fontName: 'FallbackFont-Regular' });
  const clips = [...xml.matchAll(/<clipitem\b[\s\S]*?<\/clipitem>/g)].map(match => match[0]);
  assert.equal(clips.length, items.length);
  clips.forEach((clip, i) => {
    const item = items[i];
    assertEditableStyle(sourceData(clip), item.style, item.fontName, item.text);
    assert.equal((clip.match(/<name>Source Text<\/name>/g) || []).length, 1);
    assert.match(clip, new RegExp(`<start>${Math.round(item.t * 30)}</start><end>${Math.round((item.t + item.d) * 30)}</end>`));
  });
  assert.equal(JSON.stringify(items), before);
  assert.doesNotMatch(xml, /<generatoritem|<pathurl>|\.png|\.mp4|\.mogrt/);
});

test('横長のおまかせ位置は全案とも下中央、3案の標準の傾きは0度', () => {
  for (const [id, preset] of Object.entries(XML_PRESETS)) {
    const scene = sceneFor({ ...newDraft(), fx: id, text: preset.sample });
    assert.deepEqual(scene.items.find(item => item.style === id).pos, [960, 900]);
    assert.equal(nativeStyles('landscape')[id].rotate || 0, 0);
    const top = sceneFor({ ...newDraft(), fx: id, text: preset.sample, position: 'top' });
    assert.deepEqual(top.items.find(item => item.style === id).pos, [960, 200], '指定した位置は優先する');
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
  assert.equal(slam[0].scale, '260'); assert.equal(slam[30].rotation, '0');
  assert.notEqual(slam[7].center, slam[30].center);
});

test('対応していない装飾を黙って落とさず、保存を止めて理由を返す', () => {
  const style = nativeStyles('landscape').xml_pop;
  for (const change of [{ strokes: [{ w: 8, color: ['red', 'blue'] }] }, { shadows: [{ dx: 1 }] }, { plate: {} }, { fill: ['red', 'blue'] },
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
