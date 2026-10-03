import SwiftUI
import BeenThereViews

/// The macOS app shell.
///
/// ## Everything a screen shows lives elsewhere
///
/// This file is the `@main`, the window, and the frame. The views are
/// `BeenThereViews`, which declares both `.iOS(.v17)` and `.macOS(.v14)` and
/// contains no AppKit, no UIKit and no platform conditionals — so the iOS app
/// consumes the same files and this target is the only thing that gets thrown
/// away.
///
/// ## Why the phone is drawn inside a window
///
/// The view layer is laid out at a fixed 390pt (`phoneFrame`), which is the
/// whole reason a layout tuned here survives contact with a phone. A window wide
/// enough to fill would let a two-column layout form, and that layout would have
/// to be unwound before the same code could run on a phone. So the window is a
/// little wider than the phone and the app inside it is exactly phone-width,
/// with the difference showing as the desk around it.
///
/// The `.compact` window style is what makes the title bar collapse to the
/// traffic lights and the window grow by the tab bar height, so the content
/// area really is 390pt rather than 390pt minus a chunk of chrome.
@main
struct BeenThereMacApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("Been There") {
            RootScreen(model: model)
                .frame(width: phoneWidth, height: 780)
                .task {
                    // Probes the service the address field names, so the
                    // connection screen opens with a real answer rather than a
                    // blank one. The endpoint came from `BEEN_THERE_BASE_URL`
                    // when it is set and from `make demo`'s port otherwise.
                    await model.checkService()
                }
        }
        // `.windowStyle` takes no argument on macOS, and hiding the title bar
        // would leave the window without a close button. The phone-width chrome
        // lives inside `RootScreen` instead, which is where the shared views can
        // own it without this shell needing to know about it.
        .defaultSize(width: phoneWidth, height: 780)
        .commands {
            // Refreshing from the menu is the one command the app has, and it
            // does exactly what the buttons do: re-read the server's
            // projections. Nothing here decides anything.
            CommandGroup(after: .appInfo) {
                Button("Reload from the service") {
                    Task { await model.refresh() }
                }
                .disabled(model.session == nil)
            }
        }
    }
}