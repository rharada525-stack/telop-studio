# ショート動画テロップ テンプレート

台本（`script.json`）とデザイン（`styles.json`）を書き換えて `build.py` を実行すると、
Premiere Pro にそのまま読み込めるタイムラインと素材一式が作られます。

## Premiere Pro での開き方

1. `python build.py` を実行する（約3分）
2. Premiere Pro で **ファイル → 読み込み → `output/ShortTemplate.xml`** を選ぶ
3. 1080×1920 / 30fps のシーケンスが作られ、各トラックに素材が並ぶ

| トラック | 中身 |
|---|---|
| V1 | 背景の静止画（シーンごとにゆっくりズームするキーフレーム付き） |
| V2 | 集中線 |
| V3 | 字幕（本人のセリフ） |
| V4 | 「その1」などの見出しカード |
| V5〜 | 煽り・キーワード・オチ・CTA など大きいテロップ |
| 上のほう | ツッコミ、番組タイトル帯、白フラッシュ |
| A1〜A2 | 効果音（テロップと同時に鳴るよう配置済み） |

シーケンスマーカーにシーン名（#1 フック など）を入れてあります。

## テンプレとしての使い方

- **文字だけ差し替える** → `script.json` の `text` を書き換えて `python build.py`
  - `{ }` で囲んだ部分は強調色になる（例: `"実はひと工夫で\n{もっと美味しくなる}んです"`）
  - `\n` で改行。はみ出しそうな長い文は自動で縮小
- **背景を実写に差し替える** → `assets/bg/bg_cafe.png`（または .jpg）のように、
  シーンの `bg` 名と同じファイル名で置く。縦長に自動でトリミングされる
- **見た目を変える** → `styles.json`（フォント、塗り、フチ、座布団、アニメ、効果音）
- **確認だけしたい** → `python build.py --preview-only` で `output/preview.mp4` だけを作る

### 使えるスタイル

| style | 用途 | 演出 | 効果音 |
|---|---|---|---|
| `hook` | 冒頭の煽り | 手前から叩きつけて着地で揺れる | ドン |
| `keyword` | 強調ワード | 1文字ずつポップ → 脈打つ | キラーン |
| `subtitle` | 字幕 | 1文字ずつタイプ表示 | なし |
| `tsukkomi` / `tsukkomi_green` | ツッコミ | ビヨンと弾んで傾いたままフワフワ | えっ↑ / ピコン |
| `point` | 「その1」見出し | ラベルがポップ → 帯がワイプ → 文字がタイプ | シュッ |
| `header` | 番組タイトル帯 | 上から落ちてバウンド | ポン |
| `reveal` | オチ・答え | 叩きつけ + 金色のグロー | ジャン！ |
| `cta_main` / `cta` | 締め | 1文字ずつ落下 / ポップ | ポン / ピコン |
| `speedlines` / `speedlines_white` | 集中線 | 2フレームごとにチラつく | なし |
| `flash` | 白フラッシュ | 一瞬白く光って消える | なし |

項目ごとに `"sfx": "drumroll"` のように効果音を上書きでき、`"sfx": null` で無音にできます。
`"pos": [x, y]` で位置も上書きできます。

効果音: `don` `pop` `whoosh` `kira` `pikon` `question` `jan` `drumroll`
（すべてコードで合成しているので著作権フリー）

## ファイル構成

```
script.json          台本・タイミング（ここだけ触ればOK）
styles.json          テロップのデザイン定義
build.py             一式を書き出す
engine/telop.py      テロップ描画エンジン（多重フチ・グラデ・座布団・アニメ）
engine/sfx.py        効果音シンセ
engine/bg.py         仮背景の生成
engine/premiere_xml.py  Premiere 用 XML の書き出し
output/
  ShortTemplate.xml  ← Premiere で読み込む
  preview.mp4        完成イメージ（効果音入り）
  telops/*.mov       テロップ（透過付き ProRes 4444）
  sfx/*.wav          効果音
  bg/*.png           背景
```

## 注意

- テロップは透過付きの動画として書き出しているため、Premiere 上で直接文字を打ち替えることはできない。
  文字を直すときは `script.json` を直して再ビルドする
- XML には素材の絶対パスが入っている。フォルダを移動したら `python build.py` をもう一度実行する
- 必要なもの: Python 3.10 以上、`pip install numpy pillow imageio-ffmpeg`、
  フォント（Noto Sans JP Black、源暎ぬゴシック EB）

## 今後（ブラウザツール化）

`script.json` + `styles.json` という「データ → 編集結果」の形にしてあるので、そのまま次の段階に進める。

1. 素材（写真・音声）を投げる → 音声認識で字幕とタイミングを作り、`script.json` を自動生成する
2. 同じ描画エンジンをブラウザ上（Canvas）で動かしてプレビューと書き出しを行う
3. Premiere で仕上げたい人向けに、今回と同じ XML と素材一式も書き出す
