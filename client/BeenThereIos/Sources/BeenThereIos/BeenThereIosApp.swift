import SwiftUI
import BeenThereViews

/// The iOS app shell.
///
/// The whole screen is `RootScreen`, exactly as the Mac app draws it at phone
/// width — here no frame is imposed because the phone is the frame. The
/// `.task` probe matches the Mac shell: the connection screen opens with the
/// service's real answer rather than a blank one.
///
/// The endpoint default is the same as the Mac's: `BEEN_THERE_BASE_URL` when
/// set (a launch-argument pass-through, so a simulator run can be pointed at
/// any service without a rebuild), then `127.0.0.1:8787` — which is correct on
/// the **simulator**, where localhost is the Mac itself. A *physical* iPhone
/// cannot reach the Mac's loopback, so the address field on the connection
/// screen exists: type the Mac's LAN address there.
@main
struct BeenThereIosApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("Been There") {
            RootScreen(model: model)
                .task {
                    await model.checkService()
                }
        }
    }
}
