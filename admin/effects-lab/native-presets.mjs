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
export const DESIGN_CATEGORIES = { reaction: 'ツッコミ', heading: '見出し', ending: '締め', common: '共通' };
const outline = (inner, edge, width = 8) => [{ w: width, color: inner }, { w: width + 5, color: '#ffffff' }, { w: width + 8, color: edge }];
export const DESIGN_VARIANTS = {
  classic: { category: 'common', name: '王道イエロー', tag: 'くっきり', style: { fill: '#fff06a', strokes: outline('#202025', '#202025', 7) } },
  gold: { category: 'common', name: 'リッチゴールド', tag: '光沢', style: { fill: gradient('#fffde8', '#fff09a', '#efb729', '#fff3b0', '#ce8420'), strokes: [{ w: 6, color: '#684117' }, { w: 11, color: gradient('#fff9d8', '#d09225', '#fff8cb', '#b47719') }, { w: 14, color: '#ffffff' }, { w: 17, color: '#302415' }] } },
  ruby: { category: 'common', name: 'ルビーレッド', tag: 'インパクト', style: { fill: gradient('#fff1dd', '#ff8d6f', '#e62249', '#9e1236'), strokes: outline('#4b1027', '#3c1829') } },
  ice: { category: 'common', name: 'アイスブルー', tag: '爽快', style: { fill: gradient('#ffffff', '#c8f8ff', '#50d9f1', '#2c86d4'), strokes: outline('#12446e', '#142431') } },
  emerald: { category: 'common', name: 'エメラルド', tag: 'ポジティブ', style: { fill: gradient('#faffd3', '#b6ffac', '#49db9e', '#12856d'), strokes: outline('#134e42', '#173b35') } },
  violet: { category: 'common', name: 'ロイヤルパープル', tag: '華やか', style: { fill: gradient('#fff6fe', '#ebc6ff', '#b57be9', '#7243b2'), strokes: outline('#482467', '#2c203c') } },
  rose: { category: 'common', name: 'キャンディピンク', tag: 'ポップ', style: { fill: gradient('#ffffff', '#ffd2e4', '#ff89b8', '#dc4386'), strokes: outline('#8d275b', '#4b1833') } },
  pearl: { category: 'common', name: 'パールホワイト', tag: '上品', style: { fill: gradient('#ffffff', '#ffffff', '#e5e9f3', '#bcc8de'), strokes: [{ w: 7, color: '#2c3549' }, { w: 12, color: gradient('#ffffff', '#d8e0ef', '#ffffff', '#a5b4cd') }, { w: 15, color: '#1b2231' }] } },

  reaction_punch: { category: 'reaction', name: '白抜き・ド迫力', tag: '極太の赤フチ', fontChoice: 'noto_black', sample: 'そこじゃない！',
    aspectStyle: { portrait: { size: 124, max_width: 960 }, landscape: { size: 148, max_width: 1530 } },
    style: { fill: '#ffffff', strokes: [{ w: 12, color: '#df123d' }, { w: 17, color: '#24101a' }] } },
  reaction_deadpan: { category: 'reaction', name: '真顔のひとこと', tag: '明朝・細い白フチ', fontChoice: 'yu_mincho', sample: '聞いてないんですけど',
    aspectStyle: { portrait: { size: 96, max_width: 940 }, landscape: { size: 118, max_width: 1500 } },
    style: { fill: '#15151b', strokes: [{ w: 4, color: '#ffffff' }] } },
  reaction_alarm: { category: 'reaction', name: 'ビックリ警報', tag: '4層の強いコントラスト', fontChoice: 'noto_black', sample: 'ちょっと待って！',
    aspectStyle: { portrait: { size: 118, max_width: 960 }, landscape: { size: 138, max_width: 1560 } },
    style: { fill: gradient('#fffce0', '#fff451', '#ffcb20', '#ef7514'), strokes: [{ w: 3, color: '#261812' }, { w: 10, color: '#f04622' }, { w: 15, color: '#ffffff' }, { w: 18, color: '#261812' }] } },
  heading_chapter: { category: 'heading', name: '章タイトル', tag: '太い明朝・細い金フチ', fontChoice: 'noto_serif', sample: '伝わる動画の作り方',
    aspectStyle: { portrait: { size: 108, max_width: 960 }, landscape: { size: 124, max_width: 1490 } },
    style: { fill: gradient('#fffef1', '#fff9ce', '#f4d98e'), strokes: [{ w: 4, color: '#312319' }, { w: 6, color: gradient('#fff4ad', '#c58b2d', '#fff4ad') }, { w: 8, color: '#312319' }] } },
  heading_news: { category: 'heading', name: 'ニュース見出し', tag: '端正なゴシック・太い紺フチ', fontChoice: 'yu_bold', sample: '今日の大切なポイント',
    aspectStyle: { portrait: { size: 90, max_width: 980 }, landscape: { size: 102, max_width: 1570 } },
    style: { fill: '#ffffff', strokes: [{ w: 10, color: '#112c4f' }, { w: 12, color: '#a6ddf2' }] } },
  heading_editorial: { category: 'heading', name: '特集・モノクロ', tag: '太字・シンプルな二重フチ', fontChoice: 'noto_bold', sample: 'わかりやすさを考える',
    aspectStyle: { portrait: { size: 92, max_width: 960 }, landscape: { size: 112, max_width: 1520 } },
    style: { fill: '#22252b', strokes: [{ w: 6, color: '#ffffff' }, { w: 8, color: '#22252b' }] } },
  ending_grand: { category: 'ending', name: 'グランドフィナーレ', tag: '極太明朝・金属の4層フチ', fontChoice: 'noto_serif', sample: '挑戦はここから',
    aspectStyle: { portrait: { size: 124, max_width: 970 }, landscape: { size: 150, max_width: 1530 } },
    style: { fill: gradient('#fffdec', '#ffe9a1', '#df9c2c', '#fff1bb', '#be6e19'), strokes: [{ w: 3, color: '#492c21' }, { w: 9, color: gradient('#fff9c9', '#b47a25', '#ffeab2', '#a66a1e') }, { w: 12, color: '#fff9e7' }, { w: 16, color: '#492c21' }] } },
  ending_thanks: { category: 'ending', name: '余韻のありがとう', tag: '細めの明朝・やわらかな二重フチ', fontChoice: 'yu_mincho', sample: 'ご覧いただきありがとうございました',
    aspectStyle: { portrait: { size: 84, max_width: 960 }, landscape: { size: 100, max_width: 1600 } },
    style: { fill: '#fffaf0', strokes: [{ w: 3, color: '#685044' }, { w: 5, color: '#fff3df' }] } },
  ending_action: { category: 'ending', name: '次の一歩へ', tag: '力強いゴシック・白フチ', fontChoice: 'noto_black', sample: 'ぜひ試してみてください',
    aspectStyle: { portrait: { size: 106, max_width: 970 }, landscape: { size: 128, max_width: 1540 } },
    style: { fill: gradient('#faffdd', '#c3ffb0', '#5ad5a1'), strokes: [{ w: 3, color: '#ffffff' }, { w: 8, color: '#164d42' }, { w: 11, color: '#ffffff' }] } },
};
export const FONT_CHOICES = {
  noto_black: { name: 'Noto Sans JP・極太', family: 'Noto Sans JP', weight: 900, postscriptName: 'NotoSansJP-Black' },
  noto_bold: { name: 'Noto Sans JP・太字', family: 'Noto Sans JP', weight: 700, postscriptName: 'NotoSansJP-Bold' },
  noto_serif: { name: 'Noto Serif JP・極太明朝', family: 'Noto Serif JP', weight: 900, postscriptName: 'NotoSerifJP-Black' },
  yu_mincho: { name: '游明朝・太字', family: 'Yu Mincho', weight: 600, postscriptName: 'YuMincho-Demibold' },
  yu_bold: { name: '游ゴシック・太字', family: 'Yu Gothic', weight: 700, postscriptName: 'YuGothic-Bold' },
};
export const DEFAULT_FONT = Object.fromEntries(Object.entries(FONT_CHOICES.noto_black).filter(([key]) => key !== 'name'));

// サイズと幅は縦横別。時間・動き・位置はデザイン側で変更しない。
export function variantStyle(id, aspect) {
  const variant = DESIGN_VARIANTS[id];
  return variant ? structuredClone({ ...variant.style, ...variant.aspectStyle?.[aspect] }) : {};
}
