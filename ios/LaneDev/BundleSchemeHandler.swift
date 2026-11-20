import WebKit
import CryptoKit
import UniformTypeIdentifiers

/// Read-only, local bundle origin. No HTTP server, writes, or private WebKit preferences.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let origin = URL(string: "lanedev://app/index.html")!
    #if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
    static let expectedMode = "ios-simulator"
    #else
    static let expectedMode = "ios-release"
    #endif

    private struct Policy: Decodable {
        let format: String
        let mode: String
        let editor: Bool
        let simulation: Bool
        let transit: Bool
        let simulatorTools: Bool
        let runtimeManifest: String
    }

    enum ValidationError: LocalizedError {
        case missing, incompatible, checksum

        var errorDescription: String? {
            switch self {
            case .missing: return "內建導航資源不完整，請重新建置或安裝 LaneDev。"
            case .incompatible: return "內建前端版本或組態不相容，請重新建置或安裝 LaneDev。"
            case .checksum: return "路網版本清單校驗失敗，請重新建置或安裝 LaneDev。"
            }
        }
    }

    let root: URL
    init(root: URL) { self.root = root.standardizedFileURL.resolvingSymlinksInPath() }

    func validateBundle() throws {
        guard resource(for: Self.origin) != nil,
              let policyBytes = try? Data(contentsOf: root.appendingPathComponent("client-policy.json")),
              let manifestBytes = try? Data(contentsOf: root.appendingPathComponent("data/runtime/manifest.json"))
        else { throw ValidationError.missing }
        guard let policy = try? JSONDecoder().decode(Policy.self, from: policyBytes),
              policy.format == "lanedev-ios-client-v1", policy.mode == Self.expectedMode,
              !policy.editor, !policy.simulation, !policy.transit,
              policy.simulatorTools == (Self.expectedMode == "ios-simulator")
        else { throw ValidationError.incompatible }
        guard Self.sha256(manifestBytes) == policy.runtimeManifest else { throw ValidationError.checksum }
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func resource(for url: URL) -> URL? {
        guard url.scheme == "lanedev", url.host == "app", url.user == nil, url.password == nil,
              url.port == nil else { return nil }
        let path = url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/"),
              !file.lastPathComponent.hasPrefix("."),
              (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        return file
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let method = task.request.httpMethod ?? "GET"
        guard method == "GET", let file = resource(for: url) else {
            let response = HTTPURLResponse(url: url, statusCode: method == "GET" ? 404 : 403,
                httpVersion: "HTTP/1.1", headerFields: ["Access-Control-Allow-Origin": "*"])!
            task.didReceive(response); task.didFinish(); return
        }
        do {
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            let mime: String
            switch file.pathExtension.lowercased() {
            case "js", "mjs": mime = "text/javascript"
            case "json", "geojson": mime = "application/json"
            case "css": mime = "text/css"
            case "svg": mime = "image/svg+xml"
            default: mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            }
            var headers = ["Content-Type": mime + (mime.hasPrefix("text/") || mime == "application/json" ? "; charset=utf-8" : ""), "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Lane-SHA256",
                "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"]
            if file.pathExtension == "json" {
                headers["X-Lane-SHA256"] = Self.sha256(data)
            }
            task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
            task.didReceive(data)
            task.didFinish()
        } catch { task.didFailWithError(error) }
    }

    // Tasks finish synchronously on WebKit's main-thread callback, so none outlive stop.
    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
