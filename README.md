# 編集ツール

| フォルダ | 中身 |
|---|---|
| [`telop-studio/`](telop-studio/) | **ショート動画用ブラウザツール**。自動カット・文字起こし・テロップ・MP4 書き出しまでブラウザだけで完結。GitHub Pages で公開している |
| [`short-template/`](short-template/) | Python 版。台本（JSON）からテロップ素材と Premiere 用 XML を書き出す |
| [`test-footage/`](test-footage/) | 動作確認用の仮素材（音声合成）とその作成スクリプト |
| [`admin/effects-lab/`](admin/effects-lab/) | ローカル専用の演出ラボ。演出の再生・比較・試作保存（公開対象外） |

## 更新のしかた

`telop-studio/` を直して `main` に push すると、1〜2分で公開ページに反映されます
（`.github/workflows/pages.yml`）。
