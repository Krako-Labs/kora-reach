import Foundation
import Vision

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// Keep local screen reading off a GPU that may be serving the user's models.
request.usesCPUOnly = true
if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(url:URL(fileURLWithPath:CommandLine.arguments[1]))
try handler.perform([request])
let hits = (request.results ?? []).filter {
    guard let word = $0.topCandidates(1).first else { return false }
    return word.confidence >= 0.85 && word.string == CommandLine.arguments[2]
}
if hits.count == 1 {
    let rect = hits[0].boundingBox
    print("[\(rect.midX),\(1 - rect.midY)]")
} else { print("null") }
