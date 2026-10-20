import { resolveStyles } from "./telop.js";
import { Renderer } from "./render.js";
import {
  decodeAudio, toMono16k, loudness, detectSpeech, buildLines, buildSegments, buildItems,
  totalDuration, srcToOut, outToSrc, toSrt, FX, FX_POS, SCREEN, FRAME, layoutClips, splitAtClips, clipAt, assignSpeakers,
} from "./timeline.js";
import { mixAudio, exportMp4 } from "./export.js";
import { openMedia, decodeAudioTrack } from "./decode.js";
import { DEFAULT_DESIGN, normalizeDesign, designToStyle, buildDesignPanel } from "./design.js";
import { autoEdit, describe } from "./autoedit.js";
import { buildPremierePackage } from "./premiere.js";

const $ = (id) => document.getElementById(id);
const canvas = $("preview");
const ctx = canvas.getContext("2d");
const LONG_WARN = 20 * 60; // これより長いと重くなる（秒）

const state = {
  clips: [],        // 素材: { id, file, media, audio, db, pcm, video, duration, offset, span }
  db: null,         // 全素材をつないだ 20ms ごとの音量
  pcm: null,        // 全素材をつないだ 16kHz モノラル（文字起こし用）
  speech: [],
  lines: [],
  segs: [],
  settings: {
    title: "", layout: "auto", gap: 0.3, aspect: "portrait",
    speakers: [{ id: "A", name: "話者A", design: loadDefaultDesign() }], // 話者ごとの字幕デザイン
    audio: { voiceAuto: true, voice: 100, sfx: 40 },  // 音量（%）
  },
  editSpeaker: "A", // デザインパネルで編集中の話者
  voiceAutoGain: 1, // 声を聞きやすい大きさにそろえる倍率（素材から計算）
  t: 0,             // 出力側の再生位置（秒）
  playing: false,
};
let renderer, sfxBuffers = {}, refreshDesignPanel = () => {};

const DESIGN_KEY = "telop-studio:defaultDesign";
function loadDefaultDesign() {
  try { return normalizeDesign(JSON.parse(localStorage.getItem(DESIGN_KEY))); } catch { return structuredClone(DEFAULT_DESIGN); }
}

// ---------------------------------------------------------------- speakers
// 話者を追加したときの境界線の色（Aは初期デザインのまま）
const SPEAKER_COLORS = ["#121212", "#1a5fd6", "#d62a4a", "#1f9d55", "#8a3fd1", "#e07b00"];
const speakers = () => state.settings.speakers;
const editingSpeaker = () => speakers().find((s) => s.id === state.editSpeaker) || speakers()[0];

function addSpeaker() {
  const list = speakers();
  const ids = "ABCDEFGHIJ";
  const id = [...ids].find((c) => !list.some((s) => s.id === c));
  if (!id) return null;
  const design = structuredClone(list[0].design);
  const color = SPEAKER_COLORS[list.length % SPEAKER_COLORS.length];
  if (design.strokes.length) design.strokes[0].color = color;
  else design.strokes.push({ ...structuredClone(DEFAULT_DESIGN.strokes[0]), color });
  const sp = { id, name: `話者${id}`, design };
  list.push(sp);
  return sp;
}

function renderSpeakerBar() {
  const bar = $("speakerBar");
  bar.innerHTML = "";
  for (const sp of speakers()) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "sp-tab" + (sp.id === editingSpeaker().id ? " on" : "") });
    const dot = document.createElement("i");
    dot.style.background = sp.design.strokes[0]?.color || sp.design.fill.color;
    b.append(dot, document.createTextNode(sp.name));
    b.onclick = () => { state.editSpeaker = sp.id; renderSpeakerBar(); refreshDesignPanel(); };
    bar.append(b);
  }
  const add = Object.assign(document.createElement("button"), { type: "button", className: "ghost small", textContent: "＋ 話者を追加" });
  add.onclick = () => {
    const sp = addSpeaker();
    if (!sp) return;
    state.editSpeaker = sp.id;
    renderSpeakerBar();
    refreshDesignPanel();
    designChanged();
    renderTable();
  };
  bar.append(add);
  const cur = editingSpeaker();
  $("inpSpeakerName").value = cur.name;
  $("btnSpeakerDelete").disabled = speakers().length <= 1;
}

function speakersChanged() {
  renderSpeakerBar();
  refreshDesignPanel();
  designChanged();
  renderTable();
}

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const projectKey = () => "telop-studio:" + state.clips.map((c) => `${c.file.name}:${c.file.size}`).join("|");
const baseName = () => (state.clips[0]?.file.name || "video").replace(/\.[^.]+$/, "");
const sourceDuration = () => state.clips.reduce((a, c) => a + c.duration, 0);

// ---------------------------------------------------------------- init
async function init() {
  if (!("VideoEncoder" in window) || !("AudioDecoder" in window)) $("unsupported").hidden = false;
  const raw = await (await fetch("styles.json")).json();
  const styles = resolveStyles(raw);
  renderer = new Renderer(styles, raw);
  // 話者ごとの字幕スタイル subtitle@A, subtitle@B …（subtitle は話者Aと同じ）
  renderer.setOverrides((aspect) => {
    const o = {};
    for (const sp of speakers()) o[`subtitle@${sp.id}`] = designToStyle(sp.design, aspect);
    o.subtitle = o[`subtitle@${speakers()[0].id}`];
    return o;
  });
  refreshDesignPanel = buildDesignPanel($("designPanel"), {
    getDesign: () => editingSpeaker().design,
    getAspect: () => state.settings.aspect,
    onChange: () => { designChanged(); renderSpeakerBar(); },
  });
  renderSpeakerBar();
  const ac = new AudioContext();
  const names = [...new Set(Object.values(styles).map((s) => s.sfx).filter(Boolean)), "drumroll"];
  await Promise.all(names.map(async (n) => {
    try { sfxBuffers[n] = await ac.decodeAudioData(await (await fetch(`sfx/${n}.wav`)).arrayBuffer()); } catch { /* 無くても動く */ }
  }));
  ac.close();
  await document.fonts.load('900 40px "Noto Sans JP"', "テロップ");
  applyFormat();
  syncAudioUi();
}

// 字幕デザインが変わったら作り直して再描画（連続入力はまとめる）
let designTimer;
function designChanged() {
  clearTimeout(designTimer);
  designTimer = setTimeout(async () => {
    renderer.restyle();
    if (state.clips.length) await refresh(false);
    else drawDesignSample();
  }, 150);
}

// 素材がないときもデザインを確認できるように見本を描く
async function drawDesignSample() {
  if (state.clips.length) return;
  const sp = editingSpeaker();
  await renderer.setItems([{ style: `subtitle@${sp.id}`, text: `${sp.name}の字幕見本\n{強調}はこの色になります`, t: 0, d: 10 }]);
  ctx.fillStyle = "#3a4250";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const it of renderer.items) it.obj.draw(ctx, 5, 10);
}

// 縦 9:16 / 横 16:9 の切り替え
function applyFormat() {
  const a = state.settings.aspect;
  renderer.setFormat(a);
  refreshDesignPanel();
  canvas.width = renderer.W;
  canvas.height = renderer.H;
  document.body.classList.toggle("landscape", a === "landscape");
  $("selAspect").value = a;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawDesignSample();
}

// ---------------------------------------------------------------- step 1: clips
async function addFiles(files) {
  files = [...files].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
  if (!files.length) return;
  if (state.lines.length && !confirm("素材を追加すると、文字起こしと字幕の修正はやり直しになります。続けますか？")) return;
  stop();
  files.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  for (const [i, file] of files.entries()) {
    const label = files.length > 1 ? `素材 ${i + 1}/${files.length}` : "素材";
    try {
      state.clips.push(await loadClip(file, (msg) => setStatus("anaStatus", `${label}：${msg}`)));
    } catch (e) {
      console.error(e);
      setStatus("anaStatus", `「${file.name}」を読み込めませんでした：${e.message}`, true);
      renderClipList();
      return;
    }
  }
  await clipsChanged(true);
}

async function loadClip(file, status) {
  const video = Object.assign(document.createElement("video"), { playsInline: true, preload: "auto", src: URL.createObjectURL(file) });
  await Promise.race([
    new Promise((r) => video.addEventListener("loadeddata", r, { once: true })),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  status("読み込み中…");
  // MP4/MOV は必要な部分だけ少しずつ読む（数GBでもOK）
  const media = await openMedia(file);
  if (media && !media.audio) throw new Error(media.audioError);
  let audio;
  if (media) audio = await decodeAudioTrack(media, (p) => status(`音声を読み込み中… ${Math.round(p * 100)}%`));
  else if (file.size > 800e6) throw new Error("この形式の大きいファイルには対応していません。MP4 か MOV を使ってください。");
  else audio = await decodeAudio(file);
  const pcm = await toMono16k(audio);
  return { id: crypto.randomUUID(), file, media, video, audio, pcm, db: loudness(pcm), duration: media ? media.duration : audio.duration };
}

// 素材の並び・数が変わったとき：つないだ音声を作り直す
async function clipsChanged(fromAdd) {
  renderClipList();
  const has = state.clips.length > 0;
  $("dropHint").hidden = has;
  $("dropzone").classList.toggle("loaded", has);
  $("btnAnalyze").disabled = !has;
  if (!has) {
    Object.assign(state, { db: null, pcm: null, speech: [], lines: [], segs: [], items: [] });
    await renderer.setItems([]);
    renderTable();
    applyFormat();
    for (const id of ["btnPlay", "seek", "btnExport", "btnSrt", "btnSaveProject", "btnAddLine"]) $(id).disabled = true;
    $("cutSummary").textContent = "";
    $("time").textContent = "0:00.0 / 0:00.0";
    setStatus("anaStatus", "音声は外部に送信されず、このパソコンの中だけで処理されます。");
    return;
  }
  const total = layoutClips(state.clips);
  const nFr = Math.round(total / FRAME);
  state.db = new Float32Array(nFr).fill(-100);
  state.pcm = new Float32Array(Math.round(total * 16000));
  for (const c of state.clips) {
    state.db.set(c.db.subarray(0, Math.round(c.span / FRAME)), Math.round(c.offset / FRAME));
    state.pcm.set(c.pcm.subarray(0, Math.round(c.span * 16000)), Math.round(c.offset * 16000));
  }
  state.lines = [];
  state.t = 0;
  $("btnUndoAuto").hidden = true; // 素材が変わったら、おまかせ編集の「元に戻す」は使えない
  const saved = localStorage.getItem(projectKey());
  if (saved) {
    applyProject(JSON.parse(saved));
    setStatus("anaStatus", "前回の作業を復元しました。最初からやり直す場合は「解析する」を押してください。");
  } else if (fromAdd && state.pendingProject) {
    applyProject(state.pendingProject);
    state.pendingProject = null;
    setStatus("anaStatus", "読み込んだ作業を使います。");
  } else {
    const long = sourceDuration() > LONG_WARN ? `（合計 ${fmt(sourceDuration())}。長い素材は文字起こしに時間がかかります）` : "";
    setStatus("anaStatus", `「解析する」を押すと、無言部分のカットと文字起こしをします。${long}`);
  }
  computeSpeech();
  await refresh(true);
}

function computeSpeech() {
  if (state.db) state.speech = splitAtClips(detectSpeech(state.db, { gap: state.settings.gap }), state.clips);
  computeVoiceGain();
}

function renderClipList() {
  const ol = $("clipList");
  ol.innerHTML = "";
  ol.hidden = !state.clips.length;
  state.clips.forEach((c, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="clip-name"></span><span class="mono clip-dur"></span>
      <button class="icon" title="前へ">↑</button><button class="icon" title="後ろへ">↓</button><button class="icon" title="外す">✕</button>`;
    li.querySelector(".clip-name").textContent = c.file.name;
    li.querySelector(".clip-dur").textContent = fmt(c.duration);
    const [up, down, del] = li.querySelectorAll("button");
    up.disabled = i === 0;
    down.disabled = i === state.clips.length - 1;
    const move = async (j) => {
      if (state.lines.length && !confirm("並び順を変えると、文字起こしと字幕の修正はやり直しになります。続けますか？")) return;
      stop();
      const [c2] = state.clips.splice(i, 1);
      state.clips.splice(j, 0, c2);
      await clipsChanged(false);
    };
    up.onclick = () => move(i - 1);
    down.onclick = () => move(i + 1);
    del.onclick = async () => {
      if (state.lines.length && !confirm("素材を外すと、文字起こしと字幕の修正はやり直しになります。続けますか？")) return;
      stop();
      const [gone] = state.clips.splice(i, 1);
      URL.revokeObjectURL(gone.video.src);
      await clipsChanged(false);
    };
    ol.appendChild(li);
  });
  $("fileLabel").textContent = state.clips.length
    ? `素材 ${state.clips.length} 本・合計 ${fmt(sourceDuration())}（ここに追加でドロップできます）`
    : "話している動画を選ぶ（複数まとめてOK・ドロップでも可）";
}

// ---------------------------------------------------------------- step 2: analyze
let worker;
// 話者判別の結果を字幕に反映し、足りない話者を追加する
function applySpeakers(segments) {
  const n = assignSpeakers(state.lines, segments);
  while (speakers().length < n) addSpeaker();
  for (const l of state.lines) if (l.speakerIndex != null) l.speaker = speakers()[l.speakerIndex].id;
  speakersChanged();
  return n;
}

function analyze(onlySpeakers = false) {
  if (!state.pcm) return;
  $("btnAnalyze").disabled = $("btnDiarize").disabled = true;
  showProgress("anaProgress", 0);
  worker ||= new Worker("js/whisper-worker.js", { type: "module" });
  const device = "gpu" in navigator ? "webgpu" : "wasm";
  const files = {};
  const finish = () => { $("btnAnalyze").disabled = false; $("btnDiarize").disabled = !state.lines.length; $("anaProgress").hidden = true; };
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "progress" && m.p.status === "progress" && m.p.total) {
      files[m.p.file] = [m.p.loaded, m.p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      showProgress("anaProgress", l / t);
      setStatus("anaStatus", `AIモデルをダウンロード中… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)}MB（初回のみ）`);
    } else if (m.type === "status") {
      setStatus("anaStatus", m.text);
      if (m.text.startsWith("文字起こし") || m.text.startsWith("話者を判別")) showProgress("anaProgress", -1);
    } else if (m.type === "done") {
      computeSpeech();
      state.lines = buildLines(m.chunks, state.speech, state.pcm.length / 16000);
      let msg = `完了：字幕 ${state.lines.length} 枚。下の「✨ おまかせ編集」で演出を自動で付けられます`;
      if (m.segments) msg += `・話者 ${applySpeakers(m.segments)} 人を判別（間違いは表の「話者」で直せます）`;
      finish();
      setStatus("anaStatus", msg);
      await refresh(true);
    } else if (m.type === "speakers") {
      const n = applySpeakers(m.segments);
      finish();
      setStatus("anaStatus", `話者 ${n} 人を判別しました（間違いは表の「話者」で直せます）`);
      await refresh(true);
    } else if (m.type === "error") {
      finish();
      setStatus("anaStatus", `エラー：${m.message}`, true);
    }
  };
  if (onlySpeakers) worker.postMessage({ type: "diarize", audio: state.pcm });
  else worker.postMessage({ audio: state.pcm, model: $("selModel").value, device, speakers: $("chkSpeakers").checked });
}

// ---------------------------------------------------------------- model → view
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(false), 250);
}

async function refresh(rebuildTable) {
  if (!state.clips.length) return;
  state.segs = buildSegments(state.speech, state.lines);
  const total = totalDuration(state.segs);
  state.items = buildItems(state.lines, state.segs, state.settings);
  await renderer.setItems(state.items);
  state.t = Math.min(state.t, total);
  $("seek").max = total || 1;
  const src = sourceDuration();
  $("cutSummary").textContent = `元の長さ ${fmt(src)} → カット後 ${fmt(total)}（${Math.round((1 - total / src) * 100)}% 短縮）`;
  if (rebuildTable) renderTable();
  for (const id of ["btnPlay", "seek", "btnExport", "btnSrt", "btnSaveProject", "btnAddLine"]) $(id).disabled = !state.segs.length;
  $("btnDiarize").disabled = !state.lines.length;
  $("btnAuto").disabled = !state.lines.length;
  $("btnPremiere").disabled = !state.segs.length;
  save();
  if (!state.playing) await seekTo(state.t);
}

function renderTable() {
  const tb = $("lines").querySelector("tbody");
  tb.innerHTML = "";
  const toOpts = (o) => Object.entries(o).map(([k, v]) => `<option value="${k}">${typeof v === "string" ? v : v.name}</option>`).join("");
  const opts = toOpts(FX), posOpts = toOpts(FX_POS), scrOpts = toOpts(SCREEN);
  const multi = state.clips.length > 1;
  let lastClip = -1;
  for (const l of state.lines) {
    const ci = clipAt(state.clips, l.src[0]);
    if (multi && ci !== lastClip) {
      // 素材の切れ目に見出し行を入れる
      const sep = document.createElement("tr");
      sep.className = "clip-sep";
      sep.innerHTML = `<td colspan="5"></td>`; // 列数: 時間・字幕・演出・画面効果・カット
      sep.firstChild.textContent = `素材 ${ci + 1}：${state.clips[ci].file.name}`;
      tb.appendChild(sep);
      lastClip = ci;
    }
    const tr = document.createElement("tr");
    tr.dataset.id = l.id;
    tr.innerHTML = `<td class="time"><button class="mono"></button></td>
      <td class="sub"><select class="sp-sel"></select><textarea rows="2"></textarea></td>
      <td class="fx"><select class="fx-type">${opts}</select><input type="text" placeholder="空なら字幕と同じ">
        <label class="fx-pos">位置 <select>${posOpts}</select></label></td>
      <td class="scr"><select>${scrOpts}</select></td>
      <td class="cut"><input type="checkbox"></td>`;
    const bt = tr.querySelector(".time button"), ta = tr.querySelector("textarea");
    const sel = tr.querySelector(".fx-type"), inp = tr.querySelector(".fx input[type=text]");
    const pos = tr.querySelector(".fx-pos select"), scr = tr.querySelector(".scr select"), cb = tr.querySelector(".cut input");
    bt.textContent = fmt(srcToOut(state.segs, l.src[0]));
    bt.onclick = () => seekTo(srcToOut(state.segs, l.src[0]) + 0.01);
    ta.value = l.text;
    ta.oninput = () => { l.text = ta.value; scheduleRefresh(); };
    // 話者（1人だけのときは隠す）
    const spSel = tr.querySelector(".sp-sel");
    for (const sp of speakers()) spSel.appendChild(Object.assign(document.createElement("option"), { value: sp.id, textContent: sp.name }));
    spSel.value = speakers().some((s) => s.id === l.speaker) ? l.speaker : speakers()[0].id;
    spSel.hidden = speakers().length <= 1;
    spSel.onchange = () => { l.speaker = spSel.value; scheduleRefresh(); };
    const syncFx = () => {
      const on = !!FX[l.fx]?.style;
      inp.hidden = pos.parentElement.hidden = !on;
      inp.placeholder = l.fx === "point" ? "その1/本文" : "空なら字幕と同じ";
    };
    sel.value = l.fx;
    sel.onchange = () => { l.fx = sel.value; syncFx(); scheduleRefresh(); };
    inp.value = l.fxText;
    inp.oninput = () => { l.fxText = inp.value; scheduleRefresh(); };
    pos.value = l.fxPos || "auto";
    pos.onchange = () => { l.fxPos = pos.value; scheduleRefresh(); };
    scr.value = l.screen || "auto";
    scr.onchange = () => { l.screen = scr.value; scheduleRefresh(); };
    syncFx();
    cb.checked = l.cut;
    tr.classList.toggle("is-cut", l.cut);
    cb.onchange = async () => { l.cut = cb.checked; await refresh(true); };
    tb.appendChild(tr);
  }
}

function highlightRow() {
  const cur = state.items?.find((it) => it.style.startsWith("subtitle") && state.t >= it.t && state.t < it.t + it.d);
  for (const tr of $("lines").querySelectorAll("tbody tr[data-id]")) {
    const on = cur && tr.dataset.id === cur.line;
    if (on && !tr.classList.contains("current") && state.playing) tr.scrollIntoView({ block: "nearest" });
    tr.classList.toggle("current", !!on);
  }
}

function updateClock() {
  const total = totalDuration(state.segs);
  $("time").textContent = `${fmt(state.t)} / ${fmt(total)}`;
  $("seek").value = state.t;
  highlightRow();
}

// ---------------------------------------------------------------- playback
const waitSeek = (video, t) => new Promise((r) => {
  if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) return r();
  video.addEventListener("seeked", r, { once: true });
  video.currentTime = t;
});

// 出力の時刻 → どの素材の何秒目か
function locate(t) {
  const { src, seg } = outToSrc(state.segs, t);
  const s = state.segs[seg];
  const c = state.clips[s.clip];
  return { seg, clip: c, local: Math.min(src - c.offset, c.duration - 0.01) };
}

let seekToken = 0;
async function seekTo(t) {
  if (state.playing) stop();
  state.t = Math.max(0, Math.min(t, totalDuration(state.segs)));
  if (!state.segs.length) return;
  const my = ++seekToken;
  updateClock();
  const { clip, local } = locate(state.t);
  await waitSeek(clip.video, local);
  if (my !== seekToken) return; // 連続シーク中は最後の1回だけ描く
  renderer.draw(ctx, state.t, clip.video, state.settings.layout);
}

// 音量（倍率）。声は「自動でそろえる」の倍率 × スライダー
function gains() {
  const a = state.settings.audio;
  return { voice: (a.voiceAuto ? state.voiceAutoGain : 1) * (a.voice / 100), sfx: a.sfx / 100 };
}

// しゃべっている部分の平均音量から、聞きやすい大きさ（-20dBFS 前後）にそろえる倍率を出す
function computeVoiceGain() {
  if (!state.pcm || !state.speech.length) { state.voiceAutoGain = 1; return; }
  let sum = 0, n = 0;
  for (const s of state.speech) {
    for (let i = Math.floor(s.start * 16000); i < Math.min(state.pcm.length, s.end * 16000); i += 4) { sum += state.pcm[i] ** 2; n++; }
  }
  const db = 10 * Math.log10(sum / Math.max(1, n) + 1e-12);
  state.voiceAutoGain = Math.min(6, Math.max(0.4, 10 ** ((-20 - db) / 20)));
}

let sfxCtx, sfxNodes = [], segIdx = 0, active = null, voiceBus, sfxBus;
function audioGraph() {
  sfxCtx ||= new AudioContext();
  if (!voiceBus) {
    // プレビューも書き出しと同じ音量バランスで聞けるように、声と効果音を別々の音量つまみに通す
    const limiter = new DynamicsCompressorNode(sfxCtx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    limiter.connect(sfxCtx.destination);
    voiceBus = new GainNode(sfxCtx);
    sfxBus = new GainNode(sfxCtx);
    voiceBus.connect(limiter);
    sfxBus.connect(limiter);
  }
  for (const c of state.clips) if (!c.srcNode) { c.srcNode = sfxCtx.createMediaElementSource(c.video); c.srcNode.connect(voiceBus); }
  const g = gains();
  voiceBus.gain.value = g.voice;
  sfxBus.gain.value = g.sfx;
}

async function play() {
  const total = totalDuration(state.segs);
  if (state.t >= total - 0.05) state.t = 0;
  const { seg, clip, local } = locate(state.t);
  segIdx = seg;
  active = clip.video;
  await waitSeek(active, local);
  state.playing = true;
  $("btnPlay").textContent = "❚❚";
  audioGraph();
  await sfxCtx.resume();
  const now = sfxCtx.currentTime + 0.05;
  for (const e of renderer.sfxEvents()) {
    const b = sfxBuffers[e.name];
    if (!b || e.t < state.t - 0.05) continue;
    const n = sfxCtx.createBufferSource();
    n.buffer = b;
    n.connect(sfxBus);
    n.start(now + Math.max(0, e.t - state.t));
    sfxNodes.push(n);
  }
  await active.play();
  requestAnimationFrame(tick);
}

function tick() {
  if (!state.playing) return;
  let s = state.segs[segIdx];
  let c = state.clips[s.clip];
  const local = active.currentTime;
  if (local >= s.end - c.offset - 0.02 || active.ended) {
    segIdx++;
    if (segIdx >= state.segs.length) { state.t = totalDuration(state.segs); stop(); updateClock(); return; }
    s = state.segs[segIdx];
    c = state.clips[s.clip];
    if (c.video !== active) {
      // 次の素材へ切り替え
      active.pause();
      active = c.video;
      active.currentTime = s.start - c.offset;
      active.play();
    } else {
      active.currentTime = s.start - c.offset; // 次の区間へジャンプ（ジャンプカット）
    }
  }
  state.t = s.out + Math.max(0, Math.min(active.currentTime + c.offset, s.end) - s.start);
  renderer.draw(ctx, state.t, active, state.settings.layout);
  updateClock();
  requestAnimationFrame(tick);
}

function stop() {
  state.playing = false;
  for (const c of state.clips) c.video.pause();
  $("btnPlay").textContent = "▶";
  for (const n of sfxNodes) try { n.stop(); } catch { /* 再生済み */ }
  sfxNodes = [];
}

// ---------------------------------------------------------------- export
async function doExport() {
  stop();
  if (state.clips.length > 1 && state.clips.some((c) => !c.media)) {
    setStatus("expStatus", "複数の素材をつなぐときは、すべて MP4 か MOV にしてください。", true);
    return;
  }
  const btn = $("btnExport");
  // 書き出し中に設定や字幕が変わると映像が崩れるので、操作をロックする
  const locked = [btn, $("selAspect"), $("selLayout"), $("inpTitle"), $("inpGap"), $("btnAnalyze"), $("btnAddLine"), $("inpVideo"), $("btnPlay"), $("seek")];
  locked.forEach((el) => (el.disabled = true));
  document.body.classList.add("busy");
  const suffix = state.settings.aspect === "landscape" ? "_telop_16x9.mp4" : "_telop.mp4";
  showProgress("expProgress", 0);
  try {
    setStatus("expStatus", "音声をミックス中…");
    const audio = await mixAudio(state.clips, state.segs, renderer.sfxEvents(), sfxBuffers, gains());
    setStatus("expStatus", "書き出し中…");
    const blob = await exportMp4({
      clips: state.clips, segs: state.segs, renderer, layout: state.settings.layout, audio,
      onProgress: (p) => { showProgress("expProgress", p); setStatus("expStatus", `書き出し中… ${Math.round(p * 100)}%`); },
    });
    download(blob, baseName() + suffix);
    setStatus("expStatus", `完了（${(blob.size / 1e6).toFixed(1)}MB）。ダウンロードフォルダを確認してください。`);
  } catch (e) {
    console.error(e);
    setStatus("expStatus", `エラー：${e.message}`, true);
  } finally {
    locked.forEach((el) => (el.disabled = false));
    document.body.classList.remove("busy");
    $("expProgress").hidden = true;
    seekTo(state.t);
  }
}

function download(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------------------------------------------------------------- project save/load
function projectData() {
  return {
    version: 2,
    files: state.clips.map((c) => ({ name: c.file.name, size: c.file.size })),
    settings: state.settings,
    lines: state.lines,
  };
}
function save() {
  if (state.clips.length) try { localStorage.setItem(projectKey(), JSON.stringify(projectData())); } catch { /* 容量不足など */ }
}
function applyProject(p) {
  const { design: oldDesign, ...s } = p.settings || {};
  // 話者ごとのデザイン。古い保存データ（デザイン1つだけ）は話者Aのデザインとして読み込む
  const sps = (s.speakers && s.speakers.length ? s.speakers : [{ id: "A", name: "話者A", design: oldDesign || speakers()[0].design }])
    .map((sp) => ({ id: sp.id, name: sp.name || `話者${sp.id}`, design: normalizeDesign(sp.design) }));
  state.settings = {
    ...state.settings,
    ...s,
    speakers: sps,
    audio: { ...state.settings.audio, ...(s.audio || {}) },
  };
  if (!sps.some((sp) => sp.id === state.editSpeaker)) state.editSpeaker = sps[0].id;
  state.lines = p.lines || [];
  renderSpeakerBar();
  refreshDesignPanel();
  $("inpTitle").value = state.settings.title;
  $("selLayout").value = state.settings.layout;
  $("inpGap").value = state.settings.gap;
  $("gapVal").textContent = `${Number(state.settings.gap).toFixed(2)}秒`;
  renderer.restyle();
  applyFormat();
  syncAudioUi();
  computeSpeech();
}

function syncAudioUi() {
  const a = state.settings.audio;
  $("chkVoiceAuto").checked = a.voiceAuto;
  $("inpVoice").value = a.voice;
  $("inpSfx").value = a.sfx;
  $("voiceVal").textContent = `${a.voice}%`;
  $("sfxVal").textContent = `${a.sfx}%`;
  if (voiceBus) { const g = gains(); voiceBus.gain.value = g.voice; sfxBus.gain.value = g.sfx; }
}

// ---------------------------------------------------------------- helpers
function setStatus(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
}
function showProgress(id, p) {
  const el = $(id);
  el.hidden = false;
  el.firstElementChild.style.width = p < 0 ? "100%" : `${Math.round(p * 100)}%`;
  el.firstElementChild.style.opacity = p < 0 ? 0.5 : 1;
}

// ---------------------------------------------------------------- events
$("inpVideo").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
for (const el of [$("dropzone"), document.querySelector(".phone")]) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); $("dropzone").classList.add("over"); });
  el.addEventListener("dragleave", () => $("dropzone").classList.remove("over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("over");
    addFiles(e.dataTransfer.files);
  });
}
$("btnAnalyze").onclick = () => analyze(false);
$("btnDiarize").onclick = () => analyze(true);
$("btnPlay").onclick = () => (state.playing ? stop() : play());
$("seek").oninput = (e) => seekTo(Number(e.target.value));
$("selAspect").onchange = async (e) => {
  stop();
  state.settings.aspect = e.target.value;
  applyFormat();
  await refresh(false);
};
$("selLayout").onchange = (e) => { state.settings.layout = e.target.value; refresh(false); };
$("inpTitle").oninput = (e) => { state.settings.title = e.target.value; scheduleRefresh(); };
$("inpGap").oninput = (e) => {
  state.settings.gap = Number(e.target.value);
  $("gapVal").textContent = `${state.settings.gap.toFixed(2)}秒`;
  computeSpeech();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(true), 200);
};
$("btnAddLine").onclick = async () => {
  const s = outToSrc(state.segs, state.t).src;
  const l = { id: crypto.randomUUID(), src: [s, s + 1.5], text: "新しい字幕", cut: false, fx: "", fxText: "" };
  state.lines.push(l);
  state.lines.sort((a, b) => a.src[0] - b.src[0]);
  await refresh(true);
};
$("btnExport").onclick = doExport;

// Premiere 用 ZIP
const FOLDER_KEY = "telop-studio:sourceFolder";
try { $("inpFolder").value = localStorage.getItem(FOLDER_KEY) || ""; } catch { /* なくてもよい */ }
$("inpFolder").oninput = (e) => { try { localStorage.setItem(FOLDER_KEY, e.target.value.trim().replace(/^"|"$/g, "")); } catch { /* なくてもよい */ } };
$("btnPremiere").onclick = async () => {
  stop();
  const btn = $("btnPremiere");
  btn.disabled = true;
  document.body.classList.add("busy");
  try {
    setStatus("prStatus", "テロップを画像にしています…");
    const name = baseName() + (state.settings.aspect === "landscape" ? "_16x9" : "");
    const blob = await buildPremierePackage({
      clips: state.clips, segs: state.segs, renderer, settings: state.settings, items: state.items,
      gains: gains(), sfxEvents: renderer.sfxEvents(), sfxBuffers,
      folder: $("inpFolder").value.trim().replace(/^"|"$/g, ""), name,
      onProgress: (p) => setStatus("prStatus", `書き出し中… ${Math.round(p * 100)}%`),
    });
    download(blob, `${name}_premiere.zip`);
    setStatus("prStatus", `完了（${(blob.size / 1e6).toFixed(1)}MB）。ZIP を元の動画と同じフォルダに展開し、中の「はじめにお読みください.txt」の手順で読み込んでください。`);
  } catch (e) {
    console.error(e);
    setStatus("prStatus", `エラー：${e.message}`, true);
  } finally {
    btn.disabled = false;
    document.body.classList.remove("busy");
    seekTo(state.t);
  }
};

// おまかせ編集（押す前の状態を覚えておき、「元に戻す」で戻せる）
let beforeAuto = null;
$("btnAuto").onclick = async () => {
  stop();
  beforeAuto = structuredClone(state.lines);
  const n = autoEdit(state.lines, { strength: $("selStrength").value, speakers: speakers() });
  await refresh(true);
  setStatus("autoStatus", `付けた演出：${describe(n)}。気に入らない行は表で直すか、「元に戻す」で戻せます。`);
  $("btnUndoAuto").hidden = false;
};
$("btnUndoAuto").onclick = async () => {
  if (!beforeAuto) return;
  state.lines = beforeAuto;
  beforeAuto = null;
  $("btnUndoAuto").hidden = true;
  await refresh(true);
  setStatus("autoStatus", "おまかせ編集の前に戻しました。");
};

// 字幕デザイン：保存・読み込み・標準にする・初期に戻す
// 1人分のファイル = デザインそのもの / 全員分のファイル = { speakers: [{ name, design }] }
const setDesign = (d) => { editingSpeaker().design = normalizeDesign(d); speakersChanged(); };
const json = (o) => new Blob([JSON.stringify(o, null, 2)], { type: "application/json" });
$("btnDesignSave").onclick = () => download(json(editingSpeaker().design), `字幕デザイン_${editingSpeaker().name}.json`);
$("btnDesignSaveAll").onclick = () => download(json({ speakers: speakers().map(({ id, name, design }) => ({ id, name, design })) }), "字幕デザイン_全員.json");
$("inpDesign").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (Array.isArray(data.speakers)) {
      // 全員分: 名前・順番もファイルのとおりにする（字幕に付けた話者は順番で対応させる）
      const old = speakers().map((s) => s.id);
      state.settings.speakers = data.speakers.map((sp, i) => ({ id: "ABCDEFGHIJ"[i], name: sp.name || `話者${"ABCDEFGHIJ"[i]}`, design: normalizeDesign(sp.design) }));
      for (const l of state.lines) if (l.speaker) { const i = old.indexOf(l.speaker); l.speaker = state.settings.speakers[Math.min(Math.max(i, 0), state.settings.speakers.length - 1)].id; }
      state.editSpeaker = state.settings.speakers[0].id;
      speakersChanged();
    } else setDesign(data);
    setStatus("designStatus", `「${f.name}」を読み込みました。`);
  } catch { setStatus("designStatus", "デザインのファイルを読み込めませんでした。", true); }
};
$("btnDesignDefault").onclick = () => {
  localStorage.setItem(DESIGN_KEY, JSON.stringify(editingSpeaker().design));
  setStatus("designStatus", `${editingSpeaker().name}のデザインを、新しく始める作業の標準にしました。`);
};
$("inpSpeakerName").oninput = (e) => {
  editingSpeaker().name = e.target.value || editingSpeaker().id;
  renderSpeakerBar();
  renderTable();
  save();
};
$("btnSpeakerDelete").onclick = () => {
  const sp = editingSpeaker();
  if (speakers().length <= 1 || !confirm(`${sp.name}を削除しますか？（この話者の字幕は${speakers()[0].id === sp.id ? speakers()[1].name : speakers()[0].name}になります）`)) return;
  state.settings.speakers = speakers().filter((s) => s !== sp);
  for (const l of state.lines) if (l.speaker === sp.id) l.speaker = speakers()[0].id;
  state.editSpeaker = speakers()[0].id;
  speakersChanged();
};
$("btnDesignReset").onclick = () => {
  if (!confirm(`${editingSpeaker().name}の字幕デザインを初期設定に戻しますか？`)) return;
  setDesign(DEFAULT_DESIGN);
  setStatus("designStatus", "初期設定に戻しました。");
};

// 音量
const audioChanged = () => { syncAudioUi(); save(); };
$("chkVoiceAuto").onchange = (e) => { state.settings.audio.voiceAuto = e.target.checked; audioChanged(); };
$("inpVoice").oninput = (e) => { state.settings.audio.voice = Number(e.target.value); audioChanged(); };
$("inpSfx").oninput = (e) => { state.settings.audio.sfx = Number(e.target.value); audioChanged(); };
$("btnSrt").onclick = () => download(new Blob([toSrt(state.items)], { type: "text/plain" }), baseName() + ".srt");
$("btnSaveProject").onclick = () => download(new Blob([JSON.stringify(projectData(), null, 1)], { type: "application/json" }), baseName() + "_telop.json");
$("inpProject").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const p = JSON.parse(await f.text());
  if (state.clips.length) {
    applyProject(p);
    await refresh(true);
  } else {
    state.pendingProject = p;
    const names = (p.files || (p.file ? [p.file] : [])).map((x) => x.name).join("、");
    setStatus("anaStatus", `作業を読み込みました。同じ素材（${names}）を選んでください。`);
  }
};
document.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("busy")) return;
  if (e.code === "Space" && !["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName) && state.segs.length) {
    e.preventDefault();
    state.playing ? stop() : play();
  }
});

init();
