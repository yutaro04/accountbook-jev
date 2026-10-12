// LT デモ用サーバー。依存ゼロ（Node 標準モジュールのみ）。
//
// Jev の呼び出しをすべてここに通すのは、API キーをブラウザに出さないため。
// Jev はクラウド API なので、クライアントから直接叩くとキーが露出する。
// 実アプリでも同じ理由でプロキシが要る（LT の最後で触れる論点）。
//
// パイプラインは NDJSON で流す。1ステージ終わるごとに1行送るので、
// 画面でステージが順に埋まっていく。デモで「いま何問投げたか」を指差せる。

import { createServer } from "node:http";
import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runPipeline } from "./pipeline.mjs";
import { TAXONOMY, STORE_GENRES, NECESSITY_LEVELS, RECEIPT_RUBRICS } from "./taxonomy.mjs";
import { MOCK } from "./jev.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;

// MARK: - OCR
//
// Jev は画像を受け取れないので、レシート写真は手前でテキストにする。
// macOS の Vision を叩く小さな Swift のバイナリ（ocr.swift）に任せている。
// 実アプリ（iOS）も同じ Vision なので、デモと本番で同じ経路になる。

const run = promisify(execFile);
const OCR_BINARY = join(__dirname, "ocr");
const OCR_SOURCE = join(__dirname, "ocr.swift");
let ocrStatus = { available: false, reason: "未初期化" };

/** 起動時に1回だけ。バイナリが無い（またはソースのほうが新しい）ならビルドする。 */
async function prepareOcr() {
  if (process.platform !== "darwin") {
    return { available: false, reason: "OCR は macOS（Vision）専用です" };
  }
  try {
    const [binary, source] = await Promise.all([
      stat(OCR_BINARY).catch(() => null),
      stat(OCR_SOURCE),
    ]);
    if (binary && binary.mtimeMs >= source.mtimeMs) return { available: true, reason: "" };

    console.log("  … ocr.swift をビルドしています（初回のみ）");
    await run("swiftc", ["-O", "-o", OCR_BINARY, OCR_SOURCE]);
    return { available: true, reason: "" };
  } catch (error) {
    return { available: false, reason: `ocr のビルドに失敗: ${String(error.message ?? error).slice(0, 200)}` };
  }
}

async function imageToText(buffer, extension) {
  const scratch = join(tmpdir(), `jev-receipt-${Date.now()}${extension}`);
  await writeFile(scratch, buffer);
  try {
    const { stdout } = await run(OCR_BINARY, [scratch], { maxBuffer: 4 << 20 });
    return stdout;
  } catch (error) {
    // ocr 側のメッセージだけを出す。一時ファイルのパスは見せても仕方がない。
    const detail = String(error.stderr ?? "").replace(/^ocr: /, "").split("\n")[0];
    throw new Error(detail || "画像を読み取れませんでした");
  } finally {
    await unlink(scratch).catch(() => {});
  }
}

const EXTENSIONS = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/heic": ".heic",
  "image/heif": ".heif", "image/webp": ".webp", "image/tiff": ".tiff",
};

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
      ocr: ocrStatus,
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

  // レシート画像 → テキスト。ここは Jev を一切使わない（使えない）。
  if (req.method === "POST" && req.url === "/api/ocr") {
    if (!ocrStatus.available) {
      sendJson(res, 503, { error: ocrStatus.reason });
      return;
    }

    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const extension = EXTENSIONS[contentType];
    if (!extension) {
      sendJson(res, 415, { error: `対応していない形式です: ${contentType || "(不明)"}` });
      return;
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        sendJson(res, 413, { error: "画像が大きすぎます（25MB まで）" });
        return;
      }
      chunks.push(chunk);
    }

    try {
      const text = await imageToText(Buffer.concat(chunks), extension);
      sendJson(res, 200, { text, lines: text.split("\n").filter(Boolean).length });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message ?? error).slice(0, 300) });
    }
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

ocrStatus = await prepareOcr();

server.listen(PORT, () => {
  console.log(`\n  家計簿 × Jev デモ  →  http://localhost:${PORT}`);
  console.log(
    MOCK
      ? "  ⚠️  モックモードで動いています（API を呼びません）。\n" +
          "     本物を使うには TYPESAFE_API_KEY を設定して再起動してください。"
      : "  ✅ Jev API を呼びます（TYPESAFE_API_KEY 設定済み）。"
  );
  console.log(
    ocrStatus.available
      ? "  ✅ レシート画像の読み込みが使えます（Apple Vision / オンデバイス）。\n"
      : `  ⚠️  画像の読み込みは使えません: ${ocrStatus.reason}\n`
  );
});
