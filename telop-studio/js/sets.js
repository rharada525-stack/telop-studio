// デザインセット：字幕のデザインと「演出の見た目の差し替え」をまとめて切り替える
import { DEFAULT_DESIGN, normalizeDesign } from "./design.js";

const stroke = (color, width) => ({ color, width, gradient: false, color2: "#555555", useMid: false, colorMid: "#ffffff", angle: 0 });

export const DESIGN_SETS = {
  standard: {
    name: "標準（テレビ風）",
    note: "白文字＋黒フチの字幕と、カラフルな演出テロップ",
    subtitle: DEFAULT_DESIGN,
    fxMap: {},
    autoMode: null,
  },
  entertainment: {
    name: "エンタメ切り抜き風（ショート向け）",
    note: "太い字幕、画面いっぱいの縦書き、黒枠の白い箱。オチは筆文字",
    subtitle: {
      ...DEFAULT_DESIGN,
      size: 64,
      fill: { color: "#ffffff" },
      accent: "#ff3b6b",
      accent2: "#3bb4ff",
      strokes: [stroke("#111111", 11)],
      shadow: { on: true, color: "#000000", opacity: 60, angle: 180, distance: 6, blur: 6 },
      pos: { portrait: [540, 1420], landscape: [960, 960] },
    },
    // 演出の種類 → 使うスタイル
    fxMap: { keyword: "vertical_big", hook: "vertical_big", reveal: "brush_title", cta_main: "box_quote" },
    autoMode: "short",
  },
  business: {
    name: "ビジネス講義風（長尺向け）",
    note: "下の黒帯に白い明朝の字幕、要点は大きな2色の強調、見出しは左上のコーナー名",
    subtitle: {
      ...DEFAULT_DESIGN,
      family: "Shippori Mincho B1",
      weight: 800,
      size: 58,
      maxChars: { portrait: 14, landscape: 24 },
      fill: { color: "#ffffff" },
      accent: "#ffd84a",
      accent2: "#7fd3ff",
      strokes: [],
      shadow: { on: false, color: "#000000", opacity: 0, angle: 180, distance: 0, blur: 0 },
      plate: { on: true, full: true, color: "#000000", opacity: 62, padX: 28, padY: 14, radius: 0 },
      pos: { portrait: [540, 1450], landscape: [960, 990] },
    },
    fxMap: { keyword: "biz_emph", hook: "biz_emph", reveal: "biz_emph", cta_main: "biz_emph", point: "corner_label", tsukkomi: "handwrite", tsukkomi_green: "handwrite" },
    autoMode: "long",
  },
};

export const setDesign = (key) => normalizeDesign(structuredClone(DESIGN_SETS[key]?.subtitle || DEFAULT_DESIGN));
