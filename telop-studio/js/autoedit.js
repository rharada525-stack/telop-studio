// おまかせ編集：字幕の言葉から、演出テロップ・画面効果・強調・カットを自動で付ける。
// キーワードのルールで判断する（AIで意味を理解しているわけではない）。手で設定した行は変えない。

const FILLER = /^(え[ーっ〜]*と?|えー+と?|あ[のー〜]+|う[ーん〜]+|ん[ーっ〜]+|ま[ぁあー〜]+|そ[のー〜]+|なんか)[、。…]*$/;
const ENUM = /^(まず|最初に?は?|次に?は?|続いて|そして|最後に?は?)?[、,\s]*(一つ目|ひとつ目|1つ目|１つ目|二つ目|ふたつ目|2つ目|２つ目|三つ目|みっつ目|3つ目|３つ目|四つ目|4つ目|５つ目|五つ目|5つ目|その[0-9０-９一二三四五]|ポイント[0-9０-９一二三四五]?)(は|が|目は|目)?[、,\s]*/;
const REACTION = /^(えっ|え[ー〜]+|え[、,!?！？]|ええ|まじ|マジ|本当|ほんと|なるほど|すご|やば|ヤバ|うそ|嘘|へぇ|へー|確かに|たしかに|おお|わぁ|わあ)/;
const SURPRISE = /^(えっ|え[ー〜]+|え[、,!?！？]|ええ|まじ|マジ|うそ|嘘|本当|ほんと)/;
const REVEAL = /^(そして|では|さあ|じゃあ|で)?[、,\s]*(答えは|正解は|結論は?|つまり|結果は|なんと|実は答え)/;
const STRONG = /(実は|絶対|必ず|一番|最強|裏ワザ|裏技|コツ|秘密|簡単|無料|驚き|衝撃|ポイント)/;
const NEGATIVE = /(失敗|最悪|ダメ|だめ|残念|損|後悔|危険|NG|やめた方|最低|ショック)/;
const CTA = /(フォロー|保存|チャンネル登録|高評価|コメント|試してみて|ぜひ|また(次|ね|会い))/;
const NUMBER = /([0-9０-９]+(?:\.[0-9]+)?|[一二三四五六七八九十百千万]+)(割|%|％|分|秒|時間|日|円|万円|倍|回|個|人|年|ヶ月|か月|キロ|kg|cm|位|歳|度)/g;
const ACCENT_WORDS = /(実は|絶対|必ず|一番|最強|裏ワザ|裏技|コツ|秘密|簡単|無料|ポイント)/g;

export const STRENGTH = {
  low: { name: "控えめ", hook: false, react: false, zoomGap: Infinity, mono: false, keywordFx: false, lines: false },
  mid: { name: "標準", hook: true, react: true, zoomGap: 3, mono: true, keywordFx: false, lines: false },
  high: { name: "派手", hook: true, react: true, zoomGap: 2, mono: true, keywordFx: true, lines: true },
};

const plain = (t) => t.replace(/[{}\n]/g, "");
const untouched = (l) => !l.cut && !l.fx && (!l.screen || l.screen === "auto");

// { } で強調（数字＋単位、強い言葉）。すでに { } がある行はそのまま
function accent(text) {
  if (/[{}]/.test(text)) return text;
  return text.replace(NUMBER, "{$&}").replace(ACCENT_WORDS, "{$&}").replace(/\}\{/g, "");
}

const kanjiNum = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, ひと: 1, ふた: 2, みっ: 3 };

// lines を書き換えて、付けた内容の件数を返す
export function autoEdit(lines, { strength = "mid", speakers = [] } = {}) {
  const S = STRENGTH[strength] || STRENGTH.mid;
  const n = { cut: 0, hook: 0, point: 0, react: 0, reveal: 0, cta: 0, zoom: 0, mono: 0, accent: 0, keyword: 0 };
  const live = () => lines.filter((l) => !l.cut);
  let pointNo = 0;
  let lastFx = -10; // 演出を付けた行番号（詰め込みすぎないように間をあける）

  // 1) つなぎ言葉だけの行はカット
  for (const l of lines) {
    if (!l.cut && !l.fx && FILLER.test(plain(l.text).trim())) { l.cut = true; n.cut++; }
  }
  const L = live();

  // 2) 冒頭のつかみ
  if (S.hook && L[0] && untouched(L[0]) && plain(L[0].text).length <= 24) {
    L[0].fx = "hook";
    L[0].fxText = "";
    L[0].screen = "zoom_lines";
    n.hook++;
    lastFx = 0;
  }

  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const t = plain(l.text).trim();
    const next = L[i + 1];

    // 3) 見出し「その1／その2」
    const m = t.match(ENUM);
    if (m && m[2] && !l.fx) {
      const head = m[2];
      const num = Number((head.match(/[0-9０-９]/)?.[0] || "").replace(/[０-９]/, (c) => "０１２３４５６７８９".indexOf(c))) ||
        kanjiNum[Object.keys(kanjiNum).find((k) => head.startsWith(k) || head.includes(k))] || pointNo + 1;
      pointNo = num;
      let body = t.slice(m[0].length).replace(/[、。,]$/, "");
      // 「まず1つ目」だけの行なら、次の行を見出しの本文にする
      if (body.length < 3 && next) body = plain(next.text).trim();
      body = body.length > 16 ? body.slice(0, 15) + "…" : body;
      l.fx = "point";
      l.fxText = `その${num}/${body}`;
      n.point++;
      lastFx = i;
      continue;
    }

    if (!untouched(l)) continue;

    // 4) 答え・結論の前ふり → 次の行をオチにする
    if (REVEAL.test(t) && next && untouched(next) && i - lastFx >= 1) {
      next.fx = "reveal";
      next.fxText = "";
      next.screen = "flash";
      n.reveal++;
      lastFx = i + 1;
      continue;
    }

    // 5) 短いリアクション → ツッコミ（話者ごとに色を変える）
    if (S.react && t.length <= 10 && REACTION.test(t) && i - lastFx >= 1) {
      const spIdx = Math.max(0, speakers.findIndex((s) => s.id === l.speaker));
      l.fx = spIdx % 2 ? "tsukkomi_green" : "tsukkomi";
      l.fxText = "";
      l.screen = SURPRISE.test(t) ? "shake" : "none";
      n.react++;
      lastFx = i;
      continue;
    }

    // 6) 締めの呼びかけ（最後の3行）
    if (i >= L.length - 3 && CTA.test(t)) {
      l.fx = "cta_main";
      l.fxText = "";
      n.cta++;
      lastFx = i;
      continue;
    }

    // 7) 強調：数字や強い言葉に色、ズーム、派手ならキーワードテロップ
    const before = l.text;
    l.text = accent(l.text);
    if (l.text !== before) n.accent++;
    if (S.keywordFx && i - lastFx >= 3) {
      const num = t.match(NUMBER);
      if (num) {
        l.fx = "keyword";
        l.fxText = `{${num[0]}}！`;
        l.screen = "zoom";
        n.keyword++;
        lastFx = i;
        continue;
      }
    }
    if (STRONG.test(t) && i - lastFx >= S.zoomGap) {
      l.screen = S.lines ? "zoom_lines" : "zoom";
      n.zoom++;
      lastFx = i;
      continue;
    }

    // 8) ネガティブな言葉 → モノクロ＋暗く
    if (S.mono && NEGATIVE.test(t) && i - lastFx >= 2) {
      l.screen = "mono_dark";
      n.mono++;
      lastFx = i;
    }
  }
  return n;
}

// 結果の説明文
export function describe(n) {
  const parts = [
    [n.hook, "つかみ"], [n.point, "見出し"], [n.react, "ツッコミ"], [n.reveal, "オチ"], [n.keyword, "キーワード"],
    [n.cta, "締め"], [n.zoom, "ズーム"], [n.mono, "暗転"], [n.accent, "強調色"], [n.cut, "つなぎ言葉のカット"],
  ].filter(([c]) => c).map(([c, s]) => `${s}${c}`);
  return parts.length ? parts.join("・") : "付けられる演出が見つかりませんでした";
}
