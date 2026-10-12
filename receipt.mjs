// レシートのテキストを、Jev に渡す前に「コードでできるところまで」処理する。
//
// 方針は docs の pre-parsed value extraction パターンそのまま:
//
//   1. 正規表現で候補を **多めに** 拾う（取りこぼすより拾いすぎるほうがいい）
//   2. どれが正解かは Jev の Choice に選ばせる
//   3. 選ばれた候補を、コードがそのまま使う
//
// Choice は候補の外を返せないので、「2026年」を合計金額として
// でっち上げるようなことが起きない。検証コードを書かなくてよくなる。

/** 品目にならない行（レジ周りの定型文）。 */
const EXCLUDED_WORDS = [
  "小計", "合計", "お会計", "総額", "お預り", "お預かり", "お釣り", "おつり",
  "消費税", "税込", "税抜", "内税", "外税", "値引", "割引", "現金", "クレジット",
  "カード", "電子マネー", "ポイント", "点数", "登録番号", "責任者", "レジ",
  "TEL", "電話", "領収", "軽減税率", "対象",
  // 支払い手段の行。品目ではないのに「名前 + 金額」の形をしていて紛らわしい。
  "払い", "PayPay", "楽天ペイ", "au PAY", "Suica", "PASMO", "ICOCA",
  "iD", "QUICPay", "nanaco", "WAON", "交通系", "コード決済",
];

/** 住所っぽい行。 */
const ADDRESS_PATTERN = /(都|道|府|県|市|区|町|村)[^\s]*\d/;
/** 日付っぽい行。 */
const DATE_LINE_PATTERN = /\d{2,4}\s*[年\/.\-]\s*\d{1,2}\s*[月\/.\-]\s*\d{1,2}/;
/** 時刻っぽい行。 */
const TIME_LINE_PATTERN = /\d{1,2}\s*[:：]\s*\d{2}/;

/**
 * 品名 + 金額に分解する。
 *
 * 金額はレシートの右端にあるので、**行末の数値だけ** を切り出す。
 * 行全体から数字を消すと「食パン 6枚切」が「食パン枚切」になってしまう。
 */
export function parseItems(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !EXCLUDED_WORDS.some((word) => line.includes(word)))
    .filter((line) => !ADDRESS_PATTERN.test(line))
    .filter((line) => !DATE_LINE_PATTERN.test(line))
    .filter((line) => !TIME_LINE_PATTERN.test(line))
    .map((line) => {
      const match = line.match(/^(.*?)[¥￥]?\s*([0-9][0-9,]*)\s*円?\s*$/);
      if (!match) return null;

      const amount = Number(match[2].replace(/,/g, ""));
      if (!(amount > 0 && amount <= 9_999_999)) return null;

      const name = match[1].replace(/[×xX*]\s*\d*\s*$/, "").trim();
      // 金額だけの行は品目にしない
      if ([...name].filter((c) => /\p{L}/u.test(c)).length < 2) return null;

      return { name, amount, line };
    })
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * 金額の候補を「多めに」拾う。合計がどれかは決めない。決めるのは Jev。
 * 値そのものをキーにして重複を潰し、どの行に出てきたかを添える。
 */
export function amountCandidates(text) {
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    for (const match of trimmed.matchAll(/[¥￥]?\s*([0-9][0-9,]{0,9})\s*円?/g)) {
      const raw = match[1];
      const value = Number(raw.replace(/,/g, ""));
      if (!(value > 0 && value <= 9_999_999)) continue;
      // 電話番号や日付の一部は候補から外す
      if (/\d{2,4}[-ー]\d{2,4}[-ー]\d{3,4}/.test(trimmed)) continue;
      if (DATE_LINE_PATTERN.test(trimmed) || TIME_LINE_PATTERN.test(trimmed)) continue;

      const key = String(value);
      if (!found.has(key)) found.set(key, { value, lines: [] });
      if (!found.get(key).lines.includes(trimmed)) found.get(key).lines.push(trimmed);
    }
  }
  return [...found.values()].sort((a, b) => b.value - a.value).slice(0, 40);
}

/** 日付の候補を拾う。表記ゆれを許して多めに取る。 */
export function dateCandidates(text) {
  const patterns = [
    /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /\d{4}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{1,2}/g,
    /\d{2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{1,2}/g,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
  ];
  const found = new Map();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const span = match[0].replace(/\s+/g, "");
      if (!found.has(span)) found.set(span, span);
    }
  }
  return [...found.keys()].slice(0, 10);
}

/** 店名の候補。レシートの上のほうの行に出る。これも多めに拾う。 */
export function storeNameCandidates(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .filter((line) => !ADDRESS_PATTERN.test(line))
    .filter((line) => [...line].some((c) => /\p{L}/u.test(c)))
    .slice(0, 6);
}

/**
 * 品目と購入履歴を、まずコードで粗く突き合わせる。
 *
 * ここで全組み合わせを Jev に投げると N×M 問になる。
 * 文字種を正規化した類似度で候補を1つに絞り、
 * 「本当に同じ商品か」の判断だけを Noul に任せる。
 */
export function matchHistory(items, history) {
  return items.map((item) => {
    const scored = history
      .map((entry) => ({ entry, score: similarity(normalize(item.name), normalize(entry.name)) }))
      .sort((a, b) => b.score - a.score)[0];
    // 似ても似つかないものは Jev に聞くまでもない
    return scored && scored.score >= 0.3 ? scored.entry : null;
  });
}

/** 2つの品名がどのくらい近いか（0〜1）。表記ゆれを潰してから比べる。 */
export const nameCloseness = (a, b) => similarity(normalize(a), normalize(b));

/** カタカナ・ひらがな・大小・記号のゆれを潰す。 */
function normalize(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・,.\-ー()（）]/g, "");
}

/** 2-gram の Dice 係数。短い語のために1文字一致も見る。 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const grams = (value) =>
    value.length < 2 ? [value] : [...value].slice(0, -1).map((c, i) => c + value[i + 1]);
  const left = grams(a);
  const right = new Set(grams(b));
  const hits = left.filter((gram) => right.has(gram)).length;
  return (2 * hits) / (left.length + right.size);
}
