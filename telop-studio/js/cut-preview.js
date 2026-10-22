import { setRangeEdit } from './range-edits.js';

export const clampTime = (t, duration) => Math.max(0, Math.min(duration, t));
export const frameTime = (t, duration) => clampTime(Math.round(t * 30) / 30, duration);
export const pointerTime = (x, width, duration) => frameTime(x / width * duration, duration);
export const resizeSelection = (range, side, t, duration) => ({ ...range,
  [side]: side==='start' ? Math.max(0,Math.min(t,range.end-1/30)) : Math.min(duration,Math.max(t,range.start+1/30)),
});
export const clockTime = t => {
  const ms = Math.max(0,Math.round(t*1000));
  return `${Math.floor(ms/60000)}:${((ms%60000)/1000).toFixed(3).padStart(6,'0')}`;
};

// 試聴と確定で、必ず同じ区間編集を使う。
export function draftRangeEdits(edits, clip, selection, previous = null, keep = false) {
  let next = edits;
  if (!keep && previous) next = setRangeEdit(next, { ...previous, keep: true });
  return setRangeEdit(next, { start: clip.offset + selection.start, end: clip.offset + selection.end, keep });
}

// 削除後のタイムラインから、接続点の前後に残る映像をそれぞれ最大2秒取る。
// 大きな無音や、同じ素材内にある別のカットも、確定後と同じように飛ばす。
export function connectionPreview(segs, clip, selection, context = 2) {
  const a = clip.offset + selection.start, b = clip.offset + selection.end;
  const before = [], after = [];
  for (const s of segs) {
    const start = Math.max(clip.offset, s.start), end = Math.min(clip.offset + clip.duration, s.end);
    if (end <= start) continue;
    if (start < a) before.push({ start, end: Math.min(a, end) });
    if (end > b) after.push({ start: Math.max(b, start), end });
  }
  let left = context;
  const tail = [];
  for (const s of before.toReversed()) {
    if (left <= 1e-8) break;
    const start = Math.max(s.start, s.end - left);
    tail.unshift({ start, end: s.end }); left -= s.end - start;
  }
  left = context;
  const head = [];
  for (const s of after) {
    if (left <= 1e-8) break;
    const end = Math.min(s.end, s.start + left);
    head.push({ start: s.start, end }); left -= end - s.start;
  }
  return [...tail, ...head].map(s => ({ start: s.start - clip.offset, end: s.end - clip.offset }));
}
