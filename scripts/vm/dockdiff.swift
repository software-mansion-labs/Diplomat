// Runs on the host: how much of the Dock changed between two screenshots of the test VM.
//   dockdiff <before.png> <after.png>   prints the percentage of pixels in the screen's
//                                       bottom tenth that differ, to one decimal.
import AppKit

func pixels(_ path: String) -> (data: [UInt8], width: Int, height: Int) {
    guard let image = NSImage(contentsOfFile: path),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write(Data("dockdiff: cannot read \(path)\n".utf8))
        exit(2)
    }
    var data = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
    let ctx = CGContext(data: &data, width: cg.width, height: cg.height, bitsPerComponent: 8,
                        bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    return (data, cg.width, cg.height)
}

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write(Data("usage: dockdiff <before.png> <after.png>\n".utf8))
    exit(2)
}
let a = pixels(args[1]), b = pixels(args[2])
guard a.width == b.width, a.height == b.height else {
    FileHandle.standardError.write(Data("dockdiff: the screenshots differ in size\n".utf8))
    exit(2)
}
// Rows run top to bottom; the Dock is in the last tenth.
let top = a.height - a.height / 10
var changed = 0
for i in stride(from: top * a.width * 4, to: a.data.count, by: 4) {
    let d = (0..<3).map { abs(Int(a.data[i + $0]) - Int(b.data[i + $0])) }.max()!
    if d > 40 { changed += 1 }
}
print(String(format: "%.1f", Double(changed) * 100 / Double(a.width * (a.height - top))))
