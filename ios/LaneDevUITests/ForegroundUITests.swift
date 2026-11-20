import XCTest

final class ForegroundUITests: XCTestCase {
    @MainActor
    override func tearDownWithError() throws {
        let shot = XCTAttachment(screenshot: XCUIApplication().screenshot())
        shot.name = "final-screen"; shot.lifetime = .keepAlways; add(shot)
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

    #if DEBUG
    @MainActor
    func testTouchNavigationAndHomeResume() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.segmentedControls["location-source"].waitForExistence(timeout: 10))
        app.segmentedControls["location-source"].buttons["虛擬定位"].tap()
        let search = app.webViews.textFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 30))
        search.tap()
        search.typeText("高雄大學")
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        let university = app.webViews.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "國立高雄大學 81148")).firstMatch
        XCTAssertTrue(university.waitForExistence(timeout: 10), app.debugDescription)
        university.tap()
        let route = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "路線")).firstMatch
        XCTAssertTrue(route.waitForExistence(timeout: 10), app.debugDescription)
        route.tap()
        let start = app.webViews.buttons["開始導航"]
        XCTAssertTrue(start.waitForExistence(timeout: 15), app.debugDescription)
        start.tap()
        let end = app.webViews.buttons["✕ 結束"]
        XCTAssertTrue(end.waitForExistence(timeout: 15), app.debugDescription)
        let direction = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "前方 ")).firstMatch
        XCTAssertTrue(direction.waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["沿路線前進"].tap()
        let nav = XCTAttachment(screenshot: app.screenshot())
        nav.name = "touch-foreground-navigation"; nav.lifetime = .keepAlways; add(nav)
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5) || app.state == .runningBackgroundSuspended)
        app.activate()
        XCTAssertTrue(end.waitForExistence(timeout: 15))
        end.tap()
        XCTAssertTrue(app.webViews.textFields.firstMatch.waitForExistence(timeout: 10))
    }
    #else
    @MainActor
    func testReleaseBundleWithSystemLocation() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertFalse(app.segmentedControls["location-source"].exists)
        XCTAssertFalse(app.buttons["沿路線前進"].exists)
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
        shot.name = "release-core-location-navigation"; shot.lifetime = .keepAlways; add(shot)
        end.tap()
        XCTAssertTrue(app.webViews.textFields.firstMatch.waitForExistence(timeout: 10))
    }
    #endif
}
