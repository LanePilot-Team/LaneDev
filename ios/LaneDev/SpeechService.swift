import AVFAudio

@MainActor
final class SpeechService: NSObject, @preconcurrency AVSpeechSynthesizerDelegate {
    let synthesizer = AVSpeechSynthesizer()
    var changed: () -> Void = {}
    private(set) var foreground = true
    private(set) var speech = "尚未播放"
    private var pending = Set<ObjectIdentifier>()
    private(set) var starts = 0
    private(set) var finishes = 0
    private var voice: AVSpeechSynthesisVoice?
    func refreshVoice() {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        voice = voices.first { $0.language == "zh-TW" } ?? voices.first { $0.language.hasPrefix("zh-") }
    }
    var ready: Bool { voice != nil }
    var status: String { voice.map { "iOS 中文語音可用（\($0.language)）；請試聽確認輸出" }
        ?? "缺少中文語音；請到 iOS 設定 → 輔助使用 → 朗讀與語音下載中文聲音" }
    var audio: String {
        let session = AVAudioSession.sharedInstance()
        return "音量 \(Int(session.outputVolume * 100))% · " + session.currentRoute.outputs.map(\.portName).joined(separator: "、")
    }
    override init() {
        super.init()
        refreshVoice()
        synthesizer.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
    }
    @objc private func interrupted() { stop(); speech = "音訊已中斷，等待下一則導航指示"; changed() }
    func setForeground(_ active: Bool) { foreground = active; if !active { stop() }; changed() }
    func speak(_ text: String, priority: Bool = false, queueIfBusy: Bool = true) {
        guard foreground, !text.isEmpty, text.count <= 1000 else { return }
        guard let voice else { speech = "無法播放：缺少中文聲音"; changed(); return }
        if priority { stop() }
        guard pending.count < (queueIfBusy ? 3 : 1) else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
            try session.setActive(true)
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = voice
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
            pending.insert(ObjectIdentifier(utterance))
            speech = "已送出語音，等待 iOS 播放"
            synthesizer.speak(utterance)
        } catch { speech = "語音輸出失敗：\(error.localizedDescription)" }
        changed()
    }
    func stop() {
        pending.removeAll()
        synthesizer.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        speech = "語音已停止"
        changed()
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard pending.contains(ObjectIdentifier(utterance)) else { return }
        starts += 1; speech = "正在播放"; changed()
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard pending.remove(ObjectIdentifier(utterance)) != nil else { return }
        finishes += 1; speech = "iOS 已完成播放；實際聲音請以裝置輸出確認"
        if pending.isEmpty { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        changed()
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        pending.remove(ObjectIdentifier(utterance)); changed()
    }
}
