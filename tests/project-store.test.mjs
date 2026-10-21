import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectStore, sameFiles, validateProject } from '../telop-studio/js/project-store.js';
import { MODEL_CACHE, modelCacheEntries, deleteModelCache } from '../telop-studio/js/model-cache.js';

function fixture() {
  const values = new Map();
  let seq = 0;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { values, storage, store: createProjectStore(storage, { id: () => `id${++seq}`, now: () => '2026-10-21T00:00:00Z' }) };
}
const project = text => ({ version: 2, files: [{ name: 'video.mp4', size: 123 }], settings: { title: text },
  lines: text ? [{ id: 'a', text, src: [0, 2] }] : [] });

test('従来の自動保存を引き継ぎ、旧データを上書きせずに新規作業を作る', () => {
  const { values, store } = fixture();
  const legacy = JSON.stringify(project('前の編集'));
  values.set('video-key', legacy);
  const group = store.open('video-key', project(''));
  assert.equal(group.entries[0].name, 'セーブデータ1');
  assert.equal(group.entries[0].project.lines[0].text, '前の編集');
  const fresh = store.create('video-key', project(''));
  assert.equal(fresh.name, 'セーブデータ2');
  assert.deepEqual(fresh.project.lines, []);
  assert.equal(store.select('video-key', group.activeId).project.lines[0].text, '前の編集');
  assert.equal(values.get('video-key'), legacy);
});

test('同じ動画の複製・名前変更・再読込・JSON由来の保存が互いに上書きしない', () => {
  const { store, storage } = fixture();
  const first = store.open('video', project('元の字幕')).entries[0];
  const copy = store.create('video', first.project);
  store.save('video', copy.id, project('別の字幕'), 'ショート版');
  const imported = store.create('video', project('JSONから開いた字幕'));
  const reopened = createProjectStore(storage).open('video', project('空の初期値'));
  assert.equal(reopened.entries.length, 3);
  assert.equal(reopened.activeId, imported.id);
  assert.equal(store.select('video', first.id).project.lines[0].text, '元の字幕');
  assert.equal(store.select('video', copy.id).name, 'ショート版');
  assert.equal(store.select('video', copy.id).project.lines[0].text, '別の字幕');
});

test('別動画のセーブを分離し、素材の順番・サイズが違うJSONは一致としない', () => {
  const { store } = fixture();
  store.open('a', project('動画A'));
  store.open('b', project('動画B'));
  store.create('b', project('動画Bの別編集'));
  assert.equal(store.read('a').entries.length, 1);
  const a = project('').files[0], b = { name: 'other.mp4', size: 456 };
  assert.equal(sameFiles([a, b], [b, a]), false);
  assert.equal(sameFiles([a], [{ ...a, size: 124 }]), false);
  assert.equal(sameFiles([a], [a]), true);
});

test('容量不足で保存に失敗しても、前回の保存と現在の選択を維持する', () => {
  const { store, storage } = fixture();
  const before = store.open('video', project('保存済み'));
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => store.save('video', before.activeId, project('まだ未保存')), /Quota/);
  assert.throws(() => store.create('video', project('')), /Quota/);
  assert.deepEqual(store.read('video'), before);
});

test('破損した保存・JSONを受け入れず、残っているデータを書き換えない', () => {
  const { values, store } = fixture();
  values.set('telop-studio:saves:v1:video', '{broken');
  assert.throws(() => store.open('video', project('初期値')));
  assert.equal(values.get('telop-studio:saves:v1:video'), '{broken');
  assert.throws(() => validateProject({ ...project('字幕'), lines: [{ text: '不正', src: [3, 1] }] }));
});

test('モデル削除はこのツールのモデルだけを対象とし、他モデル・他キャッシュ・セーブを残す', async () => {
  const own = 'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/encoder_model_fp16.onnx';
  const old = 'https://huggingface.co/onnx-community/whisper-small/resolve/main/config.json';
  const foreign = 'https://huggingface.co/other/model/resolve/main/model.onnx';
  const spoof = 'https://example.com/onnx-community/whisper-base/resolve/main/config.json';
  const requests = [own, old, foreign, spoof].map(url => ({ url }));
  const remaining = new Set(requests);
  const opened = [];
  const cacheStorage = {
    keys: async () => [MODEL_CACHE, 'other-tool-cache'],
    open: async name => {
      opened.push(name);
      return { keys: async () => [...remaining], delete: async request => remaining.delete(request) };
    },
  };
  const { store } = fixture();
  const saves = store.open('video', project('編集中の字幕'));
  assert.equal((await modelCacheEntries(cacheStorage)).length, 2);
  assert.equal(await deleteModelCache(cacheStorage), 2);
  assert.deepEqual([...remaining].map(r => r.url), [foreign, spoof]);
  assert.ok(opened.every(name => name === MODEL_CACHE));
  assert.deepEqual(store.read('video'), saves);
});

test('モデル未保存のブラウザでは空キャッシュを作らず、削除0件になる', async () => {
  const cacheStorage = { keys: async () => [], open: () => assert.fail('空キャッシュを作らない') };
  assert.equal(await deleteModelCache(cacheStorage), 0);
});
