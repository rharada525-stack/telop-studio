// 編集可能な文字のまま、背景から分離するテレビ風の多重フチ。
const common = { z: 5, font: 'NotoSansJP-Black.otf', size: 106, max_width: 1000,
  pos: [540, 1040], in: 'none', out: 'none', out_d: 0, idle: 'none', char: '',
  shadows: [], sfx: null, line_spacing: 1.15 };
export const NATIVE_PRESETS = {
  xml_pop: { name: '強調・ポップ［XML］', sample: 'ここが大事なポイント', xml: true,
    style: { ...common, fill: '#fff06a', strokes: [{ w: 7, color: '#202025' }, { w: 12, color: '#ffffff' }, { w: 15, color: '#202025' }], in: 'pop', out: 'fade', out_d: .2 } },
  xml_reaction: { name: 'ツッコミ・赤スラム［XML］', sample: 'そこじゃない！', xml: true, position: 'center',
    style: { ...common, fill: '#ffffff', rotate: 0, strokes: [{ w: 8, color: '#c91636' }, { w: 13, color: '#ffffff' }, { w: 16, color: '#39131b' }], in: 'slam', out: 'fade', out_d: .2 } },
  xml_heading: { name: '見出し・スライド［XML］', sample: '大切なのは伝わること', xml: true, position: 'top',
    style: { ...common, fill: '#ffffff', strokes: [{ w: 8, color: '#12446e' }, { w: 13, color: '#ffffff' }, { w: 16, color: '#142431' }], in: 'slide_left', out: 'fade', out_d: .25 } },
  native_emphasis: { name: '強調・白フチ', sample: 'ここが大事なポイント', style: { ...common, fill: '#ffffff',
    strokes: [{ w: 8, color: '#171a20' }, { w: 15, color: '#ffffff' }, { w: 19, color: '#171a20' }] } },
  native_reaction: { name: 'ツッコミ・赤', sample: 'そこじゃない！', style: { ...common, fill: '#ffffff', rotate: 0,
    strokes: [{ w: 9, color: '#e8173f' }, { w: 17, color: '#ffffff' }, { w: 21, color: '#29121a' }] } },
  native_heading: { name: '見出し・イエロー', sample: '大切なのは伝わること', style: { ...common, fill: '#ffd84a',
    strokes: [{ w: 8, color: '#322716' }, { w: 14, color: '#ffffff' }, { w: 17, color: '#322716' }] } },
};
export const XML_PRESETS = Object.fromEntries(Object.entries(NATIVE_PRESETS).filter(([, preset]) => preset.xml));
export function nativeStyles(aspect) {
  return Object.fromEntries(Object.entries(NATIVE_PRESETS).map(([id, preset]) => [id, { ...structuredClone(preset.style),
    ...(aspect === 'landscape' ? { pos: [960, 900], size: 110, max_width: 1580 } : {}) }]));
}
