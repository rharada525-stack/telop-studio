import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerTime, frameTime, clockTime, resizeSelection, draftRangeEdits, connectionPreview } from '../telop-studio/js/cut-preview.js';
import { buildSegments } from '../telop-studio/js/timeline.js';

const clip = {offset:0,duration:20};
const speech = [{start:0,end:7,clip:0},{start:9,end:20,clip:0}];
test('拡大したタイムラインでも相対位置から元動画の時刻を求め、30fpsの境界へ揃える',()=>{
  assert.equal(pointerTime(150,1000,20),3);
  assert.equal(pointerTime(600,4000,20),3);
  assert.equal(pointerTime(-10,1000,20),0);
  assert.equal(pointerTime(1100,1000,20),20);
  assert.equal(frameTime(.65,20),20/30);
});
test('表示上のミリ秒の繰り上がりを正しく扱う',()=>{
  assert.equal(clockTime(59.9999),'1:00.000');
  assert.equal(clockTime(60.001),'1:00.001');
  assert.equal(clockTime(.0001),'0:00.000');
});
test('選択の端を逆側より先へ動かしても反転せず、短い素材の端からもはみ出さない',()=>{
  assert.deepEqual(resizeSelection({start:1,end:2},'start',3,20),{start:2-1/30,end:2});
  assert.deepEqual(resizeSelection({start:0,end:.02},'start',.01,.02),{start:0,end:.02});
  assert.deepEqual(resizeSelection({start:0,end:.02},'end',0,.02),{start:0,end:.02});
});
test('試聴用の編集を作っても保存前のデータを変更せず、数値を表示桁で丸めない',()=>{
  const saved=[{start:2,end:3,keep:false}], before=structuredClone(saved);
  const selection={start:4.1234567,end:5.7654321};
  const draft=draftRangeEdits(saved,clip,selection);
  assert.deepEqual(saved,before);
  assert.deepEqual(draft.at(-1),{...selection,keep:false});
});
test('削除後の試聴は選択範囲と既存カットを飛ばし、残る映像の前後2秒をつなぐ',()=>{
  const selection={start:4,end:6};
  const segs=buildSegments(speech,[],draftRangeEdits([],clip,selection),[clip]);
  assert.deepEqual(connectionPreview(segs,clip,selection),[
    {start:2,end:4},{start:6,end:7},{start:9,end:10},
  ]);
});
test('既存カットの端を動かした試聴でも、確定後と同じ復元区間を使う',()=>{
  const selection={start:4.5,end:5.5}, previous={start:4,end:6};
  const draft=draftRangeEdits([],clip,selection,previous);
  const segs=buildSegments([{start:0,end:4,clip:0},{start:6,end:20,clip:0}],[],draft,[clip]);
  assert.deepEqual(connectionPreview(segs,clip,selection),[{start:2.5,end:4.5},{start:5.5,end:7.5}]);
});
test('試聴の元動画時刻は素材内の時刻で返し、別素材の映像を混ぜない',()=>{
  const c={offset:10,duration:5}, selection={start:1,end:2};
  const segs=[{start:0,end:10,clip:0},{start:10,end:11,clip:1},{start:12,end:15,clip:1},{start:15,end:20,clip:2}];
  assert.deepEqual(connectionPreview(segs,c,selection),[{start:0,end:1},{start:2,end:4}]);
});
test('先頭・末尾の削除は残る側だけを試聴し、全削除は空の試聴にする',()=>{
  assert.deepEqual(connectionPreview([{start:2,end:20}],clip,{start:0,end:2}),[{start:2,end:4}]);
  assert.deepEqual(connectionPreview([{start:0,end:18}],clip,{start:18,end:20}),[{start:16,end:18}]);
  assert.deepEqual(connectionPreview([],clip,{start:0,end:20}),[]);
});
