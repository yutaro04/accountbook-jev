// 計測結果を突き合わせて表にする。
//
//   node report.mjs
//
// モックで走らせた Jev の結果は **実測ではない**（遅延は setTimeout、
// 正解は文字の重なり、トークンは文字数からの概算）。
// 数字が並ぶと実測に見えてしまうので、モックのときは比較欄を伏せる。

import { readFile } from "node:fs/promises";

const read = async (name) => {
  try {
    return JSON.parse(await readFile(new URL(`./${name}`, import.meta.url), "utf8"));
  } catch {
    return null;
  }
};

const dataset = await read("dataset.json");
const runs = [
  { key: "apple-free", title: "Apple 端末内・文字列で回答", data: await read("apple-free.json") },
  { key: "apple-guided", title: "Apple 端末内・@Generable で拘束", data: await read("apple-guided.json") },
  { key: "jev", title: "Jev・Choice", data: await read("jev-result.json") },
].filter((r) => r.data);

const itemCount = dataset.receipts.reduce((sum, r) => sum + r.items.length, 0);
const receiptCount = dataset.receipts.length;
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;

function summarize(run) {
  const m = run.data.measurements;
  const correct = m.filter((x) => x.correct).length;
  const oov = m.filter((x) => !x.inVocabulary).length;
  const isJev = run.key === "jev";
  const trusted = !(isJev && run.data.estimated);

  return {
    title: run.title,
    trusted,
    correct,
    accuracy: pct(correct, m.length),
    oov,
    oovRate: pct(oov, m.length),
    totalMs: run.data.totalMs,
    perItemMs: Math.round(run.data.totalMs / m.length),
    perReceiptMs: Math.round(run.data.totalMs / receiptCount),
    calls: isJev ? run.data.calls : m.length,
    inputTokens: isJev ? run.data.inputTokens : null,
    usd: isJev ? run.data.usdTotal : 0,
    warmupMs: run.data.warmupMs ?? null,
  };
}

const rows = runs.map(summarize);

// 日本語は全角なので、見た目の幅で揃える
const width = (s) => [...s].reduce((n, c) => n + (/[\x00-\x7F｡-ﾟ]/.test(c) ? 1 : 2), 0);
const pad = (s, w) => s + " ".repeat(Math.max(0, w - width(s)));

function table(headers, body, widths) {
  const out = [headers.map((h, i) => pad(h, widths[i])).join("  ")];
  out.push(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of body) out.push(r.map((c, i) => pad(String(c), widths[i])).join("  "));
  return out.join("\n");
}

console.log(`
費目分類の比較  —  レシート ${receiptCount} 枚 / 品目 ${itemCount} 件 / 費目 ${dataset.categories.length} 択
${"=".repeat(78)}
`);

console.log(
  table(
    ["やり方", "正解率", "候補外", "1品目", "1レシート", "往復"],
    rows.map((r) => [
      r.title,
      r.trusted ? `${r.accuracy} (${r.correct}/${itemCount})` : "—",
      r.trusted ? `${r.oov} 件` : "—",
      r.trusted ? `${r.perItemMs}ms` : "—",
      r.trusted ? `${r.perReceiptMs}ms` : "—",
      r.trusted ? `${r.calls} 回` : "—",
    ]),
    [32, 16, 8, 9, 11, 7]
  )
);

console.log(`\n\n料金\n${"─".repeat(78)}`);
for (const r of rows) {
  if (!r.trusted) {
    console.log(`${pad(r.title, 32)}  未実測`);
    continue;
  }
  if (r.inputTokens == null) {
    console.log(`${pad(r.title, 32)}  API 料金なし（端末内で動くため）`);
  } else {
    const perReceipt = r.usd / receiptCount;
    console.log(
      `${pad(r.title, 32)}  入力 ${r.inputTokens.toLocaleString()} トークン` +
        ` / 計 $${r.usd.toFixed(6)} / 1枚あたり $${perReceipt.toFixed(6)}`
    );
    console.log(
      `${" ".repeat(32)}  月100枚なら $${(perReceipt * 100).toFixed(4)}` +
        ` ・ 月1万枚なら $${(perReceipt * 10000).toFixed(2)}`
    );
  }
}

// 未実測のものがあるなら、何が足りないかをはっきり出す
const pending = rows.filter((r) => !r.trusted);
if (pending.length) {
  console.log(`\n\n${"!".repeat(78)}`);
  console.log("Jev はモックで走っています。上の表の Jev 行は実測ではないので伏せました。");
  console.log("実測するには API キーを設定して、もう一度流してください:");
  console.log("\n    cd bench && TYPESAFE_API_KEY='sk-...' node jev.mjs > jev-result.json\\");
  console.log("      && node report.mjs\n");
  console.log(`${"!".repeat(78)}`);
}

// 候補外を返した品目は、LT で一番効くので個別に出す
console.log(`\n\n候補に無い費目を返したもの\n${"─".repeat(78)}`);
let found = false;
for (const run of runs) {
  const bad = run.data.measurements.filter((x) => !x.inVocabulary);
  if (!bad.length) continue;
  found = true;
  console.log(`\n${run.title}`);
  for (const x of bad) console.log(`  ${pad(x.item, 34)} → 「${x.answer}」  (正解: ${x.label})`);
}
if (!found) console.log("  なし");

// 判断が割れた品目。難しさの見当がつく
console.log(`\n\n正解できなかった品目\n${"─".repeat(78)}`);
const byItem = new Map();
for (const run of runs) {
  if (!summarize(run).trusted) continue;
  for (const x of run.data.measurements) {
    if (!byItem.has(x.item)) byItem.set(x.item, { label: x.label, answers: [] });
    byItem.get(x.item).answers.push({ run: run.title, answer: x.answer, correct: x.correct });
  }
}
for (const [item, info] of byItem) {
  const wrong = info.answers.filter((a) => !a.correct);
  if (!wrong.length) continue;
  console.log(`\n  ${item}  (正解: ${info.label})`);
  for (const a of info.answers) {
    console.log(`    ${a.correct ? "○" : "×"} ${pad(a.answer ?? "—", 12)} ${a.run}`);
  }
}
console.log();
