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
    private var geocoder = CLGeocoder()
    private var errorOverlay: UIView?
    #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
    private let simulatorPanel = SimulatorNavigationPanel()
    private var simulatorReady = false
    private var simulatorPicking = false
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
        config.userContentController.add(BridgeMessageHandler(self), name: "LaneNative")
        config.userContentController.addUserScript(WKUserScript(source:
            "Object.defineProperty(window, 'LaneGooglePlacesAvailable', {value: \(googlePlaces.configured)})",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: "document.documentElement.dataset.platform='ios'",
            injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
        config.userContentController.addUserScript(WKUserScript(source: """
            (() => {
              let fixTiming;
              window.addEventListener('lane-native', ({detail}) => {
                if (detail?.type === 'position') fixTiming = detail.motionTimestamp == null ? undefined : detail;
              });
              const send = (type, fields = {}) => window.LaneNative.postMessage(JSON.stringify({type, ...fields}));
              Object.defineProperty(window, 'LaneSimulator', { value: Object.freeze({
                prepare: coords => send('simulatorPrepare', {coords}),
                planStatus: (ready, picking) => send('simulatorPlanStatus', {ready, picking}),
                noteReroute: () => send('simulatorRouteChanged'),
                arrive: () => send('simulatorArrived'),
                timing: wallTimestamp => fixTiming?.timestamp === wallTimestamp ? fixTiming : undefined,
              }) });
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
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
        var topAnchor = view.safeAreaLayoutGuide.topAnchor
        #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
        simulatorPanel.translatesAutoresizingMaskIntoConstraints = false
        simulatorPanel.perform = { [weak self] action in self?.handleSimulatorAction(action) }
        locations.simulator.onChange = { [weak self] in self?.updateSimulatorPanel() }
        view.addSubview(simulatorPanel)
        NSLayoutConstraint.activate([
            simulatorPanel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            simulatorPanel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            simulatorPanel.topAnchor.constraint(equalTo: topAnchor),
        ])
        updateSimulatorPanel()
        topAnchor = simulatorPanel.bottomAnchor
        #endif
        NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor), webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)])
        locations.emit = { [weak self] in self?.emit($0) }
        locations.changed = { [weak self] in self?.status() }
        speech.changed = { [weak self] in self?.status() }
        webView.load(URLRequest(url: BundleSchemeHandler.origin))
    }

    #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
    private func updateSimulatorPanel() {
        simulatorPanel.update(locations.simulator, virtual: locations.virtual, navigating: navigating,
                              ready: simulatorReady, picking: simulatorPicking)
    }

    func handleSimulatorAction(_ action: SimulatorNavigationPanel.Action) {
        let simulator = locations.simulator
        switch action {
        case .selectVirtual(let enabled):
            if !locations.selectVirtual(enabled) { showNotice("請先結束導航或等目前定位完成，再切換來源") }
        case .choosePoints: emit(["type": "simulatorControl", "action": "pick"])
        case .start:
            simulatorReady = false
            emit(["type": "simulatorControl", "action": "start"])
        case .pause:
            simulator.pause()
            locations.updateSimulatorPause()
            speech.stop()
        case .resume:
            simulator.resume()
            locations.updateSimulatorPause()
        case .end:
            simulator.end()
            speech.stop()
            emit(["type": "simulatorControl", "action": "end"])
        case .rate(let rate): simulator.setRate(rate)
        case .straight: simulator.keepStraight()
        case .park: simulator.setParked(!simulator.parked)
        case .jitter: simulator.setJitter(!simulator.jitter)
        case .signal:
            simulator.setSignalLost(!simulator.signalLost)
            if simulator.signalLost {
                locations.reportSimulatorSignalLoss()
                speech.stop()
            }
        }
        updateSimulatorPanel()
        status()
    }
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
            let text = command["text"] as? String ?? ""
            let priority = command["priority"] as? Bool ?? false
            #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
            if locations.virtual && locations.simulator.rate != .normal {
                speech.speak(text, priority: priority, queueIfBusy: false)
                return
            }
            #endif
            speech.speak(text, priority: priority)
        case "stopSpeech": speech.stop()
        case "navigation": setNavigation(command["active"] as? Bool ?? false)
        case "ttsTest": speech.stop(); speech.speak("語音導航測試，前方路口請右轉。")
        case "ttsRefresh": speech.refreshVoice(); status()
        case "ttsSettings", "ttsInstall": showNotice("iOS 聲音由系統管理。請到「設定 → 輔助使用 → 朗讀與語音」下載中文聲音，再回到 LaneDev 試聽。")
        case "appSettings", "locationSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case "reverseGeocode": reverseGeocode(command)
        case "googlePlaceSearch": googlePlaces.search(command, from: self) { [weak self] in self?.emit($0) }
        case "googlePlaceCancel": if let id = command["id"] as? String { googlePlaces.cancel(id: id) }
        #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
        case "simulatorPrepare":
            if navigating, locations.virtual, let coords = command["coords"] as? [[Double]] {
                locations.simulator.prepare(coords)
            }
        case "simulatorPlanStatus":
            simulatorReady = command["ready"] as? Bool ?? false
            simulatorPicking = command["picking"] as? Bool ?? false
            updateSimulatorPanel()
        case "simulatorRouteChanged": if navigating && locations.virtual { locations.simulator.noteReroute() }
        case "simulatorArrived": if navigating && locations.virtual { locations.simulator.arrive() }
        #endif
        default: break
        }
    }
    private func setNavigation(_ active: Bool) {
        navigating = active
        UIApplication.shared.isIdleTimerDisabled = locations.foreground && active
        #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
        locations.navigationActive = active
        if !active {
            locations.simulator.end()
            if locations.virtual { locations.updateSimulatorPause() }
        }
        updateSimulatorPanel()
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
        webReady = false; googlePlaces.cancel(); locations.reset(); setNavigation(false)
        #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
        simulatorReady = false
        simulatorPicking = false
        updateSimulatorPanel()
        #endif
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { webReady = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { locations.publishState(); status() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showError(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showError(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webReady = false; googlePlaces.cancel(); locations.reset(); setNavigation(false)
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
