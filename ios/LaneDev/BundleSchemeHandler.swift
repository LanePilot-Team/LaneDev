import WebKit
import CryptoKit
import UniformTypeIdentifiers

/// Read-only, local bundle origin. No HTTP server, writes, or private WebKit preferences.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let origin = URL(string: "lanedev://app/index.html")!
    let root: URL
    init(root: URL) { self.root = root.standardizedFileURL.resolvingSymlinksInPath() }

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
                headers["X-Lane-SHA256"] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            }
            task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
            task.didReceive(data)
            task.didFinish()
        } catch { task.didFailWithError(error) }
    }

    // Tasks finish synchronously on WebKit's main-thread callback, so none outlive stop.
    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
