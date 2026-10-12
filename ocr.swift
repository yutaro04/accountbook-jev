// レシート画像 → テキスト。Apple Vision のオンデバイス OCR。
//
// **Jev はテキスト専用で、画像を受け取れない。** だから OCR はここでやる。
// 実アプリ（iOS）も同じ Vision を使っているので、デモと本番で同じ経路になる。
//
//   swiftc -O -o ocr ocr.swift
//   ./ocr receipt.png
//
// レシート特有の難しさは「品名が左、金額が右」で1行になっていること。
// Vision は品名と金額を**別々の箱**として返してくるので、
// 縦位置が近いものを1行にまとめ直してから、左→右に並べ直す必要がある。
//
// ここで素朴に「y が近いものをまとめる」とやると、
// **手持ちで撮った数度の傾きで破綻する。** 紙が傾いていると、
// 右端の金額は左端の品名より上（または下）にずれるので、
// 金額が1行ぶん隣の品名にくっつく。全部の金額が1つずつずれるのに
// 見た目は正しい行に見えるので、かなり危ない壊れ方をする。
//
// なので、まず紙の傾きを推定して座標を起こしてから行をまとめる。

import Foundation
import Vision
import AppKit

struct Fragment {
    let text: String
    let minX: Double   // 傾きを戻したあとのピクセル座標
    let maxX: Double
    let midY: Double
    let height: Double
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("ocr: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

func median(_ values: [Double]) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let middle = sorted.count / 2
    return sorted.count % 2 == 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

guard CommandLine.arguments.count > 1 else { fail("usage: ocr <image>") }
let path = CommandLine.arguments[1]

guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("画像として読み込めませんでした（形式が違うか、壊れています）") }

let width = Double(cgImage.width)
let height = Double(cgImage.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// 日本語を先に。レシートには英数字も混ざるので en-US も入れておく。
request.recognitionLanguages = ["ja-JP", "en-US"]
// 言語モデルによる補正は切る。商品名は辞書に無い語だらけで、
// 補正を効かせると「のむヨーグルト」が勝手に直されることがある。
request.usesLanguageCorrection = false

do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
    fail("OCR に失敗しました: \(error.localizedDescription)")
}

let observations = (request.results ?? []).compactMap { observation -> (VNRecognizedTextObservation, String)? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    return (observation, candidate.string)
}

guard !observations.isEmpty else { exit(0) }

// MARK: - 傾きの推定
//
// Vision は boundingBox（軸に平行な箱）のほかに実際の四隅も返してくるので、
// その上辺の向きがその文字列の傾きになる。ただし素直に全部の中央値は取れない。
//
// **回転を検出できなかった断片については、軸に平行な箱をそのまま四隅として返す。**
// 3度傾いた写真でも半分近くが「ちょうど 0 度」で返ってきて、
// 中央値がその 0 に引きずられる。実測した角度ではなく「未報告」なので、
// ちょうど 0 付近のものは測定値として数えない。
//
// 紙がまっすぐなら全部が 0 付近になり、候補が無くなって傾き 0 になる。これは正しい。
//
// （文字の位置だけから推定する projection profile 法も試したが、
// 　レシートは「品名の列」と「金額の列」が等間隔に並ぶので、
// 　金額が1行ぶんずれて重なる角度も同じ評価値になってしまい、区別できない）

let medianHeight = median(observations.map { Double($0.0.boundingBox.height) * height })

var angles: [Double] = []
for (observation, _) in observations {
    let dx = (observation.topRight.x - observation.topLeft.x) * width
    let dy = (observation.topRight.y - observation.topLeft.y) * height
    guard (dx * dx + dy * dy).squareRoot() > width * 0.03 else { continue }
    let angle = atan2(dy, dx)
    if abs(angle) >= 0.2 * .pi / 180 { angles.append(angle) }
}
// 測定値が少なすぎるときは、傾いていないものとして扱う
let skew = angles.count >= 3 ? median(angles) : 0

if ProcessInfo.processInfo.environment["OCR_DEBUG"] != nil {
    FileHandle.standardError.write(
        String(format: "ocr: skew %.2f deg\n", skew * 180 / .pi).data(using: .utf8)!
    )
}

let centerX = width / 2
let centerY = height / 2
let cosine = cos(-skew)
let sine = sin(-skew)

/// 画像の中心まわりに -skew だけ回して、紙をまっすぐに起こす。
func deskewed(_ x: Double, _ y: Double) -> (x: Double, y: Double) {
    let dx = x - centerX
    let dy = y - centerY
    return (centerX + dx * cosine - dy * sine, centerY + dx * sine + dy * cosine)
}

let fragments: [Fragment] = observations.map { observation, text in
    let box = observation.boundingBox // 正規化座標。原点は左下。
    // 箱の両端を起こしてから、改めて左右と中心を取り直す。
    let left = deskewed(Double(box.minX) * width, Double(box.midY) * height)
    let right = deskewed(Double(box.maxX) * width, Double(box.midY) * height)
    return Fragment(
        text: text,
        minX: min(left.x, right.x),
        maxX: max(left.x, right.x),
        midY: (left.y + right.y) / 2,
        height: Double(box.height) * height
    )
}

// MARK: - 行の組み立て

// 上から下へ。Vision の y は下が 0 なので降順で並べる。
let sorted = fragments.sorted { $0.midY > $1.midY }

// 行の高さは、文字の高さの中央値から決める。
// 固定値にすると、解像度や撮影距離が変わったときに行が割れたり繋がったりする。
let lineTolerance = max(medianHeight * 0.6, 2)

var lines: [[Fragment]] = []
var currentY = Double.nan
for fragment in sorted {
    if !currentY.isNaN, abs(currentY - fragment.midY) <= lineTolerance {
        lines[lines.count - 1].append(fragment)
        // 行の代表 y は、これまでに入れた断片の平均で更新する。
        // 先頭の1個に固定すると、長い行で少しずつずれていく。
        let members = lines[lines.count - 1]
        currentY = members.reduce(0) { $0 + $1.midY } / Double(members.count)
    } else {
        lines.append([fragment])
        currentY = fragment.midY
    }
}

// 行の中は左から右へ。
// 品名と金額のあいだは離れているので、空きが広ければ空白を多めに入れて
// 「品名   金額」の形に戻す。パーサーは行末の数値を金額として読む。
for line in lines {
    let ordered = line.sorted { $0.minX < $1.minX }
    var rendered = ""
    var previousMaxX: Double? = nil
    for fragment in ordered {
        if let previous = previousMaxX {
            rendered += (fragment.minX - previous) > width * 0.08 ? "   " : " "
        }
        rendered += fragment.text
        previousMaxX = fragment.maxX
    }
    let trimmed = rendered.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty { print(trimmed) }
}
