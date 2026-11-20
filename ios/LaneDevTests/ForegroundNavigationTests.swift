import XCTest
import WebKit
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
    func plan() async throws {
        #if targetEnvironment(simulator)
        XCTAssertTrue(controller.locations.selectVirtual(true))
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
        XCTAssertGreaterThan(controller.locations.simulator.route.count, 2)
        controller.locations.simulator.togglePlayback()
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
        let before = controller.speech.finishes
        _ = try await js("window.LaneNative.postMessage(JSON.stringify({type:'ttsTest'}))")
        let deadline = Date().addingTimeInterval(30)
        while controller.speech.finishes == before && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertGreaterThan(controller.speech.starts, 0)
        XCTAssertGreaterThan(controller.speech.finishes, before)
        print("IOS_SPEECH_CALLBACKS: starts=\(controller.speech.starts), finishes=\(controller.speech.finishes), \(controller.speech.audio)")
    }

    #if targetEnvironment(simulator)
    func testDeviationReroutesAndArrival() async throws {
        try await plan()
        _ = try await js("document.querySelector('.route-start-button').click()")
        try await wait("document.querySelector('.banner') && !document.querySelector('.gps-msg')")
        try await Task.sleep(for: .seconds(2))
        let simulator = controller.locations.simulator
        let destination = try XCTUnwrap(simulator.route.last)
        let revision = simulator.routeRevision
        simulator.deviate()
        let deadline = Date().addingTimeInterval(30)
        while simulator.routeRevision == revision && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertGreaterThan(simulator.routeRevision, revision, "Off-route fixes must cause the real shared reroute")
        XCTAssertEqual(controller.locations.watches.count, 1)
        print("IOS_REROUTE: revision \(revision) -> \(simulator.routeRevision); one native watch")
        try await screenshot("rerouted-navigation")
        // Inject an arrival GPS fix; the shared GpsDriver still decides arrival.
        simulator.setRoute([[destination.longitude, destination.latitude], [destination.longitude, destination.latitude]])
        simulator.togglePlayback()
        simulator.tick()
        try await wait("document.querySelector('.arrival-card')")
        XCTAssertTrue(controller.locations.watches.isEmpty)
        try await screenshot("arrival")
        try await click("完成導航")
        try await wait("document.querySelector('.app')?.dataset.mode === 'browse'")
        XCTAssertFalse(controller.navigating)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
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
              p => resolve({longitude:p.coords.longitude, latitude:p.coords.latitude, accuracy:p.coords.accuracy}),
              e => reject(new Error(e.message)), {timeout:15000}));
            """) as! [String: Double]
        XCTAssertEqual(position["longitude"]!, 120.2758, accuracy: 0.02)
        XCTAssertEqual(position["latitude"]!, 22.7327, accuracy: 0.02)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertFalse(controller.locations.updating)
        print("IOS_CORE_LOCATION: \(position), source=CoreLocation (Simulator injected; not real GPS)")
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
        XCTAssertTrue(controller.locations.watches.isEmpty)
        XCTAssertFalse(controller.locations.updating)
        print("IOS_DENIED_LOCATION: \(error ?? "missing")")
    }
    #endif
}
