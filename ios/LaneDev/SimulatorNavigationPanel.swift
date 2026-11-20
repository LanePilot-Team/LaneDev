#if DEBUG && LANE_SIMULATOR_NAVIGATION && targetEnvironment(simulator)
import UIKit

@MainActor
final class SimulatorNavigationPanel: UIStackView {
    enum Action {
        case selectVirtual(Bool), choosePoints, start, pause, resume, end
        case rate(SimulatorLocationSource.Rate), straight, park, jitter, signal
    }

    var perform: (Action) -> Void = { _ in }
    private let source = UISegmentedControl(items: ["Core Location", "虛擬定位"])
    private let rates = UISegmentedControl(items: ["1x", "3x", "8x"])
    private let status = UILabel()
    private let controls = UIStackView()
    private let choose = SimulatorNavigationPanel.button("選起終點", id: "sim-choose")
    private let playback = SimulatorNavigationPanel.button("開始", id: "sim-playback")
    private let end = SimulatorNavigationPanel.button("結束", id: "sim-end")
    private let scenarios = SimulatorNavigationPanel.button("情境", id: "sim-scenarios")

    init() {
        super.init(frame: .zero)
        axis = .vertical
        spacing = 4
        isLayoutMarginsRelativeArrangement = true
        layoutMargins = UIEdgeInsets(top: 4, left: 8, bottom: 4, right: 8)
        source.accessibilityIdentifier = "location-source"
        rates.accessibilityIdentifier = "sim-rate"
        source.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.perform(.selectVirtual(self.source.selectedSegmentIndex == 1))
        }, for: .valueChanged)
        rates.addAction(UIAction { [weak self] _ in
            guard let self, SimulatorLocationSource.Rate.allCases.indices.contains(self.rates.selectedSegmentIndex) else { return }
            self.perform(.rate(SimulatorLocationSource.Rate.allCases[self.rates.selectedSegmentIndex]))
        }, for: .valueChanged)
        status.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        status.textColor = .secondaryLabel
        status.accessibilityIdentifier = "sim-status"
        controls.axis = .vertical
        controls.spacing = 4
        let actions = UIStackView(arrangedSubviews: [choose, playback, end, scenarios])
        actions.spacing = 4
        actions.distribution = .fillEqually
        controls.addArrangedSubview(status)
        controls.addArrangedSubview(actions)
        controls.addArrangedSubview(rates)
        addArrangedSubview(source)
        addArrangedSubview(controls)
        scenarios.showsMenuAsPrimaryAction = true
        choose.addAction(UIAction { [weak self] _ in self?.perform(.choosePoints) }, for: .touchUpInside)
        end.addAction(UIAction { [weak self] _ in self?.perform(.end) }, for: .touchUpInside)
        playback.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.perform(self.playbackAction)
        }, for: .touchUpInside)
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private var playbackAction = Action.start
    private var menuState: [Bool] = []

    func update(_ simulator: SimulatorLocationSource, virtual: Bool, navigating: Bool, ready: Bool, picking: Bool) {
        source.selectedSegmentIndex = virtual ? 1 : 0
        controls.isHidden = !virtual
        choose.isEnabled = !navigating
        end.isEnabled = navigating
        rates.selectedSegmentIndex = SimulatorLocationSource.Rate.allCases.firstIndex(of: simulator.rate) ?? 0
        scenarios.isEnabled = simulator.state == .driving || simulator.state == .paused

        let label: String
        let prefix: String
        switch simulator.state {
        case .idle:
            label = "開始"; playbackAction = .start
            prefix = ready ? "路線已就緒" : picking ? "點地圖選起點與終點" : "選起終點或使用地點搜尋"
        case .driving:
            label = "暫停"; playbackAction = .pause
            prefix = simulator.signalLost ? "訊號中斷" : simulator.parked ? "停車" : simulator.straightBearing != nil ? "保持直行" : "行駛"
        case .paused:
            label = "繼續"; playbackAction = .resume; prefix = "已暫停"
        case .arrived:
            label = "抵達"; prefix = "已抵達"
        }
        if playback.configuration?.title != label { playback.configuration?.title = label }
        playback.isEnabled = simulator.state == .idle ? ready && !navigating : simulator.state != .arrived

        let stats = simulator.state == .idle ? "" : " · \(simulator.elapsedSeconds) 秒 · \(Int(simulator.distanceM)) m"
        let reroutes = simulator.reroutes > 0 ? " · 重算 \(simulator.reroutes)" : ""
        status.text = prefix + stats + reroutes
        let nextMenu = [simulator.straightBearing != nil, simulator.parked, simulator.jitter, simulator.signalLost]
        if menuState != nextMenu {
            menuState = nextMenu
            scenarios.menu = UIMenu(children: [
                menuAction("保持直行", .straight, selected: nextMenu[0]),
                menuAction(nextMenu[1] ? "繼續行駛" : "停車", .park, selected: nextMenu[1]),
                menuAction("定位抖動", .jitter, selected: nextMenu[2]),
                menuAction(nextMenu[3] ? "恢復訊號" : "中斷訊號", .signal, selected: nextMenu[3]),
            ])
        }
    }

    private func menuAction(_ title: String, _ action: Action, selected: Bool) -> UIAction {
        UIAction(title: title, state: selected ? .on : .off) { [weak self] _ in self?.perform(action) }
    }

    private static func button(_ title: String, id: String) -> UIButton {
        var config = UIButton.Configuration.tinted()
        config.title = title
        config.buttonSize = .small
        let button = UIButton(configuration: config)
        button.accessibilityIdentifier = id
        return button
    }
}

#endif
