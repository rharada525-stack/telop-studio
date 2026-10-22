// 単色は従来のText generator、フチ付きはPremiereのSource Textを使う。
// 2026-10-23、Premiere 2026で横長のNoto Sans JP Black・多重フチ・文字編集を確認。
// https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Applications/Applications.html
import { blockState } from '../../telop-studio/js/block-motion.js';
import { makeTextData, base64, isSupportedPaint } from './source-text.mjs?v=20261023-rich1';
import { getSparkleClips, isSparkleType } from './sparkles.mjs?v=20261023-sparkle1';
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const rate = '<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>';
const parameter = (id, name, value) => `<parameter><parameterid>${id}</parameterid><name>${name}</name><value>${value}</value></parameter>`;
const num = n => String(Number(n.toFixed(6)));
const point = (x, y) => `<horiz>${num(x)}</horiz><vert>${num(y)}</vert>`;
const enters = new Set(['none', 'slam', 'pop', 'drop', 'elastic', 'slide_left', 'slide_right', 'slide_up', 'fade', 'fade_up', 'bounce', 'zoom_in']);
const exits = new Set(['none', 'fade', 'zoom_out', 'pop_out', 'shrink', 'slide_out_left', 'slide_out_right']);
const idles = new Set(['none', 'pulse', 'float', 'tremble', 'wobble']);
const hasSparkle = style => style?.sparkle != null && style.sparkle !== '' && style.sparkle !== 'none';

export function xmlStyleWarnings(st, text = '') {
  if (!st) return ['演出を選んでください'];
  const reasons = [];
  if (st.group || st.effect || st.vertical) reasons.push('複合パーツ・画面効果・縦書き');
  if (st.strokes && (!Array.isArray(st.strokes) || st.strokes.length > 4 || st.strokes.some(s => !s || !Number.isFinite(s.w) || s.w < 0 || s.w > 80 || !isSupportedPaint(s.color)))) reasons.push('未対応の色・範囲外のフチ');
  if (st.shadows?.length) reasons.push('影');
  if (st.plate) reasons.push('背景プレート');
  if (!isSupportedPaint(st.fill)) reasons.push('未対応の塗り（単色・縦グラデーションに対応）');
  if (st.char) reasons.push('1文字ずつの動き');
  if (!enters.has(st.in || 'none') || !exits.has(st.out || 'fade') || !idles.has(st.idle || 'none')) reasons.push('ワイプ・変形などの動き');
  if (st.tracking) reasons.push('字間の指定');
  if (hasSparkle(st) && !isSparkleType(st.sparkle)) reasons.push('未対応のキラキラ');
  if (/[{}\[\]]/.test(text) && (st.accent || st.accent2 || st.accent_scale && st.accent_scale !== 1)) reasons.push('一部だけの強調');
  if (/[\r\n]/.test(text)) reasons.push('複数行の行間');
  return reasons;
}

// 30fpsの画面と同じ値を使用。一定区間の中間キーだけを省き、止まる時刻は残す。
export function motionSamples(style, frames, W, H) {
  const pos = style.pos || [W / 2, H / 2];
  return Array.from({ length: frames + 1 }, (_, frame) => {
    const state = blockState(style, frame / 30, frames / 30);
    return { frame, scale: num(state.s * 100), rotation: num((style.rotate || 0) + state.rot),
      center: point((pos[0] + state.dx - W / 2) / W, (pos[1] + state.dy - H / 2) / H), opacity: num(state.op * 100) };
  });
}
function motionParameter(id, name, samples, min, max) {
  const values = samples.map(s => s[id]);
  const keys = values.every(v => v === values[0]) ? '' : samples.filter((s, i) =>
    i === 0 || i === samples.length - 1 || s[id] !== samples[i - 1][id] || s[id] !== samples[i + 1][id])
    .map(s => `<keyframe><when>${s.frame}</when><value>${s[id]}</value></keyframe>`).join('');
  return `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>` +
    (min == null ? '' : `<valuemin>${min}</valuemin><valuemax>${max}</valuemax>`) + `<value>${values[0]}</value>${keys}</parameter>`;
}
function motionFilters(style, frames, W, H, samples = motionSamples(style, frames, W, H)) {
  const effect = (id, name, body) => `<filter><effect><name>${name}</name><effectid>${id}</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${body}</effect></filter>`;
  return effect('basic', 'Basic Motion', motionParameter('scale', 'Scale', samples, 0, 1000) +
    motionParameter('rotation', 'Rotation', samples, -8640, 8640) + motionParameter('center', 'Center', samples)) +
    effect('opacity', 'Opacity', motionParameter('opacity', 'Opacity', samples, 0, 100));
}

// Premiere自身の書き出すGraphicAndType XML。1クリップ内の1つの文字にフチを持たせる。
// Text generatorによる単色の読み込み経路は下に残し、フチ付きの場合だけこちらを使う。
function graphicClip({ text, start, end, index, style, id = index + 1, motion }, W, H, fontName) {
  const frames = end - start;
  const nativeParameter = (id, name, value) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name><value>${esc(value)}</value></parameter>`;
  const still = value => `-91445760000000000,${value},0,0,0,0,0,0`;
  // ブラウザの文字ブロックは高さsize、ベースライン0.88*size。中央との差は0.38*size。
  const baseline = .5 + style.size * .38 / H;
  return `<clipitem id="graphic-${id}"><name>${esc(text)}</name><duration>${frames}</duration>${rate}<start>${start}</start><end>${end}</end><in>0</in><out>${frames}</out><enabled>TRUE</enabled><alphatype>straight</alphatype><pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic>
<file id="graphic-file-${id}"><name>Graphic</name><mediaSource>GraphicAndType</mediaSource>${rate}<media><video><samplecharacteristics>${rate}<width>${W}</width><height>${H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media></file>
<filter><effect><name>${esc(text)}</name><effectid>GraphicAndType</effectid><effectcategory>graphic</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype><pproBypass>false</pproBypass>
<parameter authoringApp="PremierePro"><parameterid>1</parameterid><name>Source Text</name><hash>${crypto.randomUUID()}</hash><value>${base64(makeTextData(text, style, fontName))}</value></parameter>
${nativeParameter(2, 'Transform', still('false'))}
${nativeParameter(3, 'Position', `${still(`0.5:${num(baseline)}`)},5,4,0,0,0,0`)}
${nativeParameter(4, 'Scale', still('100.'))}${nativeParameter(5, 'Horizontal Scale', still('100.'))}${nativeParameter(6, 'Uniform Scale', still('true'))}
${nativeParameter(7, 'Rotation', still('0.'))}${nativeParameter(8, 'Opacity', still('100.'))}
${nativeParameter(9, 'Anchor Point', `${still('0:0')},5,4,0,0,0,0`)}
</effect></filter>${motionFilters(style, frames, W, H, motion)}</clipitem>`;
}

export function plainText(text) {
  // ブラウザプレビューの強調マーカーを外し、XML 1.0で使えない制御文字を除く。
  return String(text).replace(/[{}\[\]]/g, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
}

export function buildTextXml({ name = '演出ラボ_文字の読み込みテスト', W = 1920, H = 1080, items, fontName = 'YuGothic-Bold' }) {
  if (![W, H].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('画面サイズが不正です。');
  // OpenType name ID 6のPostScript名。表示用ファミリー名を変形・推測して渡さない。
  // https://learn.microsoft.com/en-us/typography/opentype/spec/name
  const checkFont = font => {
    if (typeof font !== 'string' || !font.length || font.length > 63 || /[^\x21-\x7e]|[\[\](){}<>/%]/.test(font)) throw new Error('PCのフォントから選ぶか、PostScript名（例: YuGothic-Bold）を入力してください。');
    return font;
  };
  checkFont(fontName);
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('1〜100個の文字を指定してください。');
  const clips = items.map((item, index) => {
    const text = plainText(item.text ?? '');
    if (!text.trim() || text.length > 300) throw new Error('文字は1〜300文字で指定してください。');
    if (!Number.isFinite(item.t) || item.t < 0 || !Number.isFinite(item.d) || item.d <= 0 || item.t + item.d > 3600) throw new Error('表示時間が不正です。');
    const start = Math.round(item.t * 30), end = Math.round((item.t + item.d) * 30);
    if (end <= start) throw new Error('表示時間は1フレーム以上にしてください。');
    const style = item.style;
    if (style) {
      const warnings = xmlStyleWarnings(style, item.text);
      if (warnings.length) throw new Error(`このXMLにはまだ渡せません: ${warnings.join('・')}`);
      if (!Number.isFinite(style.size) || style.size < 1 || style.size > 400 ||
          style.rotate != null && (!Number.isFinite(style.rotate) || Math.abs(style.rotate) > 180) ||
          style.out_d != null && (!Number.isFinite(style.out_d) || style.out_d < 0 || style.out_d > 3) ||
          style.pos != null && (!Array.isArray(style.pos) || style.pos.length !== 2 || !style.pos.every(n => Number.isFinite(n) && Math.abs(n) <= 10000))) throw new Error('文字サイズ・位置・傾き・退場時間が不正です。');
      if (hasSparkle(style) && (!item.bounds || !['width', 'height'].every(key => Number.isFinite(item.bounds[key]) && item.bounds[key] > 0 && item.bounds[key] <= 8192))) throw new Error('キラキラには本文の実際の幅と高さが必要です。');
    }
    return { text, start, end, index, style, bounds: item.bounds, fontName: checkFont(item.fontName ?? fontName) };
  }).sort((a, b) => a.start - b.start);
  if (clips.some((clip, i) => i && clip.start < clips[i - 1].end)) throw new Error('文字の表示時間を重ねないでください。');
  const generators = clips.map(({ text, start, end, index, style, fontName }) => {
    if (style && (typeof style.fill !== 'string' || style.strokes?.some(s => s.w > 0))) return graphicClip({ text, start, end, index, style }, W, H, fontName);
    const rgb = style ? style.fill.slice(1).match(/../g).map(n => parseInt(n, 16)) : [255, 255, 255];
    // PremiereのFCP Text変換は480行基準。既存の読み込み用XMLはそのまま保持。
    const size = style ? num(style.size * 480 / H) : String(Math.round(H * .075));
    return `<generatoritem id="text-${index + 1}">
<name>${esc(text.replace(/\n/g, ' '))}</name><duration>${end - start}</duration>${rate}
<in>0</in><out>${end - start}</out><start>${start}</start><end>${end}</end>
<enabled>TRUE</enabled><anamorphic>FALSE</anamorphic><alphatype>black</alphatype>
<effect id="text-effect-${index + 1}"><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype>
${parameter('str', 'Text', esc(text).replace(/\n/g, '&#13;'))}
${parameter('fontname', 'Font', esc(fontName.trim()))}
${parameter('fontsize', 'Size', size)}
${parameter('fontstyle', 'Style', '1')}
${parameter('fontalign', 'Alignment', '2')}
${parameter('fontcolor', 'Font Color', `<alpha>255</alpha><red>${rgb[0]}</red><green>${rgb[1]}</green><blue>${rgb[2]}</blue>`)}
${parameter('origin', 'Origin', '<horiz>0</horiz><vert>0</vert>')}
</effect>${style ? motionFilters(style, end - start, W, H) : ''}<sourcetrack><mediatype>video</mediatype></sourcetrack></generatoritem>`;
  }).join('\n');
  // 本文はV1の1レイヤーを維持する。星は各粒子の編集可能な文字としてV2以降へ。
  // 本文の時間が重ならないので、バッチでも粒子番号ごとのトラックを再利用できる。
  const decorations = [];
  for (const clip of clips) {
    if (!hasSparkle(clip.style)) continue;
    const particles = getSparkleClips({ style: clip.style, bounds: clip.bounds, t: clip.start / 30, d: (clip.end - clip.start) / 30, W, H });
    particles.forEach((particle, index) => {
      const start = particle.startFrame, end = particle.endFrame;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < clip.start || end > clip.end || end <= start) throw new Error('キラキラの表示時間が本文の範囲外です。');
      const motion = particle.motion.map(sample => ({ frame: sample.frame, scale: num(sample.scale), rotation: num(sample.rotation),
        center: point((sample.center.x - W / 2) / W, (sample.center.y - H / 2) / H), opacity: num(sample.opacity) }));
      (decorations[index] ||= []).push(graphicClip({ text: particle.text, start, end, style: particle.style,
        id: `sparkle-${clip.index + 1}-${index + 1}`, motion }, W, H, checkFont(particle.fontName)));
    });
  }
  const track = body => `<track>${body}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  const tracks = track(generators) + decorations.map(clips => track(clips.join('\n'))).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5"><sequence id="effects-lab-text-test">
<name>${esc(plainText(name))}</name><duration>${clips.at(-1).end}</duration>${rate}
<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
<media><video><format><samplecharacteristics>${rate}<width>${W}</width><height>${H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
${tracks}</video></media>
</sequence></xmeml>\n`;
}
