import CoreLocation
import OSLog

final class LocationService: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()
    var emit: ([String: Any]) -> Void = { _ in }
    var changed: () -> Void = {}
    private(set) var watches = Set<Int>()
    private var permissionRequests = Set<String>()
    private(set) var foreground = true
    private(set) var updating = false
    private var resumedAt = Date()
    #if DEBUG && targetEnvironment(simulator)
    let simulator = SimulatorLocationSource()
    private(set) var virtual = false
    func selectVirtual(_ enabled: Bool) -> Bool {
        guard !navigationActive else { return false }
        manager.stopUpdatingLocation(); manager.stopUpdatingHeading(); updating = false
        simulator.stop()
        virtual = enabled
        resumedAt = Date()
        emit(["type": "heading", "value": NSNull()])
        completePermissions()
        refresh()
        return true
    }
    var navigationActive = false
    #endif

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = false
        #if DEBUG && targetEnvironment(simulator)
        simulator.onFix = { [weak self] location in self?.deliver(location) }
        #endif
    }

    var locationStatus: String {
        if !foreground { return "前景導航已暫停；回到 App 後等待新定位" }
        #if DEBUG && targetEnvironment(simulator)
        if virtual { return "Simulator 虛擬定位；非實機 GPS" }
        #endif
        switch manager.authorizationStatus {
        case .denied: return "未授權定位，請到 App 設定允許使用期間定位"
        case .restricted: return "系統限制使用定位"
        case .notDetermined: return "定位尚未授權"
        default:
            return manager.accuracyAuthorization == .fullAccuracy ? "精確定位已授權（僅前景）" : "僅允許概略位置，請在設定開啟精確位置"
        }
    }

    private var allowed: Bool {
        #if DEBUG && targetEnvironment(simulator)
        if virtual { return true }
        #endif
        return manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways
    }

    func requestPermission(id: String) {
        guard !id.isEmpty else { return }
        permissionRequests.insert(id)
        authorize()
    }
    private func authorize() {
        if !allowed && manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else { completePermissions(); refresh() }
    }
    private func completePermissions() {
        guard allowed || manager.authorizationStatus != .notDetermined else { return }
        let error = allowed ? "" : locationStatus
        for id in permissionRequests { emit(["type": "locationResult", "id": id, "error": error]) }
        permissionRequests.removeAll()
    }
    func start(id: Int) {
        watches.insert(id)
        authorize()
    }
    func stop(id: Int) { watches.remove(id); refresh() }
    func reset() {
        watches.removeAll(); permissionRequests.removeAll(); refresh()
    }
    func setForeground(_ active: Bool) {
        foreground = active
        resumedAt = Date()
        emit(["type": "lifecycle", "active": active])
        emit(["type": "heading", "value": NSNull()])
        if !active && !watches.isEmpty {
            emit(["type": "positionError", "code": 2, "message": "前景導航已暫停，返回 App 後等待新定位"])
        }
        refresh()
    }
    func refresh() {
        #if DEBUG && targetEnvironment(simulator)
        if virtual {
            if foreground && !watches.isEmpty { simulator.start(); updating = true }
            else { simulator.stop(); updating = false }
            changed(); return
        }
        #endif
        guard foreground, !watches.isEmpty, allowed else {
            manager.stopUpdatingLocation(); manager.stopUpdatingHeading(); updating = false
            if !allowed && manager.authorizationStatus != .notDetermined && !watches.isEmpty {
                emit(["type": "positionError", "code": 1, "message": locationStatus])
                watches.removeAll()
            }
            changed(); return
        }
        if !updating {
            manager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
        }
        updating = true
        changed()
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { completePermissions(); refresh() }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        #if DEBUG && targetEnvironment(simulator)
        guard !virtual else { return }
        #endif
        guard let location = locations.last, location.timestamp >= resumedAt else { return }
        deliver(location)
    }
    private func deliver(_ location: CLLocation) {
        guard foreground, !watches.isEmpty, location.horizontalAccuracy >= 0,
              CLLocationCoordinate2DIsValid(location.coordinate), abs(location.timestamp.timeIntervalSinceNow) < 15 else { return }
        emit(["type": "position", "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
            "coords": ["longitude": location.coordinate.longitude, "latitude": location.coordinate.latitude,
                "accuracy": location.horizontalAccuracy, "altitude": location.altitude,
                "altitudeAccuracy": location.verticalAccuracy >= 0 ? location.verticalAccuracy as Any : NSNull(),
                "speed": location.speed >= 0 ? location.speed as Any : NSNull(),
                "heading": location.course >= 0 ? location.course as Any : NSNull()]])
    }
    func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
        #if DEBUG && targetEnvironment(simulator)
        guard !virtual else { return }
        #endif
        guard foreground, !watches.isEmpty else { return }
        let value = heading.trueHeading >= 0 ? heading.trueHeading : heading.magneticHeading
        emit(["type": "heading", "value": heading.headingAccuracy >= 0 && value >= 0 ? value as Any : NSNull()])
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        #if DEBUG && targetEnvironment(simulator)
        guard !virtual else { return }
        #endif
        guard foreground, !watches.isEmpty else { return }
        let code = (error as? CLError)?.code
        Logger(subsystem: "tw.lanepilot.lanedev.ios", category: "Location").info("CoreLocation error=\(code?.rawValue ?? -1)")
        // A temporary unknown fix is recoverable: Core Location keeps trying.
        // Leave the subscription alive; the JS request's timeout handles prolonged loss.
        if code == .locationUnknown { return }
        let denied = code == .denied
        emit(["type": "positionError", "code": denied ? 1 : 2, "message": denied ? locationStatus : "GPS 訊號不可用，請移至空曠處"])
    }
}
