import AVFAudio

@MainActor
final class SpeechService: NSObject, @preconcurrency AVSpeechSynthesizerDelegate {
    nonisolated static let promptLifetime: TimeInterval = 5

    private struct Prompt {
        let text: String
        let expiresAt: TimeInterval
    }

    private var synthesizer: AVSpeechSynthesizer?
    private let uptime: () -> TimeInterval
    private let availableVoices: () -> [AVSpeechSynthesisVoice]
    private var queue: [Prompt] = []
    private var current: AVSpeechUtterance?
    private var playbackTimeout: Task<Void, Never>?
    private var sessionActive = false
    private(set) var interrupted = false
    private var voice: AVSpeechSynthesisVoice?
    var changed: () -> Void = {}
    private(set) var foreground = true
    private(set) var speech = "尚未播放"
    private(set) var starts = 0
    private(set) var finishes = 0

    init(uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         availableVoices: @escaping () -> [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices) {
        self.uptime = uptime
        self.availableVoices = availableVoices
        super.init()
        refreshVoice()
        let notifications = NotificationCenter.default
        notifications.addObserver(self, selector: #selector(audioInterrupted),
                                  name: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance())
        if #available(iOS 17, *) {
            notifications.addObserver(self, selector: #selector(voicesChanged),
                                      name: AVSpeechSynthesizer.availableVoicesDidChangeNotification, object: nil)
        }
    }

    var ready: Bool { voice != nil }
    var status: String {
        voice.map { "iOS 中文語音可用（\($0.language)）；請試聽確認輸出" }
            ?? "缺少中文聲音，請依 iOS 語音說明下載後重新檢查"
    }
    var audio: String {
        let session = AVAudioSession.sharedInstance()
        return "音量 \(Int(session.outputVolume * 100))% · " + session.currentRoute.outputs.map(\.portName).joined(separator: "、")
    }
    var currentText: String? { current?.speechString }
    var queuedCount: Int { queue.count }

    func refreshVoice() {
        let voices = availableVoices()
        voice = voices.first { $0.language == "zh-TW" } ?? voices.first { $0.language.hasPrefix("zh-") }
        changed()
    }

    @objc nonisolated private func voicesChanged() {
        Task { @MainActor [weak self] in self?.refreshVoice() }
    }

    @objc private func audioInterrupted(_ notification: Notification) {
        guard let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: value) else { return }
        switch type {
        case .began:
            // The system can deliver a suspension notification after the scene has returned.
            if notification.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool == true { return }
            interrupted = foreground
            sessionActive = false
            discardPlayback()
            if foreground { updateStatus("音訊已中斷，等待系統釋放音訊") }
        case .ended:
            guard interrupted else { return }
            interrupted = false
            if foreground { updateStatus("音訊已恢復，等待下一則導航指示") }
        @unknown default: break
        }
    }

    func setForeground(_ active: Bool) {
        guard foreground != active else { return }
        foreground = active
        if active {
            // iOS does not always deliver an ended event after leaving the app.
            // A new prompt must acquire the audio session before it can speak.
            interrupted = false
            refreshVoice()
        } else {
            discardPlayback()
            releaseSession()
            updateStatus("已暫停語音，返回 App 後等待新指示")
        }
    }

    func speak(_ text: String, priority: Bool = false, queueIfBusy: Bool = true,
               validFor: TimeInterval = SpeechService.promptLifetime) {
        guard foreground, !interrupted, !text.isEmpty, text.count <= 1000, validFor > 0 else { return }
        guard ready else { updateStatus("無法播放：缺少中文聲音"); return }
        if priority { discardPlayback() }
        let now = uptime()
        queue.removeAll { $0.expiresAt <= now }
        // Only hand one utterance to iOS at a time so a queued prompt can expire before it starts.
        if current != nil && (!queueIfBusy || queue.count >= 2) { return }
        queue.append(Prompt(text: text, expiresAt: now + validFor))
        playNext()
    }

    func stop() {
        discardPlayback()
        releaseSession()
        if foreground && !interrupted { updateStatus("語音已停止") }
    }

    private func discardPlayback() {
        queue.removeAll()
        let hadCurrent = current != nil
        clearCurrent()
        synthesizer?.delegate = nil
        if hadCurrent { synthesizer?.stopSpeaking(at: .immediate) }
        synthesizer = nil
    }

    private func clearCurrent() {
        current = nil
        playbackTimeout?.cancel()
        playbackTimeout = nil
    }

    private func releaseSession() {
        guard sessionActive else { return }
        sessionActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func updateStatus(_ value: String) {
        guard speech != value else { return }
        speech = value
        changed()
    }

    private func playNext() {
        guard current == nil, foreground, !interrupted else { return }
        let now = uptime()
        queue.removeAll { $0.expiresAt <= now }
        guard !queue.isEmpty, let voice else {
            queue.removeAll()
            releaseSession()
            return
        }
        do {
            if !sessionActive {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
                try session.setActive(true)
                sessionActive = true
            }
            let utterance = AVSpeechUtterance(string: queue.removeFirst().text)
            utterance.voice = voice
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
            current = utterance
            updateStatus("已送出語音，等待 iOS 播放")
            playbackTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                guard let self else { return }
                self.stop()
                self.updateStatus("語音播放逾時，可試聽以檢查輸出")
            }
            let synthesizer = self.synthesizer ?? AVSpeechSynthesizer()
            self.synthesizer = synthesizer
            synthesizer.delegate = self
            synthesizer.speak(utterance)
        } catch {
            discardPlayback()
            releaseSession()
            updateStatus("語音輸出失敗：\(error.localizedDescription)")
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard current === utterance else { return }
        starts += 1
        updateStatus("正在播放")
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard current === utterance else { return }
        clearCurrent()
        finishes += 1
        updateStatus("iOS 已完成播放；實際聲音請以裝置輸出確認")
        playNext()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard current === utterance else { return }
        clearCurrent()
        updateStatus("iOS 已取消這則語音")
        playNext()
    }
}
