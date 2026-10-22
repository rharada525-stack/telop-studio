// 本体のタイムラインを通し、演出の組み合わせ・位置・表示時間も同じ条件で試す。
import { FX, buildItems } from '../../telop-studio/js/timeline.js';
import { DESIGN_SETS, setDesign } from '../../telop-studio/js/sets.js';
import { designToStyle } from '../../telop-studio/js/design.js';
import { NATIVE_PRESETS, DESIGN_VARIANTS, DEFAULT_FONT, FONT_CHOICES, nativeStyles } from './native-presets.mjs?v=20261023-rich1';
export const EFFECTS = { ...Object.fromEntries(Object.entries(NATIVE_PRESETS).map(([id, preset]) => [id, { name: preset.name, style: id }])), ...FX };

export const STORAGE_KEY = 'telop-studio:effects-lab:v1';
export const SAMPLES = {
  ...Object.fromEntries(Object.entries(NATIVE_PRESETS).map(([id, preset]) => [id, preset.sample])),
  keyword: 'ここが{大事なポイント}', hook: '実は{逆効果}でした',
  tsukkomi: 'なんでやねん！', tsukkomi_green: 'それは知らなかった！',
  point: 'その1/まずは{結論}から', reveal: 'まさかの{大成功}！',
  cta_main: 'ぜひ{試して}みてください', vertical: '継続は{力}なり',
  quote: 'あなたなら{どうする}？', biz: '{伝える力}を磨く',
  corner: '今日の{ポイント}', next: 'この後、{驚きの展開}…',
  hand: 'ちょっと待って〜', horror: '何かが{おかしい}…',
  note: '※これは演出のテストです', name: '動画講師　{サンプル}',
  brush: '{挑戦}はここから', '': '画面効果のテスト',
};
export function newDraft() {
  return { version: 1, name: '新しい試作', fx: 'xml_pop', aspect: 'landscape', set: 'standard',
    design: 'classic', font: structuredClone(DEFAULT_FONT), text: SAMPLES.xml_pop, subtitle: '字幕と演出の重なりも確認できます', separate: false,
    position: 'auto', screen: 'auto', duration: 3, overrides: { portrait: {}, landscape: {} } };
}

// JSONは試作専用の形式だけを受け入れ、公開用のプロジェクトと混ぜない。
export function validateDraft(value, styleNames) {
  if (!value || value.version !== 1 || typeof value.name !== 'string' || !Object.hasOwn(EFFECTS, value.fx) ||
      !['portrait', 'landscape'].includes(value.aspect) || !Object.hasOwn(DESIGN_SETS, value.set) ||
      typeof value.separate !== 'boolean' || typeof value.text !== 'string' || value.text.length > 300 || typeof value.subtitle !== 'string' || value.subtitle.length > 300 ||
      !Number.isFinite(value.duration) || value.duration < 0.5 || value.duration > 12 ||
      !['auto', 'tl', 'top', 'tr', 'center', 'bottom'].includes(value.position) ||
      !['auto', 'none', 'zoom', 'zoom_lines', 'lines', 'flash', 'mono_dark', 'dark', 'mono', 'shake'].includes(value.screen)) {
    throw new Error('演出テスト用のJSONを選んでください。');
  }
  if (value.design != null && value.design !== '' && !Object.hasOwn(DESIGN_VARIANTS, value.design)) throw new Error('不明なデザインです。');
  if (value.font != null) validateFont(value.font);
  const out = { ...newDraft(), ...structuredClone(value), design: value.design ?? '', font: value.font ?? null, name: value.name.slice(0, 80), overrides: { portrait: {}, landscape: {} } };
  for (const aspect of ['portrait', 'landscape']) {
    for (const [key, st] of Object.entries(value.overrides?.[aspect] || {})) {
      if (!styleNames.includes(key)) throw new Error(`不明なスタイル: ${key}`);
      validateStyle(st, styleNames);
      out.overrides[aspect][key] = st;
    }
  }
  return out;
}

export function validateStyle(st, names) {
  if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('スタイルはJSONオブジェクトで指定してください。');
  // 巨大キャンバスや循環するグループ参照を試作JSONから作らない。
  const walk = (value, depth = 0) => {
    if (depth > 8) throw new Error('スタイルの階層が深すぎます。');
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 10000)) throw new Error('数値は-10000〜10000で指定してください。');
    if (typeof value === 'string' && value.length > 200) throw new Error('スタイルの文字列が長すぎます。');
    if (Array.isArray(value) && value.length > 20) throw new Error('配列の要素が多すぎます。');
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype', 'extends'].includes(k)) throw new Error('このキーは試作では使えません。');
      walk(v, depth + 1);
    }
  };
  walk(st);
  const limit = (key, min, max) => { if (st[key] != null && (!Number.isFinite(st[key]) || st[key] < min || st[key] > max)) throw new Error(`${key}は${min}〜${max}で指定してください。`); };
  limit('size', 1, 400); limit('tracking', -1, 1); limit('line_spacing', .3, 3);
  limit('stagger', 0, .3); limit('char_delay', 0, 3); limit('out_d', 0, 3);
  for (const stroke of st.strokes || []) if (!Number.isFinite(stroke.w) || stroke.w < 0 || stroke.w > 80) throw new Error('境界線は0〜80pxで指定してください。');
  for (const shadow of [...(st.shadows || []), ...(st.plate?.shadow ? [st.plate.shadow] : [])]) {
    if (!['dx', 'dy', 'blur'].every(key => Number.isFinite(shadow[key])) || shadow.blur < 0 || shadow.blur > 100 || Math.abs(shadow.dx) > 300 || Math.abs(shadow.dy) > 300) throw new Error('影は距離±300px・ぼかし0〜100pxで指定してください。');
  }
  for (const key of ['max_width', 'max_height']) if (st[key] != null && (!Number.isFinite(st[key]) || st[key] < 1 || st[key] > 2400)) throw new Error(`${key}は1〜2400で指定してください。`);
  if (st.group && (!names.includes(st.label_style) || !names.includes(st.body_style))) throw new Error('見出し・本文のスタイルが見つかりません。');
  if (st.pos && (!Array.isArray(st.pos) || st.pos.length !== 2 || !st.pos.every(Number.isFinite))) throw new Error('posは[X, Y]で指定してください。');
  if (st.char && !['pop', 'type', 'drop'].includes(st.char)) throw new Error('1文字の動きはpop / type / dropから選んでください。');
  return st;
}

export function sceneFor(draft) {
  const start = 0.5, end = start + draft.duration, total = end + 0.7;
  const design = setDesign(draft.set);
  const native = Object.hasOwn(NATIVE_PRESETS, draft.fx);
  const effectStyle = native ? draft.fx : DESIGN_SETS[draft.set].fxMap[draft.fx] || FX[draft.fx]?.style || 'subtitle';
  const settings = { aspect: draft.aspect, autoHighlight: false, fxMap: DESIGN_SETS[draft.set].fxMap,
    speakers: [{ id: 'A', design }] };
  if (native) settings.fxMap = { ...settings.fxMap, keyword: draft.fx };
  const lines = [{ id: 'test', src: [start, end], text: draft.separate ? draft.subtitle : draft.text,
    fx: native ? 'keyword' : draft.fx, fxText: draft.separate || native ? draft.text : '',
    fxPos: draft.position === 'auto' && draft.aspect === 'landscape' ? 'bottom' : draft.position === 'auto' && native ? NATIVE_PRESETS[draft.fx].position || 'auto' : draft.position, screen: draft.screen, speaker: 'A' }];
  const items = buildItems(lines, [{ start: 0, end: total, out: 0 }], settings)
    .filter(item => draft.separate || !item.style.startsWith('subtitle'))
    .map(item => ({ ...item, ...(native && item.style === draft.fx ? { t: start, d: draft.duration } : {}),
      ...(draft.aspect === 'landscape' && draft.position === 'auto' && draft.fx && item.style === effectStyle ? { pos: [960, 900] } : {}) }));
  return { total, start, end, items,
    subtitle: designToStyle(design, draft.aspect), style: effectStyle };
}

export const DEFAULTS_KEY = `${STORAGE_KEY}:design-defaults`;
const appearanceKeys = ['fill', 'strokes', 'shadows', 'font', 'family', 'weight', 'size', 'tracking', 'line_spacing', 'max_width', 'max_height', 'accent', 'accent2', 'accent_scale', 'plate'];
const paintKeys = ['fill', 'strokes', 'shadows', 'accent', 'accent2', 'accent_scale', 'plate'];
export function validateFont(font) {
  if (!font || typeof font.family !== 'string' || !font.family.trim() || font.family.length > 100 ||
      !Number.isFinite(font.weight) || font.weight < 100 || font.weight > 900 ||
      typeof font.postscriptName !== 'string' || !/^[!-~]{1,63}$/.test(font.postscriptName) || /[\[\](){}<>/%]/.test(font.postscriptName)) throw new Error('フォント名・太さ・PostScript名を確認してください。');
  return { family: font.family, weight: font.weight, postscriptName: font.postscriptName };
}

export function designStyle(draft, aspect = draft.aspect, changed = true) {
  const preset = nativeStyles(aspect)[draft.fx];
  if (!preset) return null;
  const variant = DESIGN_VARIANTS[draft.design]?.style || {};
  const font = draft.font ? { family: draft.font.family, weight: draft.font.weight } : {};
  return { ...preset, ...structuredClone(variant), ...(changed ? draft.overrides?.[aspect]?.[draft.fx] || {} : {}), ...font };
}

export function selectDesign(draft, id) {
  if (!Object.hasOwn(DESIGN_VARIANTS, id)) throw new Error('不明なデザインです。');
  const next = structuredClone(draft); next.design = id;
  for (const aspect of ['portrait', 'landscape']) {
    const style = next.overrides[aspect][draft.fx];
    if (style) for (const key of paintKeys) delete style[key];
  }
  return next;
}

export function selectFont(draft, font) {
  const next = structuredClone(draft); next.font = validateFont(font);
  for (const aspect of ['portrait', 'landscape']) {
    const style = next.overrides[aspect][draft.fx];
    if (style) for (const key of ['font', 'family', 'weight']) delete style[key];
  }
  return next;
}

export function captureDesignDefault(draft) {
  if (!NATIVE_PRESETS[draft.fx]?.xml) throw new Error('XML演出を選んでください。');
  const overrides = { portrait: {}, landscape: {} };
  for (const aspect of ['portrait', 'landscape']) {
    const style = draft.overrides[aspect][draft.fx] || {};
    overrides[aspect] = Object.fromEntries(Object.entries(style).filter(([key]) => appearanceKeys.includes(key)));
  }
  return { design: draft.design, font: structuredClone(draft.font), overrides };
}

export function applyDesignDefault(draft, defaults) {
  const entry = defaults[draft.fx];
  if (!entry) return draft;
  const next = structuredClone(draft); next.design = entry.design; next.font = structuredClone(entry.font);
  for (const aspect of ['portrait', 'landscape']) {
    const style = next.overrides[aspect][draft.fx] || {};
    for (const key of appearanceKeys) delete style[key];
    next.overrides[aspect][draft.fx] = { ...style, ...structuredClone(entry.overrides[aspect]) };
  }
  return next;
}

export function validateDefaults(value, names) {
  if (value?.kind !== 'effects-lab-design-defaults' || value.version !== 1 || !value.defaults || Array.isArray(value.defaults) || typeof value.defaults !== 'object') throw new Error('演出ラボの標準デザインJSONを選んでください。');
  const out = {};
  for (const [id, entry] of Object.entries(value.defaults)) {
    if (!NATIVE_PRESETS[id]?.xml || !entry || (entry.design !== '' && !Object.hasOwn(DESIGN_VARIANTS, entry.design))) throw new Error('不明な演出・デザインです。');
    const font = entry.font == null ? null : validateFont(entry.font);
    const overrides = { portrait: {}, landscape: {} };
    for (const aspect of ['portrait', 'landscape']) {
      const style = entry.overrides?.[aspect] || {}; validateStyle(style, names);
      if (Object.keys(style).some(key => !appearanceKeys.includes(key))) throw new Error('標準デザインには見た目だけを保存できます。');
      overrides[aspect] = structuredClone(style);
    }
    out[id] = { design: entry.design, font, overrides };
  }
  return out;
}

// 保存済みの古い試作は見た目を保持し、対応が確認できる書体だけXMLへ渡す。
export function fontForStyle(draft, style) {
  if (draft.font && Object.hasOwn(NATIVE_PRESETS, draft.fx)) return validateFont(draft.font);
  if (style.family) {
    const face = Object.values(FONT_CHOICES).find(font => font.family === style.family && font.weight === (style.weight ?? 900));
    return face ? validateFont(face) : null;
  }
  return style.font === 'NotoSansJP-Black.otf' ? structuredClone(DEFAULT_FONT) : null;
}
