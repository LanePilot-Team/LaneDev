import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let controller = NavigationViewController()
        controller.setForeground(false)
        window.rootViewController = controller
        self.window = window
        (UIApplication.shared.delegate as? AppDelegate)?.window = window
        window.makeKeyAndVisible()
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? NavigationViewController)?.setForeground(true)
    }
    func sceneWillResignActive(_ scene: UIScene) {
        (window?.rootViewController as? NavigationViewController)?.setForeground(false)
    }
    func sceneDidDisconnect(_ scene: UIScene) {
        (window?.rootViewController as? NavigationViewController)?.disconnect()
        if let delegate = UIApplication.shared.delegate as? AppDelegate, delegate.window === window {
            delegate.window = nil
        }
        window = nil
    }
}
