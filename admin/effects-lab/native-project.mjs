// Premiereの通常テキスト（AE.ADBE Text）のデータを作る。画像・動画・MOGRTは生成しない。
// privateな保存形式なので、実機検証が済むまでラボの検証用出力として扱う。
export const TICKS = 254016000000;
const encoder = new TextEncoder();
const esc = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));

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
  finish(root) { this.view.setUint32(0, this.length - 12, true); this.view.setUint32(8, 0x11223344, true); this.view.setUint32(12, root - 12, true); return this.bytes.slice(0, this.length); }
}

export function unsupported(style) {
  const reasons = [];
  if (style.group || style.vertical || style.effect) reasons.push('組み合わせ・縦書き・画面効果');
  if (style.in && style.in !== 'none' || style.out && style.out !== 'none' && style.out_d !== 0 || style.char || style.idle && style.idle !== 'none') reasons.push('動き');
  if (style.plate || style.shadows?.length) reasons.push('背景・影');
  const colors = [style.fill, ...(style.strokes || []).map(s => s.color), ...(style.accent ? [style.accent] : []), ...(style.accent2 ? [style.accent2] : [])];
  if (colors.some(color => typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color))) reasons.push('グラデーション・透明色');
  if (!Number.isFinite(style.size) || style.size <= 0 || style.size > 400) reasons.push('文字サイズ');
  if (style.family && style.family !== 'Noto Sans JP' || style.font && style.font !== 'NotoSansJP-Black.otf') reasons.push('フォント');
  return reasons;
}

export function makeTextData(text, style) {
  const why = unsupported(style); if (why.length) throw new Error(`この試作はまだ標準テキスト化の対象外です: ${why.join('、')}`);
  const parts = []; let current = '', accent = 0;
  const flush = () => { if (current) parts.push({ text: current.replace(/\r?\n/g, '\r'), accent }); current = ''; };
  for (const char of text) {
    if ('{}[]'.includes(char)) { flush(); accent = char === '{' ? 1 : char === '[' ? 2 : 0; } else current += char;
  }
  flush(); if (!parts.length) throw new Error('演出の文字を入力してください。');
  const w = new Writer(), strokes = style.strokes || [];
  const character = color => w.table({
    0: ['int', 0], 1: ['float', style.size], 2: ['ref', () => w.color(color)], 3: ['int', 1],
    4: ['ref', () => w.color(strokes[0]?.color || '#000000')], 5: ['int', !!strokes.length],
    6: ['float', strokes[0]?.w || 0], 7: ['float', (style.tracking || 0) * 1000],
    17: ['ref', () => w.vector(strokes.slice(1).map(stroke => () => w.table({ 0: ['ref', () => w.color(stroke.color)], 1: ['int', 1], 2: ['float', stroke.w], 3: ['int', 0], 5: ['int', 2] })))],
    20: ['int', 0], 22: ['int', 0], 24: ['int', 2],
  });
  const root = w.table({ 0: ['ref', () => w.table({
    0: ['ref', () => w.vector(parts.map(part => () => w.table({ 0: ['ref', () => w.string(part.text)], 1: ['ref', () => character(part.accent === 2 ? style.accent2 || style.fill : part.accent ? style.accent || style.fill : style.fill)] })))],
    1: ['ref', () => w.vector([() => w.string('NotoSansJP-Black')])],
    11: ['int', 0], 18: ['int', 0], 23: ['int', 1], 26: ['int', 1], 30: ['int', 2], 43: ['int', 0], 44: ['int', 1],
  })] });
  return w.finish(root);
}

function base64(bytes) {
  let out = ''; for (let i = 0; i < bytes.length; i += 16384) out += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(out);
}
function replaceTokens(text, values) { for (const [key, value] of Object.entries(values)) text = text.split(`__${key}__`).join(String(value)); return text; }

export function buildNativeProject(seed, { name, W, H, items }, uuid = () => crypto.randomUUID()) {
  if (!items.length || items.length > 200) throw new Error('1〜200個のテキストを指定してください。');
  if (![[1920, 1080], [1080, 1920]].some(([w, h]) => w === W && h === H)) throw new Error('画面の縦横サイズが不正です。');
  const baseIDs = new Set(seed.base.map(s => s.match(/ObjectID="(\d+)"/)?.[1]).filter(Boolean));
  const globalUIDs = new Map();
  for (const node of seed.base) for (const match of node.matchAll(/ObjectUID="([^"]+)"/g)) globalUIDs.set(match[1], uuid());
  const remap = (node, ids, uids) => node.replace(/\b(ObjectID|ObjectRef)="(\d+)"/g, (all, attr, id) => `${attr}="${ids.get(id) || id}"`)
    .replace(/\b(ObjectUID|ObjectURef)="([^"]+)"/g, (all, attr, id) => `${attr}="${uids.get(id) || globalUIDs.get(id) || id}"`)
    .replace(/<ClipID>[^<]+<\/ClipID>/g, () => `<ClipID>${uuid()}</ClipID>`);
  const common = { W, H, DURATION: Math.round(Math.max(...items.map(item => item.t + item.d)) * TICKS) };
  let nextID = Math.max(...baseIDs) + 1; const refs = [], clipNodes = [];
  items.forEach((item, index) => {
    const data = makeTextData(item.text, item.style), ids = new Map(), uids = new Map();
    for (const node of seed.clip) { const match = node.match(/ObjectID="(\d+)"/); if (match && !baseIDs.has(match[1])) ids.set(match[1], String(nextID++)); for (const match of node.matchAll(/ObjectUID="([^"]+)"/g)) uids.set(match[1], uuid()); }
    const pos = item.pos || item.style.pos || [W / 2, H / 2];
    const values = { ...common, NATIVE_TEXT: base64(data), TEXT_HASH: uuid(), START: Math.round(item.t * TICKS), END: Math.round((item.t + item.d) * TICKS),
      DURATION: Math.round(item.d * TICKS), X: pos[0] / W, Y: pos[1] / H, ROT: item.style.rotate || 0 };
    refs.push(`<TrackItem Index="${index}" ObjectRef="${ids.get(seed.clipID)}"/>`);
    for (const node of seed.clip) clipNodes.push(replaceTokens(remap(node, ids, uids), values)
      .replace(/(<Node\b[^>]*>\s*<ID>)\d+(<\/ID>)/g, (all, before, after) => `${before}${1000000 + nextID++}${after}`)
      .replace(/<Name>Telop Studio<\/Name>/g, `<Name>${esc(item.text.replace(/[{}\[\]]/g, '').slice(0, 80))}</Name>`));
  });
  const nodes = seed.base.map(node => {
    if (node.includes(`ObjectUID="${seed.trackUID}"`)) node = node.replace(/<TrackItems\b[^>]*\/>/, `<TrackItems Version="1">${refs.join('')}</TrackItems>`);
    return replaceTokens(remap(node, new Map(), new Map()), common).replace(/<Name>Telop Studio<\/Name>/g, `<Name>${esc(name)}</Name>`).replace(/<NextID>[^<]+<\/NextID>/g, `<NextID>${nextID + 1000000}</NextID>`);
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?><PremiereData Version="3"><Project ObjectRef="1"/>${nodes.join('')}${clipNodes.join('')}</PremiereData>`;
  if (/__[A-Z_]+__/.test(xml)) throw new Error('プロジェクトの生成に未解決の項目があります。');
  return xml;
}

export async function compressProject(xml) {
  const stream = new Blob([xml]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/octet-stream' });
}
