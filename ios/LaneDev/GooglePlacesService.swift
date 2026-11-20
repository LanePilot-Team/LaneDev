import CoreLocation
import GooglePlacesSwift
import SwiftUI
import UIKit

@MainActor
final class GooglePlacesService {
    private let key = (Bundle.main.object(forInfoDictionaryKey: "LaneGooglePlacesAPIKey") as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    private var initialized = false
    private var activeID: String?
    private weak var sheet: UIViewController?
    var configured: Bool { !key.isEmpty && !key.hasPrefix("$(") }

    func search(_ command: [String: Any], from presenter: UIViewController,
                reply: @escaping ([String: Any]) -> Void) {
        guard let id = command["id"] as? String, !id.isEmpty, id.count <= 64 else { return }
        func respond(_ fields: [String: Any]) {
            reply(fields.merging(["type": "googlePlaceResult", "id": id]) { value, _ in value })
        }
        guard configured else {
            respond(["error": "Google Places 未設定 iOS 金鑰，本地搜尋仍可使用。"])
            return
        }
        guard activeID == nil, presenter.presentedViewController == nil else {
            respond(["error": "請先關閉目前的搜尋畫面。"])
            return
        }
        guard let input = command["query"] as? String else { return }
        let query = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...200).contains(query.count) else {
            respond(["error": "請輸入 1 至 200 字的搜尋文字。"])
            return
        }
        if !initialized { initialized = PlacesClient.provideAPIKey(key) }
        guard initialized else {
            respond(["error": "Google Places 無法使用這組 iOS 金鑰，請檢查 App 設定。"])
            return
        }

        let center: CLLocationCoordinate2D
        if let lon = command["longitude"] as? Double, let lat = command["latitude"] as? Double,
           CLLocationCoordinate2DIsValid(.init(latitude: lat, longitude: lon)) {
            center = .init(latitude: lat, longitude: lon)
        } else {
            center = .init(latitude: 22.728, longitude: 120.2986)
        }
        let request = SearchByTextRequest(
            textQuery: query, placeProperties: [.placeID, .coordinate],
            locationBias: CircularCoordinateRegion(center: center, radius: 10_000),
            maxResultCount: 5, isOpenNow: false, rankPreference: .relevance, regionCode: "TW"
        )
        activeID = id
        let view = GooglePlacesSearchSheet(query: query, request: request) { [weak self] place in
            guard let self, self.activeID == id else { return }
            self.cancel()
            if let place {
                respond(["placeID": place.id, "longitude": place.location.longitude, "latitude": place.location.latitude])
            } else {
                respond(["cancelled": true])
            }
        }
        let sheet = UIHostingController(rootView: view)
        sheet.isModalInPresentation = true
        self.sheet = sheet
        presenter.present(sheet, animated: true)
    }

    func cancel(id: String? = nil) {
        guard id == nil || id == activeID else { return }
        activeID = nil
        sheet?.dismiss(animated: true)
        sheet = nil
    }
}

private struct GooglePlacesSearchSheet: View {
    typealias Selection = (id: String, location: CLLocationCoordinate2D)
    let query: String
    let finish: (Selection?) -> Void
    @State private var request: PlaceSearchViewRequest
    @State private var message: String?
    @State private var showsLicenses = false

    init(query: String, request: SearchByTextRequest, finish: @escaping (Selection?) -> Void) {
        self.query = query
        self.finish = finish
        _request = State(initialValue: .searchByText(request))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text(query).font(.subheadline).foregroundStyle(.secondary).padding(.horizontal)
                if let message {
                    Text(message).font(.callout).padding(.horizontal)
                        .accessibilityIdentifier("google-places-message")
                }
                PlaceSearchView(request: $request, configuration: PlaceSearchConfiguration(
                    content: [.address()], theme: PlacesMaterialTheme(), selectable: true
                ))
                .onLoad { places in message = places.isEmpty ? "找不到符合的 Google 地點。" : nil }
                .onRequestError { error in
                    switch error {
                    case .keyInvalid, .keyExpired, .accessNotConfigured, .incorrectBundleIdentifier:
                        message = "Google Places 未授權。請檢查 iOS 金鑰、Bundle ID、API 限制及帳單。"
                    case .network:
                        message = "目前無法連線至 Google Places，可回到本地搜尋。"
                    case .usageLimitExceeded, .rateLimitExceeded, .deviceRateLimitExceeded:
                        message = "Google Places 已達使用上限，可回到本地搜尋。"
                    default:
                        message = "Google Places 暫時無法搜尋，可回到本地搜尋。"
                    }
                }
                .onPlaceSelected { place in
                    let location = place.location
                    guard let id = place.placeID, !id.isEmpty,
                          CLLocationCoordinate2DIsValid(location) else {
                        message = "這筆結果缺少位置，請選擇其他地點。"
                        return
                    }
                    finish((id, location))
                }
            }
            .navigationTitle("Google Places")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("返回本地") { finish(nil) } }
                ToolbarItem(placement: .primaryAction) { Button("授權資訊") { showsLicenses = true } }
            }
            .sheet(isPresented: $showsLicenses) {
                NavigationStack {
                    ScrollView { Text(PlacesClient.openSourceLicenseInfo).font(.footnote).padding() }
                        .navigationTitle("開放原始碼授權")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { Button("完成") { showsLicenses = false } }
                }
            }
        }
    }
}
