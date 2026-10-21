import { resolveStyles } from "./telop.js";
import { Renderer } from "./render.js";
import {
  decodeAudio, toMono16k, loudness, detectSpeech, buildLines, buildSegments, buildItems,
  CUT_PRESETS, normalizeWords, alignWordTimes, buildLinesFromWords, retakeHints, timedLines,
  totalDuration, srcToOut, outToSrc, toSrt, FX, FX_POS, SCREEN, FRAME, layoutClips, splitAtClips, clipAt, assignSpeakers,
} from "./timeline.js?v=20261022-cuts2";
import { mixAudio, exportMp4 } from "./export.js";
import { openMedia, decodeAudioTrack } from "./decode.js";
import { DEFAULT_DESIGN, normalizeDesign, designToStyle, buildDesignPanel } from "./design.js";
import { autoEdit, describe } from "./autoedit.js";
import { buildPremierePackage } from "./premiere.js?v=20261022-cuts2";
import { DESIGN_SETS, setDesign as designOfSet } from "./sets.js";
import { createProjectStore, validateProject, projectFiles, sameFiles } from "./project-store.js?v=20261022-cuts2";
import { modelCacheEntries, deleteModelCache, deleteOldModels } from "./model-cache.js";
import { createEditHistory, resetSubtitles } from "./edit-history.js";
import { clearRangeEdits, linesForOutput } from "./range-edits.js";
import { createCutEditor } from "./cut-editor.js?v=20261022-cuts2";

const $ = (id) => document.getElementById(id);
const canvas = $("preview");
const ctx = canvas.getContext("2d");
const LONG_WARN = 20 * 60; // これより長いと重くなる（秒）
const DESIGN_KEY = "telop-studio:defaultDesign";

const state = {
  clips: [],        // 素材: { id, file, media, audio, db, pcm, video, duration, offset, span }
  db: null,         // 全素材をつないだ 20ms ごとの音量
  pcm: null,        // 全素材をつないだ 16kHz モノラル（文字起こし用）
  speech: [],
  lines: [],
  rangeEdits: [],
  captionTimes: [],
  segs: [],
  settings: defaultSettings(),
  editSpeaker: "A", // デザインパネルで編集中の話者
  voiceAutoGain: 1, // 声を聞きやすい大きさにそろえる倍率（素材から計算）
  t: 0,             // 出力側の再生位置（秒）
  playing: false,
};
function defaultSettings() {
  return {
    title: "", layout: "auto", aspect: "portrait",
    cutPreset: "solo", minSilence: 0.6, // 自動カット（Premiere 用プラグイン EditKit と同じ判定）
    autoHighlight: true, // 字幕の大事な言葉を自動で強調色にする
    designSet: "standard", // デザインセット
    fxMap: {},             // デザインセットによる演出の見た目の差し替え
    speakers: [{ id: "A", name: "話者A", design: loadDefaultDesign() }], // 話者ごとの字幕デザイン
    audio: { voiceAuto: true, voice: 100, sfx: 40 },  // 音量（%）
  };
}
let renderer, sfxBuffers = {}, refreshDesignPanel = () => {};
const projectStore = createProjectStore({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});
let activeSaveId = null, activeSaveKey = null, analysisRunning = false, projectTransition = false, deletingModels = false;
const editHistory = createEditHistory(50);
let historyApplying = false;
const editGroups = new WeakMap();
let editGroupId = 0;

function editSnapshot() {
  const p = projectData();
  return { settings: p.settings, lines: p.lines, words: p.words, rangeEdits: p.rangeEdits, autoEdit: p.autoEdit };
}
function editorLocked() { return analysisRunning || projectTransition || historyApplying || $("deleteProjectDialog").open || document.body.classList.contains("busy"); }
function syncEditControls() {
  const locked = editorLocked() || !state.clips.length;
  $("btnUndoEdit").disabled = locked || !editHistory.canUndo;
  $("btnRedoEdit").disabled = locked || !editHistory.canRedo;
  $("btnResetSubtitles").disabled = locked || !state.lines.length;
  $("btnAuto").disabled = locked || !state.lines.length;
  $("btnAddLine").disabled = locked || !state.segs.length;
  $("btnCutEditor").disabled = locked;
}
function recordEdit() {
  if (!activeSaveId || !state.clips.length || historyApplying || analysisRunning) return;
  const el = document.activeElement;
  let group = null;
  if (el?.matches('textarea, input[type="text"], input[type="number"], input[type="range"], input[type="color"]')) {
    if (!editGroups.has(el)) editGroups.set(el, ++editGroupId);
    group = editGroups.get(el);
  }
  editHistory.commit(editSnapshot(), group);
  syncEditControls();
}
document.addEventListener("focusout", () => editHistory.endGroup());
document.addEventListener("pointerup", () => editHistory.endGroup());

async function historyAction(action, status) {
  if (editorLocked() || !state.clips.length) return;
  recordEdit();
  historyApplying = true;
  updateSaveLocks();
  try {
    stop();
    await settle();
    const snapshot = action();
    if (!snapshot) return;
    applyProject(snapshot, { keepHistory: true });
    await refresh(true);
    setStatus("editStatus", status);
  } finally {
    historyApplying = false;
    updateSaveLocks();
  }
}

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
  recordEdit();
  clearTimeout(designTimer);
  designTimer = setTimeout(async () => {
    designTimer = null;
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
  // おまかせ編集の向きは、手で選んでいなければ出力の形に合わせる（縦→ショート、横→長尺）
  if (!$("selMode").dataset.touched) $("selMode").value = a === "landscape" ? "long" : "short";
  $("selAspect").value = a;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawDesignSample();
}

// ---------------------------------------------------------------- step 1: clips
async function addFiles(files) {
  if (editorLocked()) return;
  files = [...files].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
  if (!files.length) return;
  if (state.lines.length && !confirm("素材を追加すると、文字起こしと字幕の修正はやり直しになります。続けますか？")) return;
  if (state.clips.length) { await settle(); if (!save()) return; }
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
  const lv = loudness(pcm);
  return { id: crypto.randomUUID(), file, media, video, audio, pcm, db: lv.rms, pk: lv.peak, duration: media ? media.duration : audio.duration };
}

// 素材の並び・数が変わったとき：つないだ音声を作り直す
async function clipsChanged(fromAdd) {
  activeSaveId = activeSaveKey = null;
  $("saveManager").hidden = !state.clips.length;
  renderClipList();
  const has = state.clips.length > 0;
  $("dropHint").hidden = has;
  $("dropzone").classList.toggle("loaded", has);
  $("btnAnalyze").disabled = !has;
  if (!has) {
    Object.assign(state, { db: null, pk: null, pcm: null, words: [], speech: [], lines: [], rangeEdits: [], captionTimes: [], segs: [], items: [] });
    await renderer.setItems([]);
    renderTable();
    editHistory.reset(editSnapshot());
    syncEditControls();
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
  state.pk = new Float32Array(nFr).fill(-100);
  state.pcm = new Float32Array(Math.round(total * 16000));
  for (const c of state.clips) {
    state.db.set(c.db.subarray(0, Math.round(c.span / FRAME)), Math.round(c.offset / FRAME));
    state.pk.set(c.pk.subarray(0, Math.round(c.span / FRAME)), Math.round(c.offset / FRAME));
    state.pcm.set(c.pcm.subarray(0, Math.round(c.span * 16000)), Math.round(c.offset * 16000));
  }
  state.lines = [];
  state.words = [];
  state.rangeEdits = [];
  state.t = 0;
  editHistory.reset(editSnapshot());
  syncEditControls();
  try {
    const key = projectKey();
    const group = projectStore.open(key, projectData());
    let entry = group.entries.find(e => e.id === group.activeId);
    // 明示的に開いたJSONを、前回の自動保存より優先する。別プロジェクトとして保存する。
    if (fromAdd && state.pendingProject && sameFiles(projectFiles(state.pendingProject), projectData().files)) {
      entry = projectStore.create(key, state.pendingProject);
      state.pendingProject = null;
    }
    activeSaveKey = key;
    activeSaveId = entry.id;
    applyProject(entry.project);
    renderSaveControls();
    const long = sourceDuration() > LONG_WARN ? `（合計 ${fmt(sourceDuration())}。長い素材は文字起こしに時間がかかります）` : "";
    setStatus("anaStatus", entry.project.lines.length
      ? `「${entry.name}」を復元しました。やり直す場合は「新しく始める」を押してください。`
      : `「解析する」を押すと、無言部分のカットと文字起こしをします。${long}`);
    if (state.pendingProject) setStatus("projectStatus", "JSONの素材と一致しません。動画の名前・サイズ・並び順を確認してください。", true);
  } catch (e) {
    setStatus("projectStatus", `保存データを開けません：${e.message}。JSONに保存してバックアップできます。`, true);
  }
  updateSaveLocks();
  computeSpeech();
  await refresh(true);
  if (state.pendingProject) setStatus("anaStatus", "JSONの素材と一致しません。動画の名前・サイズ・並び順を確認し、同じ素材を選び直してください。", true);
}

// 自動カットの設定（プリセット + 「これより長い無言だけ切る」の秒数）
function cutOptions() {
  const p = CUT_PRESETS[state.settings.cutPreset] || CUT_PRESETS.solo;
  return { ...p, minimum: Number(state.settings.minSilence) || p.minimum };
}

function computeSpeech() {
  // 文字起こし済みなら、単語を話している所は必ず残す（発話保護）
  if (state.db) state.speech = splitAtClips(detectSpeech({ rms: state.db, peak: state.pk || state.db }, cutOptions(), state.words || []), state.clips);
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
      if (editorLocked()) return;
      if (state.lines.length && !confirm("並び順を変えると、文字起こしと字幕の修正はやり直しになります。続けますか？")) return;
      await settle(); if (!save()) return;
      stop();
      const [c2] = state.clips.splice(i, 1);
      state.clips.splice(j, 0, c2);
      await clipsChanged(false);
    };
    up.onclick = () => move(i - 1);
    down.onclick = () => move(i + 1);
    del.onclick = async () => {
      if (editorLocked()) return;
      if (state.lines.length && !confirm("素材を外すと、文字起こしと字幕の修正はやり直しになります。続けますか？")) return;
      await settle(); if (!save()) return;
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
  if (!state.pcm || editorLocked() || deletingModels) return;
  analysisRunning = true;
  updateSaveLocks();
  $("btnAnalyze").disabled = $("btnDiarize").disabled = true;
  $("selModel").disabled = true;
  $("btnCancelAnalyze").hidden = false;
  showProgress("anaProgress", 0);
  worker ||= new Worker("js/whisper-worker.js", { type: "module" });
  const device = "gpu" in navigator ? "webgpu" : "wasm";
  const files = {};
  const finish = () => {
    analysisRunning = false;
    updateSaveLocks();
    $("btnAnalyze").disabled = false;
    $("btnDiarize").disabled = !state.lines.length;
    $("selModel").disabled = false;
    $("btnCancelAnalyze").hidden = true;
    $("anaProgress").hidden = true;
  };
  $("btnCancelAnalyze").onclick = () => {
    worker.terminate();
    worker = null;
    finish();
    setStatus("anaStatus", "解析を中止しました。重い場合は低スペックモードを選んで、解析し直してください。字幕はそのまま残っています。");
  };
  worker.onerror = (e) => {
    worker.terminate();
    worker = null;
    finish();
    setStatus("anaStatus", `エラー：${e.message}。重い場合は低スペックモードでお試しください。`, true);
  };
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
      const dur = state.pcm.length / 16000;
      if (m.words) {
        // 1語ごとの時刻：字幕のタイミングに使い、話している所はカットしないよう保護する
        state.words = alignWordTimes(normalizeWords(m.words, dur), { rms: state.db, peak: state.pk || state.db }, cutOptions());
        computeSpeech();
        state.lines = buildLinesFromWords(state.words, state.speech);
      } else {
        computeSpeech();
        state.lines = buildLines(m.chunks, state.speech, dur);
      }
      const hints = state.words.length ? retakeHints(state.words, (t) => clipAt(state.clips, t)).length : 0;
      let msg = `完了：字幕 ${state.lines.length} 枚。下の「✨ おまかせ編集」で演出を自動で付けられます`;
      if (hints) msg += `・言い直しの可能性 ${hints} か所（表に「言い直し?」の印）`;
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
      setStatus("anaStatus", `エラー：${m.message}。重い場合は低スペックモードでお試しください。`, true);
    }
  };
  if (onlySpeakers) worker.postMessage({ type: "diarize", audio: state.pcm });
  else worker.postMessage({ audio: state.pcm, model: $("selModel").value, device, speakers: $("chkSpeakers").checked });
}

// ---------------------------------------------------------------- model → view
let refreshTimer;
function scheduleRefresh() {
  recordEdit();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(false), 250);
}

// 作り直しは順番に1つずつ（途中で書き出しが始まって、古いテロップと新しいテロップが混ざらないように）
let refreshChain = Promise.resolve();
function refresh(rebuildTable) {
  recordEdit();
  refreshChain = refreshChain.then(() => doRefresh(rebuildTable)).catch((e) => console.error(e));
  return refreshChain;
}

// 書き出しの前に、待ち中の変更をすべて反映し終える
async function settle() {
  if (designTimer) { clearTimeout(designTimer); designTimer = null; renderer.restyle(); }
  clearTimeout(refreshTimer);
  await refresh(false);
}

async function doRefresh(rebuildTable) {
  if (!state.clips.length) return;
  state.segs = buildSegments(state.speech, state.lines, state.rangeEdits, state.clips);
  const output = linesForOutput(state.lines, state.rangeEdits);
  state.captionTimes = timedLines(output, state.segs, state.settings);
  const total = totalDuration(state.segs);
  state.items = buildItems(output, state.segs, state.settings);
  await renderer.setItems(state.items);
  state.t = Math.min(state.t, total);
  $("seek").max = total || 1;
  const src = sourceDuration();
  $("cutSummary").textContent = `元の長さ ${fmt(src)} → カット後 ${fmt(total)}（${Math.round((1 - total / src) * 100)}% 短縮）`;
  if (rebuildTable) renderTable();
  for (const id of ["btnPlay", "seek", "btnExport", "btnSrt", "btnAddLine"]) $(id).disabled = !state.segs.length;
  $("btnSaveProject").disabled = !state.clips.length;
  $("btnDiarize").disabled = !state.lines.length;
  $("btnAuto").disabled = !state.lines.length;
  $("btnPremiere").disabled = !state.segs.length;
  $("rangeSummary").textContent = state.rangeEdits.length ? '区間の手動調整あり。「区間を指定してカット・戻す」で確認できます。' : 'カット前の動画を見ながら、切る範囲や戻す範囲を調整できます。';
  cutEditor.refresh();
  syncEditControls();
  save();
  if (!state.playing) await seekTo(state.t);
}

function renderTable() {
  const tb = $("lines").querySelector("tbody");
  tb.innerHTML = "";
  const toOpts = (o) => Object.entries(o).map(([k, v]) => `<option value="${k}">${typeof v === "string" ? v : v.name}</option>`).join("");
  const opts = toOpts(FX), posOpts = toOpts(FX_POS), scrOpts = toOpts(SCREEN);
  const multi = state.clips.length > 1;
  const lineStarts = new Map();
  for (const c of state.captionTimes) if (!lineStarts.has(c.l.id)) lineStarts.set(c.l.id, c.t0);
  // 言い直しの候補（お知らせだけ。カットするかは本人が決める）
  const hints = state.words?.length ? retakeHints(state.words, (t) => clipAt(state.clips, t)) : [];
  const HINT_LABEL = { retake: "言い直し?", repeat: "繰り返し?", stall: "中断?" };
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
    const start = lineStarts.get(l.id) ?? srcToOut(state.segs, l.src[0]);
    bt.textContent = fmt(start);
    bt.onclick = () => seekTo(start + 0.001);
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
    cb.onchange = () => setLineCut(l, cb.checked);
    // 行の半分以上が候補の範囲に入っていれば印を付ける
    const hint = hints.find((h) => Math.min(h.end, l.src[1]) - Math.max(h.start, l.src[0]) >= (l.src[1] - l.src[0]) * 0.5);
    if (hint) {
      const hb = document.createElement("button");
      hb.className = "retake-hint";
      hb.textContent = HINT_LABEL[hint.type] || "言い直し?";
      hb.title = `${hint.reason}${hint.retained ? `
残す方：「${hint.retained}」` : ""}
クリックでこの行をカット／元に戻す`;
      hb.onclick = () => setLineCut(l, !l.cut);
      tr.querySelector(".time").appendChild(hb);
    }
    tb.appendChild(tr);
  }
}

async function setLineCut(line, cut) {
  if (editorLocked()) return;
  stop();
  // 字幕のチェックを変更した場合は、その字幕内の手動調整より新しい指定を優先。
  state.rangeEdits = clearRangeEdits(state.rangeEdits,...line.src);
  line.cut = cut;
  await refresh(true);
}

function highlightRow() {
  const cur = state.captionTimes.find(it => state.t >= it.t0 && state.t < it.end);
  for (const tr of $("lines").querySelectorAll("tbody tr[data-id]")) {
    const on = cur && tr.dataset.id === cur.l.id;
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
  const my = ++seekToken;
  updateClock();
  if (!state.segs.length) {
    ctx.fillStyle = '#111317'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#9aa1ad'; ctx.textAlign = 'center'; ctx.font = '32px "Noto Sans JP"';
    ctx.fillText('残す区間がありません',canvas.width/2,canvas.height/2);
    return;
  }
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

let sfxCtx, sfxNodes = [], segIdx = 0, active = null, voiceBus, sfxBus, playbackRun = 0;
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
  const run = ++playbackRun;
  const total = totalDuration(state.segs);
  if (state.t >= total - 0.05) state.t = 0;
  const { seg, clip, local } = locate(state.t);
  segIdx = seg;
  active = clip.video;
  await waitSeek(active, local);
  if (run !== playbackRun) return;
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
  try { await active.play(); } catch { if (run === playbackRun) stop(); return; }
  if (run === playbackRun) requestAnimationFrame(() => tick(run));
}

async function tick(run) {
  if (!state.playing || run !== playbackRun) return;
  let s = state.segs[segIdx];
  let c = state.clips[s.clip];
  const local = active.currentTime;
  if (local >= s.end - c.offset - 0.02 || active.ended) {
    segIdx++;
    if (segIdx >= state.segs.length) { state.t = totalDuration(state.segs); stop(); updateClock(); return; }
    s = state.segs[segIdx];
    c = state.clips[s.clip];
    // 古い映像の上に次の字幕だけを先に描かないよう、シークが完了してから一緒に切り替える。
    active.pause();
    active = c.video;
    await waitSeek(active, s.start - c.offset);
    if (!state.playing || run !== playbackRun) return;
    try { await active.play(); } catch { stop(); return; }
    if (!state.playing || run !== playbackRun) return;
  }
  state.t = s.out + Math.max(0, Math.min(active.currentTime + c.offset, s.end) - s.start);
  renderer.draw(ctx, state.t, active, state.settings.layout);
  updateClock();
  requestAnimationFrame(() => tick(run));
}

function stop() {
  playbackRun++;
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
  const locked = [btn, $("selAspect"), $("selLayout"), $("inpTitle"), $("inpGap"), $("selCutPreset"), $("btnAnalyze"), $("btnAddLine"), $("inpVideo"), $("btnPlay"), $("seek")];
  locked.forEach((el) => (el.disabled = true));
  document.body.classList.add("busy");
  const suffix = state.settings.aspect === "landscape" ? "_telop_16x9.mp4" : "_telop.mp4";
  showProgress("expProgress", 0);
  try {
    await settle();
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
    updateSaveLocks();
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
    words: state.words || [], // 1語ごとの時刻 [開始, 終了, 文字]（発話保護と言い直し検知に使う）
    rangeEdits: state.rangeEdits,
    autoEdit: { mode: $("selMode").value, strength: $("selStrength").value },
  };
}
function save() {
  if (!state.clips.length || !activeSaveId || activeSaveKey !== projectKey()) return false;
  recordEdit();
  try {
    const entry = projectStore.save(activeSaveKey, activeSaveId, projectData());
    setStatus("projectStatus", `自動保存済み：${entry.name}`);
    return true;
  } catch (e) {
    setStatus("projectStatus", `自動保存できません：${e.message}。「JSONに保存」でバックアップしてください。`, true);
    return false;
  }
}

function updateSaveLocks() {
  const locked = editorLocked();
  for (const id of ["selSave", "inpSaveName", "btnOpenSave", "btnNewSave", "btnCopySave", "btnDeleteSave"]) $(id).disabled = locked || !activeSaveId;
  $("inpProject").disabled = locked;
  $("btnDeleteModels").disabled = locked || deletingModels || !("caches" in window);
  syncEditControls();
}

function renderSaveControls() {
  const group = activeSaveKey && projectStore.read(activeSaveKey);
  if (!group) return;
  $("selSave").replaceChildren(...group.entries.map(entry => Object.assign(document.createElement("option"), {
    value: entry.id, textContent: entry.name,
  })));
  $("selSave").value = activeSaveId;
  $("inpSaveName").value = group.entries.find(e => e.id === activeSaveId)?.name || "";
  updateSaveLocks();
}

async function changeSave(action) {
  if (editorLocked() || !activeSaveId) return;
  projectTransition = true;
  updateSaveLocks();
  try {
    stop();
    await settle();
    if (!save()) return; // 保存に失敗した編集を置き去りにしない。
    const entry = action();
    activeSaveId = entry.id;
    state.t = 0;
    applyProject(entry.project);
    renderSaveControls();
    await refresh(true);
    setStatus("anaStatus", entry.project.lines.length ? `「${entry.name}」を開きました。` : `「${entry.name}」を新しく始めました。「解析する」で文字起こしを始められます。`);
  } catch (e) {
    setStatus("projectStatus", `プロジェクトを切り替えられません：${e.message}`, true);
  } finally {
    projectTransition = false;
    updateSaveLocks();
  }
}
function applyProject(p, { keepHistory = false } = {}) {
  $("autoStatus").textContent = "";
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
  state.rangeEdits = structuredClone(p.rangeEdits || []);
  state.words = Array.isArray(p.words) ? p.words.filter((w) => Array.isArray(w) && w.length === 3 && w.every((v, i) => (i < 2 ? Number.isFinite(v) : typeof v === "string"))) : [];
  renderSpeakerBar();
  refreshDesignPanel();
  $("inpTitle").value = state.settings.title;
  $("chkHighlight").checked = state.settings.autoHighlight !== false;
  $("selSet").value = state.settings.designSet || "standard";
  $("setNote").textContent = DESIGN_SETS[$("selSet").value]?.note || "";
  $("selLayout").value = state.settings.layout;
  syncCutUi();
  renderer.restyle();
  delete $("selMode").dataset.touched;
  applyFormat();
  if (["short", "long"].includes(p.autoEdit?.mode)) {
    $("selMode").value = p.autoEdit.mode;
    $("selMode").dataset.touched = "1";
  }
  $("selStrength").value = ["low", "mid", "high"].includes(p.autoEdit?.strength) ? p.autoEdit.strength : "mid";
  syncAudioUi();
  computeSpeech();
  if (!keepHistory) {
    editHistory.reset(editSnapshot());
    $("editStatus").textContent = "";
  }
  syncEditControls();
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
const cutEditor = createCutEditor({
  clips: () => state.clips, segments: () => state.segs, edits: () => state.rangeEdits,
  currentSource: () => state.segs.length ? outToSrc(state.segs,state.t).src : 0,
  history: () => editHistory,
  undo: () => historyAction(() => editHistory.undo(),'1つ前の編集に戻しました。'),
  redo: () => historyAction(() => editHistory.redo(),'取り消した編集をやり直しました。'),
  change: async (edits,status) => {
    if (editorLocked()) return;
    stop();
    state.rangeEdits = edits;
    await refresh(true);
    setStatus('cutEditorStatus',status);
  },
});
$("btnCutEditor").onclick = async () => {
  if (editorLocked() || !state.clips.length) return;
  stop(); await settle(); cutEditor.open();
};
$("selAspect").onchange = async (e) => {
  stop();
  state.settings.aspect = e.target.value;
  applyFormat();
  await refresh(false);
};
$("selLayout").onchange = (e) => { state.settings.layout = e.target.value; refresh(false); };
$("inpTitle").oninput = (e) => { state.settings.title = e.target.value; scheduleRefresh(); };
// 自動カットの設定を画面に反映
function syncCutUi() {
  const s = state.settings;
  if (!CUT_PRESETS[s.cutPreset]) s.cutPreset = "solo";
  if (!Number.isFinite(Number(s.minSilence))) s.minSilence = CUT_PRESETS[s.cutPreset].minimum;
  $("selCutPreset").value = s.cutPreset;
  $("inpGap").value = s.minSilence;
  $("gapVal").textContent = `${Number(s.minSilence).toFixed(2)}秒`;
}
const cutChanged = () => {
  syncCutUi();
  computeSpeech();
  recordEdit();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(true), 200);
};
$("inpGap").oninput = (e) => { state.settings.minSilence = Number(e.target.value); cutChanged(); };
$("selCutPreset").onchange = (e) => {
  state.settings.cutPreset = e.target.value;
  state.settings.minSilence = CUT_PRESETS[e.target.value].minimum; // 種類を変えたら長さもその種類の標準に
  cutChanged();
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
    await settle();
    setStatus("prStatus", "テロップを画像にしています…");
    const name = baseName() + (state.settings.aspect === "landscape" ? "_16x9" : "");
    const blob = await buildPremierePackage({
      clips: state.clips, segs: state.segs, lines: linesForOutput(state.lines, state.rangeEdits), renderer, settings: state.settings, items: state.items,
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
    updateSaveLocks();
    seekTo(state.t);
  }
};

// おまかせ編集も、ほかの編集と同じ履歴で取り消せる。
$("btnAuto").onclick = async () => {
  if (editorLocked()) return;
  recordEdit();
  historyApplying = true;
  updateSaveLocks();
  stop();
  try {
    await settle();
    const n = autoEdit(state.lines, { mode: $("selMode").value, strength: $("selStrength").value, speakers: speakers() });
    editHistory.commit(editSnapshot());
    await refresh(true);
    setStatus("autoStatus", `付けた演出：${describe(n)}。気に入らない行は表で直すか、「元に戻す」で戻せます。`);
  } finally {
    historyApplying = false;
    updateSaveLocks();
  }
};
$("selMode").onchange = (e) => { e.target.dataset.touched = "1"; save(); };
$("selStrength").onchange = () => save();

// デザインセット：字幕のデザイン（全話者）と、演出の見た目をまとめて切り替える
$("selSet").onchange = (e) => {
  const key = e.target.value;
  const set = DESIGN_SETS[key];
  if (!confirm(`「${set.name}」に切り替えます。字幕のデザインはセットの内容に置き換わります（演出の文字や位置はそのまま）。よろしいですか？`)) {
    e.target.value = state.settings.designSet || "standard";
    return;
  }
  speakers().forEach((sp, i) => {
    sp.design = designOfSet(key);
    // 2人目以降は境界線（なければ強調色）の色を変えて見分けやすくする
    if (i > 0) {
      if (sp.design.strokes.length) sp.design.strokes[0].color = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
      else sp.design.fill.color = ["#ffffff", "#bfe6ff", "#ffd1dc", "#d7ffcf"][i % 4];
    }
  });
  state.settings.designSet = key;
  state.settings.fxMap = { ...set.fxMap };
  if (set.autoMode) { $("selMode").value = set.autoMode; $("selMode").dataset.touched = "1"; }
  $("setNote").textContent = set.note;
  speakersChanged();
};
$("setNote").textContent = DESIGN_SETS.standard.note;
$("chkHighlight").onchange = (e) => { state.settings.autoHighlight = e.target.checked; refresh(false); };
$("btnUndoEdit").onclick = () => historyAction(() => editHistory.undo(), "1つ前の編集に戻しました。");
$("btnRedoEdit").onclick = () => historyAction(() => editHistory.redo(), "取り消した編集をやり直しました。");
$("btnResetSubtitles").onclick = () => historyAction(() => {
  const snapshot = resetSubtitles(editSnapshot(), DEFAULT_DESIGN);
  editHistory.commit(snapshot);
  return snapshot;
}, "字幕のデザイン・演出・画面効果・カット指定を初期化しました。文章は残っています。元に戻すこともできます。");

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
$("btnSrt").onclick = async () => {
  await settle();
  download(new Blob([toSrt(linesForOutput(state.lines, state.rangeEdits), state.segs, state.settings)], { type: "text/plain" }), baseName() + ".srt");
};
$("btnOpenSave").onclick = () => {
  const id = $("selSave").value;
  return changeSave(() => projectStore.select(activeSaveKey, id));
};
$("btnNewSave").onclick = () => changeSave(() => projectStore.create(activeSaveKey, {
  version: 2, files: projectData().files, settings: defaultSettings(), lines: [],
}));
$("btnCopySave").onclick = () => changeSave(() => projectStore.create(activeSaveKey, projectData()));
$("btnDeleteSave").onclick = async () => {
  if (editorLocked() || !activeSaveId) return;
  let target;
  try {
    const group = projectStore.read(activeSaveKey);
    target = group?.entries.find(e => e.id === $("selSave").value);
    if (!target) throw new Error("削除するプロジェクトを選んでください。");
    $("deleteProjectName").textContent = target.name;
    $("deleteLastProject").hidden = group.entries.length !== 1;
    const dialog = $("deleteProjectDialog");
    dialog.returnValue = "cancel";
    const confirmed = await new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete"), { once: true });
      dialog.showModal();
      updateSaveLocks();
    });
    updateSaveLocks();
    if (!confirmed) return;
  } catch (e) {
    updateSaveLocks();
    setStatus("projectStatus", `削除できません：${e.message}`, true);
    return;
  }
  projectTransition = true;
  updateSaveLocks();
  try {
    await settle();
    if (!save()) return;
    const { removed, active } = projectStore.remove(activeSaveKey, target.id, {
      version: 2, files: projectData().files, settings: defaultSettings(), lines: [],
    });
    if (active.id !== activeSaveId) {
      stop();
      activeSaveId = active.id;
      state.t = 0;
      applyProject(active.project);
      await refresh(true);
      setStatus("anaStatus", active.project.lines.length ? `「${active.name}」を開きました。` : `「${active.name}」を開きました。「解析する」で文字起こしを始められます。`);
    }
    renderSaveControls();
    setStatus("projectStatus", `「${removed.name}」を削除しました。編集中：${active.name}`);
  } catch (e) {
    setStatus("projectStatus", `削除できません：${e.message}`, true);
  } finally {
    projectTransition = false;
    updateSaveLocks();
  }
};
$("inpSaveName").onchange = () => {
  if (analysisRunning || projectTransition || !activeSaveId) return;
  try {
    const entry = projectStore.save(activeSaveKey, activeSaveId, projectData(), $("inpSaveName").value);
    renderSaveControls();
    setStatus("projectStatus", `自動保存済み：${entry.name}`);
  } catch (e) { setStatus("projectStatus", `名前を保存できません：${e.message}`, true); }
};
$("btnSaveProject").onclick = async () => {
  await settle();
  download(new Blob([JSON.stringify(projectData(), null, 1)], { type: "application/json" }), baseName() + "_telop.json");
};
$("inpProject").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const p = validateProject(JSON.parse(await f.text()));
    if (state.clips.length && sameFiles(projectFiles(p), projectData().files)) {
      await changeSave(() => projectStore.create(activeSaveKey, p));
    } else {
      state.pendingProject = p;
      const names = projectFiles(p).map(x => x.name).join("、");
      setStatus("anaStatus", `JSONを読み込みました。同じ素材（${names}）を同じ順番で選んでください。別プロジェクトとして開きます。`);
    }
  } catch (err) {
    setStatus("anaStatus", `作業を読み込めません：${err.message}`, true);
  } finally {
    e.target.value = "";
  }
};

async function showModelCache() {
  try {
    const entries = await modelCacheEntries(window.caches);
    setStatus("modelStatus", entries.length ? `このブラウザにモデル関連ファイルが ${entries.length} 件保存されています。` : "このブラウザには、このツールの保存済みモデルはありません。");
  } catch (e) { setStatus("modelStatus", `保存状況を確認できません：${e.message}`, true); }
}
// 使わなくなった旧版の文字起こしモデルを、起動時に自動で削除する（パソコンの容量を圧迫しないように）
if (window.caches) deleteOldModels(window.caches).then((n) => {
  if (n) console.info(`使わなくなった古いAIモデルのファイルを ${n} 件削除しました`);
}).catch(() => {});
$("modelStorage").ontoggle = () => { if ($("modelStorage").open) showModelCache(); };
$("btnDeleteModels").onclick = async () => {
  if (analysisRunning || projectTransition || deletingModels || document.body.classList.contains("busy")) return;
  if (!confirm("このツールの保存済みAIモデルを削除します。プロジェクトと元の動画は残ります。次回の解析ではモデルを再ダウンロードします。続けますか？")) return;
  deletingModels = true;
  $("btnAnalyze").disabled = $("btnDiarize").disabled = true;
  updateSaveLocks();
  try {
    worker?.terminate();
    worker = null;
    const count = await deleteModelCache(window.caches);
    setStatus("modelStatus", count ? `${count} 件のモデル関連ファイルを削除しました。次の解析で再ダウンロードします。` : "削除する保存済みモデルはありません。");
  } catch (err) { setStatus("modelStatus", `削除できません：${err.message}`, true); }
  finally {
    deletingModels = false;
    $("btnAnalyze").disabled = !state.pcm;
    $("btnDiarize").disabled = !state.lines.length;
    updateSaveLocks();
  }
};
document.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("busy") || $("deleteProjectDialog").open) return;
  const el = document.activeElement;
  const typing = el?.isContentEditable || el?.tagName === "TEXTAREA" ||
    (el?.tagName === "INPUT" && !["checkbox", "radio", "range", "button", "submit"].includes(el.type));
  if (!typing && !e.isComposing && !e.altKey && (e.ctrlKey || e.metaKey)) {
    const key = e.key.toLowerCase();
    if (key === "z" || key === "y") {
      e.preventDefault();
      const redo = key === "y" || e.shiftKey;
      historyAction(() => redo ? editHistory.redo() : editHistory.undo(), redo ? "取り消した編集をやり直しました。" : "1つ前の編集に戻しました。");
      return;
    }
  }
  if (e.code === "Space" && !$("cutEditorDialog").open && !["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName) && state.segs.length) {
    e.preventDefault();
    state.playing ? stop() : play();
  }
});

init();
