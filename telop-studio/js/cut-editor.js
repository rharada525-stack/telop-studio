import { cutRanges } from './range-edits.js';
import { clampTime, clockTime, draftRangeEdits, connectionPreview } from './cut-preview.js?v=20261022-timeline2';
import { createRangeTimeline } from './range-timeline.js?v=20261022-timeline2';

export function createCutEditor({ clips, segments, lines, edits, previewSegments, currentSource, change, undo, redo, history }) {
  const $ = id => document.getElementById(id);
  const dialog = $('cutEditorDialog'), video = $('cutSourceVideo');
  let clipIndex=0, selection=null, previous=null, sourceUrl=null, updating=false;
  let previewRun=0, preview=null, playingFrame=0, seekRun=0, internalPause=false;
  const clip = () => clips()[clipIndex];
  const valid = () => selection && selection.start>=0 && selection.end>selection.start && selection.end<=clip().duration+1e-8;
  const timeline = createRangeTimeline({clip,segments,lines,onSelect:selectRange,onSeek:t=>seekSource(t)});
  function stopPreview(message='') {
    previewRun++; preview=null; video.pause(); cancelAnimationFrame(playingFrame);
    if(message) $('cutPreviewStatus').textContent=message;
  }
  async function seekSource(t,stop=true) {
    if(stop) stopPreview();
    const run=++seekRun; t=clampTime(t,clip().duration);
    if(video.readyState<1) return;
    if(Math.abs(video.currentTime-t)>.0001) await new Promise(resolve=>{
      const done=()=>{video.removeEventListener('seeked',done);resolve();};
      video.addEventListener('seeked',done);video.currentTime=t;
    });
    if(run===seekRun) updatePosition();
  }
  function syncSelection() {
    const ok=!!valid();
    $('cutSelectionSummary').textContent=ok ? clockTime(selection.start)+' → '+clockTime(selection.end)+'　'+(selection.end-selection.start).toFixed(3)+'秒を選択' : '波形をドラッグして範囲を選択';
    $('btnApplyRangeCut').textContent=previous ? '削除範囲を変更' : '選択範囲を削除';
    for(const id of ['btnApplyRangeCut','btnKeepRange','btnPlaySelection','btnPreviewCut']) $(id).disabled=!ok || updating;
    $('btnNewRange').disabled=!selection || updating; timeline.updateSelection(ok ? selection : null);
  }
  function selectRange(range,opts={}) {
    if(updating) return;
    stopPreview('選択範囲を変更しました。まだ編集には反映していません。');
    if('existing' in opts) previous=opts.existing;
    selection=range ? {start:clampTime(range.start,clip().duration),end:clampTime(range.end,clip().duration)} : null;
    // 表示のために丸めた値を編集時刻に戻さず、保存済みの境界もそのまま使う。
    $('inpCutStart').value=selection ? String(selection.start) : '';
    $('inpCutEnd').value=selection ? String(selection.end) : ''; syncSelection();
    if(selection && opts.final) seekSource(opts.edge==='end' ? selection.end : selection.start);
  }
  function updatePosition() {
    if(!clip() || !dialog.open) return;
    $('cutSourceTime').textContent=clockTime(video.currentTime)+' / '+clockTime(clip().duration);
    timeline.setPlayhead(video.currentTime,!video.paused);
  }
  async function playRanges(ranges,label) {
    stopPreview();
    if(!ranges.length) { $('cutPreviewStatus').textContent='この範囲を削除すると、この素材に残る映像はありません。'; return; }
    const run=++previewRun, total=ranges.reduce((n,r)=>n+r.end-r.start,0);
    let index=0, elapsed=0; preview={ranges,label};
    const startPart=async()=>{
      internalPause=true;video.pause();await seekSource(ranges[index].start,false);
      if(run!==previewRun || !dialog.open) {internalPause=false;return false;}
      try {await video.play();} catch {if(run===previewRun)stopPreview('再生できませんでした。もう一度再生を押してください。');internalPause=false;return false;}
      internalPause=false;return run===previewRun;
    };
    const tick=async()=>{
      if(run!==previewRun || !dialog.open || !preview) return;
      const r=ranges[index];
      if(video.currentTime>=r.end-.005 || video.ended) {
        elapsed+=r.end-r.start;index++;
        if(index===ranges.length) {stopPreview(label+'：再生完了（編集は未確定）');await seekSource(r.end,false);return;}
        if(!await startPart())return;
      }
      if(run!==previewRun)return;
      const at=elapsed+Math.max(0,Math.min(video.currentTime-ranges[index].start,ranges[index].end-ranges[index].start));
      $('cutPreviewStatus').textContent=label+'：'+clockTime(at)+' / '+clockTime(total)+'（編集は未確定）';
      updatePosition();playingFrame=requestAnimationFrame(tick);
    };
    if(await startPart())playingFrame=requestAnimationFrame(tick);
  }
  async function apply(keep) {
    if(updating || !valid())return;
    stopPreview();updating=true;syncSelection();
    try {
      await change(draftRangeEdits(edits(),clip(),selection,previous,keep),keep ? '選択範囲を戻しました。' : previous ? '削除範囲を変更しました。' : '選択範囲を削除しました。');
      previous=null;$('cutPreviewStatus').textContent='編集に反映しました。「元に戻す」で取り消せます。';
    } finally {updating=false;refresh();}
  }
  function refresh() {
    if(!dialog.open || !clip())return;
    const h=history();$('btnUndoRange').disabled=updating || !h.canUndo;$('btnRedoRange').disabled=updating || !h.canRedo;
    const list=$('cutRangeList');list.replaceChildren();const ranges=cutRanges(segments(),clip());
    if(!ranges.length)list.textContent='この素材に削除する区間はありません。';
    for(const r of ranges) {
      const row=document.createElement('div');row.className='cut-range-row';
      const label=document.createElement('span');label.className='mono';label.textContent=clockTime(r.start-clip().offset)+'〜'+clockTime(r.end-clip().offset);
      const select=document.createElement('button');select.type='button';select.className='ghost small';select.textContent='範囲を選択';select.disabled=updating;
      select.onclick=()=>selectRange({start:r.start-clip().offset,end:r.end-clip().offset},{existing:r,final:true});
      row.append(label,select);list.append(row);
    }
    timeline.render();syncSelection();
  }
  function loadClip(at=0) {
    stopPreview();seekRun++;if(sourceUrl)URL.revokeObjectURL(sourceUrl);
    sourceUrl=URL.createObjectURL(clip().file);video.src=sourceUrl;video.onloadedmetadata=()=>seekSource(at);
    for(const id of ['inpCutStart','inpCutEnd'])$(id).max=clip().duration;
    selection=previous=null;timeline.reset();selectRange(null,{existing:null});refresh();
    $('cutPreviewStatus').textContent='波形をドラッグして、残すか削除する範囲を選んでください。';
  }
  $('selCutClip').onchange=e=>{clipIndex=Number(e.target.value);loadClip();};
  for(const side of ['Start','End']) {
    $('inpCut'+side).oninput=()=>{
      const a=$('inpCutStart').value,b=$('inpCutEnd').value;
      selection=a!=='' && b!=='' && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? {start:Number(a),end:Number(b)} : null;
      stopPreview();syncSelection();
    };
    $('inpCut'+side).onchange=e=>{if(e.target.value!=='')seekSource(Number(e.target.value));};
    $('btnMarkCut'+side).onclick=()=>selectRange({...selection || {start:video.currentTime,end:video.currentTime},[side.toLowerCase()]:video.currentTime});
  }
  video.ontimeupdate=updatePosition;
  const follow=()=>{if(!video.paused && dialog.open && !preview){updatePosition();playingFrame=requestAnimationFrame(follow);}};
  video.onplay=()=>{if(!preview)playingFrame=requestAnimationFrame(follow);};
  video.onpause=()=>{if(preview && !internalPause && !video.ended)stopPreview('再生を停止しました（編集は未確定）。');};
  $('btnCutFrameBack').onclick=()=>seekSource(video.currentTime-1/30);$('btnCutFrameNext').onclick=()=>seekSource(video.currentTime+1/30);
  $('btnStopCutPreview').onclick=()=>stopPreview('再生を停止しました（編集は未確定）。');
  $('btnPlaySelection').onclick=()=>{if(valid())playRanges([{...selection}],'選択範囲');};
  $('btnPreviewCut').onclick=()=>{if(valid())playRanges(connectionPreview(previewSegments(draftRangeEdits(edits(),clip(),selection,previous)),clip(),selection),'削除後のつながり');};
  $('btnApplyRangeCut').onclick=()=>apply(false);$('btnKeepRange').onclick=()=>apply(true);$('btnNewRange').onclick=()=>selectRange(null,{existing:null});
  $('btnUndoRange').onclick=async()=>{stopPreview();previous=null;await undo();refresh();};
  $('btnRedoRange').onclick=async()=>{stopPreview();previous=null;await redo();refresh();};
  $('btnCloseCutEditor').onclick=()=>dialog.close();
  dialog.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;if(e.key==='Delete' || e.key==='Backspace'){e.preventDefault();apply(false);}});
  dialog.onclose=()=>{stopPreview();seekRun++;video.removeAttribute('src');video.load();if(sourceUrl)URL.revokeObjectURL(sourceUrl);sourceUrl=null;};
  return {refresh,open(){
    const src=currentSource();clipIndex=Math.max(0,clips().findIndex(c=>src>=c.offset && src<c.offset+c.duration));
    $('selCutClip').replaceChildren(...clips().map((c,i)=>Object.assign(document.createElement('option'),{value:i,textContent:(i+1)+'：'+c.file.name})));
    $('selCutClip').value=clipIndex;$('cutEditorStatus').textContent='';dialog.showModal();loadClip(clampTime(src-clip().offset,clip().duration));
  }};
}
