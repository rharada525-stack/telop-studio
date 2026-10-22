// 本文1個を共有するネストにCropとScreenを適用する。動画や文字画像は使わない。
// 2026-10-23 Premiere 2026で読み込み、光沢移動、本文1回の編集による両層更新を確認。
// Basic Motionのcrop IDはPremiere自身のXML、sequence参照/ScreenはApple xmeml仕様。
export const SURFACE_LIGHT_FPS = 30;
export const SURFACE_LIGHT_TYPES = Object.freeze(['sweep', 'double']);
export const isSurfaceLightType = value => SURFACE_LIGHT_TYPES.includes(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = value => Math.round(value * 1e6) / 1e6;

/**
 * 本文の静止時の中心を0とした帯の左右端(pixel)とScreen強度(0..1)。
 * frame/startFrame/endFrameは絶対30fps。末尾はXML用の非表示キー。
 * 本文と帯を先に合成し、その全体へ本文のmotion/opacityを1回だけ適用する。
 */
export function getSurfaceLightSamples({ style, bounds, t = 0, d, W, H }) {
  if (style?.surfaceLight == null || style.surfaceLight === '' || style.surfaceLight === 'none') return null;
  if (!isSurfaceLightType(style.surfaceLight)) throw new Error('未対応の文字表面の光です。');
  if (![W, H].every(value => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error('画面サイズが不正です。');
  if (![t, d].every(Number.isFinite) || t < 0 || d <= 0 || t + d > 3600) throw new Error('文字表面の光の時間が不正です。');
  if (!bounds || ![bounds.width, bounds.height].every(value => Number.isFinite(value) && value > 0 && value <= 8192)
      || !Number.isFinite(style.size) || style.size < 1 || style.size > 400) throw new Error('本文の描画範囲と文字サイズが必要です。');
  const startFrame = Math.round(t * SURFACE_LIGHT_FPS), endFrame = Math.round((t + d) * SURFACE_LIGHT_FPS);
  const frames = endFrame - startFrame;
  if (frames < 1) throw new Error('文字表面の光は1フレーム以上にしてください。');
  const bandWidth = round(Math.min(W * .32, Math.max(style.size * .45, Math.min(style.size * 1.8, bounds.width * .24))));
  const edge = bounds.width / 2 + bandWidth / 2 + 6;
  const begin = Math.min(6, Math.floor(frames * .1)), finish = frames - Math.min(8, Math.floor(frames * .1));
  const available = finish - begin;
  let windows;
  if (style.surfaceLight === 'double' && available >= 4) {
    const gap = Math.min(6, Math.floor(available * .12));
    const run = Math.floor((available - gap) / 2);
    windows = [[begin, begin + run], [begin + run + gap, finish]];
  } else windows = [[begin, Math.min(finish, begin + 42)]];
  const samples = Array.from({ length: frames + 1 }, (_, frame) => {
    const window = windows.find(([first, last]) => frame >= first && frame <= last);
    const progress = window ? (frame - window[0]) / Math.max(1, window[1] - window[0]) : 0;
    const center = -edge + edge * 2 * progress;
    return { frame: startFrame + frame, left: round(center - bandWidth / 2), right: round(center + bandWidth / 2),
      opacity: window && frame > window[0] && frame < window[1] ? .9 : 0 };
  });
  return { startFrame, endFrame, bandWidth, samples };
}

// 再生方向やループ回数に依存せず、CanvasとXMLの30fps値を一致させる。
export function sampleSurfaceLightAt(light, time) {
  if (!light || !Number.isFinite(time)) return null;
  const frame = Math.floor(time * SURFACE_LIGHT_FPS + 1e-7);
  if (frame < light.startFrame || frame >= light.endFrame) return null;
  return light.samples[frame - light.startFrame] || null;
}

// 中央の共有本文をCropする百分率。Fit/Fillによる拡大は行わない。
export function surfaceCropSamples(light, W) {
  if (!light?.samples || !Number.isFinite(W) || W <= 0) throw new Error('光の帯のサンプルが不正です。');
  return light.samples.map(sample => ({ frame: sample.frame - light.startFrame,
    leftcrop: round(clamp((W / 2 + sample.left) / W * 100, 0, 100)),
    rightcrop: round(clamp((W / 2 - sample.right) / W * 100, 0, 100)), opacity: round(sample.opacity * 100) }));
}

const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const rate = '<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>';
const num = value => String(round(value));
const point = '<horiz>0</horiz><vert>0</vert>';
const parameter = (id, name, value, keys = []) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name><value>${value}</value>${keys.map(([frame, v]) => `<keyframe><when>${frame}</when><value>${num(v)}</value></keyframe>`).join('')}</parameter>`;
const effect = (id, name, body) => `<filter><effect><name>${name}</name><effectid>${id}</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><pproBypass>false</pproBypass>${body}</effect></filter>`;
const track = contents => `<track>${contents}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
const format = (W, H) => `<format><samplecharacteristics>${rate}<width>${W}</width><height>${H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`;
const sequence = (id, name, frames, tracks, W, H) => `<sequence id="${id}"><name>${esc(name)}</name><duration>${frames}</duration>${rate}<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video>${format(W, H)}${tracks}</video></media></sequence>`;
function nestedClip(id, name, source, start, end, filters = '', blend = 'normal') {
  const frames = end - start;
  return `<clipitem id="${id}"><name>${esc(name)}</name><duration>${frames}</duration>${rate}<start>${start}</start><end>${end}</end><in>0</in><out>${frames}</out><enabled>TRUE</enabled><alphatype>straight</alphatype><pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic><compositemode>${blend}</compositemode>${source}<sourcetrack><mediatype>video</mediatype></sourcetrack>${filters}</clipitem>`;
}
function innerFilters(crop) {
  const keys = id => crop?.map(sample => [sample.frame, sample[id]]) || [];
  const basic = effect('basic', 'Basic Motion', parameter('scale', 'Scale', '100') + parameter('rotation', 'Rotation', '0') +
    parameter('center', 'Center', point) + parameter('centerOffset', 'Anchor Point', point) +
    parameter('leftcrop', 'Left', num(crop?.[0].leftcrop || 0), keys('leftcrop')) + parameter('topcrop', 'Top', '0') +
    parameter('rightcrop', 'Right', num(crop?.[0].rightcrop || 0), keys('rightcrop')) + parameter('bottomcrop', 'Bottom', '0'));
  return basic + effect('opacity', 'Opacity', parameter('opacity', 'Opacity', num(crop ? crop[0].opacity : 100), keys('opacity')));
}

/** sourceClipは中央・静止・100%不透明のGraphicAndType本文1個。motionFiltersは外側だけに適用する。 */
export function buildSurfaceLightClip({ id, text, sourceClip, start, end, W, H, light, motionFilters }) {
  const frames = end - start;
  if (!/^[a-zA-Z0-9_-]+$/.test(String(id)) || !Number.isInteger(frames) || frames < 1
      || light?.startFrame !== start || light?.endFrame !== end
      || (sourceClip?.match(/<name>Source Text<\/name>/g) || []).length !== 1) throw new Error('光沢には編集可能な本文1個と一致する時間が必要です。');
  const sourceId = `surface-text-${id}`, lightId = `surface-light-${id}`;
  const source = sequence(sourceId, `本文を編集_${text}`, frames, track(sourceClip), W, H);
  const base = nestedClip(`surface-base-${id}`, '本文・原色', source, 0, frames, innerFilters());
  const shine = nestedClip(`surface-shine-${id}`, '本文・光沢帯', `<sequence id="${sourceId}"/>`, 0, frames, innerFilters(surfaceCropSamples(light, W)), 'screen');
  const composite = sequence(lightId, `光沢_${text}`, frames, track(base) + track(shine), W, H);
  return nestedClip(`surface-main-${id}`, text, composite, start, end, motionFilters);
}
