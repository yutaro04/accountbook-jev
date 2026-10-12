// Apple のオンデバイス LLM（Foundation Models）で費目を分類し、時間と正解率を測る。
//
//   swiftc -O -o apple apple.swift && ./apple > apple-result.json
//
// 2つのやり方を測る。これを分けないと Jev との比較が不公平になる。
//
//   free   … 候補を文章で並べて、文字列で答えてもらう
//            （このアプリが元々やっていたやり方。候補外の答えが返りうる）
//   guided … @Generable の enum で選択肢を型に縛る
//            （Foundation Models にも制約付き生成はある。公平に測る）
//
// guided が成立するのは **費目がコンパイル時に決まっている場合だけ**。
// 家計簿の費目はユーザーが編集できるので、実際のアプリでは enum にできない。
// そこが Jev の criteria（実行時に組み立てる）との本当の差になる。

import FoundationModels
import Foundation

// MARK: - 入力

struct Dataset: Decodable {
    struct Item: Decodable {
        let name: String
        let amount: Int
        let label: String
        let ambiguous: Bool?
        let accept: [String]?
    }
    struct Receipt: Decodable {
        let id: String
        let store: String
        let genre: String
        let items: [Item]
    }
    let categories: [String]
    let receipts: [Receipt]
}

// enum はコンパイル時に固定。データセットの12費目と手で揃えてある。
@Generable
enum Category: String, CaseIterable {
    case 食費, 外食, カフェ, 日用品
    case 家電家具 = "家電・家具"
    case 交通費, 水道光熱費, 通信費
    case 趣味娯楽 = "趣味・娯楽"
    case 衣服, 医療費, その他
}

@Generable
struct Pick {
    @Guide(description: "この品目が当てはまる家計簿の費目")
    var category: Category
}

// MARK: - 出力

struct Measurement: Encodable {
    let receipt: String
    let item: String
    let label: String
    let answer: String
    let correct: Bool
    let inVocabulary: Bool   // 候補の中の語を返したか
    let ms: Int
}

struct Output: Encodable {
    let mode: String
    let model: String
    let measurements: [Measurement]
    let totalMs: Int
    let warmupMs: Int
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("apple: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

let datasetURL = URL(fileURLWithPath: "dataset.json")
guard let data = try? Data(contentsOf: datasetURL),
      let dataset = try? JSONDecoder().decode(Dataset.self, from: data)
else { fail("dataset.json を読めません") }

guard case .available = SystemLanguageModel.default.availability else {
    fail("オンデバイスモデルが使えません（Apple Intelligence の設定を確認）")
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "free"
guard mode == "free" || mode == "guided" else { fail("usage: apple [free|guided]") }

/// 答えが正解かどうか。曖昧な品目は accept のどれかに当たれば正解。
func isCorrect(_ answer: String, _ item: Dataset.Item) -> Bool {
    let normalized = answer.trimmingCharacters(in: .whitespacesAndNewlines)
    if let accept = item.accept, item.ambiguous == true {
        return accept.contains(normalized)
    }
    return normalized == item.label
}

let categoryList = dataset.categories.joined(separator: " / ")

/// free モードの指示。候補を文章で渡すしかない。
let freeInstructions = """
あなたは家計簿アプリの分類器です。
レシートの品目を、次の費目のどれか1つに分類してください。

費目: \(categoryList)

答えは費目名だけを出力してください。説明や記号は書かないでください。
"""

let guidedInstructions = """
あなたは家計簿アプリの分類器です。
レシートの品目を、提示された費目のどれか1つに分類してください。
"""

func prompt(_ item: Dataset.Item, store: String, genre: String) -> String {
    """
    店: \(store)（\(genre)）
    品目: \(item.name)
    金額: \(item.amount)円

    この品目の費目は？
    """
}

let semaphore = DispatchSemaphore(value: 0)
var measurements: [Measurement] = []
var warmupMs = 0
var totalMs = 0

Task {
    // 1回目はモデルの読み込みを含むので、計測から外す。
    // これを入れないと最初の品目だけ数秒になって、比較が歪む。
    let warmStart = Date()
    do {
        let warm = LanguageModelSession(instructions: mode == "free" ? freeInstructions : guidedInstructions)
        if mode == "free" {
            _ = try await warm.respond(to: "店: テスト（スーパー）\n品目: りんご\n金額: 100円\n\nこの品目の費目は？")
        } else {
            _ = try await warm.respond(
                to: "店: テスト（スーパー）\n品目: りんご\n金額: 100円\n\nこの品目の費目は？",
                generating: Pick.self)
        }
    } catch {
        fail("ウォームアップに失敗: \(error)")
    }
    warmupMs = Int(Date().timeIntervalSince(warmStart) * 1000)

    let runStart = Date()
    for receipt in dataset.receipts {
        for item in receipt.items {
            // 品目ごとに session を作り直す。
            // 使い回すと前の品目が文脈に残り、順番で結果が変わってしまう。
            let session = LanguageModelSession(
                instructions: mode == "free" ? freeInstructions : guidedInstructions)
            let text = prompt(item, store: receipt.store, genre: receipt.genre)

            let start = Date()
            var answer = ""
            do {
                if mode == "free" {
                    answer = try await session.respond(to: text).content
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                } else {
                    answer = try await session.respond(to: text, generating: Pick.self)
                        .content.category.rawValue
                }
            } catch {
                answer = "<エラー: \(error.localizedDescription.prefix(40))>"
            }
            let ms = Int(Date().timeIntervalSince(start) * 1000)

            measurements.append(Measurement(
                receipt: receipt.id,
                item: item.name,
                label: item.label,
                answer: answer,
                correct: isCorrect(answer, item),
                inVocabulary: dataset.categories.contains(
                    answer.trimmingCharacters(in: .whitespacesAndNewlines)),
                ms: ms))

            FileHandle.standardError.write(
                "  \(receipt.id) / \(item.name) → \(answer) (\(ms)ms)\n".data(using: .utf8)!)
        }
    }
    totalMs = Int(Date().timeIntervalSince(runStart) * 1000)
    semaphore.signal()
}
semaphore.wait()

let output = Output(
    mode: mode,
    model: "Apple Foundation Models (オンデバイス)",
    measurements: measurements,
    totalMs: totalMs,
    warmupMs: warmupMs)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
print(String(data: try encoder.encode(output), encoding: .utf8)!)
