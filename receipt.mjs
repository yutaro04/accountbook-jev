// レシートのテキストを、Jev に渡す前に「コードでできるところまで」処理する。
//
// 方針は docs の pre-parsed value extraction パターンそのまま:
//
//   1. 正規表現で候補を **多めに** 拾う（取りこぼすより拾いすぎるほうがいい）
//   2. どれが正解かは Jev の Choice に選ばせる
//   3. 選ばれた候補を、コードがそのまま使う
//
// ここで大事なのは **コードと Jev の分担**。
//
//   コード … 「この数字はそもそも金額の形をしているか」（文字の形の話）
//   Jev   … 「この行は買った品物か、小計か、伝票番号か」（意味の話）
//
// 以前は「小計・合計・レジ・カード…」という除外語のリストを手で持っていた。
// それをやめた。`レジ袋` が `レジ` に引っかかって品目から消えるし、
// 逆に `金額 ¥1,919` や `伝票番号 261-003-199-6180` は
// リストに無いので品目として通ってしまう。
// **意味で決めるべきことを文字列一致で書くと、こうなる。**

/** 住所っぽい行。 */
const ADDRESS_PATTERN = /(都|道|府|県|市|区|町|村)[^\s]*\d/;
/** 日付っぽい行。 */
const DATE_LINE_PATTERN = /\d{2,4}\s*[年\/.\-]\s*\d{1,2}\s*[月\/.\-]\s*\d{1,2}/;
/** 時刻っぽい行。 */
const TIME_LINE_PATTERN = /\d{1,2}\s*[:：]\s*\d{2}/;
/** 「261-003-199-6180」のようなハイフン区切りの識別子。金額ではない。 */
const IDENTIFIER_PATTERN = /\d+\s*[-ー−―]\s*\d+\s*[-ー−―]\s*\d+/;
/** 「*************＊**7660」のようなマスクされた番号。 */
const MASKED_PATTERN = /[*＊]{4,}/;

/**
 * 行末に金額がありそうな行を、**意味で判断せずに**全部集める。
 *
 * 金額はレシートの右端にあるので、行末の数値だけを切り出す。
 * 行全体から数字を消すと「食パン 6枚切」が「食パン枚切」になってしまう。
 *
 * ここで落とすのは「そもそも金額の形をしていない」行だけ。
 * 品物かどうかの判断はしない。それは Jev の仕事。
 */
export function candidateLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (ADDRESS_PATTERN.test(line)) return null;
      if (DATE_LINE_PATTERN.test(line)) return null;
      if (TIME_LINE_PATTERN.test(line)) return null;
      if (IDENTIFIER_PATTERN.test(line)) return null;
      if (MASKED_PATTERN.test(line)) return null;

      const match = line.match(/^(.*?)[¥￥]?\s*([0-9][0-9,]*)\s*円?\s*$/);
      if (!match) return null;

      const amount = Number(match[2].replace(/,/g, ""));
      if (!(amount > 0 && amount <= 9_999_999)) return null;

      // 「牛乳 ×2」「りんご *」のような末尾の記号と個数を落とす
      const name = match[1].replace(/[×xX*＊]\s*\d*\s*$/, "").trim();
      // 名前が無い（金額だけの行）は候補にしない
      if ([...name].filter((c) => /\p{L}/u.test(c)).length < 2) return null;

      return { name, amount, line };
    })
    .filter(Boolean)
    .slice(0, 40);
}

/**
 * 金額の候補を「多めに」拾う。合計がどれかは決めない。決めるのは Jev。
 * 値そのものをキーにして重複を潰し、どの行に出てきたかを添える。
 */
export function amountCandidates(text) {
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (DATE_LINE_PATTERN.test(trimmed) || TIME_LINE_PATTERN.test(trimmed)) continue;
    if (IDENTIFIER_PATTERN.test(trimmed) || MASKED_PATTERN.test(trimmed)) continue;

    for (const match of trimmed.matchAll(/[¥￥]?\s*([0-9][0-9,]{0,9})\s*円?/g)) {
      const value = Number(match[1].replace(/,/g, ""));
      if (!(value > 0 && value <= 9_999_999)) continue;

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
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[0].replace(/\s+/g, ""));
  }
  return [...found].slice(0, 10);
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
