import XCTest
import WebKit
import CoreLocation
import AVFAudio
@testable import LaneDev

@MainActor
final class ForegroundNavigationTests: XCTestCase {
    var controller: NavigationViewController!
    override func setUp() async throws {
        controller = (UIApplication.shared.delegate as! AppDelegate).window!.rootViewController as? NavigationViewController
        XCTAssertNotNil(controller.webView)
        controller.setForeground(true)
        controller.locations.reset()
        _ = try? await js("document.body.dataset.previousDocument='true'")
        controller.webView.load(URLRequest(url: BundleSchemeHandler.origin))
        try await wait("!document.body.dataset.previousDocument && document.querySelector('.place-search-form input') && !document.querySelector('.loading')")
    }
    func js(_ body: String) async throws -> Any? {
        try await controller.webView.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
    }
    func wait(_ condition: String, seconds: Double = 60) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if (try await js("return !!(\(condition))")) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        let text = try await js("return document.body.innerText")
        XCTFail("Timed out: \(condition)\n\(text ?? "")")
        throw NSError(domain: "LaneDevTests", code: 1)
    }
    func click(_ text: String) async throws {
        let encoded = String(data: try JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed), encoding: .utf8)!
        _ = try await js("""
            const b = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === \(encoded));
            if (!b) throw new Error('Missing button ' + \(encoded)); b.click();
            """)
    }

    func setSearch(_ selector: String, _ query: String) async throws {
        let queryJSON = String(data: try JSONEncoder().encode(query), encoding: .utf8)!
        _ = try await js("""
            const field = document.querySelector('\(selector)');
            if (!field) throw new Error('Search field is absent');
            field.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, \(queryJSON));
            field.dispatchEvent(new Event('input', {bubbles:true}));
            """)
    }

    func selectLocalResult(_ name: String, within selector: String = ".place-search") async throws {
        let nameJSON = String(data: try JSONEncoder().encode(name), encoding: .utf8)!
        let match = "[...document.querySelectorAll('\(selector) .place-result')].find(b => b.querySelector('b')?.innerText === \(nameJSON))"
        try await wait(match, seconds: 15)
        _ = try await js("(\(match)).click()")
    }

    func editLocalStop(_ label: String, as name: String, query: String? = nil) async throws {
        _ = try await js("document.querySelector('button[aria-label=\"更換\(label)\"]').click()")
        try await setSearch(".stop-place-search input", query ?? name)
        try await selectLocalResult(name, within: ".stop-place-search")
        try await wait("!document.querySelector('.stop-place-search')")
    }

    func addLocalStop(_ name: String) async throws {
        try await click("＋ 新增停靠點")
        try await setSearch(".stop-place-search input", name)
        try await selectLocalResult(name, within: ".stop-place-search")
        try await wait("!document.querySelector('.stop-place-search')")
    }
    func plan(useVirtual: Bool = true) async throws {
        #if targetEnvironment(simulator)
        XCTAssertTrue(controller.locations.selectVirtual(useVirtual))
        if useVirtual { controller.locations.simulator.setRate(.normal) }
        #endif
        _ = try await js("""
            const input = document.querySelector('.place-search-form input');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '高雄大學');
            input.dispatchEvent(new Event('input', {bubbles:true}));
            """)
        try await wait("[...document.querySelectorAll('.place-result b')].some(b => b.innerText === '國立高雄大學')")
        _ = try await js("[...document.querySelectorAll('.place-result')].find(b => b.querySelector('b').innerText === '國立高雄大學').click()")
        try await wait("document.querySelector('.place-route-methods button')")
        _ = try await js("document.querySelector('.place-route-methods button').click()")
        try await wait("document.querySelector('.route-start-button') && !document.querySelector('.route-start-button').disabled")
    }
    func screenshot(_ name: String) async throws {
        let image = try await controller.webView.takeSnapshot(configuration: nil)
        let attachment = XCTAttachment(image: image)
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testBundledOfflineSearchPlanningAndNavigation() async throws {
        XCTAssertEqual(controller.webView.url?.scheme, "lanedev")
        _ = try await js("""
            window.__errors = [];
            window.addEventListener('error', e => window.__errors.push(e.message));
            window.addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason)));
            """)
        try await plan()
        let summary = try await js("return document.querySelector('.route-preview-summary').innerText")
        print("IOS_ROUTE_PREVIEW: \(summary ?? "")")
        try await click("🛵 機車")
        try await wait("document.querySelector('.route-profile .on')?.innerText.includes('機車') && !document.querySelector('.route-start-button').disabled")
        try await screenshot("offline-motorcycle-route")
        try await click("🚗 汽車")
        try await wait("document.querySelector('.route-profile .on')?.innerText.includes('汽車') && !document.querySelector('.route-start-button').disabled")
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner')")
        XCTAssertTrue(controller.navigating)
        XCTAssertTrue(UIApplication.shared.isIdleTimerDisabled)
        #if targetEnvironment(simulator)
        XCTAssertTrue(controller.locations.virtual)
        XCTAssertFalse(controller.locations.selectVirtual(false), "Source cannot switch during navigation")
        XCTAssertGreaterThan(controller.locations.simulator.track.count, 2)
        #endif
        let before = try await js("return document.querySelector('.drive-hud')?.innerText ?? document.body.innerText")
        try await Task.sleep(for: .seconds(4))
        try await screenshot("foreground-navigation")
        print("IOS_NAVIGATION_HUD: \(before ?? "")")
        XCTAssertEqual(controller.locations.watches.count, 1)
        controller.setForeground(false)
        XCTAssertFalse(controller.locations.updating)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
        XCTAssertFalse(controller.speech.foreground)
        try await Task.sleep(for: .milliseconds(200))
        controller.setForeground(true)
        XCTAssertTrue(controller.locations.updating)
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(controller.locations.watches.count, 1)
        let errors = try await js("return JSON.stringify(window.__errors)") as? String
        XCTAssertEqual(errors, "[]")
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        XCTAssertFalse(controller.navigating)
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertFalse(controller.locations.updating)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
    }

    func testReadOnlyBundleAndIntegrity() async throws {
        let result = try await js("""
            const m = await fetch('./data/runtime/manifest.json');
            const manifest = await m.json();
            const r = await fetch('./data/runtime/' + manifest.navigation.file);
            let denied;
            try { denied = (await fetch('./data/road_database.json', {method:'POST', body:'{}'})).status; }
            catch { denied = 'blocked-by-webkit'; }
            return {format:manifest.format, hash:r.headers.get('X-Lane-SHA256'), expected:manifest.navigation.sha256,
              denied, simulator:!!window.LaneSimulator,
              resources:performance.getEntriesByType('resource').filter(r => /https?:/.test(r.name)).map(r => r.name)};
            """) as! [String: Any]
        XCTAssertEqual(result["format"] as? String, "lanedev-precomputed-v1")
        XCTAssertEqual(result["hash"] as? String, result["expected"] as? String)
        XCTAssertTrue(result["denied"] as? Int == 403 || result["denied"] as? String == "blocked-by-webkit")
        XCTAssertEqual((result["resources"] as? [String]) ?? [], [])
        print("IOS_BUNDLE_CHECK: \(result)")
        let root = Bundle.main.url(forResource: "public", withExtension: nil)!
        let handler = BundleSchemeHandler(root: root)
        XCTAssertNil(handler.resource(for: URL(string: "lanedev://app/../Info.plist")!))
        XCTAssertNil(handler.resource(for: URL(string: "lanedev://evil/index.html")!))
        XCTAssertNil(handler.resource(for: URL(string: "https://app/index.html")!))
        XCTAssertNoThrow(try handler.validateBundle())
    }

    func testWebKitLoadsPackagedModulesWorkerAndWebGL() async throws {
        let result = try await js("""
            const entry = document.querySelector('script[type=module][src]');
            const manifestURL = new URL('./data/runtime/manifest.json', location.href);
            const manifest = await (await fetch(manifestURL)).json();
            const workerURL = URL.createObjectURL(new Blob([`
                self.onmessage = async ({data}) => {
                    try {
                        const response = await fetch(data);
                        self.postMessage(response.ok ? (await response.json()).format : 'HTTP ' + response.status);
                    } catch (e) { self.postMessage(String(e)); }
                };
            `], {type:'text/javascript'}));
            const worker = new Worker(workerURL);
            let workerFormat;
            try {
                workerFormat = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Worker timed out')), 5000);
                    worker.onmessage = e => { clearTimeout(timer); resolve(e.data); };
                    worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
                    worker.postMessage(manifestURL.href);
                });
            } finally { worker.terminate(); URL.revokeObjectURL(workerURL); }
            const policy = await (await fetch('./client-policy.json')).json();
            return {
                module: entry?.src.startsWith('lanedev://app/assets/') === true && !!document.querySelector('.app'),
                workerFormat, mode: policy.mode, simulator: !!window.LaneSimulator,
                webgl2: !!document.querySelector('.maplibregl-canvas')?.getContext('webgl2'),
                font: getComputedStyle(document.querySelector('.place-search-form input')).fontFamily,
                glyphs: document.fonts.check('16px "PingFang TC"', '路線導航'),
                measurements: performance.getEntriesByType('measure').map(p => p.name),
                sources: Object.keys(manifest.sources).sort(),
                remoteResources: performance.getEntriesByType('resource').filter(p => /^https?:/.test(p.name)).length,
            };
            """) as! [String: Any]
        XCTAssertEqual(result["module"] as? Bool, true)
        XCTAssertEqual(result["workerFormat"] as? String, "lanedev-precomputed-v1")
        XCTAssertEqual(result["mode"] as? String, BundleSchemeHandler.expectedMode)
        XCTAssertEqual(result["simulator"] as? Bool, BundleSchemeHandler.expectedMode == "ios-simulator")
        XCTAssertEqual(result["webgl2"] as? Bool, true)
        XCTAssertTrue((result["font"] as? String)?.contains("PingFang TC") == true)
        XCTAssertEqual(result["glyphs"] as? Bool, true)
        XCTAssertTrue((result["measurements"] as? [String])?.contains("lanedev-boot:map-sources-ready") == true)
        XCTAssertEqual(result["sources"] as? [String], ["buildings", "dividers", "medians", "roadSurfaces", "roadlabels", "roads", "roadtext", "turnbays", "zones"])
        XCTAssertEqual(result["remoteResources"] as? Int, 0)
        print("IOS_WEBKIT: \(result)")
    }

    func testInvalidRoadVersionShowsProgressErrorAndRetry() async throws {
        let key = "lanedev.test.invalid-manifest-once"
        let controller = self.controller!
        controller.webView.configuration.userContentController.addUserScript(WKUserScript(source: """
            if (location.search === '?test-invalid-manifest' && !sessionStorage.getItem('\(key)')) {
                sessionStorage.setItem('\(key)', '1');
                const load = window.fetch.bind(window);
                window.fetch = async (url, ...args) => {
                    if (!String(url).endsWith('/data/runtime/manifest.json')) return load(url, ...args);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return new Response('{"format":"invalid-test-version"}');
                };
            }
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        defer {
            controller.webView.evaluateJavaScript("sessionStorage.removeItem('\(key)')", completionHandler: nil)
        }
        controller.webView.load(URLRequest(url: URL(string: "lanedev://app/index.html?test-invalid-manifest")!))
        try await wait("document.querySelector('.loading progress')")
        try await screenshot("map-loading-progress")
        try await wait("document.querySelector('.loading[role=alert]')?.innerText.includes('預計算路網版本不相容')")
        try await screenshot("map-loading-error")
        try await click("重新載入")
        try await wait("document.querySelector('.app') && !document.querySelector('.loading')")
        try await screenshot("map-recovered")
        print("IOS_MAP_RETRY: invalid test manifest rejected and rebuilt the map after reload")
    }

    func testNativeSpeechCallbacks() async throws {
        guard controller.speech.ready else { throw XCTSkip("Simulator has no installed Chinese voice") }
        let starts = controller.speech.starts
        let finishes = controller.speech.finishes
        let saved = try await js("return document.querySelector('.client-settings input[type=checkbox]').checked") as? Bool
        addTeardownBlock { [weak self] in
            if saved == true {
                _ = try await self?.js("const voice = document.querySelector('.client-settings input[type=checkbox]'); if (voice && !voice.checked) voice.click()")
            }
        }
        _ = try await js("""
            document.querySelector('.client-settings').open = true;
            [...document.querySelectorAll('.client-settings details')].find(d => d.querySelector('summary').textContent === '語音設定').open = true;
            const voice = document.querySelector('.client-settings input[type=checkbox]');
            if (voice.checked) voice.click();
            """)
        try await click("試聽中文")
        try await waitForSpeech { self.controller.speech.finishes == finishes + 1 }
        XCTAssertEqual(controller.speech.starts, starts + 1)
        XCTAssertNil(controller.speech.currentText)
        try await wait("document.querySelector('.settings-status[role=status]').textContent.includes('iOS 已完成播放')")
        try await screenshot("stage6-speech-preview")
        try await click("試聽中文")
        try await waitForSpeech { self.controller.speech.currentText != nil }
        try await click("停止語音")
        try await waitForSpeech { self.controller.speech.currentText == nil }
        XCTAssertEqual(controller.speech.queuedCount, 0)
        XCTAssertEqual(controller.speech.finishes, finishes + 1)
        _ = try await js("document.querySelector('.client-settings input[type=checkbox]').click()")
        try await click("試聽中文")
        try await waitForSpeech { self.controller.speech.currentText != nil }
        _ = try await js("document.querySelector('.client-settings input[type=checkbox]').click()")
        try await waitForSpeech { self.controller.speech.currentText == nil }
        XCTAssertEqual(controller.speech.queuedCount, 0)
        XCTAssertEqual(controller.speech.finishes, finishes + 1)
        print("IOS_SPEECH_CALLBACKS: starts=\(controller.speech.starts), finishes=\(controller.speech.finishes), \(controller.speech.audio)")
    }

    private func waitForSpeech(file: StaticString = #filePath, line: UInt = #line,
                               _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(16)
        while !condition() && Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        guard condition() else {
            XCTFail("Timed out waiting for the native speech state", file: file, line: line)
            throw NSError(domain: "LaneDevSpeechTest", code: 1)
        }
    }

    func testSpeechExpiryPriorityAndAudioInterruption() async throws {
        var now: TimeInterval = 0
        let speech = SpeechService(uptime: { now })
        defer { speech.stop() }
        guard speech.ready else { throw XCTSkip("Simulator has no installed Chinese voice") }
        let original = String(repeating: "前方請保持直行。", count: 12)
        let obsolete = "前方有測速照相。"
        speech.speak("請直行。")
        speech.speak(obsolete)
        XCTAssertEqual(speech.queuedCount, 1)
        now = 6
        try await waitForSpeech { speech.finishes == 1 }
        XCTAssertEqual(speech.starts, 1)
        XCTAssertNil(speech.currentText)
        XCTAssertEqual(speech.queuedCount, 0)

        speech.speak(original)
        try await waitForSpeech { speech.starts == 2 }
        speech.speak(obsolete)
        let urgent = "前方路口請右轉。"
        speech.speak(urgent, priority: true)
        XCTAssertEqual(speech.currentText, urgent)
        XCTAssertEqual(speech.queuedCount, 0)
        try await waitForSpeech { speech.finishes == 2 }
        XCTAssertEqual(speech.starts, 3, "Only the urgent prompt should start after the interrupted prompt")

        func notify(_ type: AVAudioSession.InterruptionType) {
            NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(),
                                            userInfo: [AVAudioSessionInterruptionTypeKey: type.rawValue])
        }
        defer { notify(.ended) }
        speech.speak(original)
        try await waitForSpeech { speech.starts == 4 }
        speech.speak(obsolete)
        notify(.began)
        XCTAssertTrue(speech.interrupted)
        XCTAssertNil(speech.currentText)
        XCTAssertEqual(speech.queuedCount, 0)
        speech.speak(urgent, priority: true)
        XCTAssertNil(speech.currentText)
        notify(.ended)
        XCTAssertFalse(speech.interrupted)
        XCTAssertNil(speech.currentText)
        speech.speak(urgent)
        try await waitForSpeech { speech.finishes == 3 }
        XCTAssertEqual(speech.starts, 5)

        notify(.began)
        speech.setForeground(false)
        speech.setForeground(true)
        XCTAssertFalse(speech.interrupted, "Returning can recover when no ended notification was delivered")
        speech.speak(urgent)
        XCTAssertEqual(speech.currentText, urgent, speech.speech)
        do {
            try await waitForSpeech { speech.finishes == 4 }
        } catch {
            print("IOS_STAGE6_AUDIO_AFTER_RETURN: starts=\(speech.starts) finishes=\(speech.finishes) status=\(speech.speech)")
            throw error
        }
        print("IOS_STAGE6_AUDIO: expired prompt skipped, urgent prompt preempted, injected interruption dropped pending speech, fresh prompts finished after ended and after returning")
    }

    func testMissingChineseSpeechShowsRecovery() {
        let speech = SpeechService(availableVoices: { [] })
        XCTAssertFalse(speech.ready)
        XCTAssertTrue(speech.status.contains("重新檢查"))
        speech.speak("請右轉。")
        XCTAssertTrue(speech.speech.contains("缺少中文聲音"))
        XCTAssertNil(speech.currentText)
        XCTAssertEqual(speech.starts, 0)
        print("IOS_STAGE6_MISSING_VOICE: empty voice inventory injected, no utterance submitted")
    }

    #if targetEnvironment(simulator)
    func testLocalSearchSavedPlacesAndEditingStops() async throws {
        XCTAssertTrue(controller.locations.selectVirtual(true))
        let saved = try await js("return localStorage.getItem('client.savedPlaces')") as? String
        let savedJSON = String(data: try JSONEncoder().encode(saved), encoding: .utf8)!
        addTeardownBlock { [weak self] in
            _ = try await self?.js("const value=\(savedJSON); if(value === null) localStorage.removeItem('client.savedPlaces'); else localStorage.setItem('client.savedPlaces',value)")
        }
        _ = try await js("""
            document.querySelector('.client-settings').open = true;
            document.querySelector('.saved-place-settings').closest('details').open = true;
            document.querySelector('.saved-place-item button').click();
            """)
        try await setSearch(".saved-place-editor input", "國立高雄大學")
        try await wait("[...document.querySelectorAll('.saved-place-matches button b')].some(b => b.innerText === '國立高雄大學')", seconds: 12)
        _ = try await js("""
            [...document.querySelectorAll('.saved-place-matches button')].find(b => b.querySelector('b').innerText === '國立高雄大學').click();
            document.querySelector('.client-settings').open = false;
            document.querySelector('.place-search-form input').focus();
            """)
        try await wait("document.querySelector('.saved-place-chip')?.innerText.includes('國立高雄大學')")
        _ = try await js("document.querySelector('.saved-place-chip').click()")
        try await wait("document.querySelector('.place-route-target')?.innerText.includes('國立高雄大學')")
        try await screenshot("stage5-saved-place")
        _ = try await js("document.querySelector('.place-route-methods button').click()")
        try await wait("document.querySelector('.route-stop-value[aria-label=起點]')?.value === '我的位置'")
        try await editLocalStop("起點", as: "高雄大學產學育成中心")
        try await editLocalStop("終點", as: "高雄大學行政大樓i郵箱")
        try await addLocalStop("高雄大學郵局")
        try await addLocalStop("國立高雄大學游泳池")
        try await wait("document.querySelector('.route-start-button')?.disabled === false")
        _ = try await js("document.querySelector('button[aria-label=\"停靠點 2上移\"]').click()")
        try await wait("document.querySelector('input[aria-label=\"停靠點 1\"]')?.value === '國立高雄大學游泳池' && document.querySelector('input[aria-label=\"停靠點 2\"]')?.value === '高雄大學郵局'")
        _ = try await js("document.querySelector('button[aria-label=機車]').click()")
        try await wait("document.querySelector('button[aria-label=機車]').getAttribute('aria-pressed') === 'true' && document.querySelector('.route-steps .mlist-item')")
        _ = try await js("document.querySelector('button[aria-label=汽車]').click()")
        try await wait("document.querySelector('button[aria-label=汽車]').getAttribute('aria-pressed') === 'true' && document.querySelector('.route-start-button')?.disabled === false")
        _ = try await js("document.querySelector('.route-steps summary').click()")
        try await wait("document.querySelector('.route-steps')?.open === false")
        _ = try await js("document.querySelector('.route-steps summary').click()")
        try await wait("document.querySelector('.route-steps')?.open && document.querySelector('.mlist-act')?.innerText.length > 0")
        try await screenshot("stage5-reordered-waypoints")
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.trip-stop')?.innerText.includes('國立高雄大學游泳池') && document.querySelector('.trip-eta')?.innerText.includes('抵達')")
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        XCTAssertTrue(controller.locations.watches.isEmpty)
        try await plan()
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner')")
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        print("IOS_STAGE5_EDIT: saved place, current start, edited endpoints, two reordered vias, both profiles, preview steps, cancel and restart")
    }

    func testMissingGoogleKeyKeepsOfflineSearchUsable() async throws {
        guard try await js("return window.LaneGooglePlacesAvailable") as? Bool == false else {
            throw XCTSkip("Missing-key case requires an unconfigured Google Places build")
        }
        try await setSearch(".place-search-form input", "確定沒有這個地點xyz")
        try await wait("document.querySelector('.place-provider-switch')?.innerText.includes('未設定 iOS 金鑰')")
        try await wait("document.querySelector('.place-provider-switch button').disabled && typeof window.google === 'undefined'")
        let reply = try await js("""
            return new Promise(resolve => {
              const id = 'stage5-google-key-check';
              const receive = ({detail}) => { if (detail.id === id) {
                window.removeEventListener('lane-native', receive); resolve(detail.error);
              }};
              window.addEventListener('lane-native', receive);
              window.LaneNative.postMessage(JSON.stringify({type:'googlePlaceSearch', id, query:'測試'}));
            });
            """) as? String
        XCTAssertTrue(reply?.contains("未設定 iOS 金鑰") == true)
        XCTAssertNil(controller.presentedViewController)
        try await screenshot("stage5-google-key-missing")
        try await setSearch(".place-search-form input", "高雄大學")
        try await selectLocalResult("國立高雄大學")
        try await wait("document.querySelector('.place-route-target')?.innerText.includes('國立高雄大學')")
        print("IOS_STAGE5_GOOGLE: no key, native refusal, no JS loader, offline result selected")
    }

    func testRouteGuidanceUsesBundledTwoStageAndSpeedCameraData() async throws {
        XCTAssertTrue(controller.locations.selectVirtual(true))
        try await plan()
        _ = try await js("document.querySelector('button[aria-label=機車]').click()")
        try await editLocalStop("起點", as: "高雄市楠梓區援中國民小學", query: "援中國民小學")
        try await editLocalStop("終點", as: "綜合籃球場")
        try await wait("document.querySelector('.mlist-item.two-stage')?.innerText.includes('待轉')")
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.two-stage-sign') && document.querySelector('.lane-preview') && document.querySelector('.trip-eta')?.innerText.includes('抵達')")
        try await screenshot("stage5-two-stage-guidance")
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        try await plan()
        _ = try await js("document.querySelector('button[aria-label=汽車]').click()")
        try await editLocalStop("起點", as: "中和里里辦公室")
        try await editLocalStop("終點", as: "中和兒童公園")
        controller.handleSimulatorAction(.rate(.fastest))
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.camera-card:not(.camera-passed)')?.innerText.includes('測速') && document.querySelector('.trip b')?.innerText.includes('公尺')", seconds: 18)
        try await screenshot("stage5-speed-camera-alert")
        let alert = try await js("return document.querySelector('.camera-card').innerText")
        print("IOS_STAGE5_GUIDANCE: node 2601136103 two-stage, camera \(alert ?? "")")
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
    }

    func testRepeatedReroutesKeepOnlyUpcomingStops() async throws {
        try await plan()
        try await addLocalStop("高雄大學產學育成中心")
        try await addLocalStop("高雄大學郵局")
        try await wait("document.querySelector('.route-start-button')?.disabled === false")
        let simulator = controller.locations.simulator
        controller.handleSimulatorAction(.rate(.fastest))
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.trip-stop')?.innerText.includes('產學育成中心')", seconds: 15)
        try await wait("document.querySelector('.trip-stop')?.innerText.includes('高雄大學郵局')", seconds: 15)
        controller.handleSimulatorAction(.straight)
        try await waitForSimulator(seconds: 25) { simulator.reroutes >= 1 }
        try await wait("document.querySelector('.trip-stop')?.innerText.includes('高雄大學郵局')")
        try await waitForSimulator(seconds: 25) { simulator.reroutes >= 2 }
        try await wait("document.querySelector('.trip-stop')?.innerText.includes('高雄大學郵局')")
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await screenshot("stage5-reroute-keeps-waypoint")
        print("IOS_STAGE5_VIA: completed 高雄大學產學育成中心, pending 高雄大學郵局 after \(simulator.reroutes) reroutes")
        controller.handleSimulatorAction(.end)
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
    }

    func testSimulatorMissedTurnKeepsTrackThroughReroute() async throws {
        try await plan()
        try await observeAcceptance()
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner-dist span')?.innerText.includes('左轉')")
        let simulator = controller.locations.simulator
        controller.handleSimulatorAction(.rate(.fastest))
        try await waitForSimulator { simulator.distanceM >= 32 }
        let originalTrack = simulator.track
        let track = originalTrack.map { [$0.longitude, $0.latitude] }
        let before = simulator.coordinate
        controller.handleSimulatorAction(.straight)
        let bearing = try XCTUnwrap(simulator.straightBearing)
        try await waitForSimulator(seconds: 30) { simulator.reroutes > 0 }
        let atReroute = simulator.distanceM
        try await waitForSimulator { simulator.distanceM >= atReroute + 24 }
        XCTAssertGreaterThan(SimulatorLocationSource.distance(before, simulator.coordinate), 50)
        XCTAssertEqual(simulator.straightBearing, bearing)
        XCTAssertEqual(simulator.track.map { [$0.longitude, $0.latitude] }, track)
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await acceptanceMetrics("virtual-reroute", virtual: true)
        print("IOS_STAGE4_MISSED_TURN: reroutes=\(simulator.reroutes) bearing=\(bearing) moved=\(Int(atReroute))m originalTrack=\(track.count) nextFixes=\(Int(simulator.distanceM - atReroute))m watches=1")
        try await screenshot("stage4-missed-turn-after-reroute")
        let reentry = try XCTUnwrap(originalTrack.indices.min(by: {
            SimulatorLocationSource.distance(originalTrack[$0], before) < SimulatorLocationSource.distance(originalTrack[$1], before)
        }))
        let now = simulator.coordinate
        let joinPath = [[now.longitude, now.latitude]] + Array(track.dropFirst(reentry))
        XCTAssertTrue(simulator.prepare(joinPath), "Replay a return to the original corridor without installing an app route")
        try await waitForSimulator { simulator.distanceM > 160 }
        try await wait("document.querySelector('.banner') && !document.querySelector('.gps-weak')", seconds: 15)
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await screenshot("stage7-virtual-rejoined")
        print("IOS_STAGE7_VIRTUAL_REJOIN: replayed independent return and resumed matched fixes on one subscription")
        controller.handleSimulatorAction(.end)
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        try await waitForSimulator { self.controller.locations.watches.isEmpty && !simulator.hasPendingWork }
        XCTAssertTrue(controller.locations.selectVirtual(false))
        XCTAssertFalse(controller.locations.updating)
    }

    func testSimulatorNavigationScenariosAndNaturalArrival() async throws {
        let voiceWasEnabled = try await js("return document.querySelector('.client-settings input[type=checkbox]').checked") as? Bool
        if voiceWasEnabled == false {
            _ = try await js("document.querySelector('.client-settings input[type=checkbox]').click()")
            addTeardownBlock { [weak self] in
                _ = try await self?.js("const voice = document.querySelector('.client-settings input[type=checkbox]'); if (voice?.checked) voice.click()")
            }
        }
        try await plan()
        let simulator = controller.locations.simulator
        let speechBefore = controller.speech.starts
        _ = try await js("""
            window.stage4Samples = [];
            window.addEventListener('lane-native', ({detail}) => {
              if (detail.type === 'position' && detail.motionTimestamp) {
                window.stage4Samples.push(detail.coords);
                window.stage4LastMotion = detail.motionTimestamp;
              }
            });
            """)
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner') && document.querySelector('.speed-num')?.innerText === '29'")
        print("IOS_STAGE4_DRIVING: voiceWasEnabled=\(voiceWasEnabled ?? false) voiceReady=\(controller.speech.ready) speech=\(controller.speech.speech)")
        if controller.speech.ready { try await waitForSimulator { self.controller.speech.starts > speechBefore } }
        try await screenshot("stage4-normal-navigation")

        controller.handleSimulatorAction(.pause)
        try await wait("document.querySelector('.gps-weak')?.innerText.includes('虛擬導航已暫停')")
        let pausedAt = simulator.elapsedSeconds
        let pausedDistance = simulator.distanceM
        XCTAssertFalse(simulator.hasPendingWork)
        try await Task.sleep(for: .milliseconds(1250))
        XCTAssertEqual(simulator.elapsedSeconds, pausedAt)
        XCTAssertEqual(simulator.distanceM, pausedDistance)
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await screenshot("stage4-paused-hud")

        controller.handleSimulatorAction(.park)
        controller.handleSimulatorAction(.jitter)
        controller.handleSimulatorAction(.rate(.fast))
        controller.handleSimulatorAction(.resume)
        try await wait("document.querySelector('.speed-num')?.innerText === '0' && !document.querySelector('.gps-weak')?.innerText.includes('已暫停')")
        try await waitForSimulator { simulator.elapsedSeconds >= pausedAt + 3 }
        try await wait("stage4Samples.filter(c => c.speed === 0 && c.accuracy === 14).length >= 2")
        XCTAssertEqual(simulator.distanceM, pausedDistance)
        let jittered = try await js("""
            return window.stage4Samples.filter(c => c.speed === 0 && c.accuracy === 14).slice(-2)
              .map(c => [c.longitude, c.latitude]);
            """) as? [[Double]]
        XCTAssertEqual(jittered?.count, 2)
        XCTAssertNotEqual(jittered?.first, jittered?.last)
        simulator.stop()
        let motionTime = try await js("return window.stage4LastMotion") as? Double ?? 0
        XCTAssertGreaterThan(motionTime, 0)
        let lowAccuracy = CLLocation(coordinate: simulator.coordinate, altitude: 0,
                                     horizontalAccuracy: 150, verticalAccuracy: -1, timestamp: Date())
        simulator.onFix(lowAccuracy, motionTime + 500)
        try await wait("document.querySelector('.gps-weak')?.textContent.includes('訊號較弱')", seconds: 5)
        XCTAssertEqual(simulator.distanceM, pausedDistance)
        try await screenshot("stage7-virtual-low-accuracy")
        simulator.start()
        try await wait("!document.querySelector('.gps-weak')?.textContent.includes('訊號較弱')", seconds: 5)
        print("IOS_STAGE7_VIRTUAL_ACCURACY: 150m fixture froze progress; ordinary virtual fixes recovered")
        controller.handleSimulatorAction(.jitter)
        controller.handleSimulatorAction(.park)

        controller.handleSimulatorAction(.signal)
        try await wait("document.querySelector('.gps-weak')?.innerText.includes('GPS 訊號中斷')")
        XCTAssertNil(controller.speech.currentText)
        XCTAssertEqual(controller.speech.queuedCount, 0)
        try await screenshot("stage4-signal-outage")
        let outageDistance = simulator.distanceM
        let outageSamples = try await js("return window.stage4Samples.length") as? Int
        try await waitForSimulator { simulator.distanceM >= outageDistance + 16 }
        let samplesAfterOutage = try await js("return window.stage4Samples.length") as? Int
        XCTAssertEqual(outageSamples, samplesAfterOutage)
        controller.handleSimulatorAction(.signal)
        try await wait("!document.querySelector('.gps-weak')?.innerText.includes('GPS 訊號中斷') && document.querySelector('.speed-num')?.innerText === '29'")
        try await screenshot("stage4-resumed-hud")

        controller.handleSimulatorAction(.rate(.fastest))
        try await wait("document.querySelector('.arrival-card')", seconds: 50)
        try await waitForSimulator { self.controller.locations.watches.isEmpty && !simulator.hasPendingWork }
        XCTAssertEqual(simulator.state, .arrived)
        XCTAssertNil(simulator.straightBearing)
        XCTAssertGreaterThan(simulator.distanceM, 850)
        print("IOS_STAGE4_NATURAL_ARRIVAL: elapsed=\(simulator.elapsedSeconds)s distance=\(Int(simulator.distanceM))m speechStarts=\(controller.speech.starts - speechBefore) watches=0")
        try await screenshot("stage4-natural-arrival")
        try await click("完成導航")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        XCTAssertFalse(controller.navigating)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
    }

    func testSimulatorRatesKeepMotionTimeDistanceAndSpeed() async throws {
        let simulator = SimulatorLocationSource()
        var samples: [(wall: Double, motion: Double, distance: Double, speed: Double)] = []
        simulator.onFix = { location, motion in
            samples.append((location.timestamp.timeIntervalSince1970, motion, simulator.distanceM, location.speed))
        }
        defer { simulator.stop() }
        XCTAssertTrue(simulator.prepare([[120.2758, 22.7327], [120.2758, 22.744]]))
        simulator.start()
        for rate in SimulatorLocationSource.Rate.allCases {
            simulator.setRate(rate)
            samples.removeAll()
            try await waitForSimulator { samples.filter { $0.speed > 0 }.count >= 3 }
            let moving = Array(samples.filter { $0.speed > 0 }.suffix(3))
            for (a, b) in zip(moving, moving.dropFirst()) {
                XCTAssertEqual(b.motion - a.motion, 1000, accuracy: 0.01)
                XCTAssertEqual(b.distance - a.distance, 8, accuracy: 0.01)
                XCTAssertEqual(b.speed * 3.6, 28.8, accuracy: 0.01)
            }
            let interval = (moving[2].wall - moving[0].wall) / 2
            let expected = 1 / Double(rate.rawValue)
            XCTAssertEqual(interval, expected, accuracy: max(0.08, expected * 0.4))
            print("IOS_STAGE4_RATE: \(rate.rawValue)x wall=\(String(format: "%.3f", interval))s logical=1s distance=8m speed=28.8km/h")
        }
        simulator.stop()
        XCTAssertFalse(simulator.hasPendingWork)
    }

    func waitForSimulator(seconds: Double = 10, _ condition: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() && Date() < deadline { try await Task.sleep(for: .milliseconds(35)) }
        guard condition() else {
            XCTFail("Timed out waiting for Simulator playback")
            throw NSError(domain: "LaneDevSimulatorTests", code: 1)
        }
    }

    private func observeAcceptance() async throws {
        _ = try await js("""
            const state = window.stage7 = { fixes: [], hud: [], reroutes: [] };
            window.addEventListener('lane-native', ({detail}) => {
              if (detail.type === 'position') {
                state.fixes.push({ time: performance.now(), timestamp: detail.timestamp, coords: detail.coords,
                  virtual: detail.motionTimestamp != null });
              }
            });
            const original = console.log;
            console.log = function(line, ...rest) {
              if (typeof line === 'string' && line.includes('[gps]') && /重規劃|分岔/.test(line)) {
                state.reroutes.push({time: performance.now(), line});
              }
              original.call(console, line, ...rest);
            };
            let signature = '';
            new MutationObserver(() => {
              const next = ['.banner-dist', '.trip b', '.speed-num']
                .map(selector => document.querySelector(selector)?.textContent).join('|');
              if (next && next !== signature && state.fixes.length && document.querySelector('.banner')) {
                state.hud.push({signature: next, fix: state.fixes.length, delay: performance.now() - state.fixes.at(-1).time});
              }
              signature = next;
            }).observe(document.body, { subtree: true, characterData: true, childList: true });
            """)
    }

    private func acceptanceMetrics(_ name: String, virtual: Bool) async throws {
        let metrics = try await js("""
            const points = stage7.fixes.filter(fix => fix.virtual === \(virtual));
            const median = xs => { const sorted = [...xs].sort((a,b) => a-b); return sorted[Math.floor(sorted.length/2)]; };
            const gaps = points.slice(1).map((point,i) => point.time - points[i].time);
            const hud = stage7.hud.filter(({fix, delay}) => stage7.fixes[fix-1].virtual === \(virtual) && delay < 1000);
            const distinct = [...new Map(hud.map(sample => [sample.fix, sample.delay])).values()];
            return { fixes: points.length, hud: distinct.length, intervalMs: median(gaps), updateMs: median(distinct),
              reroutes: stage7.reroutes.filter(entry => entry.line.includes('重規劃完成'))
                .map(entry => Number(entry.line.match(/耗時 ([0-9]+) ms/)?.[1])) };
            """) as? [String: Any]
        let result = try XCTUnwrap(metrics)
        XCTAssertGreaterThan(result["fixes"] as? Int ?? 0, 4)
        XCTAssertGreaterThan(result["hud"] as? Int ?? 0, 1)
        let encoded = try JSONSerialization.data(withJSONObject: result, options: .sortedKeys)
        print("IOS_STAGE7_METRICS \(name): \(String(decoding: encoded, as: UTF8.self))")
    }

    private func systemFixture(_ name: String) {
        FileHandle.standardOutput.write(Data("IOS_STAGE7_FIXTURE: \(name)\n".utf8))
    }

    private func awaitSystemPoint(_ name: String, lat: Double, lng: Double) async throws {
        _ = try await js("""
            window.stage7Point = null;
            window.stage7Watch = window.LaneGeolocation.watchPosition(() => {}, () => {}, {timeout:8000});
            window.addEventListener('lane-native', function receive({detail}) {
              const c = detail.coords;
              if (detail.type === 'position' && !detail.motionTimestamp && Math.abs(c.latitude - \(lat)) < 0.00005
                 && Math.abs(c.longitude - \(lng)) < 0.00005) {
                window.stage7Point = c;
                window.removeEventListener('lane-native', receive);
              }
            });
            """)
        systemFixture(name)
        try await wait("window.stage7Point", seconds: 12)
        _ = try await js("window.LaneGeolocation.clearWatch(window.stage7Watch)")
        try await waitForSimulator { self.controller.locations.watches.isEmpty }
    }

    private func planSchoolRoute() async throws {
        XCTAssertTrue(controller.locations.selectVirtual(false))
        try await awaitSystemPoint("school", lat: 22.729232, lng: 120.277426)
        try await plan(useVirtual: false)
        try await editLocalStop("起點", as: "高雄市楠梓區援中國民小學", query: "援中國民小學")
        try await editLocalStop("終點", as: "綜合籃球場")
        try await wait("document.querySelector('.route-start-button')?.disabled === false")
    }

    func testStage7SystemDrive() async throws {
        try await planSchoolRoute()
        let carOffersTwoStage = try await js("return !!document.querySelector('.mlist-item.two-stage')") as? Bool
        XCTAssertEqual(carOffersTwoStage, false)
        _ = try await js("document.querySelector('button[aria-label=機車]').click()")
        try await wait("document.querySelector('.mlist-item.two-stage')")
        let voiceWasOn = try await js("return document.querySelector('.client-settings input[type=checkbox]').checked") as? Bool
        if voiceWasOn == false {
            _ = try await js("document.querySelector('.client-settings input[type=checkbox]').click()")
            addTeardownBlock { [weak self] in
                _ = try await self?.js("const voice = document.querySelector('.client-settings input[type=checkbox]'); if (voice?.checked) voice.click()")
            }
        }
        let speechStarts = controller.speech.starts
        try await observeAcceptance()
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner-two-stage') && document.querySelector('.two-stage-sign')", seconds: 14)
        XCTAssertFalse(controller.locations.virtual)
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await wait("document.querySelector('.speed-num')?.textContent === '0'")
        try await screenshot("stage7-system-two-stage")
        if controller.speech.ready {
            try await waitForSpeech { self.controller.speech.starts > speechStarts }
            print("IOS_STAGE7_SYSTEM_SPEECH: first live Core Location guidance started native speech")
        }
        systemFixture("jitterwest")
        try await wait("stage7.fixes.some(f => Math.abs(f.coords.longitude - 120.277393) < 0.00001)", seconds: 7)
        systemFixture("jittereast")
        try await wait("stage7.fixes.some(f => Math.abs(f.coords.longitude - 120.277459) < 0.00001) && document.querySelector('.speed-num')?.textContent === '0'", seconds: 7)
        let reroutedWhenParked = try await js("return stage7.reroutes.some(entry => entry.line.includes('重規劃完成'))") as? Bool
        XCTAssertEqual(reroutedWhenParked, false)
        let point = CLLocationCoordinate2D(latitude: 22.729239, longitude: 120.277430)
        let lowAccuracy = CLLocation(coordinate: point, altitude: 0, horizontalAccuracy: 150,
                                     verticalAccuracy: -1, timestamp: Date())
        let locationManager = controller.locations.manager
        controller.locations.locationManager(locationManager, didUpdateLocations: [lowAccuracy])
        try await wait("stage7.fixes.some(f => f.coords.accuracy === 150) && document.querySelector('.gps-weak')?.textContent.includes('訊號較弱')", seconds: 5)
        try await screenshot("stage7-system-low-accuracy")
        controller.locations.locationManager(locationManager, didFailWithError:
            NSError(domain: kCLErrorDomain, code: CLError.Code.network.rawValue))
        try await wait("document.querySelector('.gps-weak')?.textContent.includes('GPS 訊號不可用')", seconds: 5)
        try await screenshot("stage7-system-interruption")
        _ = try await js("stage7.fixes.length = 0; stage7.hud.length = 0")
        systemFixture("drive")
        try await wait("stage7.fixes.some(f => f.coords.accuracy < 20) && !document.querySelector('.gps-weak')?.textContent.includes('GPS 訊號不可用')", seconds: 12)
        try await wait("document.querySelector('.banner-dist span')?.textContent.includes('右轉')", seconds: 24)
        try await wait("document.querySelector('.arrival-card')", seconds: 58)
        try await acceptanceMetrics("CoreLocation", virtual: false)
        try await screenshot("stage7-system-arrival")
        try await click("完成導航")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertNil(controller.speech.currentText)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
        print("IOS_STAGE7_SYSTEM_DRIVE: stop, delegate accuracy and interruption fixtures, actual OS recovery, two-stage, right turn, natural arrival and end")
    }

    func testStage7SystemReroute() async throws {
        try await planSchoolRoute()
        _ = try await js("document.querySelector('button[aria-label=機車]').click()")
        try await addLocalStop("棒球場")
        try await addLocalStop("高雄大學郵局")
        try await wait("document.querySelector('input[aria-label=\"停靠點 2\"]')?.value === '高雄大學郵局' && document.querySelector('.route-start-button')?.disabled === false")
        try await observeAcceptance()
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.trip-stop')?.textContent.includes('棒球場') && document.querySelector('.banner-two-stage')")
        systemFixture("straight")
        try await wait("stage7.reroutes.some(x => x.line.includes('重規劃完成'))", seconds: 35)
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await wait("document.querySelector('.trip-stop')?.textContent.includes('棒球場')")
        try await screenshot("stage7-system-reroute")
        _ = try await js("""
            window.stage7EarlyStop = false;
            new MutationObserver(() => {
              const fix = stage7.fixes.at(-1)?.coords;
              const next = document.querySelector('.trip-stop')?.textContent;
              if (fix && next?.includes('高雄大學郵局') &&
                  Math.hypot((fix.longitude - 120.279381) * 102700, (fix.latitude - 22.731749) * 110540) > 75) {
                if (!stage7EarlyStop && !stage7ReachedVia) stage7EarlyStop = true;
              } else if (next?.includes('高雄大學郵局')) {
                stage7ReachedVia = true;
              }
            }).observe(document.body, {subtree:true, childList:true, characterData:true});
            window.stage7ReachedVia = false;
            """)
        systemFixture("rejoin")
        try await wait("window.stage7ReachedVia && document.querySelector('.trip-stop')?.textContent.includes('高雄大學郵局') && !document.querySelector('.gps-weak')", seconds: 88)
        let earlyStop = try await js("return window.stage7EarlyStop") as? Bool
        XCTAssertEqual(earlyStop, false, "The order only advances after a fix near the current stop")
        try await screenshot("stage7-system-rejoined")
        try await acceptanceMetrics("CoreLocation-reroute", virtual: false)
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        XCTAssertTrue(controller.locations.watches.isEmpty)
        print("IOS_STAGE7_SYSTEM_REROUTE: missed turn, accepted replacement, rejoined and advanced from 棒球場 to 高雄大學郵局")
    }

    func testStage7SystemPermissionCycle() async throws {
        XCTAssertTrue(controller.locations.selectVirtual(false))
        try await awaitSystemPoint("home", lat: 22.7327, lng: 120.2758)
        try await plan(useVirtual: false)
        try await observeAcceptance()
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("stage7.fixes.length && document.querySelector('.banner')")
        systemFixture("revoke")
        try await wait("window.LaneGeolocation.getAuthorization() === 'denied' && document.querySelector('.gps-weak')?.textContent.includes('未授權')", seconds: 16)
        XCTAssertFalse(controller.locations.updating)
        XCTAssertNil(controller.speech.currentText)
        try await screenshot("stage7-permission-revoked")
        let saved = try await js("return stage7.fixes.length") as? Int ?? 0
        systemFixture("grant")
        try await wait("window.LaneGeolocation.getAuthorization() === 'full'", seconds: 16)
        systemFixture("school")
        try await wait("stage7.fixes.length > \(saved) && !document.querySelector('.gps-weak')?.textContent.includes('未授權')", seconds: 18)
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        print("IOS_STAGE7_SYSTEM_PERMISSION: real runtime revoke and regrant resumed the same watch")
    }

    func testStage7SystemPlanningFailures() async throws {
        XCTAssertTrue(controller.locations.selectVirtual(false))
        let saved = try await js("return localStorage.getItem('client.savedPlaces')") as? String
        let savedJSON = String(data: try JSONEncoder().encode(saved), encoding: .utf8)!
        addTeardownBlock { [weak self] in
            _ = try await self?.js("const v=\(savedJSON); if(v===null) localStorage.removeItem('client.savedPlaces'); else localStorage.setItem('client.savedPlaces',v)")
        }
        _ = try await js("""
            localStorage.setItem('client.savedPlaces', JSON.stringify({home:{name:'路網外測試',position:[121.5654,25.033]}}));
            document.body.dataset.previousDocument='true';
            """)
        controller.webView.reload()
        try await wait("!document.body.dataset.previousDocument && document.querySelector('.place-search-form input') && !document.querySelector('.loading')")
        try await setSearch(".place-search-form input", "確定查無地標72604")
        try await wait("document.querySelector('.place-message')?.textContent.includes('找不到符合')")
        try await screenshot("stage7-search-empty")
        try await awaitSystemPoint("outside", lat: 25.033, lng: 121.5654)
        try await setSearch(".place-search-form input", "高雄大學")
        try await selectLocalResult("國立高雄大學")
        _ = try await js("document.querySelector('.place-route-methods button').click()")
        try await wait("document.querySelector('.route-status-error')?.textContent.includes('目前位置距離可通行道路過遠') && document.querySelector('.route-status-error')?.textContent.includes('改用地圖選擇起點') && !document.querySelector('.route-start-button')", seconds: 12)
        try await screenshot("stage7-start-outside-network")
        _ = try await js("document.querySelector('button[aria-label=更換起點]').click()")
        try await wait("document.querySelector('.route-pick-options')?.textContent.includes('在地圖上選起點')", seconds: 5)
        _ = try await js("document.querySelector('.sp-close').click()")
        try await wait("document.querySelector('.place-search-form input')")
        try await awaitSystemPoint("disconnected", lat: 22.7211639, lng: 120.2590509)
        try await setSearch(".place-search-form input", "高雄大學")
        try await selectLocalResult("國立高雄大學")
        _ = try await js("document.querySelector('.place-route-methods button').click()")
        try await wait("document.querySelector('.route-status-error')?.textContent.includes('第 1 段規劃失敗')", seconds: 12)
        try await screenshot("stage7-unreachable-route")
        _ = try await js("document.querySelector('.sp-close').click()")
        try await wait("document.querySelector('.place-search-form input')")
        try await awaitSystemPoint("home", lat: 22.7327, lng: 120.2758)
        _ = try await js("document.querySelector('.place-search-form input').focus()")
        try await wait("[...document.querySelectorAll('.saved-place-chip')].some(b => b.textContent.includes('路網外測試'))")
        _ = try await js("[...document.querySelectorAll('.saved-place-chip')].find(b => b.textContent.includes('路網外測試')).click()")
        _ = try await js("document.querySelector('.place-route-methods button').click()")
        try await wait("document.querySelector('.route-status-error')?.textContent.includes('目的地附近找不到可導航道路')", seconds: 12)
        XCTAssertFalse(controller.navigating)
        try await screenshot("stage7-destination-outside-network")
        print("IOS_STAGE7_FAILURES: empty search, outside start, unreachable official graph component and outside saved destination")
    }

    /// Run separately with simctl privacy grant and simctl location start; no virtual source.
    func testSystemCoreLocationBridge() async throws {
        if controller.navigating { throw XCTSkip("Navigation from a failed test is still active") }
        XCTAssertTrue(controller.locations.selectVirtual(false))
        guard controller.locations.manager.authorizationStatus == .authorizedWhenInUse
            || controller.locations.manager.authorizationStatus == .authorizedAlways else {
            throw XCTSkip("Grant Simulator location permission and start a simctl location path before this test")
        }
        let position = try await js("""
            return await new Promise((resolve, reject) => window.LaneGeolocation.getCurrentPosition(
              p => resolve({longitude:p.coords.longitude, latitude:p.coords.latitude, accuracy:p.coords.accuracy, timestamp:p.timestamp}),
              e => reject(new Error(e.message)), {timeout:15000}));
            """) as! [String: Double]
        XCTAssertEqual(position["longitude"]!, 120.2758, accuracy: 0.02)
        XCTAssertEqual(position["latitude"]!, 22.7327, accuracy: 0.02)
        XCTAssertLessThan(abs(Date().timeIntervalSince1970 * 1000 - position["timestamp"]!), 10_000)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertFalse(controller.locations.updating)
        print("IOS_CORE_LOCATION: \(position), source=CoreLocation (Simulator injected; not real GPS)")
    }

    func testCoreLocationConversionAndAuthorizationPolicy() throws {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        let started = now.addingTimeInterval(-2)
        let coordinate = CLLocationCoordinate2D(latitude: 22.7327, longitude: 120.2758)
        let valid = CLLocation(coordinate: coordinate, altitude: 83, horizontalAccuracy: 5,
                               verticalAccuracy: 12, course: 71, courseAccuracy: 6,
                               speed: 8, speedAccuracy: 1, timestamp: now)
        let payload = try XCTUnwrap(LocationService.position(valid, since: started, now: now))
        let coords = try XCTUnwrap(payload["coords"] as? [String: Double])
        XCTAssertEqual(payload["timestamp"] as? Double, 1_795_000_000_000)
        XCTAssertEqual(coords, ["latitude": 22.7327, "longitude": 120.2758, "accuracy": 5,
                                "altitude": 83, "altitudeAccuracy": 12, "speed": 8, "heading": 71])
        let unknown = CLLocation(coordinate: coordinate, altitude: .nan, horizontalAccuracy: 7,
                                 verticalAccuracy: -1, course: 83, courseAccuracy: 75,
                                 speed: -1, speedAccuracy: -1, timestamp: now)
        let unknownPayload = try XCTUnwrap(LocationService.position(unknown, since: started, now: now))
        let unknownCoords = try XCTUnwrap(unknownPayload["coords"] as? [String: Any])
        for key in ["altitude", "altitudeAccuracy", "speed", "heading"] { XCTAssertTrue(unknownCoords[key] is NSNull) }
        XCTAssertTrue(JSONSerialization.isValidJSONObject(unknownPayload))
        let invalid = CLLocation(coordinate: coordinate, altitude: 0, horizontalAccuracy: -1,
                                 verticalAccuracy: 1, timestamp: now)
        XCTAssertNil(LocationService.position(invalid, since: started, now: now))
        XCTAssertFalse(LocationService.fresh(now.addingTimeInterval(-3), since: started, now: now))
        XCTAssertFalse(LocationService.fresh(now.addingTimeInterval(-11), since: .distantPast, now: now))
        XCTAssertFalse(LocationService.fresh(now.addingTimeInterval(2), since: started, now: now))
        XCTAssertEqual(LocationService.compassBearing(trueHeading: 90, magnetic: 80, accuracy: 5), 90)
        XCTAssertEqual(LocationService.compassBearing(trueHeading: -1, magnetic: 80, accuracy: 5), 80)
        XCTAssertNil(LocationService.compassBearing(trueHeading: 90, magnetic: 80, accuracy: 75))
        XCTAssertEqual(LocationAuthorization.resolve(.notDetermined, accuracy: .fullAccuracy, servicesEnabled: nil), .notDetermined)
        XCTAssertEqual(LocationAuthorization.resolve(.denied, accuracy: .fullAccuracy, servicesEnabled: true), .denied)
        XCTAssertEqual(LocationAuthorization.resolve(.denied, accuracy: .fullAccuracy, servicesEnabled: false), .servicesDisabled)
        XCTAssertEqual(LocationAuthorization.resolve(.restricted, accuracy: .fullAccuracy, servicesEnabled: true), .restricted)
        XCTAssertEqual(LocationAuthorization.resolve(.authorizedWhenInUse, accuracy: .reducedAccuracy, servicesEnabled: true), .reduced)
        XCTAssertEqual(LocationAuthorization.resolve(.authorizedWhenInUse, accuracy: .fullAccuracy, servicesEnabled: true), .full)
    }

    func testSystemLocationDrivesHudAndReloadCancelsWatch() async throws {
        XCTAssertTrue(controller.locations.selectVirtual(false))
        XCTAssertEqual(controller.locations.authorization, .full, "Grant Simulator location before starting the test")
        _ = try await js("""
            Object.defineProperty(navigator, 'geolocation', {get() { throw new Error('Browser GPS must not be opened on iOS'); }});
            window.systemFixes = [];
            window.addEventListener('lane-native', ({detail}) => {
              if (detail.type === 'position') window.systemFixes.push(detail);
            });
            """)
        try await plan(useVirtual: false)
        let before = try await js("return window.systemFixes.length") as! Int
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner') && window.systemFixes.length >= \(before + 2)", seconds: 25)
        XCTAssertTrue(controller.locations.updating)
        XCTAssertFalse(controller.locations.virtual)
        XCTAssertEqual(controller.locations.watches.count, 1)
        let evidence = try await js("""
            const [a,b] = window.systemFixes.slice(-2);
            return {fixes: [a,b].map(x => [x.coords.longitude,x.coords.latitude,x.timestamp]),
                    speed: document.querySelector('.speed-num')?.innerText,
                    hud: document.querySelector('.banner')?.innerText};
            """) as! [String: Any]
        let fixes = try XCTUnwrap(evidence["fixes"] as? [[Double]])
        XCTAssertGreaterThan(fixes[1][2], fixes[0][2])
        XCTAssertNotEqual(fixes[1][1], fixes[0][1], "Simulator OS fixture must move between updates")
        XCTAssertFalse((evidence["hud"] as? String ?? "").isEmpty)
        print("IOS_SYSTEM_LOCATION_HUD: \(evidence)")
        try await screenshot("stage3-system-location-hud")

        controller.setForeground(false)
        XCTAssertFalse(controller.locations.updating)
        try await wait("document.querySelector('.gps-weak')?.innerText.includes('已暫停')")
        let pausedCount = try await js("return window.systemFixes.length") as! Int
        try await Task.sleep(for: .milliseconds(1250))
        let countWhilePaused = try await js("return window.systemFixes.length") as? Int
        XCTAssertEqual(countWhilePaused, pausedCount)
        XCTAssertNil(controller.speech.currentText)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
        controller.setForeground(true)
        try await wait("window.systemFixes.length > \(pausedCount) && !document.querySelector('.gps-weak')?.innerText.includes('已暫停')")
        XCTAssertEqual(controller.locations.watches.count, 1)
        XCTAssertTrue(UIApplication.shared.isIdleTimerDisabled)

        _ = try await js("document.body.dataset.previousDocument='true'")
        if controller.speech.ready {
            controller.speech.speak(String(repeating: "前方請保持直行。", count: 12), priority: true)
            controller.speech.speak("前方有測速照相。")
            XCTAssertEqual(controller.speech.queuedCount, 1)
        }
        controller.webView.reload()
        try await wait("!document.body.dataset.previousDocument && document.querySelector('.place-search-form input') && !document.querySelector('.loading')")
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertFalse(controller.locations.updating)
        XCTAssertFalse(controller.navigating)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
        XCTAssertNil(controller.speech.currentText)
        XCTAssertEqual(controller.speech.queuedCount, 0)
        try await plan(useVirtual: false)
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner')")
        XCTAssertEqual(controller.locations.watches.count, 1)
        try await click("✕ 結束")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertFalse(controller.locations.updating)
        print("IOS_STAGE6_LIFECYCLE: pause stopped Core Location and cleared idle timer; new fix resumed one watch; reload cleared speech, idle timer and watches; navigation started again")
    }

    /// Run separately after simctl privacy revoke location, then restore permission.
    func testDeniedLocationPermission() async throws {
        XCTAssertTrue(controller.locations.selectVirtual(false))
        guard controller.locations.manager.authorizationStatus == .denied else {
            throw XCTSkip("Revoke Simulator location permission before this denial-specific test")
        }
        let error = try await js("""
            return await new Promise((resolve, reject) => {
              const id = 'denial-check';
              const handle = e => { if(e.detail.type === 'locationResult' && e.detail.id === id) {
                window.removeEventListener('lane-native',handle); resolve(e.detail.error); } };
              window.addEventListener('lane-native',handle);
              window.LaneNative.postMessage(JSON.stringify({type:'requestLocation',id}));
              setTimeout(() => reject(new Error('permission result missing')),3000);
            });
            """) as? String
        XCTAssertTrue(error?.contains("未授權") == true)
        let denied = try await js("""
            return await new Promise(resolve => window.LaneGeolocation.getCurrentPosition(
              () => resolve('unexpected fix'), e => resolve(e.reason), {timeout:3000}));
            """) as? String
        XCTAssertEqual(denied, "denied")
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertFalse(controller.locations.updating)
        print("IOS_DENIED_LOCATION: \(error ?? "missing")")
    }
    #endif
}
