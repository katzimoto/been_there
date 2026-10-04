import SwiftUI
import BeenThereViews

/// The iOS app shell.
///
/// ## Everything a screen shows lives elsewhere
///
/// The whole product surface is `BeenThereViews`, consumed unchanged and built
/// for the iOS SDK by this target. `../BeenThereMac` is the same arrangement on
/// the Mac, which is what makes the sharing checkable rather than aspirational:
/// neither shell contains a view, a rule, or a networking call, so a screen
/// cannot drift between the two platforms without one of those packages
/// changing.
///
/// ## Why the canvas fills the screen and the content is 390pt
///
/// `BeenThereViews` lays every screen out at `phoneWidth` (390) on purpose —
/// a layout that is free to fill its window grows a two-column layout on a
/// Mac, and that layout cannot be put back onto a phone without rewriting it.
/// A phone wider than 390pt therefore shows the same column centred, and this
/// shell paints `Ink.canvas` behind it so the margin is the page rather than a
/// border around one. The narrower phones get the column edge to edge.
///
/// ## Where the service address comes from
///
/// `AppModel.init` reads `BEEN_THERE_BASE_URL` and falls back to the port
/// `make demo` prints, and the screen still lets it be typed and checked. The
/// simulator shares the host's loopback, so `127.0.0.1:8787` is the host's
/// address here exactly as it is in a browser on it.
@main
struct BeenThereIOSApp: App {

    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootScreen(model: model)
                // The column is centred by `phoneFrame` inside `RootScreen`;
                // this is the colour behind whatever space is left over.
                .background(Ink.canvas)
                .task {
                    // Probe the service the address field names, so the app
                    // opens with the service's real answer rather than a blank
                    // one. Same call the Mac shell makes.
                    await model.checkService()
                }
        }
    }
}
