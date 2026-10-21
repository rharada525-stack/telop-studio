// Premiere Pro 用の書き出し（FCP7 XML + テロップ画像 + 効果音 + 字幕SRT を ZIP にまとめる）
import { zipSync, strToU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
import { totalDuration, toSrt } from "./timeline.js";

const SEQ_FPS = 30;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rateXml = (tb, ntsc) => `<rate><timebase>${tb}</timebase><ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
const sf = (t) => Math.round(t * SEQ_FPS); // 秒 → シーケンスのフレーム

// フォルダのパス + ファイル名 → Premiere が読める file:// の URL
function fileUrl(folder, rel) {
  if (!folder) return rel; // 場所が分からないときは名前だけ（Premiere でリンクし直す）
  const p = (folder.replace(/[\\/]+$/, "") + "/" + rel).replace(/\\/g, "/");
  const enc = p.split("/").map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join("/");
  return "file://localhost/" + enc.replace(/^\/+/, "");
}

// 素材のフレームレート（29.97 なら timebase 30 + NTSC）
function clipRate(clip) {
  const s = clip.media?.video.samples;
  if (!s || s.length < 3) return { tb: 30, ntsc: false, fps: 30 };
  const d = s.slice(0, 120).map((x) => x.dur).filter((x) => x > 0).sort((a, b) => a - b);
  const fps = 1 / d[Math.floor(d.length / 2)];
  const tb = Math.round(fps);
  const ntsc = Math.abs(fps - (tb * 1000) / 1001) < Math.abs(fps - tb);
  return { tb, ntsc, fps: ntsc ? (tb * 1000) / 1001 : tb };
}

// 重ならないようにトラック（レーン）へ詰める
function packLanes(clips) {
  const lanes = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const lane = lanes.find((l) => l[l.length - 1].end <= c.start);
    if (lane) lane.push(c);
    else lanes.push([c]);
  }
  return lanes;
}

const motionFilter = (scale) =>
  `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory>` +
  `<effecttype>motion</effecttype><mediatype>video</mediatype><parameter authoringApp="PremierePro"><parameterid>scale</parameterid>` +
  `<name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale.toFixed(2)}</value></parameter></effect></filter>`;

const opacityFilter = (keys) =>
  `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory>` +
  `<effecttype>motion</effecttype><mediatype>video</mediatype><parameter authoringApp="PremierePro"><parameterid>opacity</parameterid>` +
  `<name>Opacity</name><valuemin>0</valuemin><valuemax>100</valuemax><value>${keys[0][1]}</value>` +
  keys.map(([f, v]) => `<keyframe><when>${f}</when><value>${v}</value></keyframe>`).join("") +
  `</parameter></effect></filter>`;

const levelFilter = (gain) =>
  `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory>` +
  `<effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter authoringApp="PremierePro"><parameterid>level</parameterid>` +
  `<name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${Math.min(3.98, Math.max(0, gain)).toFixed(4)}</value></parameter></effect></filter>`;

const canvasPng = (c) => new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), "image/png"));

export async function buildPremierePackage({ clips, segs, lines, renderer, settings, items, gains, sfxEvents, sfxBuffers, folder, name, onProgress }) {
  const { W, H } = renderer;
  const total = totalDuration(segs);
  const dir = `${name}_premiere`; // ZIP の中のフォルダ名（素材と同じ場所に展開する）
  const files = {};
  const fileDefs = new Map(); // パス → file 要素（2回目からは id だけ）
  let nClip = 0;

  const fileXml = (key, def) => {
    if (fileDefs.has(key)) return `<file id="${fileDefs.get(key)}"/>`;
    const id = `file-${fileDefs.size + 1}`;
    fileDefs.set(key, id);
    return `<file id="${id}">${def}</file>`;
  };
  const stillFileDef = (rel, dur) =>
    `<name>${esc(rel.split("/").pop())}</name><pathurl>${esc(fileUrl(folder, `${dir}/${rel}`))}</pathurl>${rateXml(SEQ_FPS, false)}` +
    `<duration>${dur}</duration><media><video><samplecharacteristics>${rateXml(SEQ_FPS, false)}<width>${W}</width><height>${H}</height>` +
    `<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`;

  // ---- 1) 素材（カット済みの区間を並べる。ズームの区間は分けて拡大率を上げる）
  const zooms = renderer.screens.filter((e) => e.effect === "zoom").map((e) => [e.t, e.t + e.d]);
  const cuts = [];
  for (const s of segs) {
    const len = s.end - s.start;
    const bounds = new Set([s.out, s.out + len]);
    for (const [a, b] of zooms) for (const x of [a, b]) if (x > s.out && x < s.out + len) bounds.add(x);
    const pts = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const o0 = pts[i], o1 = pts[i + 1];
      if (sf(o1) - sf(o0) < 1) continue;
      const mid = (o0 + o1) / 2;
      cuts.push({ seg: s, o0, o1, zoom: zooms.some(([a, b]) => mid >= a && mid < b) });
    }
  }
  const srcVideo = [], srcAudio = [];
  for (const c of cuts) {
    const clip = clips[c.seg.clip];
    const r = clipRate(clip);
    const local0 = c.seg.start - clip.offset + (c.o0 - c.seg.out);
    const local1 = local0 + (c.o1 - c.o0);
    const vw = clip.video.videoWidth || W, vh = clip.video.videoHeight || H;
    let layout = settings.layout;
    if (layout === "auto") layout = vw > vh === W > H ? "cover" : "fit";
    const base = (layout === "fit" ? Math.min(W / vw, H / vh) : Math.max(W / vw, H / vh)) * 100;
    const durF = Math.round(clip.duration * r.fps);
    const key = `src:${c.seg.clip}`;
    const def = () =>
      `<name>${esc(clip.file.name)}</name><pathurl>${esc(fileUrl(folder, clip.file.name))}</pathurl>${rateXml(r.tb, r.ntsc)}` +
      `<duration>${durF}</duration><media><video><samplecharacteristics>${rateXml(r.tb, r.ntsc)}<width>${vw}</width><height>${vh}</height>` +
      `<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` +
      `<audio><samplecharacteristics><depth>16</depth><samplerate>${clip.audio?.sampleRate || 48000}</samplerate></samplecharacteristics>` +
      `<channelcount>${Math.min(2, clip.audio?.numberOfChannels || 2)}</channelcount></audio></media>`;
    const common = { start: sf(c.o0), end: sf(c.o1), in: Math.round(local0 * r.fps), out: Math.round(local1 * r.fps), r, key, def, name: clip.file.name };
    srcVideo.push({ ...common, scale: base * (c.zoom ? 1.18 : 1) });
    srcAudio.push(common);
  }

  // ---- 2) テロップ・集中線・フラッシュ・暗転を画像にする
  const pngCanvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const pctx = pngCanvas.getContext("2d");
  const overlays = { fx: [], sub: [], lines: [], top: [] };
  const drawable = renderer.items;
  let k = 0;
  for (const it of drawable) {
    onProgress?.(0.1 + (0.7 * k++) / Math.max(1, drawable.length));
    const start = sf(it.t), end = Math.max(start + 1, sf(it.t + it.d));
    pctx.clearRect(0, 0, W, H);
    let kind, extra = "";
    if (it.style === "flash") {
      pctx.fillStyle = "#ffffff";
      pctx.fillRect(0, 0, W, H);
      kind = "top";
      extra = opacityFilter([[0, 100], [Math.max(1, end - start), 0]]);
    } else {
      // 動きが終わって止まった状態を1枚の画像にする
      const tStill = Math.max(0, Math.min(it.d - 0.25, 1.2));
      it.obj.draw(pctx, tStill, it.d);
      kind = it.style.startsWith("subtitle") ? "sub" : it.style.startsWith("speedlines") ? "lines" : "fx";
    }
    const rel = `telops/${String(k).padStart(4, "0")}_${it.style.replace(/[^a-z0-9_]/gi, "_")}.png`;
    files[`${dir}/${rel}`] = await canvasPng(pngCanvas);
    const label = (it.label ? it.label + " " : "") + (it.text || it.style).replace(/[{}\n]/g, " ");
    overlays[kind].push({ start, end, rel, label: `[${it.style}] ${label}`.slice(0, 60), extra });
  }
  // 周りを暗くする効果は、暗いふちの画像を重ねる
  const darks = renderer.screens.filter((e) => e.effect === "dark");
  if (darks.length) {
    pctx.clearRect(0, 0, W, H);
    const g = pctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.25, W / 2, H * 0.45, Math.hypot(W, H) * 0.6);
    g.addColorStop(0, "rgba(0,0,0,0.25)");
    g.addColorStop(1, "rgba(0,0,0,0.85)");
    pctx.fillStyle = g;
    pctx.fillRect(0, 0, W, H);
    files[`${dir}/telops/dark_vignette.png`] = await canvasPng(pngCanvas);
    for (const e of darks) overlays.lines.push({ start: sf(e.t), end: Math.max(sf(e.t) + 1, sf(e.t + e.d)), rel: "telops/dark_vignette.png", label: "暗転", extra: "" });
  }

  // ---- 3) 効果音
  const sfxClips = [];
  const used = new Set(sfxEvents.filter((e) => e.t < total).map((e) => e.name));
  for (const n of used) {
    try { files[`${dir}/sfx/${n}.wav`] = new Uint8Array(await (await fetch(`sfx/${n}.wav`)).arrayBuffer()); } catch { used.delete(n); }
  }
  for (const e of sfxEvents) {
    if (!used.has(e.name) || e.t >= total) continue;
    const len = Math.max(1, sf(sfxBuffers[e.name]?.duration || 1.5));
    sfxClips.push({ start: sf(e.t), end: Math.min(sf(total), sf(e.t) + len), name: e.name, len });
  }

  // ---- 4) XML を組み立てる
  const clipItem = (c, inner) => {
    nClip++;
    return `<clipitem id="clipitem-${nClip}">${inner}</clipitem>`;
  };
  const vSource = (c) => clipItem(c,
    `<name>${esc(c.name)}</name><enabled>TRUE</enabled><duration>${c.end - c.start}</duration>${rateXml(c.r.tb, c.r.ntsc)}` +
    `<start>${c.start}</start><end>${c.end}</end><in>${c.in}</in><out>${c.out}</out>` +
    fileXml(c.key, c.def()) + motionFilter(c.scale));
  const aSource = (c) => clipItem(c,
    `<name>${esc(c.name)}</name><enabled>TRUE</enabled><duration>${c.end - c.start}</duration>${rateXml(c.r.tb, c.r.ntsc)}` +
    `<start>${c.start}</start><end>${c.end}</end><in>${c.in}</in><out>${c.out}</out>` +
    fileXml(c.key, c.def()) + `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` + levelFilter(gains.voice));
  const vStill = (o) => clipItem(o,
    `<name>${esc(o.label)}</name><enabled>TRUE</enabled><duration>${o.end - o.start}</duration>${rateXml(SEQ_FPS, false)}` +
    `<start>${o.start}</start><end>${o.end}</end><in>0</in><out>${o.end - o.start}</out><alphatype>straight</alphatype>` +
    fileXml(`still:${o.rel}`, stillFileDef(o.rel, Math.max(o.end - o.start, 1))) + o.extra);
  const aSfx = (c) => clipItem(c,
    `<name>SE ${esc(c.name)}</name><enabled>TRUE</enabled><duration>${c.len}</duration>${rateXml(SEQ_FPS, false)}` +
    `<start>${c.start}</start><end>${c.end}</end><in>0</in><out>${c.end - c.start}</out>` +
    fileXml(`sfx:${c.name}`, `<name>${c.name}.wav</name><pathurl>${esc(fileUrl(folder, `${dir}/sfx/${c.name}.wav`))}</pathurl>${rateXml(SEQ_FPS, false)}` +
      `<duration>${c.len}</duration><media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media>`) +
    `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` + levelFilter(gains.sfx));

  const vTrack = (list, fn) => `<track>${list.map(fn).join("")}</track>`;
  const aTrack = (list, fn) => `<track premiereTrackType="Stereo">${list.map(fn).join("")}</track>`;
  const videoTracks = [
    vTrack(srcVideo, vSource),
    ...packLanes(overlays.lines).map((l) => vTrack(l, vStill)),
    ...packLanes(overlays.sub).map((l) => vTrack(l, vStill)),
    ...packLanes(overlays.fx).map((l) => vTrack(l, vStill)),
    ...packLanes(overlays.top).map((l) => vTrack(l, vStill)),
  ];
  const audioTracks = [aTrack(srcAudio, aSource), ...packLanes(sfxClips).map((l) => aTrack(l, aSfx))];
  const seqFormat = `<samplecharacteristics>${rateXml(SEQ_FPS, false)}<width>${W}</width><height>${H}</height>` +
    `<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1">` +
    `<name>${esc(name)}</name><duration>${sf(total)}</duration>${rateXml(SEQ_FPS, false)}<in>-1</in><out>-1</out>` +
    `<media><video><format>${seqFormat}</format>${videoTracks.join("")}</video>` +
    `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>` +
    `</samplecharacteristics></format>${audioTracks.join("")}</audio></media></sequence></xmeml>\n`;

  files[`${dir}/${name}.xml`] = strToU8(xml);
  files[`${dir}/${name}_字幕.srt`] = strToU8(toSrt(lines, segs, settings));
  files[`${dir}/はじめにお読みください.txt`] = strToU8(readme(name, dir, folder, clips));
  onProgress?.(0.95);
  const zip = zipSync(files, { level: 0 }); // 画像も音もすでに圧縮済みなので無圧縮でまとめる
  return new Blob([zip], { type: "application/zip" });
}

function readme(name, dir, folder, clips) {
  return [
    "テロップスタジオ → Premiere Pro の読み込み手順",
    "",
    "1. この ZIP を、元の動画が入っているフォルダの中に展開してください。",
    `   （展開すると「${dir}」というフォルダができます）`,
    folder ? `   元の動画のフォルダ：${folder}` : "   ※書き出し時に素材フォルダを指定しなかったので、読み込み時にファイルの場所を聞かれます（下の4）。",
    "2. Premiere Pro で［ファイル］→［読み込み］を選び、",
    `   「${dir}\\${name}.xml」を選びます。`,
    "3. カット済みの動画・テロップ・効果音が並んだシーケンスができます。",
    "4. 「メディアをリンク」の画面が出たら、［検索］で元の動画を1つ選ぶと、残りも自動で見つかります。",
    "   テロップ画像や効果音の場所を聞かれたら、展開したフォルダの telops / sfx の中を選んでください。",
    "",
    "・字幕を Premiere 上で文字として直したいときは、",
    `  「${name}_字幕.srt」を読み込んでキャプショントラックに置き、字幕画像のトラックを削除してください。`,
    "・テロップのアニメーション、モノクロ、揺れ、ぼかし背景は画像では再現できないため入っていません。",
    "  必要なら Premiere のエフェクトで付けてください。",
    "",
    "使った素材：",
    ...clips.map((c) => `  ${c.file.name}`),
  ].join("\r\n");
}
