import { cutRanges, setRangeEdit } from './range-edits.js';

export function createCutEditor({ clips, segments, edits, currentSource, change, undo, redo, history }) {
  const $ = id => document.getElementById(id);
  const dialog = $('cutEditorDialog'), video = $('cutSourceVideo');
  let clipIndex = 0, selected = null, sourceUrl = null, updating = false;
  const clip = () => clips()[clipIndex];
  const seconds = n => n.toFixed(2);
  const read = () => ({ start: Number($('inpCutStart').value), end: Number($('inpCutEnd').value) });
  const valid = () => {
    const {start,end} = read();
    return $('inpCutStart').value !== '' && $('inpCutEnd').value !== '' && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= clip().duration + 1e-8 && end > start;
  };
  function drawMap() {
    const c = clip(), map = $('cutMap');
    map.replaceChildren();
    for (const s of segments()) {
      const a = Math.max(c.offset,s.start), b = Math.min(c.offset+c.duration,s.end);
      if (b <= a) continue;
      const span = document.createElement('span');
      span.className = 'kept-range';
      span.style.left = `${(a-c.offset)/c.duration*100}%`;
      span.style.width = `${(b-a)/c.duration*100}%`;
      map.append(span);
    }
    if (valid()) {
      const {start,end} = read(), span = document.createElement('span');
      span.className = 'selected-range';
      span.style.left = `${start/c.duration*100}%`;
      span.style.width = `${(end-start)/c.duration*100}%`;
      map.append(span);
    }
  }
  function syncSelection() {
    const {start,end} = read(), ok = valid();
    $('sliderCutStart').value = start;
    $('sliderCutEnd').value = end;
    $('cutSelectionSummary').textContent = ok ? `${seconds(start)}秒 → ${seconds(end)}秒（${seconds(end-start)}秒）` : '開始より後の終了位置を、素材の長さの範囲で指定してください。';
    $('btnApplyRangeCut').textContent = selected ? 'カット範囲を変更' : 'この区間をカット';
    $('btnApplyRangeCut').disabled = $('btnKeepRange').disabled = !ok || updating;
    drawMap();
  }
  function selectRange(start,end,existing = null) {
    selected = existing;
    $('inpCutStart').value = seconds(Math.max(0,start));
    // 動画末尾の切り上げで、素材より長い指定にならないようにする。
    $('inpCutEnd').value = String(Math.min(clip().duration,Number(seconds(end))));
    syncSelection();
    video.pause();
    video.currentTime = Math.max(0,start-.3);
  }
  async function apply(keep) {
    if (updating || !valid()) return;
    video.pause();
    updating = true;
    syncSelection();
    try {
      const c = clip(), {start,end} = read();
      let next = edits();
      // 既存カットの境界を動かすときは旧範囲を戻してから、新しい範囲を切る。
      if (!keep && selected) next = setRangeEdit(next,{...selected,keep:true});
      next = setRangeEdit(next,{start:c.offset+start,end:c.offset+end,keep});
      await change(next,keep ? '指定した区間を戻しました。' : selected ? 'カット範囲を変更しました。' : '指定した区間をカットしました。');
      selected = null;
    } finally { updating = false; refresh(); }
  }
  function refresh() {
    if (!dialog.open || !clip()) return;
    const h = history();
    $('btnUndoRange').disabled = updating || !h.canUndo;
    $('btnRedoRange').disabled = updating || !h.canRedo;
    const list = $('cutRangeList');
    list.replaceChildren();
    const ranges = cutRanges(segments(),clip());
    if (!ranges.length) list.textContent = 'この素材にカットする区間はありません。';
    for (const r of ranges) {
      const row = document.createElement('div');
      row.className = 'cut-range-row';
      const label = document.createElement('span');
      label.className = 'mono';
      label.textContent = `${seconds(r.start-clip().offset)}〜${seconds(r.end-clip().offset)}秒`;
      const adjust = document.createElement('button'), restore = document.createElement('button');
      adjust.type = restore.type = 'button';
      adjust.className = restore.className = 'ghost small';
      adjust.textContent = '調整'; restore.textContent = 'このカットを戻す';
      adjust.disabled = restore.disabled = updating;
      adjust.onclick = () => selectRange(r.start-clip().offset,r.end-clip().offset,r);
      restore.onclick = () => { selectRange(r.start-clip().offset,r.end-clip().offset,r); return apply(true); };
      row.append(label,adjust,restore); list.append(row);
    }
    syncSelection();
  }
  function loadClip(at = 0) {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    video.pause();
    const c = clip();
    sourceUrl = URL.createObjectURL(c.file);
    video.src = sourceUrl;
    video.onloadedmetadata = () => { video.currentTime = Math.min(at,c.duration-.01); };
    for (const id of ['inpCutStart','inpCutEnd','sliderCutStart','sliderCutEnd']) $(id).max = c.duration;
    selectRange(at,Math.min(at+1,c.duration));
    refresh();
  }
  $('selCutClip').onchange = e => { clipIndex = Number(e.target.value); loadClip(); };
  for (const side of ['Start','End']) {
    $('inpCut'+side).oninput = syncSelection;
    $('inpCut'+side).onchange = e => {
      const t = Number(e.target.value);
      if (Number.isFinite(t) && t >= 0 && t <= clip().duration) { video.pause(); video.currentTime = t; }
    };
    $('sliderCut'+side).oninput = e => {
      $('inpCut'+side).value = e.target.value;
      syncSelection();
      video.pause(); video.currentTime = Number(e.target.value);
    };
    $('btnMarkCut'+side).onclick = () => { $('inpCut'+side).value = seconds(video.currentTime); syncSelection(); };
  }
  video.ontimeupdate = () => { $('cutSourceTime').textContent = `${seconds(video.currentTime)} / ${seconds(clip().duration)}秒`; };
  $('btnCutFrameBack').onclick = () => { video.pause(); video.currentTime = Math.max(0,video.currentTime-1/30); };
  $('btnCutFrameNext').onclick = () => { video.pause(); video.currentTime = Math.min(clip().duration,video.currentTime+1/30); };
  $('btnApplyRangeCut').onclick = () => apply(false);
  $('btnKeepRange').onclick = () => apply(true);
  $('btnNewRange').onclick = () => selectRange(video.currentTime,Math.min(clip().duration,video.currentTime+1));
  $('btnUndoRange').onclick = async () => { video.pause(); selected = null; await undo(); refresh(); };
  $('btnRedoRange').onclick = async () => { video.pause(); selected = null; await redo(); refresh(); };
  $('btnCloseCutEditor').onclick = () => dialog.close();
  dialog.onclose = () => {
    video.pause(); video.removeAttribute('src'); video.load();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  };
  return {
    refresh,
    open() {
      const src = currentSource();
      clipIndex = Math.max(0,clips().findIndex(c => src >= c.offset && src < c.offset+c.duration));
      $('selCutClip').replaceChildren(...clips().map((c,i) => Object.assign(document.createElement('option'),{value:i,textContent:`${i+1}：${c.file.name}`})));
      $('selCutClip').value = clipIndex;
      $('cutEditorStatus').textContent = '';
      dialog.showModal(); loadClip(Math.max(0,src-clip().offset));
    },
  };
}
