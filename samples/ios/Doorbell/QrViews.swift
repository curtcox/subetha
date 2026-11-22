import AVFoundation
import CoreImage.CIFilterBuiltins
import SubEthaCore
import SwiftUI

/// One QR code for `text`, one pixel per module (scale it up without smoothing).
func qrImage(_ text: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "L"
    guard let output = filter.outputImage,
          let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
    return UIImage(cgImage: cg)
}

/// Shows a `QrSender`'s frames one after another, forever (spec §11.2). A camera that starts
/// late or misses frames just keeps scanning.
struct AnimatedQrView: View {
    let sender: QrSender
    var framesPerSecond: Double = 8
    @State private var start = Date()

    var body: some View {
        TimelineView(.periodic(from: start, by: 1 / framesPerSecond)) { context in
            let seq = Int(context.date.timeIntervalSince(start) * framesPerSecond)
            if let image = qrImage(sender.text(seq)) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .padding(12)
                    .background(Color.white) // quiet zone, whatever the theme
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// Camera preview that reports the text of every QR code it sees (new strings only) to
/// `onText`, on a background queue. Needs NSCameraUsageDescription and camera permission.
struct QrScannerView: UIViewRepresentable {
    let onText: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onText: onText) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        context.coordinator.start(in: view)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "org.subetha.sample.qr")
        private let onText: (String) -> Void
        private var last: String?

        init(onText: @escaping (String) -> Void) { self.onText = onText }

        func start(in view: PreviewView) {
            view.previewLayer.session = session
            view.previewLayer.videoGravity = .resizeAspectFill
            queue.async { self.configure() }
        }

        private func configure() {
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
            session.beginConfiguration()
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: queue)
                output.metadataObjectTypes = [.qr] // only after adding the output
            }
            session.commitConfiguration()
            session.startRunning()
        }

        func stop() {
            queue.async { self.session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            for case let code as AVMetadataMachineReadableCodeObject in metadataObjects {
                guard let text = code.stringValue, text != last else { continue }
                last = text
                onText(text)
            }
        }
    }
}
