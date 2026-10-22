import test from 'node:test';
import assert from 'node:assert/strict';
import { setRangeEdit, clearRangeEdits, cutRanges, linesForOutput } from '../telop-studio/js/range-edits.js';
import { buildSegments, totalDuration, outToSrc, buildItems, toSrt } from '../telop-studio/js/timeline.js';
import { createEditHistory, resetSubtitles } from '../telop-studio/js/edit-history.js';
import { createProjectStore, validateProject } from '../telop-studio/js/project-store.js';

const clips = [{offset:0,duration:10}];
const speech = [{start:1,end:4,clip:0},{start:6,end:9,clip:0}];
const ranges = segs => segs.map(s=>[s.start,s.end,s.clip,s.out]);
const line = {id:'a',src:[1,4],text:'残す字幕',cut:false};

test('発話と字幕の途中でも、指定した時刻だけを切り取り、音声・映像の出力時刻を詰める', () => {
  const segs = buildSegments(speech,[line],[{start:2.25,end:3.5,keep:false}],clips);
  assert.deepEqual(ranges(segs),[[1,2.25,0,0],[3.5,4,0,1.25],[6,9,0,1.75]]);
  assert.equal(totalDuration(segs),4.75);
  assert.equal(outToSrc(segs,1.25).src,3.5);
  const items = buildItems([line],segs,{});
  assert.deepEqual(items.map(i=>[i.t,i.d]),[[0,1.25],[1.25,.5]]);
  assert.match(toSrt([line],segs),/00:00:01,250 --> 00:00:01,750/);
});

test('自動カットの開始・終了を縮めると、前後の映像が戻る', () => {
  let edits = setRangeEdit([],{start:4,end:6,keep:true});
  edits = setRangeEdit(edits,{start:4.5,end:5.5,keep:false});
  const segs = buildSegments(speech,[],edits,clips);
  assert.deepEqual(ranges(segs),[[1,4.5,0,0],[5.5,9,0,3.5]]);
  assert.deepEqual(cutRanges(segs,clips[0]),[{start:0,end:1},{start:4.5,end:5.5},{start:9,end:10}]);
});

test('手動カットを部分的に戻し、さらに切り直した場合は最後の指定を優先する', () => {
  let edits = setRangeEdit([],{start:2,end:8,keep:false});
  edits = setRangeEdit(edits,{start:3,end:7,keep:true});
  edits = setRangeEdit(edits,{start:4,end:5,keep:false});
  const segs = buildSegments([{start:0,end:10,clip:0}],[],edits,clips);
  assert.deepEqual(ranges(segs),[[0,2,0,0],[3,4,0,2],[5,7,0,3],[8,10,0,5]]);
  assert.deepEqual(clearRangeEdits(edits,3.5,5.5),[
    {start:2,end:3,keep:false},{start:3,end:3.5,keep:true},{start:5.5,end:7,keep:true},{start:7,end:8,keep:false},
  ]);
});

test('字幕単位で切った部分も映像と字幕を一緒に戻し、ほかのカットは戻さない', () => {
  const lines = [{...line,cut:true},{id:'b',src:[6,9],text:'カットのまま',cut:true}];
  const edits = [{start:2,end:3,keep:true}];
  const segs = buildSegments(speech,lines,edits,clips);
  const output = linesForOutput(lines,edits);
  assert.deepEqual(ranges(segs),[[2,3,0,0]]);
  assert.equal(lines[0].cut,true);
  assert.equal(output[1].cut,true);
  assert.equal(buildItems(output,segs,{}).length,1);
  assert.match(toSrt(output,segs),/残す字幕/);
  assert.doesNotMatch(toSrt(output,segs),/カットのまま/);
});

test('全カットからも復元でき、複数素材の境界や丸め用の隙間を越えて復元しない', () => {
  const multi = [{offset:0,duration:1.01},{offset:1.02,duration:2}];
  const allCut = buildSegments([] ,[],[{start:0,end:4,keep:false}],multi);
  assert.deepEqual(allCut,[]);
  const restored = buildSegments([],[],[{start:0,end:99,keep:true}],multi);
  assert.deepEqual(ranges(restored),[[0,1.01,0,0],[1.02,3.02,1,1.01]]);
  assert.deepEqual(cutRanges(restored,multi[1]),[]);
});

test('10msの細かいカットを勝手に拡大せず、前後の短い映像も残す', () => {
  const segs = buildSegments([{start:0,end:1,clip:0}],[],[{start:.01,end:.02,keep:false}],clips);
  assert.equal(segs[0].end,.01);
  assert.equal(segs[1].start,.02);
  assert.equal(totalDuration(segs),.99);
});

test('区間編集はプロジェクト保存・JSON・複製・Undo/Redoで保持し、字幕初期化でも残す', () => {
  const storage = new Map();
  const store = createProjectStore({getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)});
  const original = {version:2,files:[{name:'test.mp4',size:10}],settings:{speakers:[],audio:{}},lines:[line],rangeEdits:[]};
  const group = store.open('test',original);
  const h = createEditHistory(); h.reset(original);
  const edited = {...original,rangeEdits:[{start:2,end:3,keep:false}]};
  h.commit(edited);
  const saved = store.save('test',group.activeId,JSON.parse(JSON.stringify(edited)));
  const copy = store.create('test',saved.project);
  assert.deepEqual(copy.project.rangeEdits,edited.rangeEdits);
  assert.deepEqual(h.undo().rangeEdits,[]);
  assert.deepEqual(h.redo().rangeEdits,edited.rangeEdits);
  assert.deepEqual(resetSubtitles(edited,{}).rangeEdits,edited.rangeEdits);
  assert.deepEqual(store.select('test',group.activeId).project.rangeEdits,edited.rangeEdits);
});

test('古いプロジェクトを読み込め、不正な区間は保存前に拒否する', () => {
  const p = {files:[{name:'a',size:1}],settings:{},lines:[]};
  assert.doesNotThrow(()=>validateProject(p));
  for (const range of [{start:-1,end:2,keep:true},{start:2,end:1,keep:true},{start:1,end:2,keep:'yes'},null]) {
    assert.throws(()=>validateProject({...p,rangeEdits:[range]}));
  }
  assert.throws(()=>setRangeEdit([],{start:1,end:1,keep:true}));
});
