import AppKit
import Foundation

struct Failure: Codable {
    let check: String
    let expected: String
    let actual: String
}

struct Report: Codable {
    let format: Int
    let image: String
    let scheme: String
    let state: String
    let widthPixels: Int
    let heightPixels: Int
    let topHeroPixels: Int
    let lowerBrandPixels: Int
    let lowerBrandWidthPixels: Int
    let lowerBrandHeightPixels: Int
    let failures: [Failure]
    let status: String
}

guard CommandLine.arguments.count == 4 else {
    fputs("usage: detector image.png light|dark state\n", stderr)
    exit(64)
}

let imagePath = CommandLine.arguments[1]
let scheme = CommandLine.arguments[2]
let state = CommandLine.arguments[3]
guard scheme == "light" || scheme == "dark",
      let bytes = try? Data(contentsOf: URL(fileURLWithPath: imagePath)),
      let bitmap = NSBitmapImageRep(data: bytes) else {
    fputs("unreadable image or scheme\n", stderr)
    exit(65)
}

let width = bitmap.pixelsWide
let height = bitmap.pixelsHigh
var failures: [Failure] = []

let expectedHeight = state.hasPrefix("minimum-") ? 732 : 900
if width != 640 || height != expectedHeight {
    failures.append(Failure(
        check: "KR-SIZE",
        expected: "640x\(expectedHeight) px",
        actual: "\(width)x\(height) px"
    ))
}

var topHeroPixels = 0
var lowerBrandPixels = 0
var brandMinimumX = width
var brandMaximumX = -1
var brandMinimumY = height
var brandMaximumY = -1

for x in 0..<width {
    for y in 0..<min(180, height) {
        let color = (bitmap.colorAt(x: x, y: y) ?? .clear)
            .usingColorSpace(.deviceRGB) ?? .clear
        if color.alphaComponent > 0.5
            && color.blueComponent > 0.45
            && color.blueComponent > color.redComponent * 1.35 {
            topHeroPixels += 1
        }
    }

    for y in max(0, height - 80)..<height where x >= 240 && x <= 400 {
        let color = (bitmap.colorAt(x: x, y: y) ?? .clear)
            .usingColorSpace(.deviceRGB) ?? .clear
        if color.alphaComponent > 0.5
            && color.greenComponent > 0.65
            && color.blueComponent > 0.75
            && color.redComponent < 0.55 {
            lowerBrandPixels += 1
            brandMinimumX = min(brandMinimumX, x)
            brandMaximumX = max(brandMaximumX, x)
            brandMinimumY = min(brandMinimumY, y)
            brandMaximumY = max(brandMaximumY, y)
        }
    }
}

let lowerBrandWidth = brandMaximumX >= brandMinimumX
    ? brandMaximumX - brandMinimumX + 1
    : 0
let lowerBrandHeight = brandMaximumY >= brandMinimumY
    ? brandMaximumY - brandMinimumY + 1
    : 0

if state == "contract" && topHeroPixels < 1_000 {
    failures.append(Failure(
        check: "KR-HERO",
        expected: "hero present in top 180 px",
        actual: "\(topHeroPixels) pixels"
    ))
}

if ["contract", "scroll-bottom", "minimum-bottom"].contains(state)
    && (lowerBrandPixels < 140
        || lowerBrandWidth < 100
        || lowerBrandHeight < 9
        || brandMaximumY > height - 16) {
    failures.append(Failure(
        check: "KR-FOOTER",
        expected: "KRAKO footer fully visible after Advanced at document bottom",
        actual: "\(lowerBrandPixels) pixels, \(lowerBrandWidth)x\(lowerBrandHeight) px"
    ))
}

if ["scroll-top", "minimum-top"].contains(state) && lowerBrandPixels >= 140 {
    failures.append(Failure(
        check: "KR-FOOTER-FLOW",
        expected: "KRAKO footer remains in document flow after Advanced",
        actual: "footer is visible while the overflow document is at its top"
    ))
}

func rgb(_ x: Int, _ y: Int) -> [CGFloat] {
    let c = (bitmap.colorAt(x: x, y: y) ?? .clear).usingColorSpace(.deviceRGB) ?? .clear
    return [c.redComponent, c.greenComponent, c.blueComponent]
}
// Left outer canvas stays clear of scrolling cards and hero artwork.
let titlebar = rgb(8, 20)
let canvas = rgb(8, 55)
let seam = zip(titlebar, canvas).map { abs($0 - $1) }.max() ?? 1
if seam > 0.035 {
    failures.append(Failure(check: "KR-TITLEBAR-SEAM", expected: "channel difference <= 0.035", actual: "\(seam)"))
}
if scheme == "dark" {
    let canvasSample = rgb(8, min(300, height - 1))
    let figmaCanvas: [CGFloat] = [3.0 / 255.0, 20.0 / 255.0, 32.0 / 255.0] // #031420
    let delta = zip(canvasSample, figmaCanvas).map { abs($0 - $1) }.max() ?? 1
    if delta > 0.035 {
        failures.append(Failure(
            check: "KR-DARK-CANVAS",
            expected: "Figma R10 canvas #031420 within 0.035/channel",
            actual: "max delta \(delta)"
        ))
    }
}

let report = Report(
    format: 2,
    image: imagePath,
    scheme: scheme,
    state: state,
    widthPixels: width,
    heightPixels: height,
    topHeroPixels: topHeroPixels,
    lowerBrandPixels: lowerBrandPixels,
    lowerBrandWidthPixels: lowerBrandWidth,
    lowerBrandHeightPixels: lowerBrandHeight,
    failures: failures,
    status: failures.isEmpty ? "PASS" : "FAIL"
)
let json = try JSONEncoder().encode(report)
print(String(decoding: json, as: UTF8.self))
fflush(stdout)
if !failures.isEmpty { exit(2) }
