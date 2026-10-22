// PremiereがXMLへ書き出すSource Text用。公開仕様ではないため実機確認を伴う。
const encoder = new TextEncoder();
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Canvasの0度（上から下）だけを受け付ける。Premiereでは同じ方向が90度。
// 色配列は等間隔・不透明。任意の角度や透明度を黙って落とさない。
export function isSupportedPaint(paint) {
  if (typeof paint === 'string') return HEX_COLOR.test(paint);
  return !!paint && !Array.isArray(paint) && Array.isArray(paint.stops)
    && paint.stops.length >= 2 && paint.stops.length <= 8
    && paint.stops.every(color => typeof color === 'string' && HEX_COLOR.test(color))
    && (paint.angle === undefined || paint.angle === 0)
    && Object.keys(paint).every(key => key === 'stops' || key === 'angle');
}

function paintInfo(paint) {
  if (!isSupportedPaint(paint)) throw new Error('XMLの色は単色、または2〜8色の縦グラデーションを指定してください。');
  return typeof paint === 'string' ? { color: paint, gradient: null } : { color: paint.stops[0], gradient: paint };
}

class Writer {
  constructor() { this.bytes = new Uint8Array(65536); this.view = new DataView(this.bytes.buffer); this.length = 16; }
  alloc(size, align = 4) { this.length = Math.ceil(this.length / align) * align; const p = this.length; this.length += size; if (this.length > this.bytes.length) throw new Error('テキストデータが大きすぎます。'); return p; }
  table(fields) {
    const keys = Object.keys(fields).map(Number).sort((a, b) => a - b), count = Math.max(...keys, -1) + 1;
    const vt = this.alloc(4 + count * 2, 2), p = this.alloc(4 + keys.length * 4);
    this.view.setUint16(vt, 4 + count * 2, true); this.view.setUint16(vt + 2, 4 + keys.length * 4, true); this.view.setInt32(p, p - vt, true);
    keys.forEach((key, i) => {
      const at = p + 4 + i * 4, [type, value] = fields[key]; this.view.setUint16(vt + 4 + key * 2, 4 + i * 4, true);
      if (type === 'ref') this.view.setUint32(at, value() - at, true);
      else if (type === 'float') this.view.setFloat32(at, value, true);
      else this.view.setUint32(at, Number(value), true);
    });
    return p;
  }
  vector(values) { const p = this.alloc(4 + values.length * 4); this.view.setUint32(p, values.length, true); values.forEach((value, i) => { const at = p + 4 + i * 4; this.view.setUint32(at, value() - at, true); }); return p; }
  string(text) { const bytes = encoder.encode(text), p = this.alloc(5 + bytes.length); this.view.setUint32(p, bytes.length, true); this.bytes.set(bytes, p + 4); return p; }
  color(hex) { return this.table(Object.fromEntries([0, 1, 2].map(i => [i, ['int', parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)]]))); }
  // 実際の.prtextstyleのSource Text構造で確認した線形グラデーション。
  // 保存済みの素材を埋め込まず、入力色から各ストップを新規生成する。
  gradient(paint) {
    return this.table({
      0: ['float', 90],
      1: ['ref', () => this.vector(paint.stops.map((color, i) => () => this.table({
        0: ['ref', () => this.color(color)], 1: ['float', i / (paint.stops.length - 1)], 2: ['float', .5],
      })))],
      2: ['ref', () => this.vector([0, 1].map(position => () => this.table({
        0: ['float', 1], 1: ['float', position], 2: ['float', .5],
      })))],
    });
  }
  finish(root) { this.view.setUint32(0, this.length - 12, true); this.view.setUint32(8, 0x11223344, true); this.view.setUint32(12, root - 12, true); return this.bytes.slice(0, this.length); }
}

export function makeTextData(text, style, fontName = 'NotoSansJP-Black') {
  const parts = []; let current = '', accent = 0;
  const flush = () => { if (current) parts.push({ text: current.replace(/\r?\n/g, '\r'), accent }); current = ''; };
  for (const char of text) {
    if ('{}[]'.includes(char)) { flush(); accent = char === '{' ? 1 : char === '[' ? 2 : 0; } else current += char;
  }
  flush(); if (!parts.length) throw new Error('演出の文字を入力してください。');
  const w = new Writer(), strokes = (style.strokes || []).map(stroke => ({ ...stroke, paint: paintInfo(stroke.color) }));
  const firstStroke = strokes[0]?.paint || paintInfo('#000000');
  const character = color => {
    const fill = paintInfo(color);
    return w.table({
      0: ['int', 0], 1: ['float', style.size], 2: ['ref', () => w.color(fill.color)], 3: ['int', 1],
      4: ['ref', () => w.color(firstStroke.color)], 5: ['int', !!strokes.length],
      6: ['float', strokes[0]?.w || 0], 7: ['float', (style.tracking || 0) * 1000],
      17: ['ref', () => w.vector(strokes.slice(1).map(stroke => () => w.table({
        0: ['ref', () => w.color(stroke.paint.color)], 1: ['int', 1], 2: ['float', stroke.w],
        3: ['int', stroke.paint.gradient ? 1 : 0],
        ...(stroke.paint.gradient ? { 4: ['ref', () => w.gradient(stroke.paint.gradient)] } : {}),
        5: ['int', 2],
      })))],
      20: ['int', fill.gradient ? 1 : 0],
      ...(fill.gradient ? { 21: ['ref', () => w.gradient(fill.gradient)] } : {}),
      22: ['int', firstStroke.gradient ? 1 : 0],
      ...(firstStroke.gradient ? { 23: ['ref', () => w.gradient(firstStroke.gradient)] } : {}),
      24: ['int', 2],
    });
  };
  const root = w.table({ 0: ['ref', () => w.table({
    0: ['ref', () => w.vector(parts.map(part => () => w.table({ 0: ['ref', () => w.string(part.text)], 1: ['ref', () => character(part.accent === 2 ? style.accent2 || style.fill : part.accent ? style.accent || style.fill : style.fill)] })))],
    1: ['ref', () => w.vector([() => w.string(fontName)])],
    4: ['int', 2], 11: ['int', 0], 18: ['int', 0], 23: ['int', 1], 26: ['int', 1], 30: ['int', 2], 43: ['int', 0], 44: ['int', 1],
  })] });
  return w.finish(root);
}

export function base64(bytes) {
  let out = ''; for (let i = 0; i < bytes.length; i += 16384) out += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(out);
}
