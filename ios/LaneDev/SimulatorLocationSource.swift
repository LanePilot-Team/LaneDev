#if DEBUG && targetEnvironment(simulator)
import CoreLocation

/// TEMPORARY: delete this file, toolbar, bridge hook and simulator tests before the iPhone milestone.
/// Generates location fixes only; never computes route state or bypasses road restrictions.
final class SimulatorLocationSource {
    var onFix: (CLLocation) -> Void = { _ in }
    private(set) var coordinate = CLLocationCoordinate2D(latitude: 22.7327, longitude: 120.2758)
    private(set) var playing = false
    private var timer: Timer?
    private(set) var route: [CLLocationCoordinate2D] = []
    private(set) var routeRevision = 0
    private var segment = 0
    private var segmentM = 0.0
    private var deviation = false
    private let speed = 8.0

    func setRoute(_ coords: [[Double]]) {
        routeRevision += 1
        route = coords.filter { $0.count == 2 && $0.allSatisfy(\.isFinite) }
            .map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) }
            .filter(CLLocationCoordinate2DIsValid)
        segment = 0; segmentM = 0
        // Preserve the current fix when receiving an actual reroute.
        deviation = false
    }
    func togglePlayback() { if route.count > 1 { playing.toggle() } }
    func pause() { playing = false }
    func deviate() {
        playing = false; deviation = true
        coordinate.longitude += 0.002; coordinate.latitude -= 0.001
    }
    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        // Async: JS must receive its watch id before the first fix.
    }
    func stop() { timer?.invalidate(); timer = nil }
    func tick() {
        var heading: CLLocationDirection = -1
        if playing && !deviation && route.count > 1 {
            var step = speed
            while segment < route.count - 1 {
                let a = route[segment], b = route[segment + 1]
                let length = CLLocation(latitude: a.latitude, longitude: a.longitude)
                    .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
                let left = max(0, length - segmentM)
                if step >= left {
                    step -= left; segment += 1; segmentM = 0; coordinate = b
                } else {
                    segmentM += step
                    let f = length > 0 ? segmentM / length : 0
                    coordinate = .init(latitude: a.latitude + (b.latitude - a.latitude) * f,
                        longitude: a.longitude + (b.longitude - a.longitude) * f)
                    heading = atan2((b.longitude - a.longitude) * cos(a.latitude * .pi / 180), b.latitude - a.latitude) * 180 / .pi
                    heading = (heading + 360).truncatingRemainder(dividingBy: 360)
                    break
                }
            }
            if segment == route.count - 1 { playing = false }
        }
        onFix(CLLocation(coordinate: coordinate, altitude: 0, horizontalAccuracy: 6,
            verticalAccuracy: -1, course: heading, speed: playing ? speed : 0, timestamp: Date()))
    }
}
#endif
