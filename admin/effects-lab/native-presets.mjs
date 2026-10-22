// 編集可能な文字のまま、背景から分離するテレビ風の多重フチ。
const common = { z: 5, font: 'NotoSansJP-Black.otf', size: 106, max_width: 1000,
  pos: [540, 1040], in: 'none', out: 'none', out_d: 0, idle: 'none', char: '',
  shadows: [], sfx: null, line_spacing: 1.15 };
export const NATIVE_PRESETS = {
  xml_pop: { name: '強調・ポップ［XML］', sample: 'ここが大事なポイント', xml: true,
    style: { ...common, fill: '#fff06a', strokes: [{ w: 7, color: '#202025' }, { w: 12, color: '#ffffff' }, { w: 15, color: '#202025' }], in: 'pop', out: 'fade', out_d: .2 } },
  xml_reaction: { name: 'ツッコミ・スラム［XML］', sample: 'そこじゃない！', xml: true, position: 'center',
    style: { ...common, fill: '#ffffff', rotate: 0, strokes: [{ w: 8, color: '#c91636' }, { w: 13, color: '#ffffff' }, { w: 16, color: '#39131b' }], in: 'slam', out: 'fade', out_d: .2 } },
  xml_heading: { name: '見出し・スライド［XML］', sample: '大切なのは伝わること', xml: true, position: 'top',
    style: { ...common, fill: '#ffffff', strokes: [{ w: 8, color: '#12446e' }, { w: 13, color: '#ffffff' }, { w: 16, color: '#142431' }], in: 'slide_left', out: 'fade', out_d: .25 } },
  xml_bounce: { name: 'バウンド［XML］', sample: 'やればできる！', xml: true,
    style: { ...common, fill: '#fff06a', rotate: 0, strokes: [{ w: 7, color: '#202025' }, { w: 12, color: '#ffffff' }, { w: 15, color: '#202025' }], in: 'bounce', out: 'fade', out_d: .2 } },
  xml_drop: { name: '落下［XML］', sample: 'まさかの大発見', xml: true,
    style: { ...common, fill: '#ffffff', rotate: 0, strokes: [{ w: 8, color: '#c91636' }, { w: 13, color: '#ffffff' }, { w: 16, color: '#39131b' }], in: 'drop', out: 'fade', out_d: .2 } },
  xml_float: { name: 'ふわっと登場［XML］', sample: '小さな一歩が未来を変える', xml: true,
    style: { ...common, fill: '#ffffff', rotate: 0, strokes: [{ w: 8, color: '#12446e' }, { w: 13, color: '#ffffff' }, { w: 16, color: '#142431' }], in: 'fade_up', out: 'fade', out_d: .25 } },
  xml_zoom: { name: 'ズームイン［XML］', sample: 'その瞬間がチャンス', xml: true,
    style: { ...common, fill: '#fff06a', rotate: 0, strokes: [{ w: 7, color: '#202025' }, { w: 12, color: '#ffffff' }, { w: 15, color: '#202025' }], in: 'zoom_in', out: 'fade', out_d: .2 } },
  xml_rise: { name: '下からスライド［XML］', sample: '覚えておきたいポイント', xml: true,
    style: { ...common, fill: '#ffffff', rotate: 0, strokes: [{ w: 8, color: '#12446e' }, { w: 13, color: '#ffffff' }, { w: 16, color: '#142431' }], in: 'slide_up', out: 'fade', out_d: .25 } },
  native_emphasis: { name: '強調・白フチ', sample: 'ここが大事なポイント', style: { ...common, fill: '#ffffff',
    strokes: [{ w: 8, color: '#171a20' }, { w: 15, color: '#ffffff' }, { w: 19, color: '#171a20' }] } },
  native_reaction: { name: 'ツッコミ・赤', sample: 'そこじゃない！', style: { ...common, fill: '#ffffff', rotate: 0,
    strokes: [{ w: 9, color: '#e8173f' }, { w: 17, color: '#ffffff' }, { w: 21, color: '#29121a' }] } },
  native_heading: { name: '見出し・イエロー', sample: '大切なのは伝わること', style: { ...common, fill: '#ffd84a',
    strokes: [{ w: 8, color: '#322716' }, { w: 14, color: '#ffffff' }, { w: 17, color: '#322716' }] } },
};
export const XML_PRESETS = Object.fromEntries(Object.entries(NATIVE_PRESETS).filter(([, preset]) => preset.xml));
export const XML_LEGACY_PRESETS = Object.fromEntries(['xml_pop', 'xml_reaction', 'xml_heading'].map(id => [id, NATIVE_PRESETS[id]]));
export function nativeStyles(aspect) {
  return Object.fromEntries(Object.entries(NATIVE_PRESETS).map(([id, preset]) => [id, { ...structuredClone(preset.style),
    ...(aspect === 'landscape' ? { pos: [960, 900], size: 110, max_width: 1580 } : {}) }]));
}

// 動きと分けて選べる見た目。元記事の素材は使わず、配色とフチを独自に組む。
const gradient = (...stops) => ({ stops, angle: 0 });
const outline = (inner, edge, width = 8) => [{ w: width, color: inner }, { w: width + 5, color: '#ffffff' }, { w: width + 8, color: edge }];
export const DESIGN_VARIANTS = {
  classic: { name: '王道イエロー', tag: 'くっきり', style: { fill: '#fff06a', strokes: outline('#202025', '#202025', 7) } },
  gold: { name: 'リッチゴールド', tag: '光沢', style: { fill: gradient('#fffde8', '#fff09a', '#efb729', '#fff3b0', '#ce8420'), strokes: [{ w: 6, color: '#684117' }, { w: 11, color: gradient('#fff9d8', '#d09225', '#fff8cb', '#b47719') }, { w: 14, color: '#ffffff' }, { w: 17, color: '#302415' }] } },
  ruby: { name: 'ルビーレッド', tag: 'インパクト', style: { fill: gradient('#fff1dd', '#ff8d6f', '#e62249', '#9e1236'), strokes: outline('#4b1027', '#3c1829') } },
  ice: { name: 'アイスブルー', tag: '爽快', style: { fill: gradient('#ffffff', '#c8f8ff', '#50d9f1', '#2c86d4'), strokes: outline('#12446e', '#142431') } },
  emerald: { name: 'エメラルド', tag: 'ポジティブ', style: { fill: gradient('#faffd3', '#b6ffac', '#49db9e', '#12856d'), strokes: outline('#134e42', '#173b35') } },
  violet: { name: 'ロイヤルパープル', tag: '華やか', style: { fill: gradient('#fff6fe', '#ebc6ff', '#b57be9', '#7243b2'), strokes: outline('#482467', '#2c203c') } },
  rose: { name: 'キャンディピンク', tag: 'ポップ', style: { fill: gradient('#ffffff', '#ffd2e4', '#ff89b8', '#dc4386'), strokes: outline('#8d275b', '#4b1833') } },
  pearl: { name: 'パールホワイト', tag: '上品', style: { fill: gradient('#ffffff', '#ffffff', '#e5e9f3', '#bcc8de'), strokes: [{ w: 7, color: '#2c3549' }, { w: 12, color: gradient('#ffffff', '#d8e0ef', '#ffffff', '#a5b4cd') }, { w: 15, color: '#1b2231' }] } },
};
export const FONT_CHOICES = {
  noto_black: { name: 'Noto Sans JP・極太', family: 'Noto Sans JP', weight: 900, postscriptName: 'NotoSansJP-Black' },
  noto_bold: { name: 'Noto Sans JP・太字', family: 'Noto Sans JP', weight: 700, postscriptName: 'NotoSansJP-Bold' },
  noto_serif: { name: 'Noto Serif JP・極太明朝', family: 'Noto Serif JP', weight: 900, postscriptName: 'NotoSerifJP-Black' },
  yu_mincho: { name: '游明朝・太字', family: 'Yu Mincho', weight: 600, postscriptName: 'YuMincho-Demibold' },
  yu_bold: { name: '游ゴシック・太字', family: 'Yu Gothic', weight: 700, postscriptName: 'YuGothic-Bold' },
};
export const DEFAULT_FONT = Object.fromEntries(Object.entries(FONT_CHOICES.noto_black).filter(([key]) => key !== 'name'));
