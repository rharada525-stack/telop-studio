import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalFontStore, fontWeight } from '../telop-studio/js/local-fonts.js';

const fonts = [
  { family: 'テスト明朝', style: 'Regular', postscriptName: 'TestMincho-Regular' },
  { family: 'テスト明朝', style: 'Bold', postscriptName: 'TestMincho-Bold' },
  { family: 'テスト明朝', style: 'Black Italic', postscriptName: 'TestMincho-BlackItalic' },
  { family: 'テスト角ゴシック', style: 'Heavy', postscriptName: 'TestGothic-Heavy' },
];

test('PCフォントを家族名でまとめ、再読み込みしても重複を増やさない', async () => {
  const store = createLocalFontStore({ query: async () => fonts, register: async () => {} });
  const expected = ['テスト明朝', 'テスト角ゴシック'].sort((a, b) => a.localeCompare(b, 'ja'));
  assert.deepEqual(await store.read(), expected);
  assert.deepEqual(await store.read(), expected);
  assert.equal(store.premiereName('テスト明朝', 900), 'TestMincho-Bold');
  assert.equal(store.premiereName('未登録', 700), '');
});

test('選んだPCフォントの実データを読み込み、複数の太さを同じ描画名で登録する', async () => {
  const calls = [];
  const store = createLocalFontStore({ query: async () => fonts, register: async (...args) => { calls.push(args); } });
  await store.read();
  await Promise.all([store.load('テスト明朝', 400), store.load('テスト明朝', 700), store.load('テスト明朝', 700)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], calls[1][0]);
  assert.equal(store.cssFamily('テスト明朝'), calls[0][0]);
  assert.deepEqual(calls.map(c => c[1].postscriptName), ['TestMincho-Regular', 'TestMincho-Bold']);
  assert.deepEqual(calls.map(c => c[2]), [400, 700]);
  assert.equal(fonts[0].family, 'テスト明朝'); // 保存する実名を書き換えない
});

test('未許可・読み込み失敗を成功扱いせず、失敗後も再試行できる', async () => {
  let fail = true;
  const store = createLocalFontStore({ query: async () => fonts, register: async () => { if (fail) throw new Error('font failed'); } });
  await store.load('テスト明朝', 700);
  assert.equal(store.cssFamily('テスト明朝'), 'テスト明朝');
  await store.read();
  await assert.rejects(store.load('テスト明朝', 700));
  assert.equal(store.cssFamily('テスト明朝'), 'テスト明朝');
  fail = false; await store.load('テスト明朝', 700);
  assert.notEqual(store.cssFamily('テスト明朝'), 'テスト明朝');
  const blocked = createLocalFontStore({ query: async () => { throw new Error('denied'); } });
  await assert.rejects(blocked.read());
  assert.deepEqual(blocked.families(), []);
});

test('英語と国内フォントで使う太さ表記を区別する', () => {
  for (const [style, expected] of [['Bold', 700], ['ExtraBold', 800], ['SemiBold', 600], ['Black', 900], ['Medium', 500], ['EB', 800], ['R', 400], ['B', 700]]) assert.equal(fontWeight({ style }), expected);
});
