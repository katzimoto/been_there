import SwiftUI
import BeenThereViews

#if canImport(UIKit)
import UIKit
#endif

/// The iOS app shell.
///
/// The whole screen is `RootScreen`, exactly as the Mac shell draws it at phone
/// width — here no frame is imposed because the phone is the frame. The
/// `.task` probe matches the Mac shell: the connection screen opens with the
/// service's real answer rather than a blank one.
///
/// ## The two things this shell owns
///
/// Everything a screen shows lives in `BeenThereViews`, so this file has two
/// jobs and no more:
///
/// 1. **Haptics.** The only `UIKit` in the client, because a tap you can feel is
///    the one thing the shared views cannot do for themselves — they build for
///    macOS too, and a platform import there would break that. It is injected
///    through the environment exactly as the palette is, so a view asks for
///    feedback without knowing which platform it is running on.
/// 2. **The scene**, plus the endpoint default.
///
/// The endpoint default is `BEEN_THERE_BASE_URL` when set, then
/// `127.0.0.1:8787` — which is correct on the **simulator**, where localhost is
/// the Mac itself. A *physical* iPhone cannot reach the Mac's loopback, so the
/// address field on the connection screen exists: type the Mac's LAN address
/// there.
@main
struct BeenThereIosApp: App {
    @State private var model = AppModel()

    /// UIKit's generators where they exist, and nothing at all where they do not.
    private var platformFeedback: Feedback {
        #if canImport(UIKit)
        IosFeedback.make()
        #else
        .silent
        #endif
    }

    var body: some Scene {
        WindowGroup("Been There") {
            RootScreen(model: model, feedback: platformFeedback)
                .task {
                    await model.checkService()
                }
        }
    }
}

#if canImport(UIKit)
/// `UIKit`'s feedback generators, adapted to the view layer's vocabulary.
///
/// A type rather than three closures at the call site, so the mapping from
/// "what happened" to "how it feels" is one readable switch instead of being
/// spread across every button. Generators are prepared once and fired on the
/// main actor, which is what `UIImpactFeedbackGenerator` expects.
enum IosFeedback {
    static func make() -> Feedback {
        Feedback(
            impact: { weight in
                let style: UIImpactFeedbackGenerator.FeedbackStyle = switch weight {
                case .light: .light
                case .medium: .medium
                case .heavy: .heavy
                case .soft: .soft
                case .rigid: .rigid
                }
                let generator = UIImpactFeedbackGenerator(style: style)
                generator.prepare()
                generator.impactOccurred()
            },
            notify: { result in
                let style: UINotificationFeedbackGenerator.FeedbackType = switch result {
                case .success: .success
                case .warning: .warning
                case .error: .error
                }
                let generator = UINotificationFeedbackGenerator()
                generator.prepare()
                generator.notificationOccurred(style)
            },
            selection: {
                UISelectionFeedbackGenerator().selectionChanged()
            }
        )
    }
}
#endif