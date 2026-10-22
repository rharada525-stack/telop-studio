// Premiere標準の文字レイヤーで扱う最初の3案。見た目の確認から始める。
const common = { z: 5, font: 'NotoSansJP-Black.otf', size: 106, max_width: 1000,
  pos: [540, 1040], in: 'none', out: 'none', out_d: 0, idle: 'none', char: '',
  shadows: [], sfx: null, line_spacing: 1.15 };
export const NATIVE_PRESETS = {
  native_emphasis: { name: '強調・白フチ', sample: 'ここが大事なポイント', style: { ...common, fill: '#ffffff',
    strokes: [{ w: 8, color: '#171a20' }, { w: 15, color: '#ffffff' }, { w: 19, color: '#171a20' }] } },
  native_reaction: { name: 'ツッコミ・赤', sample: 'そこじゃない！', style: { ...common, fill: '#ffffff', rotate: -5,
    strokes: [{ w: 9, color: '#e8173f' }, { w: 17, color: '#ffffff' }, { w: 21, color: '#29121a' }] } },
  native_heading: { name: '見出し・イエロー', sample: '大切なのは伝わること', style: { ...common, fill: '#ffd84a',
    strokes: [{ w: 8, color: '#322716' }, { w: 14, color: '#ffffff' }, { w: 17, color: '#322716' }] } },
};
export function nativeStyles(aspect) {
  return Object.fromEntries(Object.entries(NATIVE_PRESETS).map(([id, preset]) => [id, { ...structuredClone(preset.style),
    ...(aspect === 'landscape' ? { pos: [960, 790], size: 100, max_width: 1580 } : {}) }]));
}
