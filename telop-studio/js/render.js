// 1フレーム = 動画（出力の形に合わせる）+ テロップ を描く
import { makeItem } from "./telop.js?v=20261022-fonts1";

export const FPS = 30;
export const FORMATS = {
  portrait: { W: 1080, H: 1920 },  // 縦 9:16（ショート）
  landscape: { W: 1920, H: 1080 }, // 横 16:9
};

// styles.json の "_landscape" に書いた差分を、横長のときだけ上書きする
export function stylesFor(base, raw, aspect) {
  if (aspect !== "landscape") return base;
  const over = raw._landscape || {};
  const out = {};
  for (const [k, st] of Object.entries(base)) out[k] = over[k] ? { ...st, ...over[k] } : st;
  return out;
}

export class Renderer {
  constructor(base, raw) {
    this.base = base;
    this.raw = raw;
    this.cache = new Map(); // テロップの見た目が同じなら再利用（編集中も軽い）
    this.items = [];
    this.screens = [];
    this.overrides = () => ({});
    this.setFormat("portrait");
  }

  setFormat(aspect) {
    if (this.aspect === aspect) return;
    this.aspect = aspect;
    ({ W: this.W, H: this.H } = FORMATS[aspect]);
    this.restyle();
    const sw = Math.round(this.W / 20), sh = Math.round(this.H / 20);
    this.small = Object.assign(document.createElement("canvas"), { width: sw, height: sh });
  }

  // 字幕デザインなど、画面で変えたスタイルを上書きする（aspect => { subtitle: {...} }）
  setOverrides(fn) {
    this.overrides = fn;
    this.restyle();
  }

  restyle() {
    this.styles = { ...stylesFor(this.base, this.raw, this.aspect), ...this.overrides(this.aspect) };
    this.cache.clear();
  }

  async setItems(items) {
    const used = new Set();
    const built = [];
    this.screens = items.filter((it) => it.style === "__screen");
    for (const it of items) {
      if (it.style === "__screen") continue;
      const key = JSON.stringify([it.style, it.text || "", it.label || "", it.pos || "", it.align || ""]);
      used.add(key);
      if (!this.cache.has(key)) this.cache.set(key, await makeItem(it, this.styles, this.W, this.H, FPS));
      built.push({ ...it, obj: this.cache.get(key), z: this.styles[it.style].z ?? 5 });
    }
    for (const k of [...this.cache.keys()]) if (!used.has(k)) this.cache.delete(k);
    this.items = built.sort((a, b) => a.z - b.z || a.t - b.t);
  }

  // 画面効果（ズーム・モノクロ・暗く・揺れ）の時刻 t での強さ
  screenState(t) {
    const s = { zoom: 1, gray: 0, dark: 0, dx: 0, dy: 0 };
    for (const e of this.screens) {
      const u = t - e.t;
      if (u < 0 || u >= e.d) continue;
      const env = Math.min(Math.min(1, u / 0.12), Math.min(1, (e.d - u) / 0.2));
      if (e.effect === "zoom") {
        const pin = 1 - (1 - Math.min(1, u / 0.1)) ** 3; // パッと寄る
        const out = Math.min(1, (e.d - u) / 0.2);
        s.zoom = Math.max(s.zoom, 1 + 0.18 * pin * out);
      } else if (e.effect === "mono") s.gray = Math.max(s.gray, env);
      else if (e.effect === "dark") s.dark = Math.max(s.dark, env);
      else if (e.effect === "shake") {
        const amp = 18 * Math.max(0, 1 - u / 0.6);
        s.dx += amp * Math.sin(u * 83);
        s.dy += amp * Math.cos(u * 61);
      }
    }
    return s;
  }

  // src: <video>（回転は適用済み）または VideoFrame（rotation を自分で適用）
  drawVideo(ctx, src, layout, rotation = 0) {
    const { W, H } = this;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (!src) return;
    const isFrame = typeof VideoFrame !== "undefined" && src instanceof VideoFrame;
    const sw = isFrame ? src.displayWidth : src.videoWidth;
    const sh = isFrame ? src.displayHeight : src.videoHeight;
    if (!sw) return;
    const rot = isFrame ? rotation : 0;
    const swap = rot === 90 || rot === 270;
    const vw = swap ? sh : sw, vh = swap ? sw : sh; // 見た目の縦横
    const place = (c, cx, cy, f) => {
      c.save();
      c.translate(cx, cy);
      c.rotate((rot * Math.PI) / 180);
      c.drawImage(src, (-sw * f) / 2, (-sh * f) / 2, sw * f, sh * f);
      c.restore();
    };
    // おまかせ: 素材と出力の縦横が同じなら切り抜き、違えば全体表示（縦横が混ざった素材向け）
    if (layout === "auto") layout = vw > vh === W > H ? "cover" : "fit";
    if (layout === "fit") {
      // ぼかし背景 + 全体表示（縦横が違う素材向け）
      const s = this.small, sctx = s.getContext("2d");
      place(sctx, s.width / 2, s.height / 2, Math.max(s.width / vw, s.height / vh));
      ctx.save();
      ctx.imageSmoothingQuality = "high";
      ctx.filter = "blur(12px) brightness(0.6)";
      ctx.drawImage(s, -40, -40, W + 80, H + 80);
      ctx.restore();
      place(ctx, W / 2, H / 2, Math.min(W / vw, H / vh));
    } else {
      place(ctx, W / 2, H / 2, Math.max(W / vw, H / vh));
    }
  }

  draw(ctx, t, src, layout, rotation = 0) {
    const { W, H } = this;
    const fx = this.screenState(t);
    ctx.save();
    if (fx.zoom !== 1 || fx.dx || fx.dy) {
      // 顔のあたり（少し上）を中心に寄る
      const cx = W / 2, cy = H * 0.42;
      ctx.translate(cx + fx.dx, cy + fx.dy);
      ctx.scale(fx.zoom, fx.zoom);
      ctx.translate(-cx, -cy);
    }
    this.drawVideo(ctx, src, layout, rotation);
    ctx.restore();
    if (fx.gray > 0) {
      // 彩度をゼロに（モノクロ）
      ctx.save();
      ctx.globalCompositeOperation = "saturation";
      ctx.globalAlpha = fx.gray;
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (fx.dark > 0) {
      // 周りを暗く（ネガティブな雰囲気）
      ctx.save();
      const g = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.25, W / 2, H * 0.45, Math.hypot(W, H) * 0.6);
      g.addColorStop(0, `rgba(0,0,0,${0.25 * fx.dark})`);
      g.addColorStop(1, `rgba(0,0,0,${0.85 * fx.dark})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    for (const it of this.items) if (t >= it.t && t < it.t + it.d) it.obj.draw(ctx, t - it.t, it.d);
  }

  sfxEvents() {
    const ev = [];
    for (const it of this.items) {
      const st = this.styles[it.style];
      if (st.sfx) ev.push({ name: st.sfx, t: it.t + (st.sfx_offset || 0) });
    }
    return ev;
  }
}
