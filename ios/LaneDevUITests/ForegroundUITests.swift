import XCTest

final class ForegroundUITests: XCTestCase {
    @MainActor
    override func tearDownWithError() throws {
        let shot = XCTAttachment(screenshot: XCUIApplication().screenshot())
        shot.name = "final-screen"; shot.lifetime = .keepAlways; add(shot)
    }

    @MainActor
    private func assertRecenterInNavigation(_ app: XCUIApplication, source: String) {
        let web = app.webViews.firstMatch
        let recenter = web.buttons["回到目前位置"]
        XCTAssertFalse(recenter.exists)
        let from = web.coordinate(withNormalizedOffset: CGVector(dx: 0.28, dy: 0.64))
        let to = web.coordinate(withNormalizedOffset: CGVector(dx: 0.61, dy: 0.50))
        from.press(forDuration: 0.05, thenDragTo: to)
        XCTAssertTrue(recenter.waitForExistence(timeout: 8), app.debugDescription)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "stage7-\(source)-drag-recenter"
        shot.lifetime = .keepAlways
        add(shot)
        recenter.tap()
        XCTAssertTrue(recenter.waitForNonExistence(timeout: 8), app.debugDescription)
        print("IOS_STAGE7_RECENTER \(source): drag released follow; recenter restored follow")
    }

    @MainActor
    func testOfflineMapGesturesAndPreferenceAfterRelaunch() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let locate = app.webViews.buttons["目前位置"]
        func waitForMap() {
            XCTAssertTrue(locate.waitForExistence(timeout: 30))
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: locate)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
        }
        func capture(_ name: String) throws -> Data {
            let shot = app.screenshot()
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            let image = try XCTUnwrap(shot.image.cgImage)
            let mapContent = CGRect(x: image.width / 5, y: image.height / 4,
                                    width: image.width * 3 / 5, height: image.height / 2)
            return try XCTUnwrap(try XCTUnwrap(image.cropping(to: mapContent)).dataProvider?.data) as Data
        }
        waitForMap()
        let start = try capture("offline-map-start")
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.54, dy: 0.59))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.33, dy: 0.43))
        from.press(forDuration: 0.08, thenDragTo: to)
        let dragged = try capture("offline-map-drag")
        XCTAssertNotEqual(start, dragged)

        // The canvas has a thin accessibility wrapper. Target the enclosing WebView's center.
        let map = app.webViews.firstMatch
        XCTAssertGreaterThan(map.frame.height, 200)
        map.pinch(withScale: 1.8, velocity: 0.8)
        let zoomed = try capture("offline-map-zoom")
        XCTAssertNotEqual(dragged, zoomed)
        map.rotate(CGFloat.pi / 3, withVelocity: 0.8)
        let rotated = try capture("offline-map-rotate")
        XCTAssertNotEqual(zoomed, rotated)

        let settings = app.webViews.buttons["設定"]
        func voiceControl() throws -> XCUIElement {
            settings.tap()
            let checkbox = app.webViews.checkBoxes["語音導航"]
            if checkbox.exists { return checkbox }
            let toggle = app.webViews.switches["語音導航"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), app.debugDescription)
            return toggle
        }
        let voice = try voiceControl()
        let saved = try XCTUnwrap(voice.value as? String)
        voice.tap()
        let changed = try XCTUnwrap(voice.value as? String)
        XCTAssertNotEqual(saved, changed)
        app.terminate()
        app.launch()
        waitForMap()
        let reopenedVoice = try voiceControl()
        XCTAssertEqual(reopenedVoice.value as? String, changed, "localStorage must retain the preference across process restarts")
        reopenedVoice.tap()
        XCTAssertEqual(reopenedVoice.value as? String, saved)
        settings.tap()
        _ = try capture("offline-map-reopened")
        print("IOS_OFFLINE_MAP: drag, pinch, rotate, process relaunch, persisted and restored preference")
    }

    @MainActor
    func testNavigationSettingsSurviveProcessRelaunch() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let web = app.webViews.firstMatch
        let settings = web.buttons["設定"]
        let locate = web.buttons["目前位置"]
        func openSettings() {
            XCTAssertTrue(locate.waitForExistence(timeout: 30))
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: locate)], timeout: 30), .completed)
            settings.tap()
        }
        func zoomControl() -> XCUIElement {
            let control = web.otherElements["導航視距"]
            XCTAssertTrue(control.waitForExistence(timeout: 5), web.debugDescription)
            return control
        }
        func chooseZoom(_ option: String) {
            zoomControl().tap()
            let menuOption = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", option)).firstMatch
            if menuOption.waitForExistence(timeout: 3) {
                menuOption.tap()
            } else {
                let wheel = app.pickerWheels.firstMatch
                XCTAssertTrue(wheel.waitForExistence(timeout: 3), app.debugDescription)
                wheel.adjust(toPickerWheelValue: option)
                app.buttons["Done"].tap()
            }
        }
        func openHomeEditor() -> XCUIElement {
            web.buttons["常用地點"].tap()
            web.buttons["編輯"].firstMatch.tap()
            let field = web.textFields["住家地址"]
            XCTAssertTrue(field.waitForExistence(timeout: 5), web.debugDescription)
            return field
        }
        func replaceAddress(_ field: XCUIElement, with text: String) {
            let current = field.value as? String ?? ""
            field.tap()
            let end = field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5))
            end.tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
            XCTAssertEqual(field.value as? String, text)
            web.buttons["只存地址文字"].tap()
        }
        openSettings()
        let checkbox = web.checkBoxes["語音導航"]
        let voice = checkbox.exists ? checkbox : web.switches["語音導航"]
        XCTAssertTrue(voice.waitForExistence(timeout: 5), web.debugDescription)
        let initialVoice = try XCTUnwrap(voice.value as? String)
        voice.tap()
        let changedVoice = try XCTUnwrap(voice.value as? String)
        XCTAssertNotEqual(changedVoice, initialVoice)
        let initialZoom = try XCTUnwrap(zoomControl().value as? String)
        let changedZoom = initialZoom == "遠景 · 16" ? "遠景 · 17" : "遠景 · 16"
        chooseZoom(changedZoom)
        XCTAssertEqual(zoomControl().value as? String, changedZoom)
        let field = openHomeEditor()
        let original = try XCTUnwrap(field.value as? String)
        let address = "LaneDev Stage 6"
        replaceAddress(field, with: address)
        app.terminate()
        app.launch()
        openSettings()
        XCTAssertEqual(voice.value as? String, changedVoice)
        XCTAssertEqual(zoomControl().value as? String, changedZoom)
        web.buttons["常用地點"].tap()
        XCTAssertTrue(web.staticTexts[address].waitForExistence(timeout: 5), web.debugDescription)
        let evidence = XCTAttachment(screenshot: app.screenshot())
        evidence.name = "stage6-relaunched-settings"
        evidence.lifetime = .keepAlways
        add(evidence)
        web.buttons["編輯"].firstMatch.tap()
        let home = web.textFields["住家地址"]
        replaceAddress(home, with: original)
        XCTAssertTrue(web.staticTexts[original].waitForExistence(timeout: 5), web.debugDescription)
        web.buttons["常用地點"].tap()
        chooseZoom(initialZoom)
        voice.tap()
        XCTAssertEqual(zoomControl().value as? String, initialZoom)
        XCTAssertEqual(voice.value as? String, initialVoice)
        print("IOS_STAGE6_PREFERENCES: changed voice, zoom and saved home; all three persisted after terminating and relaunching the process")
    }

    @MainActor
    func testIOSSettingsEntrypoints() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let web = app.webViews.firstMatch
        let settings = web.buttons["設定"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30))
        settings.tap()
        func dismissHelp(containing text: String) {
            let help = app.alerts["LaneDev"]
            XCTAssertTrue(help.waitForExistence(timeout: 5))
            let message = help.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
            XCTAssertTrue(message.exists, help.debugDescription)
            help.buttons["好"].tap()
        }
        web.buttons["語音設定"].tap()
        web.buttons["iOS 語音說明"].tap()
        dismissHelp(containing: "輔助使用")
        web.buttons["語音設定"].tap()
        web.buttons["定位與方向"].tap()
        web.buttons["iOS 定位服務說明"].tap()
        dismissHelp(containing: "隱私權與安全性")
        web.buttons["App 定位權限"].tap()
        let systemSettings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        XCTAssertTrue(systemSettings.wait(for: .runningForeground, timeout: 10))
        app.activate()
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        print("IOS_STAGE6_SETTINGS_ENTRIES: voice and device location instructions displayed; LaneDev's settings opened in Settings and returned to the app")
    }

    @MainActor
    func testMainFlowKeyboardMapStartAndEndButtons() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let web = app.webViews.firstMatch
        let search = web.textFields["搜尋地點或地址"]
        let locate = web.buttons["目前位置"]
        XCTAssertTrue(search.waitForExistence(timeout: 30))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: locate)], timeout: 30), .completed)
        search.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), app.debugDescription)
        search.typeText("高雄大學")
        let result = web.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "國立高雄大學 81148")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15), app.debugDescription)
        let screen = app.coordinate(withNormalizedOffset: .zero)
        let listTop = search.frame.maxY + 14
        let lower = min(keyboard.frame.minY - 18, listTop + 148)
        let upper = listTop + 24
        for _ in 0..<5 where !result.isHittable && lower > upper {
            let from = screen.withOffset(CGVector(dx: search.frame.midX, dy: lower))
            let to = screen.withOffset(CGVector(dx: search.frame.midX, dy: upper))
            from.press(forDuration: 0.05, thenDragTo: to)
        }
        XCTAssertTrue(result.isHittable, app.debugDescription)
        XCTAssertLessThanOrEqual(result.frame.maxY, keyboard.frame.minY + 2)
        func capture(_ name: String) {
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        capture("stage5-keyboard-local-search")
        result.tap()
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 6))
        let route = web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "路線")).firstMatch
        XCTAssertTrue(route.waitForExistence(timeout: 10)); route.tap()
        let origin = web.textFields["起點"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "我的位置"), object: origin)], timeout: 12), .completed)

        web.buttons["更換起點"].tap()
        let mapStart = web.buttons["在地圖上選起點"]
        XCTAssertTrue(mapStart.waitForExistence(timeout: 10), app.debugDescription)
        mapStart.tap()
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 6))
        XCTAssertTrue(web.buttons["取消選點"].waitForExistence(timeout: 8), app.debugDescription)
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.38, dy: 0.58)).tap()
        XCTAssertTrue(origin.waitForExistence(timeout: 8), app.debugDescription)
        XCTAssertNotEqual(origin.value as? String, "我的位置")

        let start = web.buttons["開始導航"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        XCTAssertTrue(start.isHittable)
        XCTAssertGreaterThanOrEqual(start.frame.height, 44)
        capture("stage5-map-selected-preview")
        start.tap()
        let end = web.buttons["✕ 結束"]
        XCTAssertTrue(end.waitForExistence(timeout: 15))
        XCTAssertTrue(end.isHittable)
        XCTAssertGreaterThanOrEqual(end.frame.height, 44)
        XCTAssertLessThanOrEqual(end.frame.maxY, web.frame.maxY)
        assertRecenterInNavigation(app, source: "keyboard-flow")
        end.tap()
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        print("IOS_STAGE5_TOUCH: keyboard results reachable, selected location, current start then replaced with map point, preview/exit controls >=44pt")
    }

    @MainActor
    func testTapSavedPlaceShortcutsWithKeyboardOpen() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let web = app.webViews.firstMatch
        let search = web.textFields["搜尋地點或地址"]
        let locate = web.buttons["目前位置"]
        XCTAssertTrue(search.waitForExistence(timeout: 30))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: locate)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)

        let keyboard = app.keyboards.firstMatch
        let route = web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "路線")).firstMatch
        for label in ["住家", "學校", "公司"] {
            search.tap()
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
            let shortcut = web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            XCTAssertTrue(shortcut.waitForExistence(timeout: 5), app.debugDescription)
            if !shortcut.isHittable {
                let school = web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "學校")).firstMatch
                school.swipeLeft()
            }
            shortcut.tap()
            XCTAssertTrue(route.waitForExistence(timeout: 8), app.debugDescription)
            XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
            route.tap()
            let destination = web.textFields["終點"]
            XCTAssertTrue(destination.waitForExistence(timeout: 8), app.debugDescription)
            XCTAssertTrue((destination.value as? String)?.hasPrefix(label) == true, app.debugDescription)
            web.buttons["關閉路線"].tap()
        }
    }

    #if !DEBUG
    @MainActor
    func testReleaseStartupTiming() {
        continueAfterFailure = false
        let app = XCUIApplication()
        var samples: [Int] = []
        for _ in 0..<3 {
            if app.state != .notRunning { app.terminate() }
            let startedAt = ProcessInfo.processInfo.systemUptime
            app.launch()
            let locate = app.webViews.buttons["目前位置"]
            XCTAssertTrue(locate.waitForExistence(timeout: 30))
            let usable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: locate)
            XCTAssertEqual(XCTWaiter.wait(for: [usable], timeout: 30), .completed)
            samples.append(Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000))
        }
        print("IOS_STARTUP_MS: \(samples)")
    }

    #endif

    @MainActor
    func testCoreLocationNavigationAndHomeResume() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertFalse(app.segmentedControls["location-source"].exists)
        XCTAssertFalse(app.buttons["sim-playback"].exists)
        XCTAssertFalse(app.buttons["sim-choose"].exists)
        XCTAssertFalse(app.buttons["sim-scenarios"].exists)
        let search = app.webViews.textFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 30))
        XCTAssertTrue(app.webViews.buttons["目前位置"].waitForExistence(timeout: 30))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.webViews.buttons["目前位置"])
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
        search.tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        search.tap()
        search.typeText("高雄大學")
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        let university = app.webViews.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "國立高雄大學 81148")).firstMatch
        XCTAssertTrue(university.waitForExistence(timeout: 10)); university.tap()
        let route = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "路線")).firstMatch
        XCTAssertTrue(route.waitForExistence(timeout: 10)); route.tap()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if alert.waitForExistence(timeout: 2) {
            print("IOS_PERMISSION_ALERT: \(alert.debugDescription)")
            let allow = alert.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "While Using", "使用期間")).firstMatch
            if allow.exists { allow.tap() }
        }
        let start = app.webViews.buttons["開始導航"]
        XCTAssertTrue(start.waitForExistence(timeout: 20), app.debugDescription); start.tap()
        let end = app.webViews.buttons["✕ 結束"]
        XCTAssertTrue(end.waitForExistence(timeout: 15))
        let direction = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "前方 ")).firstMatch
        XCTAssertTrue(direction.waitForExistence(timeout: 20), app.debugDescription)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "core-location-navigation"; shot.lifetime = .keepAlways; add(shot)
        assertRecenterInNavigation(app, source: "core-location")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5) || app.state == .runningBackgroundSuspended)
        app.activate()
        XCTAssertTrue(direction.waitForExistence(timeout: 20))
        let paused = app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "前景導航已暫停")).firstMatch
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: paused)], timeout: 15), .completed)
        end.tap()
        XCTAssertTrue(app.webViews.textFields.firstMatch.waitForExistence(timeout: 10))
    }
}
