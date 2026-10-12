// LT デモ用サーバー。依存ゼロ（Node 標準モジュールのみ）。
//
// Jev の呼び出しをすべてここに通すのは、API キーをブラウザに出さないため。
// Jev はクラウド API なので、クライアントから直接叩くとキーが露出する。
// 実アプリでも同じ理由でプロキシが要る（LT の最後で触れる論点）。
//
// パイプラインは NDJSON で流す。1ステージ終わるごとに1行送るので、
// 画面でステージが順に埋まっていく。デモで「いま何問投げたか」を指差せる。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runPipeline } from "./pipeline.mjs";
import { TAXONOMY, STORE_GENRES, NECESSITY_LEVELS, RECEIPT_RUBRICS } from "./taxonomy.mjs";
import { MOCK } from "./jev.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;

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

  // 画面に「データ設計」を出すため。費目はサーバー側の1ファイルが正。
  if (req.method === "GET" && req.url === "/api/design") {
    sendJson(res, 200, {
      mock: MOCK,
      費目: Object.fromEntries(
        Object.entries(TAXONOMY).map(([name, node]) => [name, Object.keys(node.children)])
      ),
      店ジャンル: Object.keys(STORE_GENRES),
      必需度の段階: NECESSITY_LEVELS.map((level) => level.summary),
      レシート評価: Object.fromEntries(
        Object.entries(RECEIPT_RUBRICS).map(([name, rubric]) => [
          name,
          rubric.criteria.map((level) => level.summary),
        ])
      ),
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/analyze") {
    let body = "";
    for await (const chunk of req) body += chunk;

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });

    try {
      const { text } = JSON.parse(body || "{}");
      for await (const event of runPipeline(text ?? "")) {
        res.write(JSON.stringify(event) + "\n");
      }
    } catch (error) {
      res.write(JSON.stringify({ type: "error", message: String(error.message ?? error) }) + "\n");
    }
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`\n  家計簿 × Jev デモ  →  http://localhost:${PORT}`);
  console.log(
    MOCK
      ? "  ⚠️  モックモードで動いています（API を呼びません）。\n" +
          "     本物を使うには TYPESAFE_API_KEY を設定して再起動してください。\n"
      : "  ✅ Jev API を呼びます（TYPESAFE_API_KEY 設定済み）。\n"
  );
});
