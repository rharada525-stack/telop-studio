// CanvasとXMLで共用する、秒単位のテキスト全体の動き。DOMには依存しない。
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
