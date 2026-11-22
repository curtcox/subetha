import AVFoundation

/// The platform half of the sound link: plays modem samples through AVAudioEngine and hands
/// microphone buffers to a callback. Everything else (modulation, scanning, gossip) is
/// SubEthaCore's `AudioLink`.
final class AppleAudio {
    /// The rate `play(_:done:)` takes samples at (the modem's native rate).
    static let playbackRate: Double = 48_000

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: AppleAudio.playbackRate, channels: 1)!
    private var tapping = false

    init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        // Measurement mode turns off voice processing (AGC, noise suppression) that smears tones.
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker])
        try? session.setPreferredSampleRate(Self.playbackRate)
        try session.setActive(true)
    }

    /// Plays `samples` (mono, -1...1, at `playbackRate`) and calls `done` when they've played.
    func play(_ samples: [Float], done: @escaping () -> Void) {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return done() }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for (i, s) in samples.enumerated() { channel[i] = s }
        do {
            try activate()
            if !engine.isRunning { try engine.start() }
        } catch {
            return done()
        }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in done() }
        player.play()
    }

    /// Starts recording; `onSamples` gets mono buffers and their sample rate on the audio thread.
    /// Needs microphone permission (NSMicrophoneUsageDescription).
    func record(_ onSamples: @escaping ([Float], Int) -> Void) throws {
        guard !tapping else { return }
        try activate()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        let rate = Int(inputFormat.sampleRate)
        let wasRunning = engine.isRunning
        if wasRunning { engine.stop() }
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
            guard let channel = buffer.floatChannelData?[0] else { return }
            onSamples(Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))), rate)
        }
        tapping = true
        try engine.start()
    }

    func stopRecording() {
        guard tapping else { return }
        engine.inputNode.removeTap(onBus: 0)
        tapping = false
    }
}
