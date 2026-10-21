import { pointerTime, frameTime, clockTime, resizeSelection } from './cut-preview.js?v=20261022-timeline2';
import { cutRanges } from './range-edits.js';

export function createRangeTimeline({ clip, segments, lines, onSelect, onSeek }) {
  const $ = id => document.getElementById(id);
  const root = $('cutTimeline'), scroll = $('cutTimelineScroll'), canvas = $('cutWaveform');
  let zoom = 1, width = 1, selection = null, drag = null, playhead = 0;
  const localCuts = () => cutRanges(segments(),clip());
  const timeAt = e => pointerTime(e.clientX-root.getBoundingClientRect().left,width,clip().duration);
  const rangeButton = (range, label, className, action) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = className;
    button.textContent = label; button.title = label;
    button.style.left = `${range.start/clip().duration*100}%`;
    button.style.width = `${(range.end-range.start)/clip().duration*100}%`;
    button.onclick = action; return button;
  };
  function updateSelection(range) {
    selection = range && range.end > range.start ? range : null;
    const overlay = $('cutTimelineSelection');
    overlay.hidden = !selection;
    if (!selection) return;
    overlay.style.left = `${selection.start/clip().duration*100}%`;
    overlay.style.width = `${(selection.end-selection.start)/clip().duration*100}%`;
    for (const side of ['Start','End']) {
      const el = $('cutHandle'+side), t = selection[side.toLowerCase()];
      el.setAttribute('aria-valuemin','0'); el.setAttribute('aria-valuemax',String(clip().duration));
      el.setAttribute('aria-valuenow',String(t)); el.setAttribute('aria-valuetext',clockTime(t));
    }
  }
  function setPlayhead(t, follow = false) {
    playhead = t; $('cutPlayhead').style.left = `${t/clip().duration*100}%`;
    if (follow) {
      const x = t/clip().duration*width;
      if (x < scroll.scrollLeft || x > scroll.scrollLeft+scroll.clientWidth-12) scroll.scrollLeft = Math.max(0,x-60);
    }
  }
  function render() {
    const c = clip(); if (!c) return;
    width = Math.min(24000,Math.max(1,scroll.clientWidth)*zoom);
    root.style.width = `${width}px`;
    canvas.width = Math.ceil(width); canvas.height = 164;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111820'; ctx.fillRect(0,0,width,164);
    ctx.fillStyle = '#183e35'; ctx.fillRect(0,28,width,76);
    const cuts = localCuts();
    ctx.fillStyle = '#512b34';
    for (const r of cuts) ctx.fillRect((r.start-c.offset)/c.duration*width,28,(r.end-r.start)/c.duration*width,136);
    const db = c.pk || c.db;
    if (db?.length) {
      ctx.fillStyle = '#72d5b0';
      for (let x=0;x<width;x++) {
        const a = Math.floor(x/width*c.duration/.02), b = Math.max(a+1,Math.ceil((x+1)/width*c.duration/.02));
        let peak = -80;
        for (let i=a;i<Math.min(db.length,b);i++) peak = Math.max(peak,db[i]);
        const h = Math.max(1,Math.min(33,(peak+65)/55*33)); ctx.fillRect(x,66-h,1,h*2);
      }
    }
    const pxSec = width/c.duration;
    const step = [.1,.25,.5,1,2,5,10,15,30,60,120,300,600,1800].find(s=>s*pxSec>=75) || 3600;
    ctx.font = '11px monospace'; ctx.textBaseline = 'top';
    for (let t=0;t<=c.duration;t+=step) {
      const x = t/c.duration*width;
      ctx.fillStyle = '#34424e'; ctx.fillRect(x,22,1,142);
      ctx.fillStyle = '#bbc8d7'; ctx.fillText(clockTime(t).replace(/\.000$/,''),x+4,5);
    }
    $('cutCaptionTrack').replaceChildren();
    for (const l of lines()) {
      const start = Math.max(0,l.src[0]-c.offset), end = Math.min(c.duration,l.src[1]-c.offset);
      if (end<=start) continue;
      const r = {start,end};
      $('cutCaptionTrack').append(rangeButton(r,l.text,'timeline-caption',()=>onSelect(r,{final:true,existing:null,edge:'start'})));
    }
    $('cutRemovalTrack').replaceChildren(...cuts.map(r => {
      const local = {start:r.start-c.offset,end:r.end-c.offset};
      return rangeButton(local,`削除 ${clockTime(local.start)}〜${clockTime(local.end)}`,'timeline-cut',()=>onSelect(local,{final:true,existing:r,edge:'start'}));
    }));
    updateSelection(selection); setPlayhead(playhead);
    $('timelineZoomLabel').textContent = `${Math.round(width/Math.max(1,scroll.clientWidth)*100)}%`;
    $('btnTimelineZoomOut').disabled = zoom<=1;
    $('btnTimelineZoomIn').disabled = width>=23999;
  }
  function setZoom(next) {
    const oldWidth = width, center = (scroll.scrollLeft+scroll.clientWidth/2)/oldWidth;
    zoom = Math.max(1,Math.min(64,next)); render();
    const focus = selection ? (selection.start+selection.end)/2/clip().duration : center;
    scroll.scrollLeft = Math.max(0,focus*width-scroll.clientWidth/2);
  }
  $('btnTimelineZoomIn').onclick = () => setZoom(zoom*2);
  $('btnTimelineZoomOut').onclick = () => setZoom(zoom/2);
  $('btnTimelineFit').onclick = () => { zoom=1; render(); scroll.scrollLeft=0; };
  root.onpointerdown = e => {
    if (e.button!==0 || e.target.closest('.timeline-caption,.timeline-cut')) return;
    const t = timeAt(e), y = e.clientY-root.getBoundingClientRect().top;
    const side = e.target.id==='cutHandleStart' ? 'start' : e.target.id==='cutHandleEnd' ? 'end' : null;
    drag = side && selection ? {side,original:{...selection}} : {side:y<28 ? 'seek' : 'new',anchor:t};
    root.setPointerCapture(e.pointerId); e.preventDefault();
    if (drag.side==='seek') onSeek(t);
    else if (drag.side==='new') onSelect({start:t,end:t},{existing:null});
  };
  root.onpointermove = e => {
    if (!drag) return;
    const t = timeAt(e);
    const rect = scroll.getBoundingClientRect();
    if (e.clientX>rect.right-16) scroll.scrollLeft+=20;
    if (e.clientX<rect.left+16) scroll.scrollLeft-=20;
    if (drag.side==='seek') return onSeek(t);
    if (drag.side==='new') onSelect({start:Math.min(drag.anchor,t),end:Math.max(drag.anchor,t)},{existing:null});
    else {
      const r = resizeSelection(drag.original,drag.side,t,clip().duration);
      onSelect(r,{edge:drag.side});
    }
  };
  const finish = e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    if (d.side==='new' && (!selection || selection.end-selection.start<1/60)) { onSelect(null,{existing:null}); onSeek(d.anchor); }
    else if (selection && d.side!=='seek') onSelect(selection,{final:true,edge:d.side==='new' ? 'start' : d.side});
  };
  root.onpointerup = finish; root.onpointercancel = finish;
  for (const side of ['start','end']) $('cutHandle'+(side==='start'?'Start':'End')).onkeydown = e => {
    if (!selection || !['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const t = frameTime(selection[side]+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?10:1)/30,clip().duration);
    const r = resizeSelection(selection,side,t,clip().duration);
    onSelect(r,{final:true,edge:side});
  };
  const observer = new ResizeObserver(()=>{ if (root.isConnected && scroll.clientWidth) render(); });
  observer.observe(scroll);
  return { render, updateSelection, setPlayhead, reset() { zoom=1; scroll.scrollLeft=0; selection=null; render(); } };
}
