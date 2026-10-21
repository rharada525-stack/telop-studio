// 元素材の時刻で保存する区間編集。後から指定したカット／復元を優先する。
export function clearRangeEdits(edits, start, end) {
  return edits.flatMap(e => {
    if (e.end <= start || e.start >= end) return [{ ...e }];
    return [e.start < start && { ...e, end: start }, e.end > end && { ...e, start: end }].filter(Boolean);
  });
}

export function setRangeEdit(edits, range) {
  const { start, end, keep } = range;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || typeof keep !== 'boolean') throw new Error('開始・終了の秒数を確認してください。');
  const sorted = [...clearRangeEdits(edits, start, end), { start, end, keep }].sort((a,b) => a.start-b.start);
  const out = [];
  for (const e of sorted) {
    const last = out.at(-1);
    if (last && last.keep === e.keep && e.start <= last.end + 1e-8) last.end = Math.max(last.end, e.end);
    else out.push({ ...e });
  }
  return out;
}

const subtract = (segs, a, b) => segs.flatMap(s => {
  if (b <= s.start || a >= s.end) return [s];
  return [a > s.start && { ...s, end: a }, b < s.end && { ...s, start: b }].filter(Boolean);
});

export function applyRangeEdits(segs, edits, clips) {
  let out = segs.map(s => ({ ...s }));
  for (const e of edits) {
    out = subtract(out, e.start, e.end);
    if (e.keep) clips.forEach((c, clip) => {
      const start = Math.max(e.start, c.offset), end = Math.min(e.end, c.offset + c.duration);
      if (end > start) out.push({ start, end, clip });
    });
  }
  out.sort((a,b) => a.start-b.start);
  const merged = [];
  for (const s of out) {
    const last = merged.at(-1);
    if (last && last.clip === s.clip && s.start <= last.end + 1e-8) last.end = Math.max(last.end,s.end);
    else merged.push({ ...s });
  }
  return merged;
}

// 字幕単位のカットから一部を戻した場合、その戻した映像にも元の字幕を出す。
export const linesForOutput = (lines, edits) => lines.map(l => l.cut && edits.some(e => e.keep && e.start < l.src[1] && e.end > l.src[0]) ? { ...l, cut: false } : l);

export function cutRanges(segs, clip) {
  const out = [], end = clip.offset + clip.duration;
  let pos = clip.offset;
  for (const s of segs) {
    const a = Math.max(clip.offset,s.start), b = Math.min(end,s.end);
    if (b <= a) continue;
    if (a > pos + 1e-8) out.push({start:pos,end:a});
    pos = Math.max(pos,b);
  }
  if (end > pos + 1e-8) out.push({start:pos,end});
  return out;
}
