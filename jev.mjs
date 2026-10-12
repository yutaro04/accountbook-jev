// Jev（TypeSafe System One）クライアント。依存ゼロ。
//
// SDK を使わず素の fetch にしているのは、LT で **実際に飛んでいる JSON** を
// そのまま見せたいから。実務では @typesafe/sdk を使ってよい。
//
// エンドポイントは1つだけ:  POST https://api.typesafe.ai/v1/systemone
// リクエストは state / model / questions の3つだけ。
// questions は何問積んでも **1往復**。全問が同じ state を見て、独立に評価される。

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.JEV_MODEL ?? "jev-latest";
const API_KEY = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;

/** API キーが無いときに、オフラインで動かすためのモード（デモの保険）。 */
export const MOCK = process.env.JEV_MOCK === "1" || !API_KEY;

// MARK: - question ビルダー
//
// 3つのプリミティブしかない。これだけで家計簿アプリが組み上がる。

/** 選択肢から1つ選ぶ。choice / probabilities / confidence が返る。 */
export const Choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });

/** ルブリックで採点する。criteria は低い→高いの順に 2〜10 段階。 */
export const Score = (instructions, criteria) => ({ type: "score", instructions, criteria });

/** はい/いいえ。0〜1 の確率が返る。criteria は任意。 */
export const Noul = (instructions, criteria) =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };

// MARK: - 確信度
//
// Choice と Score は confidence を返してくる。Noul は確率そのものしか返さない。
// docs の式に合わせて、Noul だけ自前で確信度に直す。

/** Noul の確率を確信度に変換する。p=0.5 で 0、p=0 または 1 で 1。 */
export const noulConfidence = (p) => Math.abs(2 * p - 1);

/** docs 推奨の3段階。しきい値はリスクに応じて変える前提。 */
export function band(confidence, { auto = 0.85, confirm = 0.5 } = {}) {
  if (confidence >= auto) return "auto"; // そのまま確定してよい
  if (confidence >= confirm) return "confirm"; // ユーザーに確認する
  return "manual"; // 採用しない。手入力に回す
}

// MARK: - 呼び出し

/**
 * questions をまとめて1回投げる。
 * 戻り値には、LT で見せるために request / elapsedMs も入れてある。
 */
export async function ask(state, questions, { label = "", mockHints = {} } = {}) {
  const request = { state, model: MODEL, questions };
  const startedAt = Date.now();

  if (MOCK) {
    // mockHints は request に入れない。画面に出る JSON は本物と同じ形に保つ。
    const answers = mockAnswers(questions, mockHints, state);
    await new Promise((resolve) => setTimeout(resolve, 120 + Object.keys(questions).length * 8));
    return {
      label,
      request,
      answers,
      model: `${MODEL} (mock)`,
      usage: { input_tokens: estimateTokens(state) + 40 * Object.keys(questions).length, output_tokens: 0 },
      elapsedMs: Date.now() - startedAt,
      questionCount: Object.keys(questions).length,
      mock: true,
    };
  }

  const payload = await postWithRetry(request);
  return {
    label,
    request,
    answers: payload.answers ?? {},
    model: payload.model,
    usage: payload.usage,
    elapsedMs: Date.now() - startedAt,
    questionCount: Object.keys(questions).length,
    mock: false,
  };
}

/** 429 / 529 は指数バックオフで数回だけ粘る（docs の推奨）。 */
async function postWithRetry(request, attempt = 0) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (response.ok) return response.json();

  if ((response.status === 429 || response.status === 529) && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
    return postWithRetry(request, attempt + 1);
  }

  const detail = await response.text();
  throw new Error(`Jev API ${response.status}: ${detail.slice(0, 400)}`);
}

const estimateTokens = (value) =>
  Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 2.5);

// MARK: - モック
//
// API キーが無くてもデモが最後まで通るようにする。
// 「それっぽい」答えを作るため、instructions と criteria の文字の重なりで
// スコアを出して softmax している。**Jev とは何の関係もない安物の近似** で、
// 本物の代わりにはならない。会場の Wi-Fi が落ちたときのための保険。

/** 受け皿の選択肢。語の重なりでは「どれにも当てはまらない」を表現できないので下げる。 */
const CATCH_ALL = new Set(["不明", "その他", "該当なし", "わからない"]);

function mockAnswers(questions, hints, state) {
  const context = flatten(state);
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      mockAnswer(id, question, hints[id], context),
    ])
  );
}

function mockAnswer(id, question, hint, context) {
  const prompt = flatten(question.instructions);
  // 本物は state を見て答える。モックも state を見ないと
  // 「お預りとお釣りが書いてある＝現金払い」のような判断ができない。
  // instructions ほど強くは効かせない。
  const score = (text) => overlap(prompt, text) + overlap(context, text) * 0.3;

  if (question.type === "choice") {
    const keys = Object.keys(question.criteria);
    const weights = keys.map(
      (key) =>
        score(key + " " + flatten(question.criteria[key])) -
        (CATCH_ALL.has(key) ? 0.6 : 0) +
        (hint === key ? 1.2 : 0)
    );
    const probabilities = softmax(weights, 9, seed(id));
    const distribution = Object.fromEntries(keys.map((key, i) => [key, round(probabilities[i])]));
    return {
      type: "choice",
      choice: keys[argmax(probabilities)],
      probabilities: distribution,
      confidence: round(choiceConfidence(probabilities)),
    };
  }

  if (question.type === "score") {
    const levels = question.criteria;
    const weights = levels.map((level) => score(flatten(level)));
    const probabilities = softmax(weights, 5, seed(id));
    return {
      type: "score",
      score: round(probabilities.reduce((sum, p, i) => sum + p * i, 0)),
      confidence: round(scoreConfidence(probabilities)),
      // 本物と同じく、criteria に渡したものをそのまま返す（オブジェクトならオブジェクト）
      legend: Object.fromEntries(levels.map((level, i) => [String(i), level])),
      probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), round(p)])),
    };
  }

  // noul。語の重なりでは測れない問い（同一商品かなど）は、
  // 呼び出し側がコードで出した値をヒントとして渡してくる。
  if (hint != null) return { type: "noul", noul: round(clamp(hint)) };

  const positive = score(flatten(question.criteria?.true ?? "はい そうである"));
  const negative = score(flatten(question.criteria?.false ?? "いいえ そうではない"));
  const jitter = ((seed(id) % 1000) / 1000 - 0.5) * 0.3;
  const [p] = softmax([positive, negative], 4, seed(id));
  return { type: "noul", noul: round(clamp(p + jitter)) };
}

/** docs の式。選択肢が均等なときに 0、1つに寄り切ったときに 1。 */
export function choiceConfidence(probabilities) {
  const n = probabilities.length;
  if (n < 2) return 1;
  return (Math.max(...probabilities) - 1 / n) / (1 - 1 / n);
}

/** docs の式。隣の段階への迷いは、遠い段階への迷いより軽く効く。 */
export function scoreConfidence(probabilities) {
  const n = probabilities.length;
  const peak = argmax(probabilities);
  const spread = probabilities.reduce((sum, p, i) => sum + p * Math.abs(i - peak), 0);
  const evenSpread =
    Array.from({ length: n }, (_, i) => Math.abs(i - (n - 1) / 2)).reduce((a, b) => a + b, 0) / n;
  return Math.max(0, 1 - spread / evenSpread);
}

/**
 * 値だけを拾って1本の文字列にする。
 * JSON.stringify だとキー名（field / question / type …）まで比較に混ざって、
 * 「TEL」のような英字の行が構造キーと当たってしまう。
 */
function flatten(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.map(flatten).join(" ");
}

/**
 * 2-gram と 1-gram の重なり。日本語は 2-gram だけだと当たりが少ないので
 * 1 文字の一致も軽く足す（「店名」と「丸の内店」が繋がるのはこちら）。
 */
function overlap(a, b) {
  // 英字は落とす。日本語のデモなので意味を担っているのは日本語と数字で、
  // 英字を残すと「TEL」が英語の語と当たってノイズになる。
  const clean = (value) =>
    value.normalize("NFKC").toLowerCase().replace(/[a-z]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
  const bigrams = (v) => new Set([...v].slice(0, -1).map((c, i) => c + v[i + 1]));
  const left = clean(a);
  const right = clean(b);
  const [lb, rb] = [bigrams(left), bigrams(right)];
  const ru = new Set(right);

  let bigramHits = 0;
  for (const gram of lb) if (rb.has(gram)) bigramHits += 1;
  let unigramHits = 0;
  for (const char of new Set(left)) if (ru.has(char)) unigramHits += 1;

  // 両側の大きさで割る（コサイン類似度の形）。
  // 片側だけで割ると、**説明の長い選択肢ほど当たりやすくなる**。
  // 「品物」の説明が一番長いせいで、小計の行まで品物に吸われていた。
  const lu = new Set(left);
  const bigramScore = lb.size && rb.size ? bigramHits / Math.sqrt(lb.size * rb.size) : 0;
  const unigramScore = lu.size && ru.size ? unigramHits / Math.sqrt(lu.size * ru.size) : 0;
  return bigramScore + unigramScore * 0.35;
}

function softmax(weights, temperature, noiseSeed) {
  const noised = weights.map((w, i) => w * temperature + (((noiseSeed + i * 7919) % 1000) / 1000) * 0.9);
  const max = Math.max(...noised);
  const exponentials = noised.map((w) => Math.exp(w - max));
  const total = exponentials.reduce((a, b) => a + b, 0);
  return exponentials.map((e) => e / total);
}

const argmax = (values) => values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
const round = (value) => Math.round(value * 1000) / 1000;
const clamp = (value) => Math.min(1, Math.max(0, value));
const seed = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100003, 7);
