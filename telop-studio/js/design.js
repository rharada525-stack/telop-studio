// 字幕（デフォルトテロップ）のデザイン設定。Premiere のエッセンシャルグラフィックスに近い項目を数値で決める。

export const DEFAULT_DESIGN = {
  version: 1,
  family: "Noto Sans JP",
  weight: 900,
  size: 66,
  tracking: 0,   // 字間（1/1000 文字。Premiere と同じ単位）
  leading: 12,   // 行間（px）
  maxChars: { portrait: 13, landscape: 26 }, // 1行に入れる文字数の目安
  fill: "#ffffff",
  accent: "#ffe14d", // { } で囲んだ文字の色
  stroke1: { on: true, color: "#121212", width: 9 },
  stroke2: { on: false, color: "#ffffff", width: 6 },
  shadow: { on: true, color: "#000000", opacity: 55, angle: 180, distance: 5, blur: 6 },
  plate: { on: false, color: "#000000", opacity: 60, padX: 28, padY: 12, radius: 10 },
  pos: { portrait: [540, 1390], landscape: [960, 950] },
  animation: "none", // none | fade | type | pop
};

export const WEB_FONTS = ["Noto Sans JP", "M PLUS Rounded 1c", "Zen Maru Gothic", "Dela Gothic One", "Kosugi Maru", "BIZ UDPGothic", "Noto Serif JP"];

const hexA = (hex, opacity) => hex.slice(0, 7) + Math.round((Math.max(0, Math.min(100, opacity)) / 100) * 255).toString(16).padStart(2, "0");

// 足りない項目を初期値で埋める（古い保存データや手書きのファイルでも読めるように）
export function normalizeDesign(d) {
  const out = structuredClone(DEFAULT_DESIGN);
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b || {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) merge(a[k], v);
      else if (k in a) a[k] = v;
    }
  };
  merge(out, d);
  return out;
}

// デザイン → テロップエンジンのスタイル
export function designToStyle(d, aspect) {
  const strokes = [];
  let w = 0;
  for (const s of [d.stroke1, d.stroke2]) {
    if (s.on && s.width > 0) {
      w += Number(s.width);
      strokes.push({ w, color: s.color });
    }
  }
  const shadows = [];
  if (d.shadow.on) {
    const a = (d.shadow.angle * Math.PI) / 180;
    shadows.push({
      dx: Math.round(d.shadow.distance * Math.sin(a)),
      dy: Math.round(-d.shadow.distance * Math.cos(a)),
      blur: Number(d.shadow.blur),
      color: hexA(d.shadow.color, d.shadow.opacity),
    });
  }
  const anim = {
    none: { in: "none", out: "none", out_d: 0 },
    fade: { in: "fade", out: "fade", out_d: 0.15 },
    type: { in: "none", char: "type", stagger: 0.022, out: "fade", out_d: 0.12 },
    pop: { in: "none", char: "pop", stagger: 0.03, out: "fade", out_d: 0.12 },
  }[d.animation] || { in: "none", out: "none", out_d: 0 };
  return {
    z: 3,
    family: d.family,
    weight: Number(d.weight),
    size: Number(d.size),
    tracking: d.tracking / 1000,
    line_spacing: (Number(d.size) + Number(d.leading)) / Number(d.size),
    max_width: aspect === "landscape" ? 1800 : 1000,
    fill: d.fill,
    accent: d.accent,
    strokes,
    shadows,
    plate: d.plate.on
      ? { type: "round", radius: Number(d.plate.radius), fill: hexA(d.plate.color, d.plate.opacity), pad: [Number(d.plate.padX), Number(d.plate.padY)] }
      : undefined,
    pos: d.pos[aspect],
    idle: "none",
    sfx: null,
    ...anim,
  };
}

// ---------------------------------------------------------------- 設定パネル
// 項目: [ラベル, パス, 種類, オプション]
const SECTIONS = [
  ["文字", [
    ["フォント", "family", "font"],
    ["太さ", "weight", "select", [[400, "標準"], [500, "中"], [700, "太"], [800, "極太"], [900, "最太"]]],
    ["サイズ", "size", "num", { min: 10, max: 300, unit: "px" }],
    ["字間", "tracking", "num", { min: -200, max: 1000, unit: "/1000" }],
    ["行間", "leading", "num", { min: -50, max: 200, unit: "px" }],
    ["1行の文字数（縦）", "maxChars.portrait", "num", { min: 4, max: 40, unit: "字" }],
    ["1行の文字数（横）", "maxChars.landscape", "num", { min: 4, max: 60, unit: "字" }],
  ]],
  ["塗り", [
    ["文字の色", "fill", "color"],
    ["強調の色 { }", "accent", "color"],
  ]],
  ["境界線（内側）", [
    ["使う", "stroke1.on", "check"],
    ["色", "stroke1.color", "color"],
    ["幅", "stroke1.width", "num", { min: 0, max: 60, unit: "px" }],
  ]],
  ["境界線（外側）", [
    ["使う", "stroke2.on", "check"],
    ["色", "stroke2.color", "color"],
    ["幅", "stroke2.width", "num", { min: 0, max: 60, unit: "px" }],
  ]],
  ["シャドウ", [
    ["使う", "shadow.on", "check"],
    ["色", "shadow.color", "color"],
    ["不透明度", "shadow.opacity", "num", { min: 0, max: 100, unit: "%" }],
    ["角度", "shadow.angle", "num", { min: 0, max: 360, unit: "°" }],
    ["距離", "shadow.distance", "num", { min: 0, max: 100, unit: "px" }],
    ["ブラー", "shadow.blur", "num", { min: 0, max: 100, unit: "px" }],
  ]],
  ["背景（座布団）", [
    ["使う", "plate.on", "check"],
    ["色", "plate.color", "color"],
    ["不透明度", "plate.opacity", "num", { min: 0, max: 100, unit: "%" }],
    ["余白（横）", "plate.padX", "num", { min: 0, max: 200, unit: "px" }],
    ["余白（縦）", "plate.padY", "num", { min: 0, max: 200, unit: "px" }],
    ["角の丸み", "plate.radius", "num", { min: 0, max: 200, unit: "px" }],
  ]],
  ["位置（いまの出力の形）", [
    ["X（中心）", "pos.@.0", "num", { min: 0, max: 1920, unit: "px" }],
    ["Y（中心）", "pos.@.1", "num", { min: 0, max: 1920, unit: "px" }],
  ]],
  ["動き", [
    ["アニメーション", "animation", "select", [["none", "なし（標準）"], ["fade", "フェード"], ["type", "1文字ずつ表示"], ["pop", "1文字ずつポップ"]]],
  ]],
];

const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => {
  const ks = p.split(".");
  const last = ks.pop();
  const t = ks.reduce((a, k) => a[k], o);
  t[last] = v;
};

// container に入力欄を作る。getDesign/getAspect は今の値、onChange はデザインが変わったとき
export function buildDesignPanel(container, { getDesign, getAspect, onChange }) {
  container.innerHTML = "";
  const inputs = [];
  const fontList = document.createElement("datalist");
  fontList.id = "fontList";
  const fillFonts = (local = []) => {
    fontList.innerHTML = "";
    for (const f of [...WEB_FONTS, ...local]) fontList.appendChild(Object.assign(document.createElement("option"), { value: f }));
  };
  fillFonts();
  container.appendChild(fontList);

  for (const [title, fields] of SECTIONS) {
    const sec = document.createElement("fieldset");
    sec.className = "dz-sec";
    sec.innerHTML = `<legend>${title}</legend>`;
    for (const [label, rawPath, type, opt] of fields) {
      const row = document.createElement("label");
      row.className = `dz-row dz-${type}`;
      row.append(Object.assign(document.createElement("span"), { textContent: label }));
      let el;
      if (type === "select") {
        el = document.createElement("select");
        for (const [v, t] of opt) el.appendChild(Object.assign(document.createElement("option"), { value: v, textContent: t }));
      } else if (type === "check") {
        el = Object.assign(document.createElement("input"), { type: "checkbox" });
      } else if (type === "color") {
        el = Object.assign(document.createElement("input"), { type: "color" });
      } else if (type === "font") {
        el = Object.assign(document.createElement("input"), { type: "text", placeholder: "フォント名" });
        el.setAttribute("list", "fontList");
      } else {
        el = Object.assign(document.createElement("input"), { type: "number", min: opt.min, max: opt.max, step: 1 });
      }
      row.append(el);
      if (opt?.unit) row.append(Object.assign(document.createElement("small"), { textContent: opt.unit }));
      if (type === "font") {
        const btn = Object.assign(document.createElement("button"), { type: "button", className: "ghost small", textContent: "PCのフォント" });
        btn.title = "このパソコンに入っているフォントを候補に追加します";
        btn.onclick = async () => {
          if (!("queryLocalFonts" in window)) { alert("このブラウザではPCのフォント一覧を取得できません。フォント名を直接入力してください。"); return; }
          try {
            const fonts = await window.queryLocalFonts();
            fillFonts([...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b, "ja")));
            btn.textContent = "追加しました";
          } catch { alert("フォントの読み取りが許可されませんでした。フォント名を直接入力しても使えます。"); }
        };
        row.append(btn);
      }
      const path = () => rawPath.replace("@", getAspect());
      const read = () => {
        const v = getPath(getDesign(), path());
        if (type === "check") el.checked = !!v;
        else el.value = v;
      };
      const write = () => {
        const d = getDesign();
        let v = type === "check" ? el.checked : el.value;
        if (type === "num") { v = Number(v); if (Number.isNaN(v)) return; }
        if (type === "select" && /^\d+$/.test(v)) v = Number(v);
        setPath(d, path(), v);
        onChange(d);
      };
      el.addEventListener(type === "check" || type === "select" || type === "color" ? "change" : "input", write);
      if (type === "color") el.addEventListener("input", write);
      inputs.push(read);
      sec.appendChild(row);
    }
    container.appendChild(sec);
  }
  const refresh = () => inputs.forEach((r) => r());
  refresh();
  return refresh;
}
