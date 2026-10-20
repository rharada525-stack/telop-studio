// テロップ描画エンジン（Python 版 short-template/engine/telop.py のブラウザ移植）
// 多重フチ・グラデ塗り・影/グロー・座布団・ワイプ・ブロック/1文字アニメ

// styles.json のフォントファイル名 → Web フォント
const WEBFONTS = {
  "NotoSansJP-Black.otf": { family: "Noto Sans JP", weight: 900 },
  "GenEiNuGothic-EB.ttf": { family: "M PLUS Rounded 1c", weight: 800 },
};
// st.family（フォント名を直接指定。PCに入っているフォントも可）があればそれを優先する
const fontCss = (st, size) => {
  if (st.family) return `${st.weight ?? 900} ${size}px "${st.family}", "Noto Sans JP", sans-serif`;
  const f = WEBFONTS[st.font] || { family: "Noto Sans JP", weight: 900 };
  return `${f.weight} ${size}px "${f.family}"`;
};

// ---------------------------------------------------------------- easing
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
const easeInCubic = (p) => p ** 3;
const easeInQuad = (p) => p * p;
const easeOutExpo = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
const easeOutBack = (p, k = 1.70158) => { p -= 1; return 1 + (k + 1) * p ** 3 + k * p ** 2; };
const easeInBack = (p, k = 1.70158) => (k + 1) * p ** 3 - k * p ** 2;
const easeOutElastic = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
function easeOutBounce(p) {
  const n1 = 7.5625, d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
  if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
  return n1 * (p -= 2.625 / d1) * p + 0.984375;
}

// ---------------------------------------------------------------- helpers
const canvas = (w, h) => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};

// 塗り: 色 / 色の配列（上→下）/ { stops: [色...], angle: 度 }（0°=上→下、90°=左→右。box の範囲にかける）
function paintStyle(ctx, paint, y0, y1, box) {
  if (typeof paint === "string") return paint;
  if (Array.isArray(paint)) {
    if (paint.length === 1) return paint[0];
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    paint.forEach((c, i) => g.addColorStop(i / (paint.length - 1), c));
    return g;
  }
  const stops = paint.stops || [];
  if (stops.length < 2) return stops[0] || "#ffffff";
  const b = box || { x0: 0, y0, x1: 0, y1 };
  const a = ((paint.angle || 0) * Math.PI) / 180;
  const dx = Math.sin(a), dy = Math.cos(a);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const half = Math.abs(((b.x1 - b.x0) / 2) * dx) + Math.abs(((b.y1 - b.y0) / 2) * dy) || 1;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

// { } = 強調色1、[ ] = 強調色2。返す値: 行ごとの [文字, 強調の種類(0/1/2)]
function parseMarkup(text) {
  const lines = [[]];
  let acc = 0;
  for (const ch of text) {
    if (ch === "{") acc = 1;
    else if (ch === "[") acc = 2;
    else if (ch === "}" || ch === "]") acc = 0;
    else if (ch === "\n") lines.push([]);
    else lines[lines.length - 1].push([ch, acc]);
  }
  return lines;
}

// 縦書きで90度回す文字・位置をずらす文字
const V_ROTATE = new Set([..."ー〜～…‥—―－-=~（）()「」『』【】［］〈〉《》｛｝<>＜＞：:；;"]);
const V_PUNCT = new Set([..."、。，．,."]);
const V_SMALL = new Set([..."ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ"]);

// ---------------------------------------------------------------- plate (座布団)
function renderPlate(pl, box) {
  const [x0, y0, x1, y1] = box;
  const H = y1 - y0;
  const k = ((pl.skew || 0) * H) / 2;
  const sw = pl.stroke ? pl.stroke.w : 0;
  const sh = pl.shadow;
  const mg = sw + 6 + (sh ? Math.abs(sh.dx) + Math.abs(sh.dy) + 3 * sh.blur : 0);
  const ox = x0 - mg - k, oy = y0 - mg;
  const c = canvas(x1 - x0 + 2 * mg + 2 * k + 2, H + 2 * mg + 2);
  const ctx = c.getContext("2d");

  const path = (e, band) => {
    const ax0 = x0 - ox - e, ay0 = y0 - oy - e, ax1 = x1 - ox + e, ay1 = y1 - oy + e;
    ctx.beginPath();
    if (pl.type === "slant") {
      if (band) {
        const t = (ay1 - ay0 - band) / (ay1 - ay0);
        ctx.moveTo(ax0 + k - 2 * k * t, ay1 - band); ctx.lineTo(ax1 + k - 2 * k * t, ay1 - band);
        ctx.lineTo(ax1 - k, ay1); ctx.lineTo(ax0 - k, ay1);
      } else {
        ctx.moveTo(ax0 + k, ay0); ctx.lineTo(ax1 + k, ay0); ctx.lineTo(ax1 - k, ay1); ctx.lineTo(ax0 - k, ay1);
      }
      ctx.closePath();
    } else {
      const r = Math.min((pl.radius || 0) + e, (ay1 - ay0) / 2);
      ctx.roundRect(ax0, ay0, ax1 - ax0, ay1 - ay0, r);
    }
  };
  if (sh) {
    ctx.save();
    ctx.filter = `blur(${sh.blur}px)`;
    ctx.translate(sh.dx, sh.dy);
    path(sw); ctx.fillStyle = sh.color; ctx.fill();
    ctx.restore();
  }
  if (sw) { path(sw); ctx.fillStyle = pl.stroke.color; ctx.fill(); }
  path(0); ctx.fillStyle = paintStyle(ctx, pl.fill, y0 - oy, y1 - oy); ctx.fill();
  if (pl.bar) { path(0, pl.bar.h); ctx.fillStyle = pl.bar.color; ctx.fill(); }
  return { img: c, ox, oy };
}

// ---------------------------------------------------------------- block
const CHAR_DUR = { pop: 0.26, type: 0.14, drop: 0.42 };

function charState(kind, u, size) {
  if (u < 0) return null;
  if (kind === "pop") {
    const p = clamp(u / CHAR_DUR.pop);
    return [Math.max(0.02, easeOutBack(p, 2.8)), (1 - easeOutCubic(p)) * 0.25 * size, clamp(p * 5), 0];
  }
  if (kind === "type") {
    const p = clamp(u / CHAR_DUR.type);
    return [1, (1 - easeOutCubic(p)) * 0.18 * size, p, 0];
  }
  if (kind === "drop") {
    const p = clamp(u / CHAR_DUR.drop);
    return [1, -(1 - easeOutBounce(p)) * 0.9 * size, clamp(p * 6), (1 - p) * -12];
  }
  return [1, 0, 1, 0];
}

const measureCtx = canvas(4, 4).getContext("2d", { willReadFrequently: true });

export class Block {
  constructor(st, text) {
    this.st = st;
    let size = st.size;
    const lines = parseMarkup(text);
    const trkEm = st.tracking || 0;
    const accScale = st.accent_scale || 1; // 強調部分だけ大きくする倍率
    const sz = (acc) => (acc ? size * accScale : size);
    const strokes = st.strokes || [];
    const shadows = st.shadows || [];
    const maxsw = Math.max(0, ...strokes.map((s) => s.w));
    const m = 4 + maxsw + Math.max(0, ...shadows.map((s) => Math.abs(s.dx) + Math.abs(s.dy) + 3 * s.blur));
    this.glyphs = [];
    let textW, textH;

    if (st.vertical) {
      // ---- 縦書き：右の列から左へ。文字は上から下へ
      const colH = (line) => line.reduce((a, [, acc]) => a + sz(acc) * (1 + trkEm), 0);
      const fit = Math.max(...lines.map(colH));
      if (st.max_height && fit > st.max_height) size = Math.floor((size * st.max_height) / fit);
      this.size = size;
      const colGap = size * (st.line_spacing || 1.15);
      textW = colGap * (lines.length - 1) + size * accScale;
      textH = Math.max(...lines.map(colH));
      lines.forEach((line, li) => {
        const cx = textW - (size * accScale) / 2 - li * colGap;
        let y = 0;
        for (const [ch, acc] of line) {
          const s = sz(acc);
          const cy = y + s / 2;
          if (ch.trim()) this.glyphs.push(this.makeGlyphV(ch, acc, s, cx, cy, m, maxsw, strokes, shadows, { x0: cx - s / 2, x1: cx + s / 2, y0: 0, y1: textH }));
          y += s * (1 + trkEm);
        }
      });
    } else {
      // ---- 横書き
      const lineW = (line, size) => line.reduce((a, [c, acc]) => {
        measureCtx.font = fontCss(st, acc ? size * accScale : size);
        return a + measureCtx.measureText(c).width;
      }, 0) + trkEm * size * Math.max(0, line.length - 1);
      if (st.max_width) {
        const w = Math.max(...lines.map((l) => lineW(l, size)));
        if (w > st.max_width) size = Math.floor((size * st.max_width) / w);
      }
      this.size = size;
      const lineHeight = (line) => Math.max(...line.map(([, acc]) => sz(acc)), size);
      const lh = (line) => lineHeight(line) * (st.line_spacing || 1.15);
      textW = Math.max(...lines.map((l) => lineW(l, size)));
      let by = 0;
      lines.forEach((line, li) => {
        const big = lineHeight(line);
        by += li === 0 ? 0.88 * big : lh(line);
        let pen = (textW - lineW(line, size)) / 2;
        for (const [ch, acc] of line) {
          const s = sz(acc);
          const font = fontCss(st, s);
          measureCtx.font = font;
          const mt = measureCtx.measureText(ch);
          if (ch.trim()) this.glyphs.push(this.makeGlyph(font, ch, acc, mt, pen, by, m, maxsw, strokes, shadows, 0.88 * s, 0.12 * s, textW, s));
          pen += mt.width + trkEm * size;
        }
      });
      textH = by + 0.12 * lineHeight(lines[lines.length - 1]);
    }

    this.plate = null;
    if (st.plate) {
      const [px, py] = st.plate.pad || [30, 15];
      // 画面幅いっぱいの帯（ビジネス系の字幕でよく使う）
      this.content = st.plate.full && st._W
        ? [textW / 2 - st._W / 2 - 2, -py, textW / 2 + st._W / 2 + 2, textH + py]
        : [-px, -py, textW + px, textH + py];
      this.plate = renderPlate(st.plate, this.content);
    } else {
      this.content = [0, 0, textW, textH];
    }
    const ax = (this.content[0] + this.content[2]) / 2;
    const ay = (this.content[1] + this.content[3]) / 2;
    const rects = this.glyphs.map((g) => [g.x, g.y, g.x + g.w, g.y + g.h]);
    if (this.plate) rects.push([this.plate.ox, this.plate.oy, this.plate.ox + this.plate.img.width, this.plate.oy + this.plate.img.height]);
    const mg = st.char ? 0.35 * size : 4;
    const hw = Math.max(...rects.map((r) => Math.max(ax - r[0], r[2] - ax))) + mg;
    const hh = Math.max(...rects.map((r) => Math.max(ay - r[1], r[3] - ay))) + mg;
    this.w = Math.ceil(2 * hw) + 1;
    this.h = Math.ceil(2 * hh) + 1;
    this.off = [hw - ax, hh - ay];
    this.contentW = this.content[2] - this.content[0];

    this.textImg = canvas(this.w, this.h);
    const tctx = this.textImg.getContext("2d");
    const nPass = this.glyphs.length ? this.glyphs[0].layers.length : 0;
    for (let k = 0; k < nPass; k++)
      for (const g of this.glyphs) tctx.drawImage(g.layers[k], g.x + this.off[0], g.y + this.off[1]);
    this.work = canvas(this.w, this.h);
    this.staticImg = this.textImg;
    if (this.plate) {
      this.staticImg = canvas(this.w, this.h);
      const sctx = this.staticImg.getContext("2d");
      sctx.drawImage(this.plate.img, this.plate.ox + this.off[0], this.plate.oy + this.off[1]);
      sctx.drawImage(this.textImg, 0, 0);
    }
    this.charEnd = st.char ? (st.char_delay || 0) + (st.stagger || 0.03) * this.glyphs.length + CHAR_DUR[st.char] : 0;
  }

  makeGlyph(font, ch, acc, mt, pen, by, m, maxsw, strokes, shadows, cap, desc, textW, size) {
    // 描く範囲は測った大きさより広めにとる（測り方が少しずれても文字が切れて線が残らないように）
    const l = Math.min(-mt.actualBoundingBoxLeft, -0.2 * size) - maxsw;
    const r = Math.max(mt.actualBoundingBoxRight, mt.width + 0.2 * size) + maxsw;
    const t = Math.min(-mt.actualBoundingBoxAscent, -1.1 * size) - maxsw;
    const b = Math.max(mt.actualBoundingBoxDescent, 0.35 * size) + maxsw;
    const g = { w: Math.ceil(r - l + 2 * m), h: Math.ceil(b - t + 2 * m) };
    const ox = m - l, oy = m - t;
    g.x = pen + l - m;
    g.y = by + t - m;
    // グラデーションをかける範囲 = その行の文字全体（字ごとにバラバラにならないように）
    const box = { x0: -g.x, x1: textW - g.x, y0: oy - cap, y1: oy + desc };
    this.paintGlyph(g, font, ch, acc, (ctx) => ctx.fillText(ch, ox, oy), (ctx) => ctx.strokeText(ch, ox, oy), maxsw, strokes, shadows, box);
    return g;
  }

  // 縦書きの1文字。cx, cy は文字の中心
  makeGlyphV(ch, acc, size, cx, cy, m, maxsw, strokes, shadows, colBox) {
    const font = fontCss(this.st, size);
    const S = Math.ceil(size * 1.6 + 2 * (maxsw + m));
    const g = { w: S, h: S, x: cx - S / 2, y: cy - S / 2 };
    let dx = 0, dy = 0;
    if (V_PUNCT.has(ch)) { dx = 0.32 * size; dy = -0.32 * size; }
    else if (V_SMALL.has(ch)) { dx = 0.08 * size; dy = -0.08 * size; }
    const rot = V_ROTATE.has(ch);
    const place = (ctx) => {
      ctx.translate(S / 2 + dx, S / 2 + dy);
      if (rot) ctx.rotate(Math.PI / 2);
      ctx.textAlign = "center";
    };
    const base = 0.38 * size; // CJK の字面の中心とベースラインの差
    const box = { x0: colBox.x0 - g.x, x1: colBox.x1 - g.x, y0: colBox.y0 - g.y, y1: colBox.y1 - g.y };
    this.paintGlyph(g, font, ch, acc,
      (ctx) => { ctx.save(); place(ctx); ctx.fillText(ch, 0, base); ctx.restore(); },
      (ctx) => { ctx.save(); place(ctx); ctx.strokeText(ch, 0, base); ctx.restore(); },
      maxsw, strokes, shadows, box);
    return g;
  }

  // 影 → 境界線（外側から）→ 塗り の順に、1文字分の層を作る
  paintGlyph(g, font, ch, acc, fill, stroke, maxsw, strokes, shadows, box) {
    const layer = (fn) => {
      const c = canvas(g.w, g.h);
      // 文字はCPUで描く（GPUで描くと、フォント読み込み直後に別の字の欠片が混ざることがある）
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.font = font;
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      fn(ctx);
      return c;
    };
    const shape = (ctx, w, style) => {
      ctx.fillStyle = style;
      fill(ctx);
      if (w > 0) { ctx.strokeStyle = style; ctx.lineWidth = 2 * w; stroke(ctx); }
    };
    g.layers = [];
    for (const sh of shadows)
      g.layers.push(layer((ctx) => {
        if (sh.blur) ctx.filter = `blur(${sh.blur}px)`;
        ctx.translate(sh.dx, sh.dy);
        shape(ctx, maxsw, sh.color);
      }));
    for (const s of [...strokes].reverse())
      g.layers.push(layer((ctx) => shape(ctx, s.w, paintStyle(ctx, s.color, box.y0 - s.w, box.y1 + s.w, box))));
    const st = this.st;
    const fillPaint = acc === 2 && st.accent2 ? st.accent2 : acc && st.accent ? st.accent : st.fill;
    g.layers.push(layer((ctx) => shape(ctx, 0, paintStyle(ctx, fillPaint, box.y0, box.y1, box))));
  }

  // 時刻 t のブロック画像（ブロック単位の変形は含まない）
  compose(t) {
    const st = this.st;
    const animatingPlate = this.plate && st.plate_anim === "wipe" && t < 0.32;
    if (!animatingPlate && (!st.char || t >= this.charEnd)) return this.staticImg;
    const ctx = this.work.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const [ox, oy] = this.off;
    if (this.plate) {
      const { img, ox: px, oy: py } = this.plate;
      let w = img.width;
      if (st.plate_anim === "wipe") w = Math.floor(img.width * easeOutCubic(clamp(t / 0.32)));
      if (w > 0) ctx.drawImage(img, 0, 0, w, img.height, px + ox, py + oy, w, img.height);
    }
    if (!st.char || t >= this.charEnd) {
      ctx.drawImage(this.textImg, 0, 0);
      return this.work;
    }
    const delay = st.char_delay || 0, stg = st.stagger || 0.03;
    const states = this.glyphs.map((_, i) => charState(st.char, t - delay - i * stg, this.size));
    const nPass = this.glyphs[0].layers.length;
    for (let k = 0; k < nPass; k++) {
      this.glyphs.forEach((g, i) => {
        const s = states[i];
        if (!s || s[2] <= 0) return;
        const [sc, dy, a, rot] = s;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(g.x + ox + g.w / 2, g.y + oy + g.h / 2 + dy);
        if (rot) ctx.rotate((rot * Math.PI) / 180);
        ctx.scale(sc, sc);
        ctx.drawImage(g.layers[k], -g.w / 2, -g.h / 2);
        ctx.restore();
      });
    }
    return this.work;
  }
}

// ---------------------------------------------------------------- block-level animation
export function blockState(st, t, d) {
  let s = 1, rot = 0, dx = 0, dy = 0, op = 1, sx = 1, sy = 1, wipe = 1, wipeFrom = 0;
  const k = st.in || "none";
  if (k === "slam") {
    const p = clamp(t / 0.28);
    s = p < 0.55 ? 2.6 + (0.9 - 2.6) * easeInQuad(p / 0.55) : 0.9 + 0.1 * easeOutBack((p - 0.55) / 0.45, 3);
    op = clamp(p / 0.18);
    const u = t - 0.15;
    if (u > 0 && u < 0.4) {
      const amp = (1 - u / 0.4) * 16;
      dx = amp * Math.sin(u * 95);
      dy = amp * Math.cos(u * 71);
    }
  } else if (k === "pop") {
    const p = clamp(t / 0.3);
    s = Math.max(0.02, easeOutBack(p, 2.2));
    op = clamp(p * 5);
  } else if (k === "drop") {
    const p = clamp(t / 0.55);
    dy = -(1 - easeOutBounce(p)) * 260;
    op = clamp(p * 6);
  } else if (k === "elastic") {
    const p = clamp(t / 0.75);
    s = Math.max(0.02, easeOutElastic(p));
    rot = Math.sin(t * 26) * 9 * (1 - p);
  } else if (k === "slide_left") {
    const p = clamp(t / 0.35);
    dx = -(1 - easeOutExpo(p)) * 900;
    op = clamp(p * 3);
  } else if (k === "fade") {
    op = clamp(t / 0.2);
  } else if (k === "fade_up") {
    const p = clamp(t / 0.25);
    dy = (1 - easeOutCubic(p)) * 40;
    op = p;
  } else if (k === "slide_right") { // 右からすべり込む
    const p = clamp(t / 0.35);
    dx = (1 - easeOutExpo(p)) * 900;
    op = clamp(p * 3);
  } else if (k === "slide_up") { // 下からすっと出る
    const p = clamp(t / 0.3);
    dy = (1 - easeOutCubic(p)) * 90;
    op = clamp(p * 2.5);
  } else if (k === "wipe") { // 左から右へ現れる
    wipe = easeOutCubic(clamp(t / 0.35));
  } else if (k === "bounce") { // ぴょんと弾んで出る
    const p = clamp(t / 0.5);
    dy = -(1 - easeOutBounce(p)) * 70;
    s = 0.85 + 0.15 * easeOutBack(clamp(t / 0.2), 2);
    op = clamp(p * 6);
  } else if (k === "jelly") { // ぷるんと出る
    const p = clamp(t / 0.6);
    const w = Math.sin(t * 28) * (1 - p) * 0.22;
    sx = 1 + w;
    sy = 1 - w;
    s = Math.max(0.02, easeOutBack(clamp(t / 0.18), 2));
    op = clamp(t / 0.08);
  } else if (k === "zoom_in") { // 小さい所からふわっと
    const p = clamp(t / 0.4);
    s = 0.55 + 0.45 * easeOutExpo(p);
    op = clamp(p * 2);
  }
  const idle = st.idle || "none";
  if (idle === "pulse") s *= 1 + 0.028 * Math.sin((2 * Math.PI * t) / 0.9);
  else if (idle === "float") {
    dy += Math.sin((2 * Math.PI * t) / 1.4) * 7;
    rot += Math.sin((2 * Math.PI * t) / 2.1) * 1.8;
  } else if (idle === "tremble") { // 小刻みに震える（ホラー・動揺）
    dx += Math.sin(t * 71) * 2.5;
    dy += Math.cos(t * 59) * 2.5;
  } else if (idle === "wobble") { // ゆらゆら
    rot += Math.sin((2 * Math.PI * t) / 1.2) * 3;
  }
  const od = st.out_d ?? 0.18;
  const q = od > 0 ? clamp((t - (d - od)) / od) : 0;
  if (q > 0) {
    const o = st.out || "fade";
    if (o === "fade") op *= 1 - q;
    else if (o === "zoom_out") { s *= 1 + 0.35 * easeInCubic(q); op *= 1 - q; }
    else if (o === "pop_out" || o === "shrink") { s *= Math.max(0.02, 1 - easeInBack(q, 2.2)); op *= 1 - q * q; }
    else if (o === "slide_out_left") dx -= easeInCubic(q) * 1200;
    else if (o === "slide_out_right") dx += easeInCubic(q) * 1200;
    else if (o === "wipe_out") { wipeFrom = easeInCubic(q); }
  }
  return { s, rot, dx, dy, op, sx, sy, wipe, wipeFrom };
}

function drawBlock(ctx, img, x, y, bs, staticRot) {
  if (bs.op <= 0.001 || bs.wipe <= 0.001 || bs.wipeFrom >= 0.999) return;
  ctx.save();
  ctx.globalAlpha = clamp(bs.op);
  ctx.translate(x + bs.dx, y + bs.dy);
  ctx.rotate(((bs.rot + (staticRot || 0)) * Math.PI) / 180);
  ctx.scale(bs.s * (bs.sx ?? 1), bs.s * (bs.sy ?? 1));
  if ((bs.wipe ?? 1) < 1 || (bs.wipeFrom ?? 0) > 0) {
    // ワイプ：見せる範囲を左から広げる／左から消す
    const x0 = -img.width / 2 + img.width * (bs.wipeFrom || 0);
    ctx.beginPath();
    ctx.rect(x0, -img.height / 2, img.width * Math.min(bs.wipe ?? 1, 1 - (bs.wipeFrom || 0)), img.height);
    ctx.clip();
  }
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
}

// ---------------------------------------------------------------- items
class TextItem {
  constructor(st, text, pos) {
    this.st = st;
    this.pos = pos;
    this.block = new Block(st, text);
  }
  width() { return this.block.contentW; }
  height() { return this.block.content[3] - this.block.content[1]; }
  center() { return this.pos[0]; }
  centerY() { return this.pos[1]; }
  shift(dx) { this.pos[0] += dx; }
  shiftY(dy) { this.pos[1] += dy; }
  draw(ctx, t, d) {
    drawBlock(ctx, this.block.compose(t), this.pos[0], this.pos[1], blockState(this.st, t, d), this.st.rotate);
  }
}

class GroupItem {
  constructor(st, styles, label, text, pos) {
    this.st = st;
    this.pos = pos;
    this.label = new Block(styles[st.label_style], label);
    this.body = new Block(styles[st.body_style], text);
    const total = this.label.contentW + (st.gap || 0) + this.body.contentW;
    this.labelX = pos[0] - total / 2 + this.label.contentW / 2;
    this.bodyX = pos[0] + total / 2 - this.body.contentW / 2;
    this.total = total;
  }
  width() { return this.total; }
  height() { return Math.max(...[this.label, this.body].map((b) => b.content[3] - b.content[1])); }
  center() { return (this.labelX - this.label.contentW / 2 + this.bodyX + this.body.contentW / 2) / 2; }
  centerY() { return this.pos[1]; }
  shift(dx) { this.labelX += dx; this.bodyX += dx; }
  shiftY(dy) { this.pos[1] += dy; }
  draw(ctx, t, d) {
    const bd = this.st.body_delay || 0;
    for (const [blk, x, t0] of [[this.body, this.bodyX, bd], [this.label, this.labelX, 0]]) {
      const lt = t - t0;
      if (lt < 0) continue;
      const sub = { ...blk.st, out: this.st.out || "fade", out_d: this.st.out_d ?? 0.18 };
      drawBlock(ctx, blk.compose(lt), x, this.pos[1], blockState(sub, lt, d - t0), blk.st.rotate);
    }
  }
}

class SpeedLines {
  constructor(st, W, H, fps) {
    this.fps = fps;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const [cx, cy] = st.center || [W / 2, H / 2];
    const R = Math.hypot(W, H);
    this.variants = [0, 1, 2].map(() => {
      const c = canvas(W, H);
      const ctx = c.getContext("2d");
      ctx.fillStyle = st.color;
      ctx.globalAlpha = st.alpha ?? 0.6;
      for (let i = 0; i < 120; i++) {
        const th = rnd() * 2 * Math.PI, dth = 0.003 + rnd() * 0.008, r0 = 400 + rnd() * 240;
        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(th), cy + r0 * Math.sin(th));
        ctx.lineTo(cx + R * Math.cos(th - dth), cy + R * Math.sin(th - dth));
        ctx.lineTo(cx + R * Math.cos(th + dth), cy + R * Math.sin(th + dth));
        ctx.fill();
      }
      return c;
    });
  }
  draw(ctx, t, d) {
    ctx.save();
    ctx.globalAlpha = clamp(t / 0.08) * (1 - clamp((t - (d - 0.15)) / 0.15));
    ctx.drawImage(this.variants[Math.floor((t * this.fps) / 2) % 3], 0, 0);
    ctx.restore();
  }
}

class Flash {
  constructor(st, W, H) { this.color = st.color; this.W = W; this.H = H; }
  draw(ctx, t, d) {
    ctx.save();
    ctx.globalAlpha = t < 0.05 ? clamp(t / 0.05) : 1 - easeOutCubic(clamp((t - 0.05) / (d - 0.05)));
    ctx.fillStyle = this.color;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- loading
export function resolveStyles(raw) {
  const out = {};
  const resolve = (name) => {
    const st = raw[name];
    if (!st.extends) return st;
    const { extends: base, ...rest } = st;
    return { ...resolve(base), ...rest };
  };
  for (const k of Object.keys(raw)) if (!k.startsWith("_")) out[k] = resolve(k);
  return out;
}

// フォントを読み込み、実際に描画に使える状態になるまで待つ。
// Chrome は読み込み完了の直後だと canvas にまだ反映されていないことがあり、そのまま作ると
// 文字の大きさを代わりのフォントで測ってしまい、文字の一部が切れて線のように残る。
const readyChars = new Set(); // 確認済みの「フォント|文字」。2回目からは待たない
async function ensureFonts(fonts, chars) {
  const keys = fonts.flatMap((f) => [...new Set(chars)].map((c) => `${f}|${c}`));
  if (keys.every((k) => readyChars.has(k))) return;
  await waitFonts(fonts, chars);
  keys.forEach((k) => readyChars.add(k));
}
async function waitFonts(fonts, chars) {
  for (let tries = 0; tries < 20; tries++) {
    await Promise.all(fonts.map((f) => document.fonts.load(f, chars).catch(() => {})));
    if (fonts.every((f) => document.fonts.check(f, chars))) {
      // 読み込み直後の反映待ち：測った幅が2回続けて同じになれば使える
      const probe = canvas(4, 4).getContext("2d");
      const widths = () => fonts.map((f) => { probe.font = f; return probe.measureText(chars).width; }).join(",");
      const w1 = widths();
      await new Promise((r) => setTimeout(r, 30));
      if (w1 === widths()) return;
    } else {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// フォントの該当サブセットを先に読み込んでから作る
export async function makeItem(it, styles, W, H, fps) {
  const st = styles[it.style];
  if (st.effect === "speedlines") return new SpeedLines(st, W, H, fps);
  if (st.effect === "flash") return new Flash(st, W, H);
  const fonts = st.group ? [styles[st.label_style], styles[st.body_style]] : [st];
  const chars = (it.label || "") + it.text;
  await ensureFonts(fonts.map((f) => fontCss(f, 100)), chars);
  const pos = [...(it.pos || st.pos || [W / 2, H / 2])];
  // _W は「画面幅いっぱいの帯」を作るときに使う
  const item = st.group ? new GroupItem(st, styles, it.label || "", it.text, pos) : new TextItem({ ...st, _W: W }, it.text, pos);
  // 左上・右上に置くときは、テロップの端を指定位置にそろえる
  const w = item.width();
  const align = it.align || st.align;
  if (align === "left" || align === "right") item.shift(align === "left" ? w / 2 : -w / 2);
  // 画面の外にはみ出さないように内側へ寄せる（字幕を左右に寄せたとき用）
  const cx = item.center();
  const margin = 24;
  if (w < W - 2 * margin) {
    if (cx - w / 2 < margin) item.shift(margin - (cx - w / 2));
    else if (cx + w / 2 > W - margin) item.shift(W - margin - (cx + w / 2));
  }
  // 上下も同じように画面の内側へ（2行になった強調テロップが下で切れないように）
  const h = item.height(), cy = item.centerY();
  if (h < H - 2 * margin) {
    if (cy - h / 2 < margin) item.shiftY(margin - (cy - h / 2));
    else if (cy + h / 2 > H - margin) item.shiftY(H - margin - (cy + h / 2));
  }
  return item;
}
