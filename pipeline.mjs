// レシート1枚を家計簿の1件に変えるまでのパイプライン。
//
// 5ステージ・API 呼び出し5回。question は品目数に応じて増えるが、
// **ステージごとの往復は常に1回**。Jev は questions を並列・独立に評価するので、
// 品目が 3 個でも 20 個でもステージの所要時間はほとんど変わらない。
//
//   stage 1  レシートを読む        Choice x4 + Noul x3   ← 正規表現の候補から選ばせる
//   stage 2  費目を決める（大）     Choice x N            ← fan-out
//   stage 3  費目を決める（小）     Choice x N'           ← 階層の2段目。criteria が品目ごとに違う
//   stage 4  品目の性質を見る       Score x N + Noul x 2N ← 型混在
//   stage 5  家計簿として評価する   Score x3 + Noul x2    ← state をオブジェクトで渡す
//
// 「LLM の出力を信じないためのコード」は、このファイルに1行も無い。
// 候補の外は返ってこないし、分からないときは確信度が下がるだけなので。

import {
  majorCriteria,
  minorCriteria,
  NECESSITY_LEVELS,
  RECEIPT_RUBRICS,
  STORE_GENRES,
  PAYMENT_METHODS,
  PURCHASE_HISTORY,
} from "./taxonomy.mjs";
import {
  parseItems,
  amountCandidates,
  dateCandidates,
  storeNameCandidates,
  matchHistory,
  nameCloseness,
} from "./receipt.mjs";
import { ask, Choice, Score, Noul, noulConfidence, band, MOCK } from "./jev.mjs";

/** 「分からない」を選択肢として設計しておく。Choice は候補の外を返せないので。 */
const UNKNOWN = "不明";

/**
 * モックが業態を当てるための店名キーワード。**モック専用**。
 * 本物は state（レシート全文）を読んで判断するので、この表は使わない。
 */
const GENRE_KEYWORDS = [
  [/薬局|ドラッグ|薬品|ファーマ/, "ドラッグストア"],
  [/珈琲|コーヒー|喫茶|カフェ/, "カフェ・喫茶店"],
  [/電機|電器|家電|カメラ/, "家電量販店"],
  [/書店|ブックス|文具/, "書店・雑貨店"],
  [/食堂|レストラン|亭|屋$/m, "飲食店・レストラン"],
  [/コンビニ|ローソン|セブン|ファミリーマート/, "コンビニ"],
  [/スーパー|マルエツ|マート|ストア/, "スーパー"],
];

/** 今月の家計の状況。実アプリでは DB から引く。stage 5 の state に混ぜる。 */
const MONTHLY = { 予算: 80000, 今月の支出: 61400, 残り日数: 19 };

/**
 * ステージを1つずつ yield する。サーバーはこれをそのまま画面へ流す。
 * 途中経過が見えるので、LT で「いま何問投げたか」を指差せる。
 */
export async function* runPipeline(text) {
  const items = parseItems(text);
  const amounts = amountCandidates(text);
  const dates = dateCandidates(text);
  const stores = storeNameCandidates(text);

  yield {
    type: "parsed",
    items,
    candidates: { 金額: amounts.map((a) => a.value), 日付: dates, 店名: stores },
    mock: MOCK,
  };

  if (items.length === 0) {
    yield { type: "done", note: "品目を検出できませんでした", summary: null };
    return;
  }

  // ---- stage 1 ------------------------------------------------------------
  // 正規表現は「取りこぼすより拾いすぎる」側に振ってある。
  // どれが合計でどれが店名かは決めない。決めるのは Choice。
  // 候補の外は返ってこないので、値の妥当性チェックが要らない。

  // 候補が1つも無いものは question を作らない。
  // 選択肢が「不明」だけの Choice は決定ではないし、
  // 確信度の式 (p_max - 1/n) / (1 - 1/n) が n=1 で壊れる。
  const extraction = {};

  if (stores.length > 0) {
    extraction.店名 = Choice(
      {
        field: { name: "店名", type: "string", description: "レシートを発行した店の名前" },
        question: "候補の行のうち、`field` にあたるのはどれですか。",
      },
      {
        ...Object.fromEntries(stores.map((line) => [line, { 行: line }])),
        [UNKNOWN]: "どの行も店名ではない",
      }
    );
  }

  if (amounts.length > 0) {
    extraction.合計金額 = Choice(
      {
        field: {
          name: "合計金額",
          type: "integer",
          unit: "円",
          description: "この買い物で実際に支払った総額。小計・消費税・お預り・お釣りではない。",
        },
        question: "候補の数値のうち、`field` にあたるのはどれですか。",
      },
      {
        ...Object.fromEntries(
          amounts.map((a) => [String(a.value), { 金額: `${a.value}円`, 出てきた行: a.lines }])
        ),
        [UNKNOWN]: "合計金額にあたる数値が無い",
      }
    );
  }

  if (dates.length > 0) {
    extraction.購入日 = Choice(
      {
        field: { name: "購入日", type: "date", description: "この買い物をした日付" },
        question: "候補のうち、`field` にあたるのはどれですか。",
      },
      {
        ...Object.fromEntries(dates.map((d) => [d, { 表記: d }])),
        [UNKNOWN]: "日付が読み取れない",
      }
    );
  }

  const stage1 = await ask(
    text,
    {
      ...extraction,
      店ジャンル: Choice("この店はどんな業態の店ですか。", STORE_GENRES),
      支払い方法: Choice("どの方法で支払っていますか。", PAYMENT_METHODS),

      // Noul は「はい/いいえ」の確率。criteria で境界を書いておくと安定する。
      レシートである: Noul("これは店が発行したレシートですか。", {
        true: { what: "店名・品目・金額・小計・合計が並んだ購買の記録", examples: ["スーパーのレシート", "飲食店の領収書"] },
        false: { what: "買い物の記録ではないもの", examples: ["買い物メモ", "献立リスト", "広告", "メール"] },
      }),
      値引きがある: Noul("この買い物に、値引き・割引・ポイント利用がありますか。", {
        true: "値引・割引・クーポン・ポイント利用の記載がある",
        false: "定価での購入のみ",
      }),
      経費にできそう: Noul("この買い物は、仕事の経費として申告できそうな内容ですか。", {
        true: { what: "業務で使う物品やサービス", examples: ["文具", "書籍", "移動費", "打合せの飲食"] },
        false: { what: "私的な生活のための買い物", examples: ["食材", "日用品", "嗜好品"] },
      }),
    },
    {
      label: "レシートを読む",
      // モック用のヒント。request には入らない。
      // 「合計の行に書いてある数値が合計」のような素朴な規則は、
      // 本番では店ごとの書式の違いですぐ破綻する。だから Jev に選ばせている。
      // ここではモックを動かすためだけに使う。
      mockHints: {
        // 業態の手がかりは店名にある。レシート全文で引くと、
        // 品目の「コーヒー豆」を見てスーパーを喫茶店だと言い出す。
        店ジャンル: GENRE_KEYWORDS.find(([pattern]) => pattern.test(stores[0] ?? ""))?.[1],
        店名: stores.find((line) => !/TEL|電話|\d{2,4}[-ー]\d{2,4}/.test(line)),
        合計金額: String(
          amounts.find((a) => a.lines.some((line) => /合計|お会計|総額/.test(line) && !/小計/.test(line)))
            ?.value ?? ""
        ),
        購入日: dates[0],
      },
    }
  );

  const receipt = {
    店名: pickValue(stage1.answers.店名),
    ジャンル: stage1.answers.店ジャンル?.choice ?? null,
    合計: toAmount(pickValue(stage1.answers.合計金額)),
    購入日: pickValue(stage1.answers.購入日),
    支払い方法: stage1.answers.支払い方法?.choice ?? null,
    レシートらしさ: stage1.answers.レシートである?.noul ?? 0,
    値引きあり: (stage1.answers.値引きがある?.noul ?? 0) > 0.5,
    経費らしさ: stage1.answers.経費にできそう?.noul ?? 0,
  };

  yield stageEvent(1, "レシートを読む", `Choice x${Object.keys(extraction).length + 2} + Noul x3`, stage1, {
    読み取り: receipt,
    // 合計の整合チェックは Jev ではなくコードの仕事。
    // Jev が選んだ値と、品目の積み上げを突き合わせる。
    検算: verifyTotal(receipt.合計, items),
    判定: fieldBands(stage1),
  });

  // ---- stage 2 ------------------------------------------------------------
  // ここから fan-out。品目 N 個 → question N 個 → API 1回。
  //
  // state は全 question で共通なので、stage 1 で分かった店のジャンルを
  // 一緒に渡せる。ドラッグストアの「牛乳」とスーパーの「牛乳」で
  // 判断を変えられるのは、この state の共有があるから。

  const sharedState = {
    レシート全文: text,
    店: { 名前: receipt.店名, ジャンル: receipt.ジャンル },
  };

  const stage2 = await ask(
    sharedState,
    Object.fromEntries(
      items.map((item, index) => [
        `item_${index}`,
        Choice(
          {
            品目: { 名前: item.name, 金額: `${item.amount}円`, レシートの行: item.line },
            質問: "この品目は、家計簿のどの費目にあたりますか。",
          },
          // criteria はユーザーの費目設定から実行時に組み立てている。
          // 固定の enum ではないので、費目を増やしてもコードは変わらない。
          majorCriteria()
        ),
      ])
    ),
    { label: "費目を決める（大分類）" }
  );

  const classified = items.map((item, index) => {
    const answer = stage2.answers[`item_${index}`];
    const confidence = answer?.confidence ?? 0;
    return {
      ...item,
      大分類: answer?.choice ?? null,
      大分類の確信度: confidence,
      大分類の確率: answer?.probabilities ?? {},
      大分類の扱い: band(confidence),
      // 2位との差。ユーザーに聞くとき「どちらですか」と出せる。
      対抗: runnerUp(answer?.probabilities),
    };
  });

  yield stageEvent(2, "費目を決める（大分類）", `Choice x${items.length}`, stage2, {
    費目: classified.map((i) => ({ 品目: i.name, 大分類: i.大分類, 確信度: i.大分類の確信度 })),
  });

  // ---- stage 3 ------------------------------------------------------------
  // 階層の2段目。question ごとに criteria が違う。
  // 「どの選択肢を見せるか」が品目の1段目の答えで決まるので、
  // criteria を実行時に組み立てられることがここで効いてくる。
  //
  // 小分類が0個の費目は question を作らない。
  // 1個しか無い費目も聞かない。選択肢が1つなら決定ではないので、
  // API を呼ぶ意味がない（docs の hierarchical classification と同じ考え方）。

  const minorQuestions = {};
  const skipped = [];
  classified.forEach((item, index) => {
    const children = Object.keys(minorCriteria(item.大分類));
    if (children.length === 0) {
      skipped.push({ 品目: item.name, 理由: `「${item.大分類}」に小分類が無い` });
      return;
    }
    if (children.length === 1) {
      item.小分類 = children[0];
      item.小分類の確信度 = 1;
      item.小分類の扱い = "auto";
      skipped.push({ 品目: item.name, 理由: "小分類が1つしか無いので聞かない" });
      return;
    }
    minorQuestions[`item_${index}`] = Choice(
      {
        品目: { 名前: item.name, 金額: `${item.amount}円` },
        確定済みの大分類: item.大分類,
        質問: `この品目は「${item.大分類}」の中のどれにあたりますか。`,
      },
      minorCriteria(item.大分類)
    );
  });

  if (Object.keys(minorQuestions).length > 0) {
    const stage3 = await ask(sharedState, minorQuestions, { label: "費目を決める（小分類）" });
    classified.forEach((item, index) => {
      const answer = stage3.answers[`item_${index}`];
      if (!answer) return;
      item.小分類 = answer.choice;
      item.小分類の確信度 = answer.confidence;
      item.小分類の確率 = answer.probabilities;
      item.小分類の扱い = band(answer.confidence);
    });

    yield stageEvent(3, "費目を決める（小分類）", `Choice x${Object.keys(minorQuestions).length}`, stage3, {
      小分類: classified.map((i) => ({ 品目: i.name, 費目: fullCategory(i), 確信度: i.小分類の確信度 ?? 1 })),
      聞かなかったもの: skipped,
    });
  }

  // ---- stage 4 ------------------------------------------------------------
  // 1回のリクエストに Score と Noul を混ぜる。型が違っても同じ state を見る。
  //
  // 定期購入の判定は、コードと Jev の分担がはっきり出るところ。
  // 履歴 M 件 × 品目 N 件を全部投げると N×M 問になるので、
  // 文字列の類似度でコードが候補を1件に絞り、
  // 「表記は違うが同じ商品か」の判断だけを Noul に任せている。

  const historyMatches = matchHistory(classified, PURCHASE_HISTORY);
  const stage4Questions = {};
  classified.forEach((item, index) => {
    const context = { 品目: { 名前: item.name, 金額: `${item.amount}円`, 費目: fullCategory(item) } };

    stage4Questions[`need_${index}`] = Score(
      { ...context, 質問: "この品目は、生活にどのくらい必要なものですか。" },
      NECESSITY_LEVELS
    );
    stage4Questions[`impulse_${index}`] = Noul(
      { ...context, 質問: "この品目は、予定せずその場で買った衝動買いに見えますか。" },
      {
        true: { what: "買うつもりが無かったのに目について買ったもの", examples: ["レジ横の菓子", "新商品の飲料"] },
        false: { what: "買い物リストに載っていそうな定番品", examples: ["牛乳", "トイレットペーパー"] },
      }
    );

    const candidate = historyMatches[index];
    if (candidate) {
      stage4Questions[`same_${index}`] = Noul(
        {
          今回の品目: { 名前: item.name, 金額: `${item.amount}円` },
          過去の購入: { 名前: candidate.name, 前回の金額: `${candidate.lastAmount}円`, 購入回数: candidate.count },
          質問: "この2つは、表記が違うだけで同じ商品ですか。",
        },
        {
          true: {
            what: "ひらがな/カタカナ、容量や個数の表記、ブランド名の省略が違うだけで、指している商品は同じ",
            examples: ["「のむヨーグルト」と「飲むヨーグルト 180ml」", "「牛乳 1L」と「牛乳 1000ml」"],
          },
          false: {
            what: "種類・用途・ブランドが異なる別の商品",
            examples: ["「牛乳」と「豆乳」", "「食パン」と「菓子パン」"],
          },
        }
      );
    }
  });

  const stage4 = await ask(
    { ...sharedState, 品目: classified.map((i) => ({ 名前: i.name, 金額: i.amount, 費目: fullCategory(i) })) },
    stage4Questions,
    {
      label: "品目の性質を見る",
      // モック用のヒント。request には入らない。
      // 名寄せは語の重なりでは測れないので、コード側の類似度を使わせる。
      mockHints: Object.fromEntries(
        historyMatches
          .map((candidate, index) => [`same_${index}`, candidate ? nameCloseness(classified[index].name, candidate.name) : null])
          .filter(([, value]) => value != null)
      ),
    }
  );

  classified.forEach((item, index) => {
    const need = stage4.answers[`need_${index}`];
    item.必需度 = need?.score ?? null;
    item.必需度の確信度 = need?.confidence ?? 0;
    item.必需度の説明 = levelLabel(need);
    item.必需度の段階数 = need ? Object.keys(need.legend ?? {}).length : NECESSITY_LEVELS.length;

    const impulse = stage4.answers[`impulse_${index}`]?.noul ?? 0;
    item.衝動買い確率 = impulse;
    item.衝動買い = impulse > 0.7;
    item.衝動買いの確信度 = noulConfidence(impulse);

    const same = stage4.answers[`same_${index}`]?.noul;
    const candidate = historyMatches[index];
    if (candidate && same != null) {
      item.履歴候補 = candidate.name;
      item.同一商品確率 = same;
      if (same > 0.8) {
        item.定期購入 = { 回数: candidate.count, 前回価格: candidate.lastAmount, 前回日: candidate.lastBoughtOn };
        item.価格差 = item.amount - candidate.lastAmount;
      }
    }
  });

  yield stageEvent(
    4,
    "品目の性質を見る",
    `Score x${classified.length} + Noul x${Object.keys(stage4Questions).length - classified.length}`,
    stage4,
    {
      必需度: classified.map((i) => ({ 品目: i.name, 必需度: i.必需度, 衝動買い確率: i.衝動買い確率 })),
      名寄せ: classified
        .filter((i) => i.履歴候補)
        .map((i) => ({ 今回: i.name, 履歴: i.履歴候補, 同一確率: i.同一商品確率 })),
    }
  );

  // ---- stage 5 ------------------------------------------------------------
  // state をオブジェクトで渡す。string だけでなく JSON を入れられるので、
  // ここまでの判定結果と今月の家計を一緒に見せられる。
  // 「レシート全文 + 分類済みの品目 + 予算」を見た上での評価になる。

  const stage5State = {
    店: { 名前: receipt.店名, ジャンル: receipt.ジャンル },
    購入日: receipt.購入日,
    合計: receipt.合計,
    品目: classified.map((i) => ({
      名前: i.name,
      金額: i.amount,
      費目: fullCategory(i),
      必需度: i.必需度,
    })),
    今月の家計: MONTHLY,
  };

  const stage5 = await ask(
    stage5State,
    {
      ...Object.fromEntries(
        Object.entries(RECEIPT_RUBRICS).map(([name, rubric]) => [
          name,
          Score(rubric.instructions, rubric.criteria),
        ])
      ),
      人の確認が要る: Noul("このレシートは、登録前に人が見直したほうがよいですか。", {
        true: { what: "読み取りが怪しい、高額、費目が割れている", examples: ["合計が品目の和と合わない", "判定が割れている品目がある"] },
        false: "そのまま家計簿に登録してよい",
      }),
      予算が危ない: Noul(
        "`今月の家計` を見て、この調子で使い続けると今月の予算を超えそうですか。",
        {
          true: "残り日数に対して支出のペースが速い",
          false: "予算内に収まりそう",
        }
      ),
    },
    { label: "家計簿として評価する" }
  );

  yield stageEvent(5, "家計簿として評価する", "Score x3 + Noul x2", stage5, {
    state: stage5State,
  });

  // ---- まとめ -------------------------------------------------------------
  // composite scoring: Score を正規化して、重みはコードで持つ。
  // 重みをモデルに決めさせないので、あとから調整できるし理由も説明できる。

  const summary = {
    receipt,
    items: classified,
    必需度の金額加重: weightedNecessity(classified),
    衝動買い金額: classified.filter((i) => i.衝動買い).reduce((sum, i) => sum + i.amount, 0),
    定期購入: classified.filter((i) => i.定期購入).length,
    値上がり: classified.filter((i) => i.定期購入 && i.価格差 > 0).length,
    評価: Object.fromEntries(
      Object.keys(RECEIPT_RUBRICS).map((name) => {
        const answer = stage5.answers[name];
        return [
          name,
          {
            score: answer?.score ?? null,
            段階数: Object.keys(answer?.legend ?? {}).length,
            confidence: answer?.confidence ?? 0,
            説明: levelLabel(answer),
          },
        ];
      })
    ),
    人の確認が要る: stage5.answers.人の確認が要る?.noul ?? 0,
    予算が危ない: stage5.answers.予算が危ない?.noul ?? 0,
    今月の家計: MONTHLY,
    // 家計簿として、費目ごとに積み上げたもの。アプリが最終的に欲しいのはこれ。
    費目別: aggregate(classified),
    要確認: classified.filter((i) => i.大分類の扱い !== "auto" || i.小分類の扱い === "manual").length,
  };

  yield { type: "done", summary };
}

// MARK: - 小道具

function stageEvent(index, name, primitive, result, derived) {
  return {
    type: "stage",
    index,
    name,
    primitive,
    questionCount: result.questionCount,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    model: result.model,
    mock: result.mock,
    request: result.request,
    answers: result.answers,
    derived,
  };
}

/**
 * Score の答えを、一番近い段階の見出しに直す。
 * criteria をオブジェクトで渡しているので、legend にもオブジェクトが入ってくる。
 * 画面に出すのは summary だけでよい。
 */
function levelLabel(answer) {
  if (!answer?.legend) return null;
  const level = answer.legend[String(Math.round(answer.score ?? 0))];
  if (level == null) return null;
  return typeof level === "string" ? level : (level.summary ?? JSON.stringify(level));
}

/** Choice の答えを値に直す。「不明」は null にする。 */
const pickValue = (answer) =>
  !answer || answer.choice === UNKNOWN ? null : answer.choice;

const toAmount = (value) => (value == null ? null : Number(String(value).replace(/[^\d]/g, "")) || null);

const fullCategory = (item) => (item.小分類 ? `${item.大分類} > ${item.小分類}` : item.大分類);

/** 2位の選択肢。確信度が低いとき、ユーザーに二択で聞くために使う。 */
function runnerUp(probabilities) {
  if (!probabilities) return null;
  const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return sorted[1] ? { 費目: sorted[1][0], 確率: sorted[1][1] } : null;
}

/** 各ステージの confidence を3段階に落として、画面で色分けできるようにする。 */
function fieldBands(stage) {
  return Object.fromEntries(
    Object.entries(stage.answers).map(([id, answer]) => {
      const confidence =
        answer.type === "noul" ? noulConfidence(answer.noul) : (answer.confidence ?? 0);
      return [id, { confidence: Math.round(confidence * 1000) / 1000, band: band(confidence) }];
    })
  );
}

/**
 * Jev が選んだ合計と、品目の積み上げを突き合わせる。
 * これは Jev の仕事ではなく、コードの仕事。足し算にモデルは要らない。
 */
function verifyTotal(total, items) {
  const sum = items.reduce((acc, item) => acc + item.amount, 0);
  if (total == null) return { 判定: "合計を特定できず", 品目の合計: sum };
  const diff = total - sum;
  return {
    判定: diff === 0 ? "一致" : `差 ${diff > 0 ? "+" : ""}${diff}円（税・値引きの可能性）`,
    選ばれた合計: total,
    品目の合計: sum,
  };
}

/** 必需度を 0〜1 に正規化し、金額で重み付けする。重みはコードが持つ。 */
function weightedNecessity(items) {
  const max = NECESSITY_LEVELS.length - 1;
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  if (!total) return 0;
  const weighted = items.reduce(
    (sum, item) => sum + (item.必需度 ?? 0) / max * item.amount,
    0
  );
  return Math.round((weighted / total) * 1000) / 1000;
}

/** 費目ごとの積み上げ。家計簿アプリが最後に欲しい形。 */
function aggregate(items) {
  const totals = new Map();
  for (const item of items) {
    const key = item.大分類 ?? "その他";
    totals.set(key, (totals.get(key) ?? 0) + item.amount);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([費目, 金額]) => ({ 費目, 金額 }));
}
