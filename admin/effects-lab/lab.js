import { Renderer, FPS } from '../../telop-studio/js/render.js?v=20261022-effects2';
import { resolveStyles } from '../../telop-studio/js/telop.js?v=20261022-effects2';
import { FX_POS, SCREEN } from '../../telop-studio/js/timeline.js';
import { DESIGN_SETS } from '../../telop-studio/js/sets.js';
import { EFFECTS as FX, STORAGE_KEY, SAMPLES, newDraft, validateDraft, validateStyle, sceneFor } from './model.mjs?v=20261022-effects2';
import { XML_PRESETS, nativeStyles } from './native-presets.mjs?v=20261022-effects2';
import { buildTextXml, xmlStyleWarnings } from './text-xml.mjs?v=20261022-effects2';
import { attachFontPicker } from '../../telop-studio/js/font-picker.js?v=20261022-fonts2';
import { localFonts } from '../../telop-studio/js/local-fonts.js';

const $ = id => document.getElementById(id);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (!local) $('blocked').hidden = false;
else init().catch(error => status(`起動できませんでした: ${error.message}`, true));

let raw, base, draft, scene, baseline, prototype, generation = 0, timer, preparing = true;
let saved = [], savedId = '', part = '', t = 0, playing = false, lastTick = 0, animation, playbackRun = 0;
let media = null, mediaURL = '', mediaGeneration = 0, background;
let audioContext, audioNodes = [], audioGeneration = 0;
let styleDirty = false;
const styleFields = { fill: 'fill', size: 'size', rotate: 'rotate', enter: 'in', exit: 'out', character: 'char', stagger: 'stagger', idle: 'idle', outDuration: 'out_d' };
const audioBuffers = new Map();
const contexts = { original: $('original').getContext('2d'), preview: $('preview').getContext('2d') };
const controlIds = ['aspect', 'set', 'text', 'subtitle', 'separate', 'duration', 'position', 'screen', 'name'];
const enters = { none: 'なし', slam: '叩きつける', pop: 'ポップ', drop: '落下', elastic: '弾む', slide_left: '左から', slide_right: '右から', slide_up: '下から', fade: 'フェード', fade_up: 'ふわっと上へ', wipe: 'ワイプ', bounce: 'バウンド', jelly: 'ぷるん', zoom_in: 'ズームイン' };
const exits = { none: 'なし', fade: 'フェード', zoom_out: 'ズームアウト', pop_out: 'ポップアウト', shrink: '縮む', slide_out_left: '左へ', slide_out_right: '右へ', wipe_out: 'ワイプ' };
const idles = { none: 'なし', pulse: '脈動', float: '浮遊', tremble: '震え', wobble: 'ゆらゆら' };

function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function setPreparing(value) {
  preparing = value;
  for (const id of ['play', 'replay', 'prev', 'next', 'seek', 'png', 'nativeExport', 'nativeBatch']) $(id).disabled = value;
  for (const button of $('effects').children) button.disabled = value;
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
      savedId = ''; setDraft(next, true);
    };
    $('effects').append(button);
  }
  $('search').oninput = () => {
    for (const button of $('effects').children) button.hidden = !button.textContent.includes($('search').value.trim());
  };
  draft = newDraft();
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    saved = data.map(entry => ({ id: String(entry.id), draft: validateDraft(entry.draft, Object.keys(base)) }));
    const working = localStorage.getItem(`${STORAGE_KEY}:working`);
    if (working) draft = validateDraft(JSON.parse(working), Object.keys(base));
  } catch { status('前の試作を読み込めませんでした。保存済みデータは上書きしていません。', true); }
  renderSaved(); bind();
  await setDraft(draft, true);
}

function readControls() {
  const out = structuredClone(draft);
  // 最初のフォント準備中は、まだ空欄のフォームで復元データを上書きしない。
  if (!prototype) return out;
  for (const id of controlIds) out[id] = id === 'separate' ? $(id).checked : id === 'duration' ? Number($(id).value) : $(id).value;
  if (styleDirty) {
    const st = structuredClone(prototype.styles[part]);
    for (const [id, key] of Object.entries(styleFields)) if (!$(id).disabled) st[key] = $(id).type === 'number' ? Number($(id).value) : $(id).value;
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
  syncStyle();
}

async function prepare(next) {
  validateDraft(next, Object.keys(base));
  const setup = sceneFor(next);
  const makeRenderer = async changed => {
    const renderer = new Renderer(base, raw); renderer.setFormat(next.aspect);
    const overrides = changed ? next.overrides[next.aspect] : {};
    renderer.setOverrides(() => ({ subtitle: setup.subtitle, ...overrides, 'subtitle@A': overrides.subtitle || setup.subtitle }));
    // グループの子は文字ブロックのみ。JSONでグループを入れ子にしない。
    for (const st of Object.values(renderer.styles)) if (st.group) {
      if (renderer.styles[st.label_style]?.group || renderer.styles[st.body_style]?.group) throw new Error('グループの中にグループは指定できません。');
    }
    const items = setup.items.filter(item => item.style === '__screen' || renderer.styles[item.style]?.effect || item.text?.trim());
    await renderer.setItems(items);
    // JSONの描画エラーは採用前に検出し、最後に描けたプレビューを保持する。
    const probe = document.createElement('canvas'); probe.width = renderer.W; probe.height = renderer.H;
    const probeCtx = probe.getContext('2d');
    for (const time of [0, .51, .63, .7, 1, setup.end - .05]) renderer.draw(probeCtx, time, null, 'auto');
    return renderer;
  };
  const [original, changed] = await Promise.all([makeRenderer(false), makeRenderer(true)]);
  return { setup, original, changed };
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
  styleDirty = false;
  const st = prototype.styles[part];
  const values = { fill: /^#[\da-f]{6}$/i.test(st.fill) ? st.fill : '#ffffff', size: st.size || 66, rotate: st.rotate || 0, enter: st.in || 'none', exit: st.out || 'fade', character: st.char || '', stagger: st.stagger ?? 0.03, idle: st.idle || 'none', outDuration: st.out_d ?? 0.18 };
  for (const [id, value] of Object.entries(values)) $(id).value = value;
  for (const id of ['size', 'rotate', 'enter', 'character', 'stagger', 'idle']) $(id).disabled = !!st.group;
  $('fill').disabled = !!st.group || !/^#[\da-f]{6}$/i.test(st.fill);
  const child = part !== scene.style && prototype.styles[scene.style].group;
  for (const id of ['exit', 'outDuration']) { $(id).disabled = !!child; $(id).title = child ? '退場は「全体（見出し＋本文）」で調整します' : ''; }
  $('json').value = JSON.stringify(st, null, 2);
  const warnings = xmlStyleWarnings(prototype.styles[scene.style], draft.text);
  $('nativeExport').disabled = !draft.fx || !draft.text.trim() || !!warnings.length;
  $('xmlSupport').textContent = warnings.length ? `この試作はXML未対応: ${warnings.join('・')}。［XML］の3案から選べます。` : '色・サイズ・位置・傾き・動きをXMLに保存できます。';
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
    styleDirty = true; stop(); status('描画を準備中…');
    timer = setTimeout(() => setDraft(readControls()), $(id).type === 'number' ? 200 : 0);
  });
  $('applyJson').onclick = () => {
    try {
      const style = validateStyle(JSON.parse($('json').value), Object.keys(base));
      const next = readControls(); next.overrides[next.aspect][part] = style; setDraft(next);
    } catch (error) { status(`JSONを適用できません: ${error.message}`, true); }
  };
  $('resetStyle').onclick = () => {
    const next = readControls(); delete next.overrides[next.aspect][part]; setDraft(next);
  };
  for (const button of document.querySelectorAll('[data-sample]')) button.onclick = () => {
    const sample = button.dataset.sample;
    const text = { short: 'ここが{大事}', long: 'これだけは覚えておきたい{大切なポイント}を詳しくお伝えします', lines: '{大切なのは}\n伝わるデザイン', default: SAMPLES[draft.fx] }[sample];
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
  $('nativeBatch').onclick = () => exportNative(true);
  attachFontPicker($('xmlFontPicker'), { input: $('xmlFont'), getWeight: () => 700,
    onSelect: family => { $('xmlFont').value = localFonts.premiereName(family, 700); } });
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
  $('new').onclick = () => { savedId = ''; $('saved').value = ''; setDraft(newDraft(), true); };
  $('export').onclick = async () => {
    if (!await setDraft(readControls())) return;
    download(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }), `${draft.name.replace(/[\\/:*?"<>|]/g, '_') || '演出の試作'}.json`);
    status('試作JSONを保存しました。');
  };
  $('import').onchange = async () => {
    try {
      const file = $('import').files[0]; if (!file) return;
      if (file.size > 250000) throw new Error('250KB以下のJSONを選んでください。');
      const next = validateDraft(JSON.parse(await file.text()), Object.keys(base));
      if (await setDraft(next, true)) { savedId = ''; status(`「${draft.name}」を読み込みました。`); }
    } catch (error) { status(error.message, true); }
    $('import').value = '';
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
  try {
    if (!await setDraft(readControls())) return;
    const W = prototype.W, H = prototype.H;
    // 実際の描画で決まった縮小後のサイズ・配置を渡す。設定値のままだと長文がはみ出す。
    const renderedItem = (renderer, styleId) => {
      const item = renderer.items.find(item => item.style === styleId);
      if (!item?.obj?.block) throw new Error('単一のテキストを選んでください。');
      return { text: item.text, t: item.t, d: item.d, style: { ...renderer.styles[styleId],
        size: item.obj.block.size, pos: [item.obj.center(), item.obj.centerY()] } };
    };
    let items;
    if (batch) {
      items = [];
      for (const [id, preset] of Object.entries(XML_PRESETS)) {
        const result = await prepare({ ...newDraft(), aspect: draft.aspect, fx: id, text: preset.sample, separate: false });
        items.push({ ...renderedItem(result.changed, id), t: items.length * 4 + .5 });
      }
    } else items = [renderedItem(prototype, scene.style)];
    const name = batch ? '演出ラボ_演出3案' : `演出ラボ_${draft.name.replace(/[\\/:*?"<>|]/g, '_')}`;
    const fontName = $('xmlFont').value;
    const xml = buildTextXml({ name, W, H, items, fontName });
    download(new Blob([xml], { type: 'application/xml;charset=utf-8' }), `${name}_${fontName.replace(/[\\/:*?"<>|]/g, '_')}.xml`);
    status('演出XMLを保存しました。Premiereの「ファイル → 読み込み」で開けます。今回追加した色・配置・動きの再現は実機で確認してください。');
  } catch (error) { status(`Premiere用データを保存できません: ${error.message}`, true); }
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
