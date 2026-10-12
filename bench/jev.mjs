// Jev で同じデータセットを分類し、時間・正解率・トークン・金額を測る。
//
//   TYPESAFE_API_KEY='sk-...' node jev.mjs > jev-result.json
//
// Apple 側と条件を揃える:
//   - 同じ品目、同じ店の文脈
//   - 同じ12費目
//   - 1回目はウォームアップとして計測から外す
//
// 揃えないのは「1レシートを何回の往復で処理するか」。
// Jev は questions を並列評価できるのでレシート1枚＝1往復、
// Apple のオンデバイスは1品目ずつ。**そこが比較したい差**なので、
// どちらも「そのやり方で一番速い形」で測る。

import { readFile } from "node:fs/promises";
import { ask, Choice, MOCK } from "../jev.mjs";
import { majorCriteria } from "../taxonomy.mjs";

const dataset = JSON.parse(await readFile(new URL("./dataset.json", import.meta.url), "utf8"));

/** 入力トークンの単価。docs の $42 / 10億トークン。出力は無料。 */
const USD_PER_INPUT_TOKEN = 42 / 1_000_000_000;

const normalize = (value) => String(value ?? "").trim();

/** 曖昧な品目は accept のどれかに当たれば正解とする（Apple 側と同じ判定）。 */
function isCorrect(answer, item) {
  const a = normalize(answer);
  if (item.ambiguous && item.accept) return item.accept.includes(a);
  return a === item.label;
}

/** レシート1枚 ＝ Choice を品目数ぶん並べて1往復。 */
async function classifyReceipt(receipt) {
  const questions = Object.fromEntries(
    receipt.items.map((item, index) => [
      `item_${index}`,
      Choice(
        {
          品目: { 名前: item.name, 金額: `${item.amount}円` },
          質問: "この品目は、家計簿のどの費目にあたりますか。",
        },
        majorCriteria()
      ),
    ])
  );

  const state = {
    店: { 名前: receipt.store, ジャンル: receipt.genre },
    品目一覧: receipt.items.map((i) => `${i.name} ${i.amount}円`),
  };

  const result = await ask(state, questions, { label: receipt.id });

  const measurements = receipt.items.map((item, index) => {
    const answer = result.answers[`item_${index}`];
    const choice = answer?.choice ?? null;
    return {
      receipt: receipt.id,
      item: item.name,
      label: item.label,
      answer: choice,
      correct: isCorrect(choice, item),
      // Choice は criteria の外を返せないので、原理上ここは必ず true になる。
      // 「測るまでもない」ことを数字で示すために、あえて測っている。
      inVocabulary: dataset.categories.includes(normalize(choice)),
      confidence: answer?.confidence ?? 0,
      ms: result.elapsedMs,
    };
  });

  return {
    measurements,
    elapsedMs: result.elapsedMs,
    inputTokens: result.usage?.input_tokens ?? 0,
    questionCount: result.questionCount,
  };
}

// ウォームアップ。接続確立やモデルの立ち上がりを計測から外す。
await classifyReceipt(dataset.receipts[0]);

const measurements = [];
let totalMs = 0;
let inputTokens = 0;
let calls = 0;

for (const receipt of dataset.receipts) {
  const r = await classifyReceipt(receipt);
  measurements.push(...r.measurements);
  totalMs += r.elapsedMs;
  inputTokens += r.inputTokens;
  calls += 1;
  process.stderr.write(
    `  ${receipt.id}: ${r.measurements.length}品目 / question ${r.questionCount} / ${r.elapsedMs}ms\n`
  );
}

console.log(
  JSON.stringify(
    {
      mode: MOCK ? "mock" : "live",
      model: MOCK ? "jev-latest (モック。実測ではない)" : "jev-latest",
      measurements,
      totalMs,
      calls,
      inputTokens,
      // モックのトークン数は文字数からの概算なので、金額も概算にしかならない
      usdTotal: inputTokens * USD_PER_INPUT_TOKEN,
      estimated: MOCK,
    },
    null,
    1
  )
);
