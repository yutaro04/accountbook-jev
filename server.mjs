// LT デモ用の最小サーバー。依存ゼロ（Node 標準モジュールのみ）。
//
// API キーをブラウザに出さないため、Jev の呼び出しはすべてここを経由する。
// 実アプリでも同じ理由でプロキシが必要になる（LT で触れる論点）。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;
const API_KEY = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** 家計簿アプリの費目。Choice の選択肢になる。 */
const CATEGORIES = {
  食費: "スーパーや商店で買った食材・飲料。自炊するための材料",
  外食: "レストラン・ファストフード・弁当・惣菜など、調理済みの食事",
  カフェ: "コーヒー・喫茶店での飲食",
  日用品: "トイレットペーパー・洗剤・掃除用品など、食べない消耗品",
  交通費: "電車・バス・タクシー・ガソリン・駐車場",
  水道光熱費: "電気・ガス・水道の料金",
  通信費: "携帯電話・インターネット・各種サブスクリプション",
  "趣味・娯楽": "本・ゲーム・映画・音楽・スポーツなど娯楽",
  衣服: "服・靴・カバン・アクセサリー",
  医療費: "薬・病院・コンタクトレンズ・衛生用品",
  その他: "上のどれにも当てはまらないもの",
};

/**
 * レシートのテキストを「品名 + 金額」に分解する。
 * iOS アプリ側と同じ考え方（合計・小計などの行は品目にしない）。
 */
function parseItems(text) {
  const excluded = [
    "小計", "合計", "お会計", "総額", "お預り", "お預かり", "お釣り", "おつり",
    "消費税", "税込", "税抜", "値引", "割引", "現金", "クレジット", "カード",
    "ポイント", "点数", "登録番号", "責任者", "レジ", "TEL", "電話",
  ];

  // 住所の行は品目ではない
  const addressPattern = /(都|道|府|県|市|区|町|村)[^\s]*\d/;

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !excluded.some((word) => line.includes(word)))
    .filter((line) => !addressPattern.test(line))
    .map((line) => {
      // 金額はレシートの右端にある。行末の数値だけを金額として切り出す。
      // 行全体から数字を消すと「食パン 6枚切」が「食パン枚切」になってしまう。
      const match = line.match(/^(.*?)[¥￥]?\s*([0-9][0-9,]*)\s*円?\s*$/);
      if (!match) return null;

      const amount = Number(match[2].replace(/,/g, ""));
      if (!(amount > 0 && amount <= 9_999_999)) return null;

      const name = match[1].replace(/[×xX*]\s*\d*\s*$/, "").trim();
      // 名前が無い（金額だけの行）は品目にしない
      if ([...name].filter((c) => /\p{L}/u.test(c)).length < 2) return null;

      return { name, amount };
    })
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * 品目をまとめて1回の API 呼び出しで分類する。
 * Jev は questions を並列・独立に評価するので、品目が増えても往復は1回で済む。
 */
async function classify(items, receiptText) {
  const questions = {};
  items.forEach((item, index) => {
    questions[`item_${index}`] = {
      type: "choice",
      instructions:
        `レシートの品目「${item.name}」（${item.amount}円）は、` +
        `家計簿のどの費目にあたりますか。`,
      criteria: CATEGORIES,
    };
  });

  const startedAt = Date.now();
  const response = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // state は全品目で共通。店名などの文脈を一緒に渡せる。
      state: receiptText,
      model: "jev-latest",
      questions,
    }),
  });
  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Jev API ${response.status}: ${detail.slice(0, 500)}`);
  }

  const payload = await response.json();
  const results = items.map((item, index) => {
    const answer = payload.answers?.[`item_${index}`];
    return {
      ...item,
      category: answer?.choice ?? null,
      confidence: answer?.confidence ?? 0,
      probabilities: answer?.probabilities ?? {},
    };
  });

  return { results, elapsedMs, usage: payload.usage, model: payload.model, questions };
}

// MARK: - HTTP

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = await readFile(join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && req.url === "/api/categories") {
    sendJson(res, 200, { categories: Object.keys(CATEGORIES) });
    return;
  }

  if (req.method === "POST" && req.url === "/api/classify") {
    if (!API_KEY) {
      sendJson(res, 500, {
        error: "TYPESAFE_API_KEY が設定されていません。環境変数を設定して再起動してください。",
      });
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const { text } = JSON.parse(body || "{}");
      const items = parseItems(text ?? "");
      if (items.length === 0) {
        sendJson(res, 200, { results: [], elapsedMs: 0, note: "品目を検出できませんでした" });
        return;
      }
      sendJson(res, 200, await classify(items, text));
    } catch (error) {
      sendJson(res, 500, { error: String(error.message ?? error) });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`\n  家計簿 × Jev デモ  →  http://localhost:${PORT}\n`);
  if (!API_KEY) {
    console.log("  ⚠️  TYPESAFE_API_KEY が未設定です。分類は実行できません。\n");
  }
});
