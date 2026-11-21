import UIKit
import WebKit
import CoreLocation
import OSLog

final class NavigationViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    private(set) var webView: WKWebView!
    let locations = LocationService()
    let speech = SpeechService()
    private let googlePlaces = GooglePlacesService()
    private(set) var navigating = false
    private var webReady = false
    private var foregroundSince = Date()
    private let geocoder = CLGeocoder()
    private var documentGeneration = 0
    private var errorOverlay: UIView?

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
        config.userContentController.add(BridgeMessageHandler(self), name: "LaneNative")
        config.userContentController.addUserScript(WKUserScript(source:
            "Object.defineProperty(window, 'LaneGooglePlacesAvailable', {value: \(googlePlaces.configured)})",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: "document.documentElement.dataset.platform='ios'",
            injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)])
        locations.emit = { [weak self] in self?.emit($0) }
        locations.changed = { [weak self] in self?.status() }
        speech.changed = { [weak self] in self?.status() }
        webView.load(URLRequest(url: BundleSchemeHandler.origin))
    }

    func setForeground(_ active: Bool) {
        if active && !locations.foreground { foregroundSince = Date() }
        speech.setForeground(active)
        locations.setForeground(active)
        UIApplication.shared.isIdleTimerDisabled = active && navigating
        Logger(subsystem: "tw.lanepilot.lanedev.ios", category: "Lifecycle").info("foreground=\(active) locationUpdating=\(self.locations.updating) speechForeground=\(self.speech.foreground) idleDisabled=\(UIApplication.shared.isIdleTimerDisabled)")
        if active { status() }
    }

    func disconnect() {
        setForeground(false)
        resetDocument()
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "LaneNative")
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard webReady, message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "lanedev", message.frameInfo.request.url?.host == "app",
              let text = message.body as? String, text.utf8.count < 2_000_000,
              let data = text.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        handle(command)
    }
    private func handle(_ command: [String: Any]) {
        switch command["type"] as? String {
        case "status": status()
        case "requestLocation": locations.requestPermission(id: command["id"] as? String ?? "")
        case "locationPermissionCancel": if let id = command["id"] as? String { locations.cancelPermission(id: id) }
        case "locationStart": if let id = command["id"] as? String { locations.start(id: id) }
        case "locationStop": if let id = command["id"] as? String { locations.stop(id: id) }
        case "speak":
            guard navigating, let milliseconds = command["issuedAt"] as? Double, milliseconds.isFinite else { return }
            let issuedAt = Date(timeIntervalSince1970: milliseconds / 1000)
            let age = Date().timeIntervalSince(issuedAt)
            guard issuedAt >= foregroundSince, age >= 0, age < SpeechService.promptLifetime else { return }
            let text = command["text"] as? String ?? ""
            let priority = command["priority"] as? Bool ?? false
            speech.speak(text, priority: priority, validFor: SpeechService.promptLifetime - age)
        case "stopSpeech": speech.stop()
        case "navigation": setNavigation(command["active"] as? Bool ?? false)
        case "ttsTest": speech.speak("語音導航測試，前方路口請右轉。", priority: true)
        case "ttsRefresh": speech.refreshVoice()
        case "ttsSettings", "ttsInstall":
            showNotice("到「設定 → 輔助使用 → 朗讀與語音」（部分 iOS 版本稱為「語音內容」），從聲音列表下載中文聲音，再回到 LaneDev 重新檢查與試聽。")
        case "locationSettings":
            showNotice("到「設定 → 隱私權與安全性 → 定位服務」開啟手機的定位服務。")
        case "appSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url) { [weak self] opened in
                    if !opened { self?.showNotice("請到「設定 → 隱私權與安全性 → 定位服務 → LaneDev」，允許使用 App 期間取用精確位置。") }
                }
            }
        case "reverseGeocode": reverseGeocode(command)
        case "googlePlaceSearch": googlePlaces.search(command, from: self) { [weak self] in self?.emit($0) }
        case "googlePlaceCancel": if let id = command["id"] as? String { googlePlaces.cancel(id: id) }
        default: break
        }
    }
    private func setNavigation(_ active: Bool) {
        navigating = active
        UIApplication.shared.isIdleTimerDisabled = locations.foreground && active
        if !active { speech.stop() }
    }
    private func reverseGeocode(_ command: [String: Any]) {
        guard let id = command["id"] as? String, let lat = command["lat"] as? Double,
              let lng = command["lng"] as? Double, lat.isFinite, lng.isFinite,
              abs(lat) <= 90, abs(lng) <= 180 else { return }
        // Optional online enrichment. The local search and route never wait for this.
        guard !geocoder.isGeocoding else { emit(["type": "addressResult", "id": id, "address": ""]); return }
        let generation = documentGeneration
        geocoder.reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lng), preferredLocale: Locale(identifier: "zh_TW")) { [weak self] places, _ in
            guard let self, self.documentGeneration == generation else { return }
            let p = places?.first
            let address = [p?.administrativeArea, p?.locality, p?.subLocality, p?.thoroughfare, p?.subThoroughfare].compactMap { $0 }.joined()
            self.emit(["type": "addressResult", "id": id, "address": address])
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
    private func resetDocument() {
        webReady = false
        documentGeneration += 1
        geocoder.cancelGeocode()
        googlePlaces.cancel()
        locations.reset()
        setNavigation(false)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { resetDocument() }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { webReady = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { locations.publishState(); status() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failedLoad(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failedLoad(error) }
    private func failedLoad(_ error: Error) {
        if (error as? URLError)?.code == .cancelled { return }
        resetDocument()
        showError(error.localizedDescription)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        resetDocument()
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

private final class BridgeMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: NavigationViewController?

    init(_ target: NavigationViewController) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
