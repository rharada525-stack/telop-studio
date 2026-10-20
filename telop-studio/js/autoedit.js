// おまかせ編集：字幕の言葉から、演出テロップ・画面効果・強調・カットを自動で付ける。
// キーワードのルールで判断する（AIで意味を理解しているわけではない）。手で設定した行は変えない。
// 「ショート向け」はテンポ重視で派手に、「長尺向け」は落ち着いて見やすく。

const FILLER = /^(え[ーっ〜]*と?|えー+と?|あ[のー〜]+|う[ーん〜]+|ん[ーっ〜]+|ま[ぁあー〜]+|そ[のー〜]+|なんか)[、。…]*$/;
const ENUM = /^(まず|最初に?は?|次に?は?|続いて|そして|最後に?は?)?[、,\s]*(一つ目|ひとつ目|1つ目|１つ目|二つ目|ふたつ目|2つ目|２つ目|三つ目|みっつ目|3つ目|３つ目|四つ目|4つ目|５つ目|五つ目|5つ目|その[0-9０-９一二三四五]|ポイント[0-9０-９一二三四五]?)(は|が|目は|目)?[、,\s]*/;
const TOPIC = /^(では|さて|ところで|続いて|次は|次に|それでは|ここからは|話は変わって|今日のテーマは)[、,\s]*/;
const SUMMARY = /^(まとめると|まとめ|要するに|結局|というわけで|ということで)[、,\s]*/;
const REVEAL = /^(そして|では|さあ|じゃあ|で)?[、,\s]*(答えは|正解は|結論は?|つまり|結果は|なんと|実は答え)/;
const REACTION = /^(えっ|え[ー〜]+|え[、,!?！？]|ええ|まじ|マジ|本当|ほんと|なるほど|すご|やば|ヤバ|うそ|嘘|へぇ|へー|確かに|たしかに|おお|わぁ|わあ)/;
const SURPRISE = /^(えっ|え[ー〜]+|え[、,!?！？]|ええ|まじ|マジ|うそ|嘘|本当|ほんと)/;
const LAUGH = /(笑|ははは|あはは|わはは|ふふ|www|ｗｗ)/;
const QUESTION = /(ですか|でしょうか|ますか|かな|んですか|知ってますか|わかりますか)[?？]?$|[?？]$/;
const EXCLAIM = /[!！]$/;
const STRONG = /(実は|絶対|必ず|一番|最強|裏ワザ|裏技|コツ|秘密|簡単|無料|驚き|衝撃|ポイント|大事|重要)/;
const NEGATIVE = /(失敗|最悪|ダメ|だめ|残念|損|後悔|危険|NG|やめた方|最低|ショック|悲しい|つらい)/;
const CTA = /(フォロー|保存|チャンネル登録|高評価|コメント|試してみて|ぜひ|また(次|ね|会い)|ご視聴)/;
const NUMBER = /([0-9０-９]+(?:\.[0-9]+)?|[一二三四五六七八九十百千万]+)(割|%|％|分|秒|時間|日|円|万円|倍|回|個|人|年|ヶ月|か月|キロ|kg|cm|位|歳|度|杯|本|枚|品|件|歩|kcal|カロリー|グラム|g)/g;
// 見出し「その1」のあとに続く「次に／最後に」は、その2・その3 として扱う
const NEXT_ITEM = /^(次に?は?|続いて|それから|最後に?は?|ラストは)[、,\s]*/;

export const MODES = { short: "ショート向け", long: "長尺向け" };
export const STRENGTH = { low: "控えめ", mid: "標準", high: "派手" };

// 向き × 強さ ごとのルール。gap は「この行数以上あけてから次の演出」
const PROFILES = {
  short: {
    low: { hook: false, react: true, zoomGap: 6, numberFx: false, question: false, exclaim: false, negative: "none", lines: false, topic: false, laughFx: true, shake: false },
    mid: { hook: true, react: true, zoomGap: 3, numberFx: true, question: true, exclaim: true, negative: "mono_dark", lines: false, topic: false, laughFx: true, shake: true },
    high: { hook: true, react: true, zoomGap: 2, numberFx: true, question: true, exclaim: true, negative: "mono_dark", lines: true, topic: false, laughFx: true, shake: true },
  },
  long: {
    low: { hook: false, react: false, zoomGap: Infinity, numberFx: false, question: false, exclaim: false, negative: "none", lines: false, topic: true, laughFx: true, shake: false },
    mid: { hook: false, react: true, zoomGap: 8, numberFx: false, question: false, exclaim: false, negative: "dark", lines: false, topic: true, laughFx: true, shake: false },
    high: { hook: true, react: true, zoomGap: 5, numberFx: false, question: false, exclaim: true, negative: "dark", lines: false, topic: true, laughFx: true, shake: true },
  },
};

const plain = (t) => t.replace(/[{}\n]/g, "");
const untouched = (l) => !l.cut && !l.fx && (!l.screen || l.screen === "auto");
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// 字幕の大事な言葉を { } で強調色にする（表示のときに使う。元の文字は変えない）
// 数字＋単位、強い言葉、「」の中。自分で { } を付けた行はそのまま
const HIGHLIGHT_WORDS = /(実は|絶対|必ず|一番|最強|最高|最悪|裏ワザ|裏技|コツ|秘密|簡単|無料|ポイント|大事|重要|注意|限定|必見|本当に|めちゃくちゃ|超|激|神|驚き|衝撃|正解|不正解|NG|OK|初めて|唯一|全部|完全)/g;
export function highlight(text) {
  if (/[{}]/.test(text)) return text;
  return text
    .replace(/「([^」]{1,12})」/g, "「{$1}」")
    .replace(NUMBER, (m) => `{${m}}`)
    .replace(HIGHLIGHT_WORDS, (m) => `{${m}}`)
    .replace(/\{([^{}]*)\{([^{}]*)\}([^{}]*)\}/g, "{$1$2$3}") // 入れ子になったら1つにまとめる
    .replace(/\}\{/g, "");
}

const kanjiNum = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, ひと: 1, ふた: 2, みっ: 3 };
function enumNumber(head, fallback) {
  const d = head.match(/[0-9０-９]/)?.[0];
  if (d) return "０１２３４５６７８９".includes(d) ? "０１２３４５６７８９".indexOf(d) : Number(d);
  const k = Object.keys(kanjiNum).find((x) => head.includes(x));
  return k ? kanjiNum[k] : fallback;
}

// lines を書き換えて、付けた内容の件数を返す
export function autoEdit(lines, { mode = "short", strength = "mid", speakers = [] } = {}) {
  const P = (PROFILES[mode] || PROFILES.short)[strength] || PROFILES.short.mid;
  const n = { cut: 0, hook: 0, point: 0, topic: 0, summary: 0, react: 0, laugh: 0, reveal: 0, cta: 0, zoom: 0, dark: 0, accent: 0, keyword: 0 };
  let pointNo = 0, topicNo = 0;
  let lastFx = -10;   // 演出を付けた行番号（詰め込みすぎないように間をあける）
  let lastZoom = -10; // ズーム系だけは別に間隔を見る

  // 1) つなぎ言葉だけの行はカット
  for (const l of lines) {
    if (!l.cut && !l.fx && FILLER.test(plain(l.text).trim())) { l.cut = true; n.cut++; }
  }
  const L = lines.filter((l) => !l.cut);
  const spIndex = (l) => Math.max(0, speakers.findIndex((s) => s.id === l.speaker));

  // 2) 冒頭のつかみ
  if (P.hook && L[0] && untouched(L[0]) && plain(L[0].text).length <= 24) {
    Object.assign(L[0], { fx: "hook", fxText: "", screen: mode === "short" ? "zoom_lines" : "zoom" });
    n.hook++;
    lastFx = lastZoom = 0;
  }

  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const t = plain(l.text).trim();
    const next = L[i + 1];
    const set = (fx, fxText, screen, key) => { Object.assign(l, { fx, fxText }); if (screen) l.screen = screen; n[key]++; lastFx = i; };

    // 3) 見出し「その1／その2」
    const m = t.match(ENUM);
    if (m && m[2] && !l.fx) {
      pointNo = enumNumber(m[2], pointNo + 1);
      let body = t.slice(m[0].length).replace(/[、。,]$/, "");
      if (body.length < 3 && next) body = plain(next.text).trim(); // 「まず1つ目」だけなら次の行を本文に
      set("point", `その${pointNo}/${cut(body, 16)}`, null, "point");
      continue;
    }

    if (!untouched(l)) continue;

    // 3b) 「その1」のあとの「次に〜／最後に〜」
    const ni = t.match(NEXT_ITEM);
    if (pointNo > 0 && ni) {
      let body = t.slice(ni[0].length).replace(/[、。,]$/, "");
      if (body.length < 3 && next) body = plain(next.text).trim();
      if (body.length >= 2) {
        pointNo++;
        set("point", `その${pointNo}/${cut(body, 16)}`, null, "point");
        continue;
      }
    }

    // 4) 話題の切り替え（長尺）→ 左上に話題の見出し
    const tm = t.match(TOPIC);
    if (P.topic && tm) {
      const body = t.slice(tm[0].length).replace(/[、。,]$/, "") || (next ? plain(next.text).trim() : "");
      if (body.length >= 3) {
        topicNo++;
        set("point", `話題${topicNo}/${cut(body, 16)}`, null, "topic");
        continue;
      }
    }

    // 5) まとめ
    const sm = t.match(SUMMARY);
    if (sm) {
      if (mode === "long") {
        const body = t.slice(sm[0].length).replace(/[、。,]$/, "") || (next ? plain(next.text).trim() : "");
        set("point", `まとめ/${cut(body || "ここまでのポイント", 16)}`, null, "summary");
        continue;
      }
      // ショートは、まとめの中身をオチとして大きく見せる（中身が短すぎるときは次の行）
      const body = t.slice(sm[0].length).replace(/[、。,]$/, "");
      if (body.length >= 3) {
        set("reveal", cut(body, 14), "flash", "reveal");
        lastZoom = i;
        continue;
      }
      if (next && untouched(next)) {
        Object.assign(next, { fx: "reveal", fxText: "", screen: "flash" });
        n.reveal++;
        lastFx = lastZoom = i + 1;
        continue;
      }
    }

    // 6) 答え・結論の前ふり → 次の行をオチにする
    if (REVEAL.test(t) && next && untouched(next)) {
      Object.assign(next, { fx: "reveal", fxText: "", screen: mode === "short" ? "flash" : "zoom" });
      n.reveal++;
      lastFx = lastZoom = i + 1;
      continue;
    }

    // 7) 笑い → 小さく「（笑）」
    if (P.laughFx && LAUGH.test(t) && i - lastFx >= 1) {
      set(spIndex(l) % 2 ? "tsukkomi" : "tsukkomi_green", "（笑）", "none", "laugh");
      continue;
    }

    // 8) 短いリアクション → ツッコミ（話者ごとに色を変える）
    if (P.react && t.length <= 10 && REACTION.test(t) && i - lastFx >= 1) {
      set(spIndex(l) % 2 ? "tsukkomi_green" : "tsukkomi", "", P.shake && SURPRISE.test(t) ? "shake" : "none", "react");
      continue;
    }

    // 9) 締めの呼びかけ（最後の3行）
    if (i >= L.length - 3 && CTA.test(t)) {
      set("cta_main", "", null, "cta");
      continue;
    }

    // 10) 強調色は「字幕の大事な言葉を自動で強調色にする」スイッチで表示時に付けるので、ここでは文字を変えない
    const canZoom = i - lastZoom >= P.zoomGap && i - lastFx >= 1;
    const zoom = (scr = "zoom") => { l.screen = scr; n.zoom++; lastZoom = lastFx = i; };

    // 11) 数字 → キーワードテロップ（ショート）。いくつかあるときは文の後ろのほう（「1日3杯」なら「3杯」）
    const num = t.match(NUMBER);
    if (P.numberFx && num && i - lastFx >= 2) {
      set("keyword", `{${num[num.length - 1]}}！`, canZoom ? "zoom" : null, "keyword");
      if (canZoom) lastZoom = i;
      continue;
    }

    // 12) 強い言葉・問いかけ・驚き → ズーム
    if (canZoom && (STRONG.test(t) || (P.question && QUESTION.test(t)) || (P.exclaim && EXCLAIM.test(t)))) {
      zoom(P.lines && STRONG.test(t) ? "zoom_lines" : "zoom");
      continue;
    }

    // 13) ネガティブな言葉 → 暗く
    if (P.negative !== "none" && NEGATIVE.test(t) && i - lastFx >= 2) {
      l.screen = P.negative;
      n.dark++;
      lastFx = i;
    }
  }
  return n;
}

// 結果の説明文
export function describe(n) {
  const parts = [
    [n.hook, "つかみ"], [n.point, "見出し"], [n.topic, "話題の見出し"], [n.summary, "まとめ"], [n.react, "ツッコミ"],
    [n.laugh, "（笑）"], [n.reveal, "オチ"], [n.keyword, "キーワード"], [n.cta, "締め"], [n.zoom, "ズーム"],
    [n.dark, "暗転"], [n.cut, "つなぎ言葉のカット"],
  ].filter(([c]) => c).map(([c, s]) => `${s}${c}`);
  return parts.length ? parts.join("・") : "付けられる演出が見つかりませんでした";
}
