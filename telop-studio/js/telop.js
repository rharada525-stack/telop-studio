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

function parseMarkup(text) {
  const lines = [[]];
  let acc = false;
  for (const ch of text) {
    if (ch === "{") acc = true;
    else if (ch === "}") acc = false;
    else if (ch === "\n") lines.push([]);
    else lines[lines.length - 1].push([ch, acc]);
  }
  return lines;
}

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
    const lineW = (line, size) => {
      measureCtx.font = fontCss(st, size);
      return line.reduce((a, [c]) => a + measureCtx.measureText(c).width, 0) + trkEm * size * Math.max(0, line.length - 1);
    };
    if (st.max_width) {
      const w = Math.max(...lines.map((l) => lineW(l, size)));
      if (w > st.max_width) size = Math.floor((size * st.max_width) / w);
    }
    this.size = size;
    const font = fontCss(st, size);
    const lh = size * (st.line_spacing || 1.15);
    const strokes = st.strokes || [];
    const shadows = st.shadows || [];
    const maxsw = Math.max(0, ...strokes.map((s) => s.w));
    const m = 4 + maxsw + Math.max(0, ...shadows.map((s) => Math.abs(s.dx) + Math.abs(s.dy) + 3 * s.blur));
    const textW = Math.max(...lines.map((l) => lineW(l, size)));
    const cap = 0.88 * size, desc = 0.12 * size;
    const textH = lh * (lines.length - 1) + cap + desc;

    this.glyphs = [];
    lines.forEach((line, li) => {
      const by = cap + li * lh;
      let pen = (textW - lineW(line, size)) / 2;
      for (const [ch, acc] of line) {
        measureCtx.font = font;
        const mt = measureCtx.measureText(ch);
        if (ch.trim()) this.glyphs.push(this.makeGlyph(font, ch, acc, mt, pen, by, m, maxsw, strokes, shadows, cap, desc, textW));
        pen += mt.width + trkEm * size;
      }
    });

    this.plate = null;
    if (st.plate) {
      const [px, py] = st.plate.pad || [30, 15];
      this.content = [-px, -py, textW + px, textH + py];
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

  makeGlyph(font, ch, acc, mt, pen, by, m, maxsw, strokes, shadows, cap, desc, textW) {
    // 描く範囲は測った大きさより広めにとる（測り方が少しずれても文字が切れて線が残らないように）
    const size = this.size;
    const l = Math.min(-mt.actualBoundingBoxLeft, -0.2 * size) - maxsw;
    const r = Math.max(mt.actualBoundingBoxRight, mt.width + 0.2 * size) + maxsw;
    const t = Math.min(-mt.actualBoundingBoxAscent, -1.1 * size) - maxsw;
    const b = Math.max(mt.actualBoundingBoxDescent, 0.35 * size) + maxsw;
    const g = { w: Math.ceil(r - l + 2 * m), h: Math.ceil(b - t + 2 * m) };
    const ox = m - l, oy = m - t;
    g.x = pen + l - m;
    g.y = by + t - m;
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
      ctx.fillText(ch, ox, oy);
      if (w > 0) { ctx.strokeStyle = style; ctx.lineWidth = 2 * w; ctx.strokeText(ch, ox, oy); }
    };
    g.layers = [];
    for (const sh of shadows)
      g.layers.push(layer((ctx) => {
        if (sh.blur) ctx.filter = `blur(${sh.blur}px)`;
        ctx.translate(sh.dx, sh.dy);
        shape(ctx, maxsw, sh.color);
      }));
    // グラデーションをかける範囲 = その行の文字全体（字ごとにバラバラにならないように）
    const box = { x0: -g.x, x1: textW - g.x, y0: oy - cap, y1: oy + desc };
    for (const s of [...strokes].reverse())
      g.layers.push(layer((ctx) => shape(ctx, s.w, paintStyle(ctx, s.color, box.y0 - s.w, box.y1 + s.w, box))));
    const fill = acc && this.st.accent ? this.st.accent : this.st.fill;
    g.layers.push(layer((ctx) => shape(ctx, 0, paintStyle(ctx, fill, oy - cap, oy + desc, box))));
    return g;
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
  let s = 1, rot = 0, dx = 0, dy = 0, op = 1;
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
  }
  const idle = st.idle || "none";
  if (idle === "pulse") s *= 1 + 0.028 * Math.sin((2 * Math.PI * t) / 0.9);
  else if (idle === "float") {
    dy += Math.sin((2 * Math.PI * t) / 1.4) * 7;
    rot += Math.sin((2 * Math.PI * t) / 2.1) * 1.8;
  }
  const od = st.out_d ?? 0.18;
  const q = od > 0 ? clamp((t - (d - od)) / od) : 0;
  if (q > 0) {
    const o = st.out || "fade";
    if (o === "fade") op *= 1 - q;
    else if (o === "zoom_out") { s *= 1 + 0.35 * easeInCubic(q); op *= 1 - q; }
    else if (o === "pop_out" || o === "shrink") { s *= Math.max(0.02, 1 - easeInBack(q, 2.2)); op *= 1 - q * q; }
    else if (o === "slide_out_left") dx -= easeInCubic(q) * 1200;
  }
  return { s, rot, dx, dy, op };
}

function drawBlock(ctx, img, x, y, bs, staticRot) {
  if (bs.op <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = clamp(bs.op);
  ctx.translate(x + bs.dx, y + bs.dy);
  ctx.rotate(((bs.rot + (staticRot || 0)) * Math.PI) / 180);
  ctx.scale(bs.s, bs.s);
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
  center() { return this.pos[0]; }
  shift(dx) { this.pos[0] += dx; }
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
  center() { return (this.labelX - this.label.contentW / 2 + this.bodyX + this.body.contentW / 2) / 2; }
  shift(dx) { this.labelX += dx; this.bodyX += dx; }
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
  const item = st.group ? new GroupItem(st, styles, it.label || "", it.text, pos) : new TextItem(st, it.text, pos);
  // 左上・右上に置くときは、テロップの端を指定位置にそろえる
  const w = item.width();
  if (it.align === "left" || it.align === "right") item.shift(it.align === "left" ? w / 2 : -w / 2);
  // 画面の外にはみ出さないように内側へ寄せる（字幕を左右に寄せたとき用）
  const cx = item.center();
  const margin = 24;
  if (w < W - 2 * margin) {
    if (cx - w / 2 < margin) item.shift(margin - (cx - w / 2));
    else if (cx + w / 2 > W - margin) item.shift(W - margin - (cx + w / 2));
  }
  return item;
}
