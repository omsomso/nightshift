// Draws the Nightshift app icon (1024×1024 PNG): a crescent moon and stars on a night-blue
// rounded square. Run by app/icon/make-icns.sh, which builds AppIcon.icns from it.
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments[1]
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: rep) else { fatalError("no context") }
NSGraphicsContext.current = context
let cg = context.cgContext

// macOS icon grid: the shape is inset from the canvas and has rounded corners.
let inset: CGFloat = 100
let rect = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let shape = CGPath(roundedRect: rect, cornerWidth: 185, cornerHeight: 185, transform: nil)

// Soft drop shadow, then the night gradient.
cg.saveGState()
cg.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: CGColor(gray: 0, alpha: 0.35))
cg.addPath(shape); cg.setFillColor(CGColor(red: 0.11, green: 0.15, blue: 0.27, alpha: 1)); cg.fillPath()
cg.restoreGState()
cg.saveGState()
cg.addPath(shape); cg.clip()
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
    CGColor(red: 0.20, green: 0.24, blue: 0.47, alpha: 1), CGColor(red: 0.08, green: 0.11, blue: 0.22, alpha: 1)] as CFArray,
    locations: [0, 1])!
cg.drawLinearGradient(gradient, start: CGPoint(x: size / 2, y: size - inset), end: CGPoint(x: size / 2, y: inset), options: [])

// Stars.
cg.setFillColor(CGColor(red: 0.80, green: 0.84, blue: 0.97, alpha: 0.9))
for (x, y, r) in [(250.0, 720.0, 9.0), (330.0, 590.0, 6.0), (220.0, 470.0, 7.0), (420.0, 780.0, 5.0), (300.0, 300.0, 6.0), (720.0, 260.0, 8.0)] {
    cg.fillEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
}

// Crescent: inside the moon's disc, fill everything except an offset disc.
let c = CGPoint(x: 560, y: 520), radius: CGFloat = 255
cg.saveGState()
cg.addEllipse(in: CGRect(x: c.x - radius, y: c.y - radius, width: 2 * radius, height: 2 * radius))
cg.clip()
let cut = CGMutablePath()
cut.addRect(CGRect(x: 0, y: 0, width: size, height: size))
cut.addEllipse(in: CGRect(x: c.x - radius + 120, y: c.y - radius + 95, width: 2 * radius, height: 2 * radius))
cg.addPath(cut)
cg.setFillColor(CGColor(red: 0.95, green: 0.64, blue: 0.23, alpha: 1))
cg.fillPath(using: .evenOdd)
cg.restoreGState()
cg.restoreGState()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
