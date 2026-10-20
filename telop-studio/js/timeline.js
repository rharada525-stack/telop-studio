// 音声解析（無音検出）・字幕の分割・カット後の時間変換・テロップ一覧の生成

// ---------------------------------------------------------------- audio
export async function decodeAudio(file) {
  const ac = new AudioContext({ sampleRate: 48000 });
  try {
    return await ac.decodeAudioData(await file.arrayBuffer());
  } finally {
    ac.close();
  }
}

export async function toMono16k(buffer) {
  const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

// 20ms ごとの音量(dB)
export function loudness(pcm16k) {
  const hop = 320;
  const n = Math.floor(pcm16k.length / hop);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += pcm16k[j] * pcm16k[j];
    db[i] = 10 * Math.log10(s / hop + 1e-10);
  }
  return db;
}

const pct = (arr, p) => {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

// しゃべっている区間を返す。gap: これより短い無音は詰めずに残す（秒）
export function detectSpeech(db, { gap = 0.3, padBefore = 0.1, padAfter = 0.14, sensitivity = 0 } = {}) {
  const fr = 0.02;
  const floor = pct(db, 0.1), peak = pct(db, 0.99);
  const thr = Math.max(floor + 12, peak - 35) - sensitivity;
  const regions = [];
  let st = -1;
  for (let i = 0; i <= db.length; i++) {
    const on = i < db.length && db[i] > thr;
    if (on && st < 0) st = i;
    if (!on && st >= 0) { regions.push([st * fr, i * fr]); st = -1; }
  }
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < gap) last[1] = r[1];
    else merged.push([...r]);
  }
  const dur = db.length * fr;
  const out = [];
  for (const [a, b] of merged.filter(([a, b]) => b - a >= 0.12)) {
    const s = Math.max(0, a - padBefore), e = Math.min(dur, b + padAfter);
    const last = out[out.length - 1];
    if (last && s <= last.end) last.end = e;
    else out.push({ start: s, end: e });
  }
  return out;
}

// ---------------------------------------------------------------- subtitles
const SOFT_MAX = 16, HARD_MAX = 24;
const isKanji = (c) => /\p{Script=Han}/u.test(c);
const isKata = (c) => /[\p{Script=Katakana}ー]/u.test(c);
const isHira = (c) => /\p{Script=Hiragana}/u.test(c);

// chars[i-1] と chars[i] の間で切るときの自然さ（大きいほど良い）
function breakScore(chars, i) {
  const a = chars[i - 1], b = chars[i];
  if (!a || !b) return -999;
  if (/[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョーー、。！？!?」』）)]/u.test(b)) return -100;
  if ("、,".includes(a)) return 10;
  if ("をはがにでへもや".includes(a) && !isHira(b)) return 7;
  if ("をはがにでへも".includes(a)) return 5;
  if ("とてねよ".includes(a)) return isHira(b) ? 3 : 6;
  if (isHira(a) && (isKanji(b) || isKata(b))) return 2;
  if ((isKata(a) && isKata(b)) || (isKanji(a) && isKanji(b))) return -20;
  return 0;
}

function bestBreak(chars, target, lo, hi) {
  let best = -1, bestScore = -Infinity;
  for (let i = Math.max(1, lo); i <= Math.min(chars.length - 1, hi); i++) {
    const s = breakScore(chars, i) - Math.abs(i - target) * 0.8;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

// 1枚の字幕に収まる長さに区切る（句読点 → 助詞の後 の順で優先）
function splitText(text) {
  const pieces = [];
  let cur = [];
  for (const ch of text.replace(/\s+/g, "")) {
    cur.push(ch);
    if ("。！？!?".includes(ch) || ("、,".includes(ch) && cur.length >= 8)) { pieces.push(cur.join("")); cur = []; continue; }
    if (cur.length >= HARD_MAX) {
      const at = bestBreak(cur, SOFT_MAX, 8, cur.length - 2);
      pieces.push(cur.slice(0, at).join(""));
      cur = cur.slice(at);
    }
  }
  if (cur.length) pieces.push(cur.join(""));
  const count = (p, re) => (p.match(re) || []).length;
  return pieces
    .map((p) => (count(p, /「/g) !== count(p, /」/g) ? p.replace(/[「」]/g, "") : p))
    .map((p) => (count(p, /『/g) !== count(p, /』/g) ? p.replace(/[『』]/g, "") : p))
    .map((p) => p.replace(/[。、,]$/u, ""))
    .filter((p) => p.trim());
}

// 2行に折り返す（真ん中付近の自然な切れ目で）
export function wrapLine(text, max = 13) {
  const chars = [...text];
  if (text.includes("\n") || chars.length <= max) return text;
  const at = bestBreak(chars, Math.ceil(chars.length / 2), 3, chars.length - 3);
  return chars.slice(0, at).join("").replace(/[、,]$/u, "") + "\n" + chars.slice(at).join("");
}

// Whisper の区間を字幕1枚ずつに分け、しゃべっている時間に比例して時刻を割り振る
export function buildLines(chunks, speech, duration) {
  const lines = [];
  chunks.forEach((c, ci) => {
    const s = c.timestamp[0] ?? 0;
    const e = c.timestamp[1] ?? (chunks[ci + 1]?.timestamp[0] ?? duration);
    const pieces = splitText(c.text || "");
    if (!pieces.length) return;
    // チャンク内の発話区間
    let spans = speech.map((r) => [Math.max(s, r.start), Math.min(e, r.end)]).filter(([a, b]) => b - a > 0.05);
    if (!spans.length) spans = [[s, e]];
    const total = spans.reduce((a, [x, y]) => a + (y - x), 0);
    const at = (frac) => {
      let left = frac * total;
      for (const [x, y] of spans) {
        if (left <= y - x) return x + left;
        left -= y - x;
      }
      return spans[spans.length - 1][1];
    };
    const n = pieces.reduce((a, p) => a + p.length, 0);
    let acc = 0;
    for (const p of pieces) {
      const a = at(acc / n);
      acc += p.length;
      const b = at(acc / n);
      // 改行は出力の形（縦/横）に合わせて表示時に入れる
      lines.push({ id: crypto.randomUUID(), src: [a, b], text: p, cut: false, fx: "", fxText: "" });
    }
  });
  return lines;
}

// ---------------------------------------------------------------- clips
// 複数の素材を1本の時間軸に並べる。境目は 20ms の倍数にそろえて音量データとずれないようにする
export const FRAME = 0.02;
export function layoutClips(clips) {
  let off = 0;
  for (const c of clips) {
    c.offset = off;
    c.span = Math.ceil(c.duration / FRAME) * FRAME;
    off += c.span;
  }
  return off;
}

// しゃべっている区間を素材の境目で分け、どの素材かを付ける（境目をまたぐ区間を作らない）
export function splitAtClips(speech, clips) {
  const out = [];
  for (const r of speech) {
    clips.forEach((c, i) => {
      const a = Math.max(r.start, c.offset), b = Math.min(r.end, c.offset + c.duration);
      if (b - a > 0.05) out.push({ start: a, end: b, clip: i });
    });
  }
  return out;
}

export const clipAt = (clips, t) => {
  for (let i = clips.length - 1; i >= 0; i--) if (t >= clips[i].offset - 1e-6) return i;
  return 0;
};

// ---------------------------------------------------------------- cut mapping
// 残す区間 = しゃべっている区間 − 「カット」にチェックした字幕の区間
export function buildSegments(speech, lines) {
  let segs = speech.map((r) => ({ ...r }));
  for (const l of lines.filter((l) => l.cut)) {
    const [a, b] = l.src;
    const next = [];
    for (const s of segs) {
      if (b <= s.start || a >= s.end) { next.push(s); continue; }
      if (a - s.start > 0.08) next.push({ ...s, end: a });
      if (s.end - b > 0.08) next.push({ ...s, start: b });
    }
    segs = next;
  }
  let o = 0;
  for (const s of segs) { s.out = o; o += s.end - s.start; }
  return segs;
}

export const totalDuration = (segs) => segs.reduce((a, s) => a + s.end - s.start, 0);

export function srcToOut(segs, t) {
  for (const s of segs) {
    if (t < s.start) return s.out; // カットされた位置は次の区間の頭に寄せる
    if (t <= s.end) return s.out + (t - s.start);
  }
  return totalDuration(segs);
}

export function outToSrc(segs, t) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (t < s.out + (s.end - s.start) || i === segs.length - 1) return { src: s.start + Math.max(0, t - s.out), seg: i };
  }
  return { src: 0, seg: 0 };
}

// ---------------------------------------------------------------- telop items
export const FX = {
  "": { name: "なし" },
  keyword: { name: "キーワード", style: "keyword" },
  hook: { name: "煽り（集中線）", style: "hook", extra: [{ style: "speedlines", d: 1.6 }] },
  tsukkomi: { name: "ツッコミ（青）", style: "tsukkomi" },
  tsukkomi_green: { name: "ツッコミ（緑）", style: "tsukkomi_green" },
  point: { name: "見出し「その1/本文」", style: "point" },
  reveal: { name: "オチ（フラッシュ）", style: "reveal", extra: [{ style: "flash", d: 0.4 }, { style: "speedlines_white", d: 1.3 }] },
  cta_main: { name: "締め", style: "cta_main" },
};

// 字幕行 → 描画用テロップ一覧（出力側の時刻）
export function buildItems(lines, segs, settings) {
  const total = totalDuration(segs);
  const live = lines.filter((l) => !l.cut).map((l) => ({ l, t0: srcToOut(segs, l.src[0]), t1: srcToOut(segs, l.src[1]) }));
  const items = [];
  if (settings.title) items.push({ style: "header", text: settings.title, t: 0.2, d: Math.max(1, total - 0.2) });
  live.forEach(({ l, t0, t1 }, i) => {
    const next = live[i + 1];
    let end = t1;
    if (next && next.t0 - t1 < 0.6) end = next.t0; // 間が短ければ次の字幕までつなぐ
    end = Math.max(end, t0 + 0.5);
    const fx = FX[l.fx];
    const ownText = l.fxText.trim();
    const wrapAt = settings.aspect === "landscape" ? 26 : 13;
    if (!(fx && fx.style && !ownText)) items.push({ style: "subtitle", text: wrapLine(l.text, wrapAt), t: t0, d: end - t0, line: l.id });
    if (!fx || !fx.style) return;
    const text = ownText || l.text;
    let d = Math.max(1.4, end - t0);
    if (l.fx === "reveal") d += 0.8;
    if (l.fx === "point") {
      const nextPoint = live.slice(i + 1).find((x) => x.l.fx === "point");
      d = (nextPoint ? nextPoint.t0 : total) - t0;
    }
    const it = { style: fx.style, text, t: t0, d, line: l.id };
    if (l.fx === "point") {
      const [label, ...body] = text.split(/[/／]/);
      Object.assign(it, body.length ? { label, text: body.join("/") } : { label: "POINT", text });
    }
    for (const ex of fx.extra || []) items.push({ style: ex.style, t: t0, d: ex.d });
    items.push(it);
  });
  return items.map((it) => ({ ...it, d: Math.min(it.d, total - it.t) })).filter((it) => it.d > 0.05);
}

// ---------------------------------------------------------------- SRT
const ts = (t) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export function toSrt(items) {
  return items
    .filter((it) => it.style === "subtitle")
    .map((it, i) => `${i + 1}\n${ts(it.t)} --> ${ts(it.t + it.d)}\n${it.text.replace(/[{}]/g, "")}\n`)
    .join("\n");
}
