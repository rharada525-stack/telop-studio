import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, alignWordTimes, buildLinesFromWords, buildItems, toSrt } from '../telop-studio/js/timeline.js';

const line = (id, start, end, extra = {}) => ({ id, src: [start, end], text: id, ...extra });
const levels = (duration, spans) => {
  const rms = new Float32Array(Math.round(duration / .02)).fill(-70);
  const peak = new Float32Array(rms.length).fill(-60);
  for (const [s,e] of spans) for (let i=Math.round(s/.02);i<Math.round(e/.02);i++) { rms[i]=-20;peak[i]=-10; }
  return {rms,peak};
};
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);

test('同時刻の日本語トークンを結合し、仮の0.3秒で次の単語に重ねない', () => {
  const words = normalizeWords([
    {text:'テ',timestamp:[1,1.1]}, {text:'ィ',timestamp:[1.1,1.1]},
    {text:'を',timestamp:[1.1,1.2]}, {text:'整える',timestamp:[1.2,1.6]},
    {text:'無効',timestamp:[3,4]},
  ],2);
  assert.deepEqual(words,[[1,1.1,'テ'],[1.1,1.2,'ィを'],[1.2,1.6,'整える']]);
  assert.deepEqual(normalizeWords([{text:'次',timestamp:[.5,null]},{text:'へ',timestamp:[.8,1]}],2),[[.5,.8,'次'],[.8,1,'へ']]);
});

test('長い無音を含む単語の時刻を音声へ寄せ、別の音の区間まで引き延ばさない', () => {
  const audio = levels(5,[[.5,1],[3,3.4],[3.8,4.4]]);
  const words = alignWordTimes([[.5,1,'説明'],[1.1,4,'最後'],[4,4.4,'三つ目']],audio);
  close(words[1][0],2.97);
  close(words[1][1],3.46);
  close(words[2][0],3.77);
  assert.equal(words.map(w=>w[2]).join(''),'説明最後三つ目');
});

test('音量で検出できない小さな声の時刻と文章は残す', () => {
  const input = [[1,1.6,'小さな声です']];
  assert.deepEqual(alignWordTimes(input,levels(3,[])),input);
});

test('短い返事も長い間やカットをまたいで同じ字幕にしない', () => {
  assert.deepEqual(buildLinesFromWords([[0,.1,'はい'],[1,1.2,'では']]).map(l=>l.text),['はい','では']);
  assert.deepEqual(buildLinesFromWords([[0,.1,'はい'],[.3,.4,'では']], [{start:0,end:.15},{start:.25,end:.5}]).map(l=>l.text),['はい','では']);
});

test('音の間があってもカタカナ語をノ／イズのように分けない', () => {
  const words = [[0,.4,'これは音量のバランスとかそもそもの'],[.4,.6,'ノ'],[1.1,1.3,'イ'],[1.3,1.4,'ズ'],[1.4,1.7,'です。']];
  const result = buildLinesFromWords(words);
  assert.ok(!result.some(l=>l.text.endsWith('ノ') || l.text.startsWith('イズ')));
  assert.equal(result.map(l=>l.text).join(''),'これは音量のバランスとかそもそものノイズです');
  assert.ok(!result.some(l=>l.text.endsWith('そも') || l.text.startsWith('そもの')));
});

test('カット境界で字幕を切り替え、前の字幕を次の区間まで残さない', () => {
  const segs = [{start:1,end:2,out:0},{start:4,end:5,out:1}];
  const lines = [line('前',1.1,1.85),line('次',4.1,4.8)];
  const items = buildItems(lines,segs,{});
  assert.deepEqual(items.map(it=>[it.text,it.t,it.d]),[['前',0,1],['次',1,1]]);
  assert.equal(toSrt(lines,segs),'1\n00:00:00,000 --> 00:00:01,000\n前\n\n2\n00:00:01,000 --> 00:00:02,000\n次\n');
});

test('同じ区間内の字幕を無言まで延ばさず、短い次の字幕に重ねない', () => {
  const items = buildItems([line('はい',0,.1),line('では',.15,.25),line('説明',.7,1)], [{start:0,end:2,out:0}],{});
  assert.equal(items.length,3);
  close(items[0].d,.1);
  close(items[1].t,.15);
  close(items[1].d,.1);
  close(items[2].t,.7);
  close(items[2].d,.3);
});

test('50msより短い字幕もSRTと描画の両方に残す', () => {
  const lines=[line('はい',.5,.53)];
  const segs=[{start:0,end:2,out:0}];
  close(buildItems(lines,segs,{})[0].d,.03);
  assert.match(toSrt(lines,segs),/00:00:00,500 --> 00:00:00,530/);
});

test('完全にカットされた字幕を次の区間へ移さず、またぐ字幕は残した部分だけに表示する', () => {
  const segs = [{start:0,end:1,out:0},{start:3,end:4,out:1}];
  const items = buildItems([line('カット内',1.2,2.7),line('またぐ',.5,3.5)],segs,{});
  assert.deepEqual(items.map(it=>[it.text,it.t,it.d]),[['またぐ',.5,.5],['またぐ',1,.5]]);
});

test('字幕を締め・オチ・見出しに置き換えても、次の発言へ最低表示時間をはみ出させない', () => {
  for (const fx of ['cta_main','reveal','point']) {
    const items = buildItems([line('短い演出',.5,.65,{fx,screen:'flash'}),line('次の発言',.8,1.2)], [{start:0,end:2,out:0}],{});
    const effect=items.find(it=>it.line==='短い演出');
    close(effect.d,.15);
    assert.ok(items.filter(it=>!it.line).every(it=>it.t+it.d<=.65+1e-8));
  }
});
