import { Renderer, FPS } from '../../telop-studio/js/render.js?v=20261022-effects2';
import { resolveStyles, makeItem, blockState } from '../../telop-studio/js/telop.js?v=20261022-effects2';
import { FX_POS, SCREEN } from '../../telop-studio/js/timeline.js';
import { DESIGN_SETS } from '../../telop-studio/js/sets.js';
import { EFFECTS as FX, STORAGE_KEY, DEFAULTS_KEY, SAMPLES, newDraft, validateDraft, validateStyle, sceneFor, designStyle, selectDesign, selectFont, captureDesignDefault, applyDesignDefault, applyMotionDesign, validateDefaults, fontForStyle } from './model.mjs?v=20261023-surface1';
import { XML_PRESETS, DESIGN_VARIANTS, DESIGN_CATEGORIES, FONT_CHOICES, DEFAULT_FONT, nativeStyles } from './native-presets.mjs?v=20261023-surface1';
import { buildTextXml, xmlStyleWarnings } from './text-xml.mjs?v=20261023-surface1';
import { attachFontPicker } from '../../telop-studio/js/font-picker.js?v=20261022-fonts2';
import { localFonts } from '../../telop-studio/js/local-fonts.js';
import { getSparkleClips, sampleSparkleAt } from './sparkles.mjs?v=20261023-sparkle2';
import { getSurfaceLightSamples, sampleSurfaceLightAt } from './surface-light.mjs?v=20261023-surface1';

const $ = id => document.getElementById(id);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (!local) $('blocked').hidden = false;
else init().catch(error => status(`起動できませんでした: ${error.message}`, true));

let raw, base, draft, scene, baseline, prototype, generation = 0, timer, preparing = true;
let saved = [], savedId = '', part = '', t = 0, playing = false, lastTick = 0, animation, playbackRun = 0;
let media = null, mediaURL = '', mediaGeneration = 0, background;
let audioContext, audioNodes = [], audioGeneration = 0;
let exporting = false;
const dirtyFields = new Set();
let styleDirty = false, defaults = {}, cardGeneration = 0, cardsKey = "";
let designCategory = '', lastDesign = '';
const styleFields = { fill: 'fill', size: 'size', rotate: 'rotate', enter: 'in', exit: 'out', character: 'char', stagger: 'stagger', idle: 'idle', outDuration: 'out_d', sparkle: 'sparkle', surfaceLight: 'surfaceLight' };
const audioBuffers = new Map();
const contexts = { original: $('original').getContext('2d'), preview: $('preview').getContext('2d') };
const controlIds = ['aspect', 'set', 'text', 'subtitle', 'separate', 'duration', 'position', 'screen', 'name'];
const enters = { none: 'なし', slam: '叩きつける', pop: 'ポップ', drop: '落下', elastic: '弾む', slide_left: '左から', slide_right: '右から', slide_up: '下から', fade: 'フェード', fade_up: 'ふわっと上へ', wipe: 'ワイプ', bounce: 'バウンド', jelly: 'ぷるん', zoom_in: 'ズームイン' };
const exits = { none: 'なし', fade: 'フェード', zoom_out: 'ズームアウト', pop_out: 'ポップアウト', shrink: '縮む', slide_out_left: '左へ', slide_out_right: '右へ', wipe_out: 'ワイプ' };
const idles = { none: 'なし', pulse: '脈動', float: '浮遊', tremble: '震え', wobble: 'ゆらゆら' };

function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function setPreparing(value) {
  preparing = value;
  for (const id of ['play', 'replay', 'prev', 'next', 'seek', 'png', 'nativeExport', 'nativeBatch', 'designBatch', 'setDefault', 'resetDefault', 'fontChoice']) $(id).disabled = value || (exporting && ['nativeExport', 'nativeBatch', 'designBatch'].includes(id));
  for (const button of [...$('effects').children, ...$('designs').children]) button.disabled = value;
}
function options(id, entries) { $(id).replaceChildren(...Object.entries(entries).map(([value, text]) => new Option(text, value))); }
function persistWorking() {
  try { localStorage.setItem(`${STORAGE_KEY}:working`, JSON.stringify(draft)); }
  catch { status('ブラウザに試作を保存できません。JSONに保存してください。', true); }
}

async function init() {
  $('lab').hidden = false;
  const response = await fetch('../../telop-studio/styles.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('styles.jsonを読み込めません');
  raw = await response.json();
  raw = { ...raw, ...nativeStyles('portrait'), _landscape: { ...raw._landscape, ...nativeStyles('landscape') } };
  base = resolveStyles(raw);
  options('set', Object.fromEntries(Object.entries(DESIGN_SETS).map(([key, item]) => [key, item.name])));
  options('position', FX_POS); options('screen', SCREEN);
  options('fontChoice', { ...Object.fromEntries(Object.entries(FONT_CHOICES).map(([id, font]) => [id, font.name])), custom: 'PCで選択したフォント' });
  options('enter', enters); options('exit', exits); options('idle', idles);
  for (const [key, fx] of Object.entries(FX)) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.fx = key; button.textContent = key ? fx.name : '画面効果だけ';
    button.onclick = () => {
      clearTimeout(timer);
      const next = readControls(); next.fx = key; next.text = SAMPLES[key];
      next.name = `${fx.name === 'なし' ? '画面効果' : fx.name}の試作`;
      // 画面効果だけの初期値。通常字幕はseparateのチェックで隠せる。
      next.screen = key ? 'auto' : 'zoom_lines';
      savedId = ''; setDraft(applyMotionDesign(next, defaults), true);
    };
    $('effects').append(button);
  }
  $('search').oninput = () => {
    for (const button of $('effects').children) button.hidden = !button.textContent.includes($('search').value.trim());
  };
  for (const [id, name] of Object.entries({ ...DESIGN_CATEGORIES, all: 'すべて' })) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost'; button.dataset.category = id;
    button.textContent = name; button.onclick = () => { designCategory = id; syncDesignFilter(); };
    $('designCategories').append(button);
  }
  for (const [id, design] of Object.entries(DESIGN_VARIANTS)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'design-card'; button.dataset.design = id;
    button.setAttribute('aria-label', `${design.name}・${design.tag}`);
    const canvas = document.createElement('canvas'); canvas.width = 560; canvas.height = 140; canvas.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.textContent = design.name;
    const detail = document.createElement('small'); detail.textContent = design.tag; button.append(canvas, name, detail);
    button.onclick = () => { clearTimeout(timer); setDraft(selectDesign(readControls(), id)); };
    $('designs').append(button);
  }
  draft = newDraft();
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    saved = data.map(entry => ({ id: String(entry.id), draft: validateDraft(entry.draft, Object.keys(base)) }));
    const working = localStorage.getItem(`${STORAGE_KEY}:working`);
    if (working) draft = validateDraft(JSON.parse(working), Object.keys(base));
  } catch { status('前の試作を読み込めませんでした。保存済みデータは上書きしていません。', true); }
  try {
    const stored = localStorage.getItem(DEFAULTS_KEY);
    if (stored) defaults = validateDefaults(JSON.parse(stored), Object.keys(base));
    if (!localStorage.getItem(`${STORAGE_KEY}:working`)) draft = applyDesignDefault(draft, defaults);
  } catch { status('標準デザインを読み込めませんでした。JSONは上書きしていません。', true); }
  renderSaved(); bind();
  await setDraft(draft, true);
}

function readControls() {
  const out = structuredClone(draft);
  // 最初のフォント準備中は、まだ空欄のフォームで復元データを上書きしない。
  if (!prototype) return out;
  for (const id of controlIds) out[id] = id === 'separate' ? $(id).checked : id === 'duration' ? Number($(id).value) : $(id).value;
  if (styleDirty) {
    const st = structuredClone(designStyle(draft) && part === draft.fx ? out.overrides[draft.aspect][part] || {} : prototype.styles[part]);
    if (draft.font && XML_PRESETS[draft.fx]) for (const key of ['font', 'family', 'weight']) delete st[key];
    for (const [id, key] of Object.entries(styleFields)) if (dirtyFields.has(id) && !$(id).disabled) st[key] = $(id).type === 'number' ? Number($(id).value) : $(id).value;
    out.overrides[draft.aspect][part] = st;
  }
  return out;
}
function syncControls() {
  for (const id of controlIds) if (id === 'separate') $(id).checked = draft[id]; else $(id).value = draft[id];
  $('subtitleLabel').hidden = !draft.separate;
  $('effectTitle').textContent = draft.fx ? FX[draft.fx].name : '画面効果だけ';
  $('styleName').textContent = scene.style;
  document.body.dataset.aspect = draft.aspect;
  for (const button of $('effects').children) button.setAttribute('aria-pressed', String(button.dataset.fx === draft.fx));
  const style = prototype.styles[scene.style];
  const parts = [scene.style, ...(style.group ? [style.label_style, style.body_style] : [])];
  const names = Object.fromEntries(parts.map((key, index) => [key, index === 0 ? (style.group ? '全体（見出し＋本文）' : 'テロップ全体') : index === 1 ? '見出しラベル' : '見出しの本文']));
  options('part', names);
  part = parts.includes(part) ? part : parts[0]; $('part').value = part;
  syncStyle(); syncDesigns();
}

async function prepare(next) {
  validateDraft(next, Object.keys(base));
  const setup = sceneFor(next);
  const makeRenderer = async changed => {
    const renderer = new Renderer(base, raw); renderer.setFormat(next.aspect);
    const configured = designStyle(next, next.aspect, changed);
    const overrides = { ...(changed ? next.overrides[next.aspect] : {}), ...(configured ? { [next.fx]: configured } : {}) };
    renderer.setOverrides(() => ({ subtitle: setup.subtitle, ...overrides, 'subtitle@A': overrides.subtitle || setup.subtitle }));
    // グループの子は文字ブロックのみ。JSONでグループを入れ子にしない。
    for (const st of Object.values(renderer.styles)) if (st.group) {
      if (renderer.styles[st.label_style]?.group || renderer.styles[st.body_style]?.group) throw new Error('グループの中にグループは指定できません。');
    }
    const items = setup.items.filter(item => item.style === '__screen' || renderer.styles[item.style]?.effect || item.text?.trim());
    await renderer.setItems(items);
    addSurfaceLightPreview(renderer);
    await addSparklePreview(renderer);
    // JSONの描画エラーは採用前に検出し、最後に描けたプレビューを保持する。
    const probe = document.createElement('canvas'); probe.width = renderer.W; probe.height = renderer.H;
    const probeCtx = probe.getContext('2d');
    for (const time of [0, .51, .63, .7, 1, setup.end - .05]) renderer.draw(probeCtx, time, null, 'auto');
    return renderer;
  };
  const [original, changed] = await Promise.all([makeRenderer(false), makeRenderer(true)]);
  return { setup, original, changed };
}

function measuredText(renderer, item) {
  const outline = Math.max(0, ...(renderer.styles[item.style].strokes || []).map(stroke => stroke.w || 0));
  return { text: item.text, t: item.t, d: item.d,
    bounds: { width: item.obj.width() + outline * 2, height: item.obj.height() + outline * 2 },
    style: { ...renderer.styles[item.style], size: item.obj.block.size, pos: [item.obj.center(), item.obj.centerY()] } };
}

// XMLと同じ順序で、文字画像へ光の帯をScreen合成してから本文の動き・透明度を1回掛ける。
// 背景は合成対象にせず、本文の同じ字面だけを明るくする。
function addSurfaceLightPreview(renderer) {
  for (const item of renderer.items) {
    const object = item.obj;
    if (!object?.block) continue;
    const style = renderer.styles[item.style];
    if (!style.surfaceLight || style.surfaceLight === 'none') continue;
    const effect = getSurfaceLightSamples({ ...measuredText(renderer, item), W: renderer.W, H: renderer.H });
    if (!effect) continue;
    const baseImage = object.block.compose(0), combined = document.createElement('canvas');
    combined.width = baseImage.width; combined.height = baseImage.height;
    const paint = combined.getContext('2d'), drawOriginal = object.draw.bind(object);
    object.draw = (ctx, localTime, duration) => {
      const band = sampleSurfaceLightAt(effect, item.t + localTime);
      if (!band || band.opacity <= 0) { drawOriginal(ctx, localTime, duration); return; }
      const image = object.block.compose(localTime), state = blockState(object.st, localTime, duration);
      if (state.op <= .001 || state.wipe <= .001 || state.wipeFrom >= .999) return;
      paint.clearRect(0, 0, combined.width, combined.height);
      paint.drawImage(image, 0, 0);
      paint.save();
      paint.beginPath(); paint.rect(band.left + combined.width / 2, 0, band.right - band.left, combined.height); paint.clip();
      paint.globalCompositeOperation = 'screen'; paint.globalAlpha = band.opacity;
      paint.drawImage(image, 0, 0); paint.restore();
      ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, state.op));
      ctx.translate(object.center() + state.dx, object.centerY() + state.dy);
      ctx.rotate((state.rot + (object.st.rotate || 0)) * Math.PI / 180);
      ctx.scale(state.s * (state.sx ?? 1), state.s * (state.sy ?? 1));
      if ((state.wipe ?? 1) < 1 || (state.wipeFrom ?? 0) > 0) {
        const from = state.wipeFrom || 0;
        ctx.beginPath(); ctx.rect(-combined.width / 2 + combined.width * from, -combined.height / 2,
          combined.width * Math.min(state.wipe ?? 1, 1 - from), combined.height); ctx.clip();
      }
      ctx.drawImage(combined, -combined.width / 2, -combined.height / 2); ctx.restore();
    };
  }
}

// 時刻から毎回同じ星を描く。再生・逆方向シーク・XMLで粒子の位置と明るさを共有。
async function addSparklePreview(renderer) {
  const clips = renderer.items.filter(item => item.obj?.block).flatMap(item =>
    getSparkleClips({ ...measuredText(renderer, item), W: renderer.W, H: renderer.H }));
  if (!clips.length) return;
  const decorations = await Promise.all(clips.map(async clip => {
    const style = { ...clip.style, pos: [renderer.W / 2, renderer.H / 2] };
    const glyph = await makeItem({ text: clip.text, style: 'spark', t: 0, d: clip.d }, { spark: style }, renderer.W, renderer.H, FPS);
    return { clip, image: glyph.block.compose(0) };
  }));
  const drawText = renderer.draw.bind(renderer);
  renderer.draw = (ctx, time, ...args) => {
    drawText(ctx, time, ...args);
    for (const { clip, image } of decorations) {
      const point = sampleSparkleAt(clip, time);
      if (!point || point.opacity <= 0) continue;
      ctx.save(); ctx.globalAlpha = point.opacity / 100;
      ctx.translate(point.center.x, point.center.y); ctx.rotate(point.rotation * Math.PI / 180);
      ctx.scale(point.scale / 100, point.scale / 100);
      ctx.drawImage(image, -image.width / 2, -image.height / 2); ctx.restore();
    }
  };
}

async function setDraft(next, resetTime = false) {
  const request = ++generation;
  stop(); clearTimeout(timer); setPreparing(true); status('描画を準備中…');
  try {
    const result = await prepare(next);
    if (request !== generation) return false;
    draft = structuredClone(next); scene = result.setup; baseline = result.original; prototype = result.changed;
    for (const canvas of [$('preview'), $('original')]) { canvas.width = prototype.W; canvas.height = prototype.H; }
    $('seek').max = scene.total;
    t = resetTime ? scene.start + 0.65 : Math.min(t, scene.total);
    background = makeBackground(prototype.W, prototype.H);
    setPreparing(false);
    syncControls(); syncMedia(); draw();
    status('準備完了。再生またはコマ送りで確認できます。');
    persistWorking();
    return true;
  } catch (error) {
    if (request !== generation) return false;
    setPreparing(!prototype);
    if (prototype) syncControls();
    status(`適用できませんでした: ${error.message}`, true); return false;
  }
}

function syncStyle() {
  styleDirty = false; dirtyFields.clear();
  const st = prototype.styles[part];
  const values = { fill: /^#[\da-f]{6}$/i.test(st.fill) ? st.fill : '#ffffff', size: st.size || 66, rotate: st.rotate || 0, enter: st.in || 'none', exit: st.out || 'fade', character: st.char || '', stagger: st.stagger ?? 0.03, idle: st.idle || 'none', outDuration: st.out_d ?? 0.18, sparkle: st.sparkle || 'none', surfaceLight: st.surfaceLight || 'none' };
  for (const [id, value] of Object.entries(values)) $(id).value = value;
  for (const id of ['size', 'rotate', 'enter', 'character', 'stagger', 'idle']) $(id).disabled = !!st.group;
  $('fill').disabled = !!st.group || !/^#[\da-f]{6}$/i.test(st.fill);
  $('sparkle').disabled = !XML_PRESETS[draft.fx] || !!st.group;
  $('surfaceLight').disabled = !XML_PRESETS[draft.fx] || !!st.group;
  const child = part !== scene.style && prototype.styles[scene.style].group;
  for (const id of ['exit', 'outDuration']) { $(id).disabled = !!child; $(id).title = child ? '退場は「全体（見出し＋本文）」で調整します' : ''; }
  $('json').value = JSON.stringify(st, null, 2);
  updateXmlControls();
}

function updateXmlControls() {
  const warnings = xmlStyleWarnings(prototype.styles[scene.style], draft.text);
  if (!fontForStyle(draft, prototype.styles[scene.style])) warnings.push('書体を選び直してください');
  $('nativeExport').disabled = exporting || !draft.fx || !draft.text.trim() || !!warnings.length;
  const hasSparkle = prototype.styles[scene.style].sparkle && prototype.styles[scene.style].sparkle !== 'none';
  const hasSurfaceLight = prototype.styles[scene.style].surfaceLight && prototype.styles[scene.style].surfaceLight !== 'none';
  $('xmlSupport').textContent = warnings.length ? `この試作はXML未対応: ${warnings.join('・')}。［XML］の演出から選べます。` : hasSurfaceLight ? '「本文を編集」シーケンスで文字を変更できます。' : hasSparkle ? '本文とキラキラを別トラックの編集可能な文字として保存します。' : '文字・グラデーション・フチ・動きをXMLに保存できます。';
}

function bind() {
  for (const id of controlIds) $(id).addEventListener(['text', 'subtitle', 'name', 'duration'].includes(id) ? 'input' : 'change', () => {
    clearTimeout(timer);
    stop(); status('描画を準備中…');
    timer = setTimeout(() => setDraft(readControls()), ['text', 'subtitle', 'name', 'duration'].includes(id) ? 280 : 0);
  });
  $('part').onchange = () => {
    const next = readControls(), changed = styleDirty; part = $('part').value;
    if (changed) setDraft(next); else syncStyle();
  };
  for (const id of Object.keys(styleFields)) $(id).addEventListener($(id).type === 'number' ? 'input' : 'change', () => {
    clearTimeout(timer);
    if (!$(id).checkValidity()) { status('指定できる範囲の数値を入力してください。', true); return; }
    styleDirty = true; dirtyFields.add(id); stop(); status('描画を準備中…');
    timer = setTimeout(() => setDraft(readControls()), $(id).type === 'number' ? 200 : 0);
  });
  $('applyJson').onclick = () => {
    try {
      const style = validateStyle(JSON.parse($('json').value), Object.keys(base));
      if (XML_PRESETS[draft.fx] && draft.font && ((style.family && style.family !== draft.font.family) || (style.weight != null && style.weight !== draft.font.weight) || (style.font && style.font !== prototype.styles[part].font))) throw new Error('書体は上の書体メニューか「PCのフォント」で変更してください。');
      const next = readControls(); next.overrides[next.aspect][part] = style; setDraft(next);
    } catch (error) { status(`JSONを適用できません: ${error.message}`, true); }
  };
  $('resetStyle').onclick = () => {
    const next = readControls(); delete next.overrides[next.aspect][part]; setDraft(next);
  };
  for (const button of document.querySelectorAll('[data-sample]')) button.onclick = () => {
    const sample = button.dataset.sample;
    const text = { short: 'ここが{大事}', long: 'これだけは覚えておきたい{大切なポイント}を詳しくお伝えします', lines: '{大切なのは}\n伝わるデザイン', default: XML_PRESETS[draft.fx] && DESIGN_VARIANTS[draft.design]?.sample || SAMPLES[draft.fx] }[sample];
    const next = readControls(); next.text = text; setDraft(next, true);
  };
  $('compare').onchange = () => { $('originalFigure').hidden = !$('compare').checked; $('screens').classList.toggle('compare', $('compare').checked); draw(); };
  $('guides').onchange = draw;
  $('play').onclick = () => playing ? stop() : play();
  $('replay').onclick = () => { stop(); t = 0; play(); };
  $('prev').onclick = () => seek(t - 1 / FPS);
  $('next').onclick = () => seek(t + 1 / FPS);
  $('seek').oninput = () => seek(Number($('seek').value));
  $('speed').onchange = () => { stop(); draw(); };
  $('sound').onchange = () => { if (playing) { stop(); play(); } };
  $('background').onchange = () => { clearMedia(); background = makeBackground(prototype.W, prototype.H); draw(); };
  $('media').onchange = loadMedia;
  $('clearMedia').onclick = () => { clearMedia(); draw(); };
  $('offset').onchange = () => seek(t);
  $('png').onclick = () => {
    // ガイドはラボの表示のみ。保存画像には入れない。
    const clean = document.createElement('canvas'); clean.width = prototype.W; clean.height = prototype.H;
    prototype.draw(clean.getContext('2d'), t, source(), 'auto');
    clean.toBlob(blob => { if (blob) download(blob, `演出テスト-${draft.fx || 'screen'}-${Math.round(t * FPS)}f.png`); });
  };
  $('nativeExport').onclick = () => exportNative(false);
  $('nativeBatch').onclick = () => exportNative('motions');
  $('designBatch').onclick = () => exportNative('designs');
  $('fontChoice').onchange = () => {
    const font = FONT_CHOICES[$('fontChoice').value];
    if (font) { clearTimeout(timer); setDraft(selectFont(readControls(), font)); }
  };
  attachFontPicker($('xmlFontPicker'), { input: $('fontFamily'), getWeight: () => draft.font?.weight || 900,
    onSelect: family => {
      const font = localFonts.describe(family, draft.font?.weight || 900);
      if (!font) { status('この書体の情報を取得できません。PCのフォントを読み直してください。', true); return; }
      clearTimeout(timer); setDraft(selectFont(readControls(), font));
    } });
  $('setDefault').onclick = async () => {
    if (!await setDraft(readControls())) return;
    const next = { ...defaults, [draft.fx]: captureDesignDefault(draft) };
    if (persistDefaults(next)) { syncDesigns(); status('この動きの標準デザインを保存しました。次に選ぶと適用されます。'); }
  };
  $('resetDefault').onclick = () => {
    const next = { ...defaults }; delete next[draft.fx];
    if (persistDefaults(next)) { syncDesigns(); status('この動きの標準指定を解除しました。'); }
  };
  $('exportDefaults').onclick = () => {
    download(new Blob([JSON.stringify(defaultsBackup(defaults), null, 2)], { type: 'application/json' }), '演出ラボ_標準デザイン.json');
    status('標準指定を保存しました。「JSONを読み込む」で戻せます。');
  };
  $('save').onclick = async () => {
    if (!await setDraft(readControls())) return;
    const id = savedId || crypto.randomUUID();
    const entry = { id, draft: structuredClone(draft) };
    const next = saved.filter(item => item.id !== id); next.push(entry);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); saved = next; savedId = id; renderSaved(); $('saved').value = id; status(`「${draft.name}」を保存しました。`); }
    catch { status('保存できません。JSONに保存してください。', true); }
  };
  $('saveAs').onclick = () => { savedId = ''; $('save').click(); };
  $('load').onclick = async () => {
    const entry = saved.find(item => item.id === $('saved').value);
    if (entry && await setDraft(entry.draft, true)) savedId = entry.id;
  };
  $('new').onclick = () => { savedId = ''; $('saved').value = ''; setDraft(applyDesignDefault(newDraft(), defaults), true); };
  $('export').onclick = async () => {
    if (!await setDraft(readControls())) return;
    download(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }), `${draft.name.replace(/[\\/:*?"<>|]/g, '_') || '演出の試作'}.json`);
    status('試作JSONを保存しました。');
  };
  $('import').onchange = async () => {
    try {
      const file = $('import').files[0]; if (!file) return;
      if (file.size > 250000) throw new Error('250KB以下のJSONを選んでください。');
      const data = JSON.parse(await file.text());
      if (data?.kind === 'effects-lab-design-defaults') {
        const imported = validateDefaults(data, Object.keys(base));
        if (persistDefaults({ ...defaults, ...imported })) { syncDesigns(); status('標準デザインを読み込みました。次に動きを選ぶと適用されます。'); }
        return;
      }
      const next = validateDraft(data, Object.keys(base));
      if (await setDraft(next, true)) { savedId = ''; status(`「${draft.name}」を読み込みました。`); }
    } catch (error) { status(error.message, true); }
    finally { $('import').value = ''; }
  };
  document.addEventListener('keydown', event => {
    if (/INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test(event.target.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); playing ? stop() : play(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(t + (event.key === 'ArrowLeft' ? -1 : 1) / FPS); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', () => { stop(); if (mediaURL) URL.revokeObjectURL(mediaURL); audioContext?.close(); });
}

async function exportNative(batch) {
  if (exporting) return;
  exporting = true;
  const batchDesignIds = visibleDesignIds(), batchCategory = designCategory;
  try {
    if (!await setDraft(readControls())) return;
    const W = prototype.W, H = prototype.H, snapshot = structuredClone(draft), snapshotStyle = scene.style;
    const exportFont = fontForStyle(snapshot, prototype.styles[snapshotStyle]);
    if (!exportFont) throw new Error('書体を選び直してください。');
    const fontName = exportFont.postscriptName;
    // 実際の描画で決まった縮小後のサイズ・配置を渡す。設定値のままだと長文がはみ出す。
    const renderedItem = (renderer, styleId) => {
      const item = renderer.items.find(item => item.style === styleId);
      if (!item?.obj?.block) throw new Error('単一のテキストを選んでください。');
      return measuredText(renderer, item);
    };
    let items;
    if (batch === 'motions') {
      items = [];
      for (const [id, preset] of Object.entries(XML_PRESETS)) {
        let sample = { ...newDraft(), aspect: snapshot.aspect, fx: id, text: preset.sample, separate: false, design: snapshot.design, font: exportFont };
        if (XML_PRESETS[snapshot.fx]) sample = applyDesignDefault(sample, { [id]: { ...captureDesignDefault(snapshot), font: exportFont } });
        const result = await prepare(sample);
        items.push({ ...renderedItem(result.changed, id), t: items.length * 4 + .5 });
      }
    } else if (batch === 'designs') {
      items = [];
      for (const id of batchDesignIds) {
        const next = selectDesign(snapshot, id); const result = await prepare(next);
        const itemFont = fontForStyle(next, result.changed.styles[result.setup.style]);
        if (!itemFont) throw new Error('書体を選び直してください。');
        items.push({ ...renderedItem(result.changed, result.setup.style), fontName: itemFont.postscriptName, t: items.length * (snapshot.duration + 1) + .5 });
      }
    } else items = [renderedItem(prototype, snapshotStyle)];
    const name = batch === 'motions' ? `演出ラボ_動き${Object.keys(XML_PRESETS).length}案` : batch === 'designs' ? `演出ラボ_${DESIGN_CATEGORIES[batchCategory] || '全デザイン'}${items.length}案` : `演出ラボ_${snapshot.name.replace(/[\\/:*?"<>|]/g, '_')}`;
    const xml = buildTextXml({ name, W, H, items, fontName });
    const fontLabel = batch === 'designs' && items.some(item => item.fontName !== fontName) ? 'デザイン別書体' : fontName;
    download(new Blob([xml], { type: 'application/xml;charset=utf-8' }), `${name}_${fontLabel.replace(/[\\/:*?"<>|]/g, '_')}.xml`);
    status('演出XMLを保存しました。Premiereの「ファイル → 読み込み」で開き、文字・フチ・動きを調整できます。');
  } catch (error) { status(`Premiere用データを保存できません: ${error.message}`, true); }
  finally { exporting = false; setPreparing(preparing); if (prototype && !preparing) { updateXmlControls(); syncDesigns(); } }
}


function defaultsBackup(value) { return { kind: 'effects-lab-design-defaults', version: 1, defaults: value }; }
function persistDefaults(next) {
  try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaultsBackup(next))); defaults = next; return true; }
  catch { status('標準指定を保存できません。JSONへの保存を使ってください。', true); return false; }
}
function syncDesigns() {
  const native = !!XML_PRESETS[draft.fx];
  $('nativeBatch').textContent = `動き${Object.keys(XML_PRESETS).length}案のXMLを保存`;
  $('designSection').hidden = !native;
  $('setDefault').disabled = !native; $('resetDefault').disabled = !native || !defaults[draft.fx];
  $('designBatch').disabled = exporting || !native || !!xmlStyleWarnings(prototype.styles[scene.style], draft.text).length;
  $('fontChoice').disabled = !native;
  for (const button of $('xmlFontPicker').querySelectorAll('button')) button.disabled = !native;
  const effectiveStyle = prototype.styles[scene.style];
  const font = fontForStyle(draft, effectiveStyle) || { family: effectiveStyle.family || '未選択', weight: effectiveStyle.weight || 900, postscriptName: '' };
  $('fontFamily').value = font.family; $('xmlFont').value = font.postscriptName;
  $('fontChoice').value = Object.entries(FONT_CHOICES).find(([, f]) => f.postscriptName === font.postscriptName)?.[0] || 'custom';
  $('designName').textContent = DESIGN_VARIANTS[draft.design]?.name || '元のデザイン';
  if (!designCategory || lastDesign !== draft.design && designCategory !== 'all') designCategory = DESIGN_VARIANTS[draft.design]?.category || 'common';
  lastDesign = draft.design; syncDesignFilter();
  for (const button of $('designs').children) button.setAttribute('aria-pressed', String(button.dataset.design === draft.design));
  const preferred = defaults[draft.fx];
  $('defaultStatus').textContent = preferred ? `標準：${DESIGN_VARIANTS[preferred.design]?.name || 'カスタム'} / ${preferred.font?.family || '元の書体'}` : '標準は未指定（このPCのラボだけに保存）';
  if (native) renderDesignCards(font).catch(error => status(`デザイン見本を表示できません: ${error.message}`, true));
}
function visibleDesignIds() {
  return Object.keys(DESIGN_VARIANTS).filter(id => designCategory === 'all' || (DESIGN_VARIANTS[id].category || 'common') === designCategory);
}
function syncDesignFilter() {
  const visible = new Set(visibleDesignIds());
  for (const button of $('designCategories').children) button.setAttribute('aria-pressed', String(button.dataset.category === designCategory));
  for (const button of $('designs').children) button.hidden = !visible.has(button.dataset.design);
  $('designs').classList.toggle('purpose-designs', visible.size === 3);
  $('designBatch').textContent = `この動き × ${DESIGN_CATEGORIES[designCategory] || '全デザイン'}${visible.size}案のXML`;
}
async function renderDesignCards(font) {
  const request = ++cardGeneration;
  const key = JSON.stringify(font); if (key === cardsKey) return;
  await Promise.all([...$('designs').children].map(async button => {
    const sample = selectDesign({ ...newDraft(), font }, button.dataset.design);
    const selected = designStyle(sample, 'landscape');
    const style = { ...selected, size: selected.size * .47, max_width: Math.min(515, selected.max_width * .47), pos: [280, 70], in: 'none', out: 'none', out_d: 0 };
    style.strokes = style.strokes.map(stroke => ({ ...stroke, w: stroke.w * .47 }));
    const item = await makeItem({ text: '伝わるテロップ', style: 'sample', t: 0, d: 3 }, { sample: style }, 560, 140, FPS);
    if (request !== cardGeneration) return;
    const canvas = button.querySelector('canvas'), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    item.draw(ctx, 1, 3);
  }));
  if (request === cardGeneration) cardsKey = key;
}

function renderSaved() {
  $('saved').replaceChildren(new Option('試作を選択', ''), ...saved.map(entry => new Option(entry.draft.name, entry.id)));
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeBackground(W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  // Rendererの動画入力の寸法インターフェイスを持つ、ラボ専用のテスト画像。
  c.videoWidth = W; c.videoHeight = H;
  const ctx = c.getContext('2d'), kind = $('background').value;
  ctx.fillStyle = kind === 'light' ? '#e4e1da' : '#252a34'; ctx.fillRect(0, 0, W, H);
  if (kind === 'checker') {
    const unit = 80; for (let y = 0; y < H; y += unit) for (let x = 0; x < W; x += unit) {
      ctx.fillStyle = ((x + y) / unit) % 2 ? '#66707d' : '#414957'; ctx.fillRect(x, y, unit, unit);
    }
  }
  if (kind === 'scene') {
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#d2d8cf'); g.addColorStop(1, '#668a84'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e9e8de'; ctx.fillRect(W * .08, H * .08, W * .22, H * .43);
    ctx.fillStyle = '#a9bdcb'; ctx.fillRect(W * .1, H * .1, W * .18, H * .38);
    ctx.fillStyle = '#4a5e68'; ctx.beginPath(); ctx.ellipse(W * .55, H * .67, W * .17, H * .3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d3ae93'; ctx.beginPath(); ctx.ellipse(W * .55, H * .32, W * .065, H * .13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#26323d'; ctx.beginPath(); ctx.ellipse(W * .55, H * .23, W * .07, H * .065, 0, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8e7262'; ctx.fillRect(0, H * .84, W, H * .16);
    ctx.fillStyle = '#dde4dc'; ctx.fillRect(W * .8, H * .55, W * .09, H * .29);
  }
  return c;
}
function source() { return media || background; }
function draw() {
  if (!prototype) return;
  for (const [renderer, canvas, ctx] of [[prototype, $('preview'), contexts.preview], [baseline, $('original'), contexts.original]]) {
    if (canvas === $('original') && !$('compare').checked) continue;
    renderer.draw(ctx, t, source(), 'auto');
    if ($('guides').checked) {
      const { W, H } = renderer;
      ctx.save(); ctx.strokeStyle = '#ffffff80'; ctx.lineWidth = 2; ctx.setLineDash([12, 12]); ctx.strokeRect(W * .05, H * .05, W * .9, H * .9);
      ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); ctx.restore();
    }
  }
  $('seek').value = t; $('clock').textContent = `${t.toFixed(2)} / ${scene.total.toFixed(2)}s · ${Math.round(t * FPS)}f`;
}

function stopAudio() { ++audioGeneration; for (const node of audioNodes) { try { node.stop(); } catch {} } audioNodes = []; }
function stop() {
  ++playbackRun; playing = false; cancelAnimationFrame(animation); stopAudio();
  if (media?.tagName === 'VIDEO') media.pause(); $('play').textContent = '▶ 再生';
}
function seek(value) { stop(); t = Math.max(0, Math.min(scene.total, value)); syncMedia(); draw(); }
async function scheduleAudio() {
  stopAudio(); if (!$('sound').checked) return;
  const run = audioGeneration;
  audioContext ||= new AudioContext(); await audioContext.resume();
  const events = prototype.sfxEvents().filter(event => event.t >= t && event.t < scene.total);
  await Promise.all(events.map(async event => {
    if (!audioBuffers.has(event.name)) {
      const response = await fetch(`../../telop-studio/sfx/${encodeURIComponent(event.name)}.wav`);
      if (!response.ok) throw new Error(event.name);
      audioBuffers.set(event.name, await audioContext.decodeAudioData(await response.arrayBuffer()));
    }
  }));
  if (run !== audioGeneration || !playing) return;
  for (const event of events) {
    const node = audioContext.createBufferSource(), gain = audioContext.createGain();
    node.buffer = audioBuffers.get(event.name); gain.gain.value = .4; node.connect(gain); gain.connect(audioContext.destination);
    const delay = (event.t - t) / Number($('speed').value);
    // 本体と同じ効果音。低速時も音程は変えず、発音タイミングだけ合わせる。
    node.onended = () => { node.disconnect(); gain.disconnect(); };
    node.start(audioContext.currentTime + delay); audioNodes.push(node);
  }
}
async function play() {
  if (!prototype || preparing) return;
  if (t >= scene.total - .001) t = 0;
  playing = true; $('play').textContent = '❚❚ 停止';
  const run = ++playbackRun;
  try { await scheduleAudio(); } catch { status('効果音を読み込めませんでした。映像だけ再生します。', true); }
  if (!playing || run !== playbackRun) return;
  syncMedia();
  if (media?.tagName === 'VIDEO') { media.playbackRate = Number($('speed').value); media.play().catch(() => status('背景動画を再生できません。静止画として表示します。', true)); }
  lastTick = performance.now();
  function tick(now) {
    if (!playing) return;
    t += Math.max(0, (now - lastTick) / 1000) * Number($('speed').value); lastTick = now;
    if (t >= scene.total) {
      if ($('loop').checked) { t = 0; stop(); play(); return; }
      t = scene.total; stop(); draw(); return;
    }
    if (media?.tagName === 'VIDEO' && Math.abs(media.currentTime - mediaTime()) > .15) syncMedia();
    draw(); animation = requestAnimationFrame(tick);
  }
  animation = requestAnimationFrame(tick);
}
function mediaTime() {
  const offset = Math.max(0, Math.min(Number($('offset').value) || 0, Math.max(0, media.duration - .04)));
  return (offset + t) % media.duration;
}
function syncMedia() { if (media?.tagName === 'VIDEO' && Number.isFinite(media.duration)) media.currentTime = mediaTime(); }
function clearMedia() {
  stop(); ++mediaGeneration;
  if (media?.tagName === 'VIDEO') { media.pause(); media.removeAttribute('src'); media.load(); }
  media = null; if (mediaURL) URL.revokeObjectURL(mediaURL); mediaURL = '';
  $('clearMedia').hidden = true; $('offsetLabel').hidden = true; $('mediaName').textContent = ''; $('media').value = '';
}
async function loadMedia() {
  const file = $('media').files[0]; if (!file) return;
  clearMedia(); const request = mediaGeneration;
  const url = URL.createObjectURL(file);
  try {
    let source;
    if (file.type.startsWith('video/')) {
      source = document.createElement('video'); source.muted = true; source.playsInline = true; source.loop = true; source.preload = 'auto';
      await new Promise((resolve, reject) => { source.onloadeddata = resolve; source.onerror = () => reject(new Error('この動画形式は再生できません。')); source.src = url; });
    } else if (file.type.startsWith('image/')) {
      const img = new Image(); img.src = url; await img.decode();
      source = document.createElement('canvas'); source.width = img.naturalWidth; source.height = img.naturalHeight;
      source.videoWidth = img.naturalWidth; source.videoHeight = img.naturalHeight; source.getContext('2d').drawImage(img, 0, 0);
    } else throw new Error('画像か動画を選んでください。');
    if (request !== mediaGeneration) { URL.revokeObjectURL(url); return; }
    media = source; mediaURL = url;
    $('clearMedia').hidden = false; $('offsetLabel').hidden = source.tagName !== 'VIDEO'; $('mediaName').textContent = file.name; $('offset').value = 0;
    if (source.tagName === 'VIDEO') { $('offset').max = Math.max(0, source.duration - .04); syncMedia(); source.onseeked = draw; }
    draw(); status('背景素材を読み込みました。このページ内だけで使います。');
  } catch (error) { URL.revokeObjectURL(url); if (request === mediaGeneration) status(error.message, true); }
}
