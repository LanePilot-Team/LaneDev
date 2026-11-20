#if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
import CoreLocation

/// Temporary Simulator driver. It produces fixes and never decides navigation progress or arrival.
final class SimulatorLocationSource {
    enum Rate: Int, CaseIterable { case normal = 1, fast = 3, fastest = 8 }
    enum State { case idle, driving, paused, arrived }

    var onFix: (CLLocation, Double) -> Void = { _, _ in }
    var onChange: () -> Void = {}
    private static let anchor = CLLocationCoordinate2D(latitude: 22.7327, longitude: 120.2758)
    private static let speedMps = 8.0
    private(set) var coordinate = SimulatorLocationSource.anchor
    private(set) var state = State.idle
    private(set) var rate = Rate.normal
    private(set) var parked = false
    private(set) var jitter = false
    private(set) var signalLost = false
    private(set) var straightBearing: Double?
    private(set) var reroutes = 0
    private(set) var elapsedSeconds = 0
    private(set) var distanceM = 0.0
    private(set) var track: [CLLocationCoordinate2D] = []
    private var tripEpoch = 0.0
    private var segment = 0
    private var segmentM = 0.0
    private var course: Double?
    private var subscribed = false
    private var timer: Timer?
    private var initialFix: DispatchWorkItem?

    var hasPendingWork: Bool { timer != nil || initialFix != nil }

    @discardableResult
    func prepare(_ coords: [[Double]]) -> Bool {
        let points = coords.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count == 2, pair.allSatisfy(\.isFinite) else { return nil }
            let point = CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
            return CLLocationCoordinate2DIsValid(point) ? point : nil
        }
        guard points.count == coords.count, points.count >= 2 else { return false }
        end()
        track = points
        coordinate = points[0]
        tripEpoch = Date().timeIntervalSince1970 * 1000
        state = .driving
        schedule()
        onChange()
        return true
    }

    func start() {
        guard !subscribed else { return }
        subscribed = true
        if state != .paused && !signalLost {
            let initial = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.initialFix = nil
                guard self.subscribed, self.state != .paused, !self.signalLost else { return }
                self.emit(speed: 0)
            }
            initialFix = initial
            DispatchQueue.main.async(execute: initial)
        }
        schedule()
    }

    /// Stop the subscription for source switches, Home, or a completed watch.
    func stop() {
        subscribed = false
        cancelWork()
    }

    func end() {
        cancelWork()
        state = .idle
        coordinate = Self.anchor
        track = []
        straightBearing = nil
        course = nil
        parked = false
        jitter = false
        signalLost = false
        reroutes = 0
        elapsedSeconds = 0
        distanceM = 0
        tripEpoch = 0
        segment = 0
        segmentM = 0
        onChange()
    }

    func pause() {
        guard state == .driving else { return }
        state = .paused
        cancelWork()
        onChange()
    }

    func resume() {
        guard state == .paused else { return }
        state = .driving
        schedule()
        onChange()
    }

    func arrive() {
        guard state == .driving || state == .paused else { return }
        state = .arrived
        cancelWork()
        onChange()
    }

    func setRate(_ value: Rate) {
        guard rate != value else { return }
        rate = value
        timer?.invalidate()
        timer = nil
        schedule()
        onChange()
    }

    func keepStraight() {
        guard state == .driving, straightBearing == nil else { return }
        let next = track.dropFirst(segment + 1).first { Self.distance(coordinate, $0) > 0.1 }
        straightBearing = course ?? next.map { Self.bearing(coordinate, $0) }
        onChange()
    }

    func setParked(_ value: Bool) { parked = value; onChange() }
    func setJitter(_ value: Bool) { jitter = value; onChange() }
    func setSignalLost(_ value: Bool) { signalLost = value; onChange() }
    func noteReroute() { reroutes += 1; onChange() }

    private func cancelWork() {
        initialFix?.cancel()
        initialFix = nil
        timer?.invalidate()
        timer = nil
    }

    private func schedule() {
        guard subscribed, state == .driving, timer == nil else { return }
        let timer = Timer(timeInterval: 1 / Double(rate.rawValue), repeats: true) { [weak self] _ in
            self?.tick()
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func tick() {
        guard subscribed, state == .driving else { return }
        elapsedSeconds += 1
        let moved = parked ? 0 : advance(by: Self.speedMps)
        distanceM += moved
        if !signalLost { emit(speed: moved) }
        onChange()
    }

    private func advance(by meters: Double) -> Double {
        if let straightBearing {
            coordinate = Self.destination(coordinate, bearing: straightBearing, meters: meters)
            course = straightBearing
            return meters
        }
        var remaining = meters
        while remaining > 0 && segment < track.count - 1 {
            let a = track[segment], b = track[segment + 1]
            let length = Self.distance(a, b)
            let left = max(0, length - segmentM)
            if length > 0.001 { course = Self.bearing(a, b) }
            if remaining >= left {
                remaining -= left
                segment += 1
                segmentM = 0
                coordinate = b
            } else {
                segmentM += remaining
                let fraction = segmentM / length
                coordinate = .init(latitude: a.latitude + (b.latitude - a.latitude) * fraction,
                                   longitude: a.longitude + (b.longitude - a.longitude) * fraction)
                remaining = 0
            }
        }
        return meters - remaining
    }

    private func emit(speed: Double) {
        let offsets: [Double] = [45, 225, 135, 315]
        let point = jitter ? Self.destination(coordinate, bearing: offsets[elapsedSeconds % 4], meters: 6) : coordinate
        let heading = speed > 0 ? course : nil
        onFix(CLLocation(coordinate: point, altitude: 0, horizontalAccuracy: jitter ? 14 : 5,
            verticalAccuracy: -1, course: heading ?? -1, courseAccuracy: heading == nil ? -1 : 0,
            speed: speed, speedAccuracy: 0, timestamp: Date()), tripEpoch + Double(elapsedSeconds) * 1000)
    }

    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude)
            .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    private static func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let radians = Double.pi / 180
        let latA = a.latitude * radians, latB = b.latitude * radians
        let lon = (b.longitude - a.longitude) * radians
        let east = sin(lon) * cos(latB)
        let north = cos(latA) * sin(latB) - sin(latA) * cos(latB) * cos(lon)
        return (atan2(east, north) / radians + 360).truncatingRemainder(dividingBy: 360)
    }

    private static func destination(_ from: CLLocationCoordinate2D, bearing: Double, meters: Double) -> CLLocationCoordinate2D {
        let radians = Double.pi / 180
        let lat = from.latitude * radians, lon = from.longitude * radians
        let angle = meters / 6_371_008.8, direction = bearing * radians
        let nextLat = asin(sin(lat) * cos(angle) + cos(lat) * sin(angle) * cos(direction))
        let nextLon = lon + atan2(sin(direction) * sin(angle) * cos(lat), cos(angle) - sin(lat) * sin(nextLat))
        return .init(latitude: nextLat / radians,
                     longitude: (nextLon / radians + 540).truncatingRemainder(dividingBy: 360) - 180)
    }
}
#endif
