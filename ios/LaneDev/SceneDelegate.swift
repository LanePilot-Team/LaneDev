import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = NavigationViewController()
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
}
