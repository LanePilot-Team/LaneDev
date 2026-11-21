import CoreLocation
import OSLog

enum LocationAuthorization: String {
    case checking, notDetermined, denied, restricted, reduced, full, servicesDisabled

    static func resolve(_ status: CLAuthorizationStatus, accuracy: CLAccuracyAuthorization,
                        servicesEnabled: Bool?) -> Self {
        switch status {
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        case .denied:
            guard let servicesEnabled else { return .checking }
            return servicesEnabled ? .denied : .servicesDisabled
        case .authorizedAlways, .authorizedWhenInUse:
            return accuracy == .fullAccuracy ? .full : .reduced
        @unknown default: return .restricted
        }
    }

    var message: String {
        switch self {
        case .checking: return "正在確認定位服務…"
        case .notDetermined: return "定位尚未授權"
        case .denied: return "未授權定位，請到 App 設定允許使用期間定位"
        case .restricted: return "系統限制使用定位"
        case .reduced: return "僅允許概略位置，請在 App 設定開啟精確位置"
        case .full: return "精確定位已授權（僅前景）"
        case .servicesDisabled: return "手機定位服務已關閉，請到設定開啟定位服務"
        }
    }

    var awaitingDecision: Bool { self == .checking || self == .notDetermined }
}

final class LocationService: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()
    var emit: ([String: Any]) -> Void = { _ in }
    var changed: () -> Void = {}
    private(set) var watches = Set<String>()
    private var permissionRequests = Set<String>()
    private var permissionPromptPending = false
    private var reportedErrors: [String: LocationAuthorization] = [:]
    private var servicesEnabled: Bool?
    private var servicesCheck = 0
    private(set) var foreground = true
    private(set) var updating = false
    private var startedAt = Date()
    private var lastFixAt = Date.distantPast

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = false
    }

    var authorization: LocationAuthorization {
        return .resolve(manager.authorizationStatus, accuracy: manager.accuracyAuthorization,
                        servicesEnabled: servicesEnabled)
    }

    var locationStatus: String {
        return foreground ? authorization.message : "前景導航已暫停，回到 App 後等待新定位"
    }

    func publishState() {
        publishForeground()
        publishAuthorization()
    }

    private func publishForeground() {
        emit(["type": "lifecycle", "active": foreground,
              "timestamp": Date().timeIntervalSince1970 * 1000])
    }

    private func publishAuthorization() {
        emit(["type": "locationAuthorization", "state": authorization.rawValue])
    }

    private func clearHeading() {
        emit(["type": "heading", "value": NSNull()])
    }

    func requestPermission(id: String) {
        guard !id.isEmpty else { return }
        permissionRequests.insert(id)
        authorize()
    }

    func cancelPermission(id: String) { permissionRequests.remove(id) }

    private func authorize() {
        if foreground && authorization == .notDetermined && !permissionPromptPending {
            permissionPromptPending = true
            manager.requestWhenInUseAuthorization()
        }
        refresh()
    }

    private func checkAuthorization() {
        servicesCheck += 1
        servicesEnabled = nil
        let check = servicesCheck
        guard authorization == .checking else { refresh(); return }
        // Apple's system-wide lookup can block the calling thread.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let enabled = CLLocationManager.locationServicesEnabled()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.servicesCheck == check else { return }
                self.servicesEnabled = enabled
                self.refresh()
            }
        }
        refresh()
    }

    func start(id: String) {
        guard !id.isEmpty else { return }
        watches.insert(id)
        authorize()
    }

    func stop(id: String) {
        watches.remove(id)
        reportedErrors.removeValue(forKey: id)
        if watches.isEmpty { stopUpdates() }
    }

    func reset() {
        watches.removeAll()
        reportedErrors.removeAll()
        permissionRequests.removeAll()
        permissionPromptPending = false
        stopUpdates()
    }

    func setForeground(_ active: Bool) {
        guard foreground != active else { return }
        foreground = active
        publishForeground()
        clearHeading()
        if active {
            checkAuthorization()
            if !watches.isEmpty || !permissionRequests.isEmpty { authorize() }
        } else {
            refresh()
        }
    }

    private func stopUpdates() {
        guard updating else { return }
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
        updating = false
    }

    private func refresh() {
        let state = authorization
        publishAuthorization()
        if !state.awaitingDecision {
            permissionPromptPending = false
            let error = state == .full ? "" : state.message
            let requests = permissionRequests
            permissionRequests.removeAll()
            for id in requests {
                emit(["type": "locationResult", "id": id, "error": error, "authorization": state.rawValue])
            }
        }
        if state == .full { reportedErrors.removeAll() }
        if foreground && !watches.isEmpty && state == .full {
            if !updating {
                startedAt = Date()
                lastFixAt = .distantPast
                updating = true
                manager.startUpdatingLocation()
                if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
            }
        } else {
            stopUpdates()
            if state != .full && !state.awaitingDecision {
                clearHeading()
                let ids = watches.filter { reportedErrors[$0] != state }
                for id in ids { reportedErrors[id] = state }
                if !ids.isEmpty {
                    emit(["type": "positionError", "ids": Array(ids), "code": 1,
                          "reason": state.rawValue, "message": state.message, "recoverable": true])
                }
            }
        }
        changed()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        checkAuthorization()
    }

    static func fresh(_ timestamp: Date, since start: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(timestamp)
        return timestamp >= start && age >= -1 && age <= 10
    }

    static func position(_ location: CLLocation, since start: Date, now: Date) -> [String: Any]? {
        guard fresh(location.timestamp, since: start, now: now),
              CLLocationCoordinate2DIsValid(location.coordinate),
              location.horizontalAccuracy.isFinite, location.horizontalAccuracy >= 0 else { return nil }
        let altitudeValid = location.altitude.isFinite && location.verticalAccuracy.isFinite && location.verticalAccuracy >= 0
        let course = location.course
        let courseAccuracy = location.courseAccuracy
        let courseValid = course.isFinite && (0..<360).contains(course) && (0...45).contains(courseAccuracy)
        let speedValid = location.speed.isFinite && location.speed >= 0
            && location.speedAccuracy.isFinite && location.speedAccuracy >= 0
        return [
            "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
            "coords": ["longitude": location.coordinate.longitude, "latitude": location.coordinate.latitude,
                       "accuracy": location.horizontalAccuracy, "altitude": altitudeValid ? location.altitude as Any : NSNull(),
                       "altitudeAccuracy": altitudeValid ? location.verticalAccuracy as Any : NSNull(),
                       "speed": speedValid ? location.speed as Any : NSNull(),
                       "heading": courseValid ? course as Any : NSNull()]
        ]
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations.reversed() {
            if deliver(location) { break }
        }
    }

    private func deliver(_ location: CLLocation) -> Bool {
        guard foreground, updating, authorization == .full, !watches.isEmpty,
              location.timestamp > lastFixAt,
              var payload = Self.position(location, since: startedAt, now: Date()) else { return false }
        lastFixAt = location.timestamp
        payload["type"] = "position"
        payload["ids"] = Array(watches)
        emit(payload)
        return true
    }

    static func compassBearing(trueHeading: Double, magnetic: Double, accuracy: Double) -> Double? {
        guard accuracy.isFinite, (0...45).contains(accuracy) else { return nil }
        return [trueHeading, magnetic].first { $0.isFinite && (0..<360).contains($0) }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
        guard foreground, updating, authorization == .full,
              Self.fresh(heading.timestamp, since: startedAt, now: Date()) else { return }
        let value = Self.compassBearing(trueHeading: heading.trueHeading, magnetic: heading.magneticHeading,
                                        accuracy: heading.headingAccuracy)
        emit(["type": "heading", "value": value.map { $0 as Any } ?? NSNull()])
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard foreground, !watches.isEmpty else { return }
        let code = (error as? CLError)?.code
        Logger(subsystem: "tw.lanepilot.lanedev.ios", category: "Location").info("CoreLocation error=\(code?.rawValue ?? -1)")
        switch code {
        case .locationUnknown: break // Core Location continues looking; the bridge owns the fix timeout.
        case .headingFailure: clearHeading()
        case .denied: checkAuthorization()
        default:
            emit(["type": "positionError", "ids": Array(watches), "code": 2,
                  "reason": "unavailable", "message": "GPS 訊號不可用，請移至空曠處"])
        }
    }
}
