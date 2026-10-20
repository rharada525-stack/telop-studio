import { resolveStyles } from "./telop.js";
import { Renderer, W, H } from "./render.js";
import {
  decodeAudio, toMono16k, loudness, detectSpeech, buildLines, buildSegments, buildItems,
  totalDuration, srcToOut, outToSrc, toSrt, FX,
} from "./timeline.js";
import { mixAudio, exportMp4 } from "./export.js";

const $ = (id) => document.getElementById(id);
const canvas = $("preview");
const ctx = canvas.getContext("2d");
const video = $("video");

const state = {
  file: null,
  audio: null,      // 元の音声（48kHz）
  db: null,         // 20msごとの音量
  speech: [],
  lines: [],
  segs: [],
  settings: { title: "", layout: "cover", gap: 0.3 },
  t: 0,             // 出力側の再生位置（秒）
  playing: false,
};
let renderer, sfxBuffers = {};

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const projectKey = (f) => `telop-studio:${f.name}:${f.size}`;

// ---------------------------------------------------------------- init
async function init() {
  if (!("VideoEncoder" in window) || !("requestVideoFrameCallback" in HTMLVideoElement.prototype)) $("unsupported").hidden = false;
  const styles = resolveStyles(await (await fetch("styles.json")).json());
  renderer = new Renderer(styles);
  const ac = new AudioContext();
  const names = [...new Set(Object.values(styles).map((s) => s.sfx).filter(Boolean)), "drumroll"];
  await Promise.all(names.map(async (n) => {
    try { sfxBuffers[n] = await ac.decodeAudioData(await (await fetch(`sfx/${n}.wav`)).arrayBuffer()); } catch { /* 無くても動く */ }
  }));
  ac.close();
  await document.fonts.load('900 40px "Noto Sans JP"', "テロップ");
  drawIdle();
}

function drawIdle() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------- step 1: file
async function loadVideo(file) {
  stop();
  state.file = file;
  $("fileLabel").textContent = `${file.name}（${(file.size / 1e6).toFixed(1)}MB）`;
  $("dropzone").classList.add("loaded");
  $("dropHint").hidden = true;
  video.src = URL.createObjectURL(file);
  await new Promise((r) => video.addEventListener("loadeddata", r, { once: true }));
  setStatus("anaStatus", "音声を読み込み中…");
  state.audio = await decodeAudio(file);
  const pcm = await toMono16k(state.audio);
  state.db = loudness(pcm);
  state.pcm = pcm;
  $("btnAnalyze").disabled = false;

  const saved = localStorage.getItem(projectKey(file));
  if (saved) {
    applyProject(JSON.parse(saved));
    setStatus("anaStatus", "前回の作業を復元しました。最初からやり直す場合は「解析する」を押してください。");
  } else {
    state.speech = detectSpeech(state.db, { gap: state.settings.gap });
    if (state.lines.length) setStatus("anaStatus", "読み込んだ作業を使います。");
    else setStatus("anaStatus", "「解析する」を押すと、無言部分のカットと文字起こしをします。");
  }
  await refresh(true);
}

// ---------------------------------------------------------------- step 2: analyze
let worker;
function analyze() {
  if (!state.pcm) return;
  $("btnAnalyze").disabled = true;
  showProgress("anaProgress", 0);
  worker ||= new Worker("js/whisper-worker.js", { type: "module" });
  const device = "gpu" in navigator ? "webgpu" : "wasm";
  const files = {};
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "progress" && m.p.status === "progress" && m.p.total) {
      files[m.p.file] = [m.p.loaded, m.p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      showProgress("anaProgress", l / t);
      setStatus("anaStatus", `AIモデルをダウンロード中… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)}MB（初回のみ）`);
    } else if (m.type === "status") {
      setStatus("anaStatus", m.text);
      if (m.text.startsWith("文字起こし")) showProgress("anaProgress", -1);
    } else if (m.type === "done") {
      state.speech = detectSpeech(state.db, { gap: state.settings.gap });
      state.lines = buildLines(m.chunks, state.speech, state.audio.duration);
      $("btnAnalyze").disabled = false;
      $("anaProgress").hidden = true;
      setStatus("anaStatus", `完了：字幕 ${state.lines.length} 枚`);
      await refresh(true);
    } else if (m.type === "error") {
      $("btnAnalyze").disabled = false;
      $("anaProgress").hidden = true;
      setStatus("anaStatus", `エラー：${m.message}`, true);
    }
  };
  worker.postMessage({ audio: state.pcm, model: $("selModel").value, device });
}

// ---------------------------------------------------------------- model → view
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(false), 250);
}

async function refresh(rebuildTable) {
  if (!state.file) return;
  state.segs = buildSegments(state.speech, state.lines);
  const total = totalDuration(state.segs);
  state.items = buildItems(state.lines, state.segs, state.settings);
  await renderer.setItems(state.items);
  state.t = Math.min(state.t, total);
  $("seek").max = total || 1;
  $("cutSummary").textContent = state.audio
    ? `元の長さ ${fmt(state.audio.duration)} → カット後 ${fmt(total)}（${Math.round((1 - total / state.audio.duration) * 100)}% 短縮）`
    : "";
  if (rebuildTable) renderTable();
  for (const id of ["btnPlay", "seek", "btnExport", "btnSrt", "btnSaveProject", "btnAddLine"]) $(id).disabled = !state.segs.length;
  save();
  if (!state.playing) await seekTo(state.t);
}

function renderTable() {
  const tb = $("lines").querySelector("tbody");
  tb.innerHTML = "";
  const opts = Object.entries(FX).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");
  for (const l of state.lines) {
    const tr = document.createElement("tr");
    tr.dataset.id = l.id;
    tr.innerHTML = `<td class="time"><button class="mono"></button></td>
      <td><textarea rows="2"></textarea></td>
      <td><select>${opts}</select></td>
      <td><input type="text" placeholder="空なら字幕と同じ"></td>
      <td class="cut"><input type="checkbox"></td>`;
    const [bt, ta, sel, inp, cb] = tr.querySelectorAll("button, textarea, select, input[type=text], input[type=checkbox]");
    bt.textContent = fmt(srcToOut(state.segs, l.src[0]));
    bt.onclick = () => seekTo(srcToOut(state.segs, l.src[0]) + 0.01);
    ta.value = l.text;
    ta.oninput = () => { l.text = ta.value; scheduleRefresh(); };
    sel.value = l.fx;
    sel.onchange = () => { l.fx = sel.value; scheduleRefresh(); };
    inp.value = l.fxText;
    inp.placeholder = l.fx === "point" ? "その1/本文" : "空なら字幕と同じ";
    inp.oninput = () => { l.fxText = inp.value; scheduleRefresh(); };
    cb.checked = l.cut;
    tr.classList.toggle("is-cut", l.cut);
    cb.onchange = async () => { l.cut = cb.checked; await refresh(true); };
    tb.appendChild(tr);
  }
}

function highlightRow() {
  const cur = state.items?.find((it) => it.style === "subtitle" && state.t >= it.t && state.t < it.t + it.d);
  for (const tr of $("lines").querySelectorAll("tbody tr")) {
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
const waitSeek = (t) => new Promise((r) => {
  if (Math.abs(video.currentTime - t) < 1e-3) return r();
  video.addEventListener("seeked", r, { once: true });
  video.currentTime = t;
});

let seekToken = 0;
async function seekTo(t) {
  if (state.playing) stop();
  state.t = Math.max(0, Math.min(t, totalDuration(state.segs)));
  if (!state.segs.length) return;
  const my = ++seekToken;
  updateClock();
  await waitSeek(outToSrc(state.segs, state.t).src);
  if (my !== seekToken) return; // 連続シーク中は最後の1回だけ描く
  renderer.draw(ctx, state.t, video, state.settings.layout);
}

let sfxCtx, sfxNodes = [], segIdx = 0;
async function play() {
  const total = totalDuration(state.segs);
  if (state.t >= total - 0.05) state.t = 0;
  const { src, seg } = outToSrc(state.segs, state.t);
  segIdx = seg;
  await waitSeek(src);
  state.playing = true;
  $("btnPlay").textContent = "❚❚";
  sfxCtx ||= new AudioContext();
  const now = sfxCtx.currentTime + 0.05;
  for (const e of renderer.sfxEvents()) {
    const b = sfxBuffers[e.name];
    if (!b || e.t < state.t - 0.05) continue;
    const n = sfxCtx.createBufferSource();
    n.buffer = b;
    n.connect(sfxCtx.destination);
    n.start(now + Math.max(0, e.t - state.t));
    sfxNodes.push(n);
  }
  await video.play();
  requestAnimationFrame(tick);
}

function tick() {
  if (!state.playing) return;
  const ct = video.currentTime;
  let s = state.segs[segIdx];
  if (ct >= s.end - 0.02 || video.ended) {
    segIdx++;
    if (segIdx >= state.segs.length) { state.t = totalDuration(state.segs); stop(); updateClock(); return; }
    s = state.segs[segIdx];
    video.currentTime = s.start; // 次の区間へジャンプ（ジャンプカット）
  }
  state.t = s.out + Math.max(0, Math.min(video.currentTime, s.end) - s.start);
  renderer.draw(ctx, state.t, video, state.settings.layout);
  updateClock();
  requestAnimationFrame(tick);
}

function stop() {
  state.playing = false;
  video.pause();
  $("btnPlay").textContent = "▶";
  for (const n of sfxNodes) try { n.stop(); } catch { /* 再生済み */ }
  sfxNodes = [];
}

// ---------------------------------------------------------------- export
async function doExport() {
  stop();
  const btn = $("btnExport");
  btn.disabled = true;
  showProgress("expProgress", 0);
  try {
    setStatus("expStatus", "音声をミックス中…");
    const audio = await mixAudio(state.audio, state.segs, renderer.sfxEvents(), sfxBuffers);
    setStatus("expStatus", "書き出し中…");
    const blob = await exportMp4({
      file: state.file, video, segs: state.segs, renderer, layout: state.settings.layout, audio,
      onProgress: (p) => { showProgress("expProgress", p); setStatus("expStatus", `書き出し中… ${Math.round(p * 100)}%`); },
    });
    download(blob, state.file.name.replace(/\.[^.]+$/, "") + "_telop.mp4");
    setStatus("expStatus", `完了（${(blob.size / 1e6).toFixed(1)}MB）。ダウンロードフォルダを確認してください。`);
  } catch (e) {
    console.error(e);
    setStatus("expStatus", `エラー：${e.message}`, true);
  } finally {
    btn.disabled = false;
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
  return { version: 1, file: state.file && { name: state.file.name, size: state.file.size }, settings: state.settings, lines: state.lines };
}
function save() {
  if (state.file) try { localStorage.setItem(projectKey(state.file), JSON.stringify(projectData())); } catch { /* 容量不足など */ }
}
function applyProject(p) {
  state.settings = { ...state.settings, ...p.settings };
  state.lines = p.lines || [];
  $("inpTitle").value = state.settings.title;
  $("selLayout").value = state.settings.layout;
  $("inpGap").value = state.settings.gap;
  $("gapVal").textContent = `${Number(state.settings.gap).toFixed(2)}秒`;
  if (state.db) state.speech = detectSpeech(state.db, { gap: state.settings.gap });
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
$("inpVideo").onchange = (e) => e.target.files[0] && loadVideo(e.target.files[0]);
for (const el of [$("dropzone"), document.querySelector(".phone")]) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); $("dropzone").classList.add("over"); });
  el.addEventListener("dragleave", () => $("dropzone").classList.remove("over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("video/")) loadVideo(f);
  });
}
$("btnAnalyze").onclick = analyze;
$("btnPlay").onclick = () => (state.playing ? stop() : play());
$("seek").oninput = (e) => seekTo(Number(e.target.value));
$("selLayout").onchange = (e) => { state.settings.layout = e.target.value; refresh(false); };
$("inpTitle").oninput = (e) => { state.settings.title = e.target.value; scheduleRefresh(); };
$("inpGap").oninput = (e) => {
  state.settings.gap = Number(e.target.value);
  $("gapVal").textContent = `${state.settings.gap.toFixed(2)}秒`;
  if (state.db) state.speech = detectSpeech(state.db, { gap: state.settings.gap });
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
$("btnSrt").onclick = () => download(new Blob([toSrt(state.items)], { type: "text/plain" }), state.file.name.replace(/\.[^.]+$/, "") + ".srt");
$("btnSaveProject").onclick = () => download(new Blob([JSON.stringify(projectData(), null, 1)], { type: "application/json" }), state.file.name.replace(/\.[^.]+$/, "") + "_telop.json");
$("inpProject").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  applyProject(JSON.parse(await f.text()));
  if (state.file) await refresh(true);
  else setStatus("anaStatus", "作業を読み込みました。同じ動画を選んでください。");
};
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName) && state.segs.length) {
    e.preventDefault();
    state.playing ? stop() : play();
  }
});

init();
