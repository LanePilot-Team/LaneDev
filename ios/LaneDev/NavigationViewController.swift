import UIKit
import WebKit
import CoreLocation
import OSLog

final class NavigationViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    private(set) var webView: WKWebView!
    let locations = LocationService()
    let speech = SpeechService()
    private(set) var navigating = false
    private var webReady = false
    private var geocoder = CLGeocoder()
    private var errorOverlay: UIView?
    #if DEBUG && targetEnvironment(simulator)
    private let sourcePicker = UISegmentedControl(items: ["Core Location", "虛擬定位"])
    private let playButton = UIButton(type: .system)
    #endif

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        openBundle()
    }

    private func openBundle() {
        errorOverlay?.removeFromSuperview()
        errorOverlay = nil
        if let webView {
            webView.load(URLRequest(url: BundleSchemeHandler.origin))
            return
        }
        guard let root = Bundle.main.url(forResource: "public", withExtension: nil),
              let bridge = Bundle.main.url(forResource: "Bridge", withExtension: "js"),
              let script = try? String(contentsOf: bridge, encoding: .utf8) else {
            showError(BundleSchemeHandler.ValidationError.missing.localizedDescription)
            return
        }
        let handler = BundleSchemeHandler(root: root)
        do { try handler.validateBundle() }
        catch { showError(error.localizedDescription); return }

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "LaneNative")
        config.userContentController.addUserScript(WKUserScript(source: "document.documentElement.dataset.platform='ios'",
            injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG && targetEnvironment(simulator)
        config.userContentController.addUserScript(WKUserScript(source: """
            Object.defineProperty(window, 'LaneSimulator', {value: Object.freeze({setRoute: coords =>
              window.LaneNative.postMessage(JSON.stringify({type:'simRoute', coords}))})});
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        config.setURLSchemeHandler(handler, forURLScheme: "lanedev")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        var topAnchor = view.safeAreaLayoutGuide.topAnchor
        #if DEBUG && targetEnvironment(simulator)
        sourcePicker.selectedSegmentIndex = 0
        sourcePicker.addTarget(self, action: #selector(sourceChanged), for: .valueChanged)
        sourcePicker.accessibilityIdentifier = "location-source"
        playButton.setTitle("沿路線前進", for: .normal)
        playButton.addTarget(self, action: #selector(play), for: .touchUpInside)
        let deviation = UIButton(type: .system)
        deviation.setTitle("偏航", for: .normal)
        deviation.addTarget(self, action: #selector(deviate), for: .touchUpInside)
        let bar = UIStackView(arrangedSubviews: [sourcePicker, playButton, deviation])
        bar.spacing = 8; bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)
        NSLayoutConstraint.activate([bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            bar.topAnchor.constraint(equalTo: topAnchor), bar.heightAnchor.constraint(equalToConstant: 40)])
        topAnchor = bar.bottomAnchor
        #endif
        NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor), webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)])
        locations.emit = { [weak self] in self?.emit($0) }
        locations.changed = { [weak self] in self?.status() }
        speech.changed = { [weak self] in self?.status() }
        webView.load(URLRequest(url: BundleSchemeHandler.origin))
    }

    #if DEBUG && targetEnvironment(simulator)
    @objc private func sourceChanged() {
        if !locations.selectVirtual(sourcePicker.selectedSegmentIndex == 1) {
            sourcePicker.selectedSegmentIndex = locations.virtual ? 1 : 0
            showNotice("請先結束導航，再切換定位來源")
        }
        status()
    }
    @objc private func play() {
        guard locations.virtual, navigating else { showNotice("先選虛擬定位、規劃路線並開始導航，再前進"); return }
        locations.simulator.togglePlayback()
        playButton.setTitle(locations.simulator.playing ? "暫停前進" : "沿路線前進", for: .normal)
    }
    @objc private func deviate() { if locations.virtual && navigating { locations.simulator.deviate() } }
    #endif

    func setForeground(_ active: Bool) {
        if active { speech.refreshVoice() }
        locations.setForeground(active)
        speech.setForeground(active)
        UIApplication.shared.isIdleTimerDisabled = active && navigating
        Logger(subsystem: "tw.lanepilot.lanedev.ios", category: "Lifecycle").info("foreground=\(active) locationUpdating=\(self.locations.updating) speechForeground=\(self.speech.foreground) idleDisabled=\(UIApplication.shared.isIdleTimerDisabled)")
        if active { status() }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "lanedev", message.frameInfo.request.url?.host == "app",
              let text = message.body as? String, text.utf8.count < 2_000_000,
              let data = text.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        handle(command)
    }
    private func handle(_ command: [String: Any]) {
        switch command["type"] as? String {
        case "status": status()
        case "requestLocation": locations.requestPermission(id: command["id"] as? String ?? "")
        case "locationStart": if let id = command["id"] as? Int { locations.start(id: id) }
        case "locationStop": if let id = command["id"] as? Int { locations.stop(id: id) }
        case "speak": speech.speak(command["text"] as? String ?? "", priority: command["priority"] as? Bool ?? false)
        case "stopSpeech": speech.stop()
        case "navigation": setNavigation(command["active"] as? Bool ?? false)
        case "ttsTest": speech.stop(); speech.speak("語音導航測試，前方路口請右轉。")
        case "ttsRefresh": speech.refreshVoice(); status()
        case "ttsSettings", "ttsInstall": showNotice("iOS 聲音由系統管理。請到「設定 → 輔助使用 → 朗讀與語音」下載中文聲音，再回到 LaneDev 試聽。")
        case "appSettings", "locationSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case "reverseGeocode": reverseGeocode(command)
        #if DEBUG && targetEnvironment(simulator)
        case "simRoute": if let coords = command["coords"] as? [[Double]] { locations.simulator.setRoute(coords) }
        #endif
        default: break
        }
    }
    private func setNavigation(_ active: Bool) {
        navigating = active
        UIApplication.shared.isIdleTimerDisabled = locations.foreground && active
        #if DEBUG && targetEnvironment(simulator)
        locations.navigationActive = active
        if !active { locations.simulator.pause(); playButton.setTitle("沿路線前進", for: .normal) }
        #endif
        if !active { speech.stop() }
    }
    private func reverseGeocode(_ command: [String: Any]) {
        guard let id = command["id"] as? String, let lat = command["lat"] as? Double,
              let lng = command["lng"] as? Double, lat.isFinite, lng.isFinite,
              abs(lat) <= 90, abs(lng) <= 180 else { return }
        // Optional online enrichment. The local search and route never wait for this.
        guard !geocoder.isGeocoding else { emit(["type": "addressResult", "id": id, "address": ""]); return }
        geocoder.reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lng), preferredLocale: Locale(identifier: "zh_TW")) { [weak self] places, _ in
            let p = places?.first
            let address = [p?.administrativeArea, p?.locality, p?.subLocality, p?.thoroughfare, p?.subThoroughfare].compactMap { $0 }.joined()
            self?.emit(["type": "addressResult", "id": id, "address": address])
        }
    }
    func emit(_ data: [String: Any]) {
        guard webReady, let webView, webView.url?.scheme == "lanedev", webView.url?.host == "app",
              let bytes = try? JSONSerialization.data(withJSONObject: data, options: [.fragmentsAllowed]),
              let json = String(data: bytes, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('lane-native',{detail:\(json)}))", completionHandler: nil)
    }
    func status() {
        emit(["type": "status", "ttsReady": speech.ready, "tts": speech.status,
            "speech": speech.speech, "audio": speech.audio, "location": locations.locationStatus,
            "compass": CLLocationManager.headingAvailable() ? "前景使用 iOS 方向感測器；低精度時隱藏朝向" : "方向感測器不可用，使用 GPS 行進方向"])
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        webReady = false; locations.reset(); setNavigation(false)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { webReady = true; status() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showError(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showError(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        locations.reset(); setNavigation(false)
        showError("導航畫面已被系統終止，請重新載入並規劃路線。")
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // Native bridge is never exposed to remote documents, subframes or popups.
        decisionHandler(url.scheme == "lanedev" && url.host == "app" && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "LaneDev", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
    private func showNotice(_ text: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "LaneDev", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
    private func showError(_ text: String) {
        errorOverlay?.removeFromSuperview()
        let overlay = UIView()
        overlay.backgroundColor = .systemBackground
        overlay.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel()
        label.numberOfLines = 0
        label.textAlignment = .center
        label.text = text
        let retry = UIButton(type: .system)
        retry.setTitle("重新載入", for: .normal)
        retry.addAction(UIAction { [weak self] _ in self?.openBundle() }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [label, retry])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(overlay)
        overlay.addSubview(stack)
        errorOverlay = overlay
        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.trailingAnchor, constant: -24),
        ])
    }
}
