// 音声解析（無音検出）・字幕の分割・カット後の時間変換・テロップ一覧の生成
import { highlight } from "./autoedit.js";

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

// 20ms ごとの音量(dB)。rms = 平均の大きさ、peak = 瞬間の最大（短い子音を拾うため）
export function loudness(pcm16k) {
  const hop = 320;
  const n = Math.floor(pcm16k.length / hop);
  const rms = new Float32Array(n), peak = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, p = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) {
      const v = pcm16k[j];
      s += v * v;
      if (Math.abs(v) > p) p = Math.abs(v);
    }
    rms[i] = 10 * Math.log10(s / hop + 1e-10);
    peak[i] = 20 * Math.log10(p + 1e-10);
  }
  return { rms, peak };
}

const pct = (arr, p) => {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

// 自動カットの設定（Premiere 用プラグイン EditKit と同じ考え方）
//   minimum: これより長い無言だけをカットする（秒）
//   tail: 話し終わりのあとに残す余白、lead: 話し始めの前に残す余白
//   thresholdDb: これより小さい音を無音とみなす（瞬間の音量は +12dB まで声として扱う）
export const CUT_PRESETS = {
  solo: { name: "1人で話す", minimum: 0.6, tail: 0.15, lead: 0.1, thresholdDb: -42 },
  dialogue: { name: "会話・対談", minimum: 1.0, tail: 0.25, lead: 0.2, thresholdDb: -42 },
  variety: { name: "バラエティ（間を残す）", minimum: 1.5, tail: 0.4, lead: 0.3, thresholdDb: -42 },
};

const mergeRanges = (ranges) => {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-8) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
};

// 残す区間（しゃべっている所）を返す。
// 声と判定する所：平均の音量がしきい値を超える、または瞬間の音量がしきい値+12dB を超える。
// 文字起こしの単語（前後 0.05 秒）も必ず声として残す（小さな声や語尾を切らないための保護）。
// 声と声の間の無言が minimum 以上のときだけ、tail/lead の余白を残してカットする。
export function detectSpeech(levels, opts = {}, words = []) {
  const o = { ...CUT_PRESETS.solo, ...opts };
  const fr = 0.02;
  const rms = levels.rms || levels, peak = levels.peak || levels;
  const dur = rms.length * fr;
  // 雑音が大きい素材では、雑音を声と取り違えないよう基準を少し上げる
  const floor = pct(rms, 0.1);
  const thr = floor > o.thresholdDb - 6 ? floor + 6 : o.thresholdDb;
  const speech = [];
  let st = -1;
  for (let i = 0; i <= rms.length; i++) {
    const on = i < rms.length && (rms[i] > thr || peak[i] > thr + 12);
    if (on && st < 0) st = i;
    if (!on && st >= 0) { speech.push({ start: st * fr, end: i * fr }); st = -1; }
  }
  for (const w of words) {
    const s = Array.isArray(w) ? w[0] : w.start, e = Array.isArray(w) ? w[1] : w.end;
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) speech.push({ start: Math.max(0, s - 0.05), end: Math.min(dur, e + 0.05) });
  }
  const voice = mergeRanges(speech);
  // カットする無言（余白を残した後の範囲）
  const cuts = [];
  let pos = 0;
  for (const v of [...voice, { start: dur, end: dur }]) {
    const gap = v.start - pos;
    if (gap >= o.minimum) {
      const a = pos === 0 ? 0 : pos + o.tail; // 先頭の無言は話し始めの余白だけ残す
      const b = v.start >= dur ? dur : v.start - o.lead;
      if (b - a > 0.02) cuts.push({ start: a, end: b });
    }
    pos = Math.max(pos, v.end);
  }
  // 残す区間 = 全体 − カット
  const keep = [];
  let cur = 0;
  for (const c of cuts) {
    if (c.start - cur > 0.02) keep.push({ start: cur, end: c.start });
    cur = c.end;
  }
  if (dur - cur > 0.02) keep.push({ start: cur, end: dur });
  return keep;
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

// ---------------------------------------------------------------- words → subtitles
// Whisper の単語（{ text, timestamp: [開始, 終了] }）を、保存用の [開始, 終了, 文字] にそろえる
export function normalizeWords(raw, duration) {
  const out = [];
  for (const w of raw || []) {
    const text = (w.text || "").replace(/\s+/g, "");
    let [s, e] = w.timestamp || [];
    if (!text || !Number.isFinite(s)) continue;
    if (!Number.isFinite(e) || e <= s) e = Math.min(duration, s + 0.3);
    out.push([Math.max(0, s), Math.min(duration, e), text]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const SENT_END = /[。！？!?]$/;
const PAUSE_BREAK = 0.45; // これ以上の間があれば字幕を分ける（秒）

// 単語の時刻をそのまま使って字幕を作る（言った瞬間に出て、言い終わりで消える）
export function buildLinesFromWords(words) {
  const lines = [];
  let buf = [];
  const emit = (n = buf.length) => {
    const part = buf.slice(0, n);
    buf = buf.slice(n);
    let text = part.map((w) => w[2]).join("");
    const count = (re) => (text.match(re) || []).length;
    if (count(/「/g) !== count(/」/g)) text = text.replace(/[「」]/g, "");
    text = text.replace(/[。、,]$/u, "");
    if (text.trim()) lines.push({ id: crypto.randomUUID(), src: [part[0][0], part[part.length - 1][1]], text, cut: false, fx: "", fxText: "" });
  };
  const chars = () => buf.map((w) => w[2]).join("");
  words.forEach((w, i) => {
    buf.push(w);
    const next = words[i + 1];
    const len = [...chars()].length;
    if (SENT_END.test(w[2]) || (/[、,]$/.test(w[2]) && len >= 8)) return emit();
    if (next && next[0] - w[1] >= PAUSE_BREAK && len >= 4) return emit();
    if (len >= HARD_MAX) {
      // 単語の切れ目のうち、日本語として自然な所で分ける
      let best = buf.length - 1, bestScore = -Infinity, pos = 0;
      for (let k = 1; k < buf.length; k++) {
        pos += [...buf[k - 1][2]].length;
        const cs = [...chars()];
        const s = breakScore(cs, pos) - Math.abs(pos - SOFT_MAX) * 0.8;
        if (s > bestScore && pos >= 6) { bestScore = s; best = k; }
      }
      emit(best);
    }
  });
  if (buf.length) emit();
  return lines;
}

// ---------------------------------------------------------------- retake hints
// 言い直し・繰り返し・中断の言葉を見つける（Premiere 用プラグイン EditKit と同じ判定）。
// お知らせだけで、自動ではカットしない。
const RETAKE = { lookAhead: 20, headChars: 10, headMatch: 5, prefixMatch: 5, fragmentPrefix: 3, repeatChars: 8, repeatGap: 15 };
const STALL = /ちょっと待って|もう一回|もう一度|撮り直|言い直|やり直|間違え|すみません|ごめんなさい/;
const PUNCT = /[\s、。，．,.！？!?「」『』…]/;

export function retakeHints(words, voiceOf = () => "") {
  const groups = [];
  let current = null;
  for (const [start, end, text] of words) {
    const voice = voiceOf(start);
    if (!current || start - current.end > 0.7 || current.voice !== voice) {
      current = { start, end, text: "", voice, words: [] };
      groups.push(current);
    }
    current.text += text;
    current.end = end;
    current.words.push({ start, end, text });
    if (/[。！？!?]$/.test(text)) current = null;
  }
  for (const g of groups) {
    g.chars = [];
    for (const w of g.words) for (const ch of w.text) if (!PUNCT.test(ch)) g.chars.push({ ch, word: w });
    g.clean = g.chars.map((c) => c.ch).join("");
  }
  const longestCommon = (x, y) => {
    let best = 0;
    for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) {
      let n = 0;
      while (i + n < x.length && j + n < y.length && x[i + n] === y[j + n]) n++;
      if (n > best) best = n;
    }
    return best;
  };
  const restartsAs = (a, b) => {
    const x = a.clean, y = b.clean;
    let shared = 0;
    while (shared < Math.min(x.length, y.length) && x[shared] === y[shared]) shared++;
    if (shared >= RETAKE.prefixMatch) return true;
    if (shared >= RETAKE.fragmentPrefix && x.length <= shared + 2) return true; // 「2つ目。」→「2つ目が…」
    return longestCommon(x.slice(0, RETAKE.headChars), y.slice(0, RETAKE.headChars)) >= RETAKE.headMatch;
  };
  const hints = [], covered = [];
  const push = (h) => { hints.push(h); covered.push([h.start, h.end]); };
  const isCovered = (s, e) => covered.some(([a, b]) => s < b && e > a);
  // 1) 同じ出だしで言い直している（前の方を消す候補）
  for (let i = 0; i < groups.length - 1; i++) {
    const a = groups[i];
    for (let j = i + 1; j < groups.length; j++) {
      const b = groups[j];
      if (b.start - a.end > RETAKE.lookAhead) break;
      if (a.voice !== b.voice || b.start < a.end || !restartsAs(a, b)) continue;
      const taken = groups.slice(i, j);
      const stalled = taken.some((g) => STALL.test(g.text));
      push({ type: "retake", start: a.start, end: groups[j - 1].end, text: taken.map((g) => g.text).join(""), retained: b.text,
        reason: "同じ内容を話し直している可能性があります。" + (stalled ? "途中に中断の言葉もあります。" : "") });
      i = j - 1;
      break;
    }
  }
  // 2) 同じ言い回しを続けて繰り返している
  groups.forEach((g) => {
    const x = g.clean;
    let best = null;
    for (let p = 0; p < x.length; p++) for (let q = p + RETAKE.repeatChars; q < x.length; q++) {
      let n = 0;
      while (q + n < x.length && p + n < q && x[p + n] === x[q + n]) n++;
      if (n >= RETAKE.repeatChars && q - (p + n) <= RETAKE.repeatGap && (!best || n > best.n)) best = { p, q, n };
    }
    if (!best) return;
    const first = g.chars[best.p].word, second = g.chars[best.q].word;
    const before = g.words[g.words.indexOf(second) - 1];
    if (!before || before.end <= first.start || isCovered(first.start, before.end)) return;
    push({ type: "repeat", start: first.start, end: before.end, text: x.slice(best.p, best.q), retained: x.slice(best.q, best.q + best.n),
      reason: "同じ言い回しを続けて繰り返している可能性があります。" });
  });
  // 3) 「ちょっと待って」「撮り直し」など中断の言葉
  groups.forEach((g, i) => {
    if (!STALL.test(g.text) || isCovered(g.start, g.end)) return;
    push({ type: "stall", start: g.start, end: g.end, text: g.text, retained: groups[i + 1]?.text || "",
      reason: "「ちょっと待って」など、中断や言い直しの言葉があります。" });
  });
  return hints.sort((a, b) => a.start - b.start);
}

// （旧方式）Whisper の区間を字幕1枚ずつに分け、しゃべっている時間に比例して時刻を割り振る
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
// 演出テロップ。pos/screen は「おまかせ」のときの初期値（横長は人と重ならない位置にする）
export const FX = {
  "": { name: "なし" },
  keyword: { name: "キーワード", style: "keyword", pos: { portrait: "auto", landscape: "bottom" }, screen: "none" },
  hook: { name: "煽り", style: "hook", pos: { portrait: "auto", landscape: "bottom" }, screen: "lines" },
  tsukkomi: { name: "ツッコミ（青）", style: "tsukkomi", pos: { portrait: "auto", landscape: "tr" }, screen: "none" },
  tsukkomi_green: { name: "ツッコミ（緑）", style: "tsukkomi_green", pos: { portrait: "auto", landscape: "tl" }, screen: "none" },
  point: { name: "見出し「その1/本文」", style: "point", pos: { portrait: "auto", landscape: "tl" }, screen: "none" },
  reveal: { name: "オチ", style: "reveal", pos: { portrait: "auto", landscape: "center" }, screen: "flash" },
  cta_main: { name: "締め", style: "cta_main", pos: { portrait: "auto", landscape: "bottom" }, screen: "none" },
  vertical: { name: "縦書き（大）", style: "vertical_big", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  quote: { name: "白箱（問いかけ・引用）", style: "box_quote", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  biz: { name: "ビジネス強調（2色）", style: "biz_emph", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  corner: { name: "コーナー名（左上）", style: "corner_label", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  next: { name: "この後（右上）", style: "next_preview", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  hand: { name: "手書き風", style: "handwrite", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  horror: { name: "ホラー・不穏", style: "horror", pos: { portrait: "auto", landscape: "auto" }, screen: "dark" },
  note: { name: "注釈（※小さく）", style: "note", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  name: { name: "名前テロップ", style: "name_plate", pos: { portrait: "auto", landscape: "auto" }, screen: "none" },
  brush: { name: "筆文字タイトル", style: "brush_title", pos: { portrait: "auto", landscape: "auto" }, screen: "lines" },
};

// 長く出しておく演出（次の同じ種類が出るまで表示）
const PERSIST = new Set(["point", "corner"]);

export const FX_POS = {
  auto: "おまかせ", tl: "左上", top: "上", tr: "右上", center: "真ん中", bottom: "下（字幕の位置）",
};

export const SCREEN = {
  auto: "おまかせ",
  none: "なし",
  zoom: "ズーム",
  zoom_lines: "ズーム＋集中線",
  lines: "集中線",
  flash: "フラッシュ＋集中線",
  mono_dark: "モノクロ＋暗く",
  dark: "周りを暗く",
  mono: "モノクロ",
  shake: "揺れ",
};

// 位置の名前 → 座標と揃え方
const PLACES = {
  portrait: { tl: [60, 560, "left"], top: [540, 560], tr: [1020, 560, "right"], center: [540, 900], bottom: [540, 1180] },
  landscape: { tl: [70, 215, "left"], top: [960, 200], tr: [1850, 215, "right"], center: [960, 520], bottom: [960, 800] },
};

function placeFor(key, aspect, replacesSubtitle, subtitlePos) {
  if (!key || key === "auto") return {};
  if (key === "bottom" && replacesSubtitle) return { pos: [...subtitlePos] };
  const p = PLACES[aspect][key];
  return p ? { pos: [p[0], p[1]], align: p[2] } : {};
}

// 画面効果 → 描画するもの
function screenItems(effect, t, d) {
  const lines = (style = "speedlines", dd = Math.min(d, 1.6)) => ({ style, t, d: dd });
  const scr = (e) => ({ style: "__screen", effect: e, t, d });
  switch (effect) {
    case "zoom": return [scr("zoom")];
    case "zoom_lines": return [scr("zoom"), lines()];
    case "lines": return [lines()];
    case "flash": return [{ style: "flash", t, d: 0.4 }, lines("speedlines_white", 1.3)];
    case "mono_dark": return [scr("mono"), scr("dark")];
    case "dark": return [scr("dark")];
    case "mono": return [scr("mono")];
    case "shake": return [scr("shake")];
    default: return [];
  }
}

// 描画とSRTで同じ字幕時刻を使う。演出の有無にかかわらず、カットしていない行を残す。
function timedLines(lines, segs) {
  const total = totalDuration(segs);
  const live = lines.filter((l) => !l.cut).map((l) => ({ l, t0: srcToOut(segs, l.src[0]), t1: srcToOut(segs, l.src[1]) }));
  return live.map(({ l, t0, t1 }, i) => {
    const next = live[i + 1];
    let end = t1;
    if (next && next.t0 - t1 < 0.6) end = next.t0; // 間が短ければ次の字幕までつなぐ
    end = Math.min(total, Math.max(end, t0 + 0.5));
    return { l, t0, end };
  }).filter(({ t0, end }) => end - t0 > 0.05);
}

// 字幕行 → 描画用テロップ一覧（出力側の時刻）
export function buildItems(lines, segs, settings) {
  const total = totalDuration(segs);
  const aspect = settings.aspect || "portrait";
  const speakers = settings.speakers || [];
  const live = timedLines(lines, segs);
  const items = [];
  if (settings.title) items.push({ style: "header", text: settings.title, t: 0.2, d: Math.max(1, total - 0.2) });
  live.forEach(({ l, t0, end }, i) => {
    const fx = FX[l.fx];
    const ownText = (l.fxText || "").trim();
    const replaces = !!(fx && fx.style && !ownText); // 字幕そのものを演出テロップにする
    // 話者ごとの字幕デザイン（スタイル名は subtitle@話者ID）
    const sp = speakers.find((s) => s.id === l.speaker) || speakers[0];
    const design = sp?.design;
    const subStyle = sp ? `subtitle@${sp.id}` : "subtitle";
    const wrapAt = design?.maxChars?.[aspect] || (aspect === "landscape" ? 26 : 13);
    const shown = settings.autoHighlight === false ? l.text : highlight(l.text); // 大事な言葉を自動で強調色に
    if (!replaces) items.push({ style: subStyle, text: wrapLine(shown, wrapAt), t: t0, d: end - t0, line: l.id });

    let d = Math.max(1.4, end - t0);
    if (fx && fx.style) {
      // デザインセットで演出の見た目を差し替える（例：ビジネス講義風なら「キーワード」→ 2色の大きい強調）
      const style = settings.fxMap?.[l.fx] || fx.style;
      const vertical = style === "vertical_big";
      // 字幕そのものを演出にするときは、強調色を付けて読みやすい長さで改行する
      let text = ownText || wrapLine(shown, vertical ? 7 : aspect === "landscape" ? 18 : 10);
      if (l.fx === "reveal") d += 0.8;
      if (PERSIST.has(l.fx)) {
        const nextSame = live.slice(i + 1).find((x) => x.l.fx === l.fx);
        d = (nextSame ? nextSame.t0 : total) - t0;
      }
      const it = { style, text, t: t0, d, line: l.id };
      if (l.fx === "point") {
        const [label, ...body] = text.split(/[/／]/);
        if (style === "point") Object.assign(it, body.length ? { label, text: body.join("/") } : { label: "POINT", text });
        else it.text = body.length ? `${label}　${body.join("/")}` : text; // 見出しを1行のラベルで出すデザインのとき
      }
      const posKey = !l.fxPos || l.fxPos === "auto" ? fx.pos?.[aspect] : l.fxPos;
      Object.assign(it, placeFor(posKey, aspect, replaces, design?.pos?.[aspect] || [0, 0]));
      items.push(it);
    }
    // 画面効果（演出なしの行にも付けられる）
    const effect = !l.screen || l.screen === "auto" ? fx?.screen || "none" : l.screen;
    const effDur = fx && fx.style && !PERSIST.has(l.fx) ? d : end - t0;
    items.push(...screenItems(effect, t0, effDur));
  });
  return items.map((it) => ({ ...it, d: Math.min(it.d, total - it.t) })).filter((it) => it.d > 0.05);
}

// ---------------------------------------------------------------- speakers
// 話者判別の結果を各字幕に割り当てる。いちばん長く重なっている話者にする。
// 戻り値: 判別結果の番号 → 登場順の連番（0, 1, 2…）
export function assignSpeakers(lines, segments) {
  // 0 = 無音、1〜3 = 1人ずつ、4以上 = 2人が重なった区間（どちらか分からないので使わない）
  const usable = segments.filter((s) => s.id >= 1 && s.id <= 3);
  const order = [];
  for (const l of lines) {
    const score = {};
    for (const s of usable) {
      const ov = Math.min(l.src[1], s.end) - Math.max(l.src[0], s.start);
      if (ov > 0) score[s.id] = (score[s.id] || 0) + ov;
    }
    const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    if (!best) { l.speakerIndex = null; continue; }
    const raw = Number(best[0]);
    if (!order.includes(raw)) order.push(raw);
    l.speakerIndex = order.indexOf(raw);
  }
  return order.length;
}

// ---------------------------------------------------------------- SRT
const ts = (t) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export function toSrt(lines, segs) {
  return timedLines(lines, segs)
    .map(({ l, t0, end }, i) => `${i + 1}\n${ts(t0)} --> ${ts(end)}\n${l.text.replace(/[{}\[\]]/g, "")}\n`)
    .join("\n");
}
