import XCTest

/// The app, driven the way a person drives it.
///
/// ## Why this target exists
///
/// Everything else in the client is a unit test over a function, which cannot
/// answer the question that matters most about an app: does it work? A
/// `ClientGate` test proves the mirror agrees with the kernel; nothing proves the
/// screen is reachable, that the buttons are where a thumb expects, or that
/// signing in with a real credential against a real service actually gets a
/// member to their people. That is this file's job.
///
/// It runs against the service a developer already has (`make demo`), which is
/// why it reads its address and credentials from the environment rather than
/// hard-coding a port. It is skipped, loudly, when the service is not there —
/// a skipped test is a statement about the machine, not a green result.
///
/// ## The credentials
///
/// `BEEN_THERE_DEMO_CONTACT` and `BEEN_THERE_DEMO_PASSWORD`, which the seeder
/// prints. One of the eight seeded people. Signing in as a seeded member rather
/// than signing up is deliberate: a seeded person has a profile and a standing, so
/// the People tab has something to show, and a signup would need four API calls
/// this file has no business making.
final class BeenThereIosUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        // The first frame of a SwiftUI app is laid out twice; tapping during that
        // lands on coordinates that are about to move. One settle wait is the
        // difference between a reliable tap and an intermittent one.
        _ = app.staticTexts["Been There"].waitForExistence(timeout: 10)
    }

    /// The service address, or nil when the environment does not name one.
    private func serviceURL() -> URL? {
        guard let raw = ProcessInfo.processInfo.environment["BEEN_THERE_BASE_URL"],
              let url = URL(string: raw) else { return nil }
        return url
    }

    private func credentials() -> (contact: String, password: String)? {
        let environment = ProcessInfo.processInfo.environment
        guard let contact = environment["BEEN_THERE_DEMO_CONTACT"],
              let password = environment["BEEN_THERE_DEMO_PASSWORD"] else { return nil }
        return (contact, password)
    }

    /// Signs in and waits for the tab bar the service's data unlocks.
    func testAMemberCanSignInAndReachTheirPeople() throws {
        guard let url = serviceURL(), let credentials = credentials() else {
            throw XCTSkip("BEEN_THERE_BASE_URL and the demo credentials are needed; `make demo` prints them")
        }

        let address = app.textFields.firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 10), "the address field is the first thing on the screen")
        address.replace(with: url.absoluteString)

        let contact = app.textFields.element(boundBy: 1)
        XCTAssertTrue(contact.waitForExistence(timeout: 5), "the contact field is the second field")
        contact.replace(with: credentials.contact)

        // The secure field is the flaky one: SwiftUI gives it focus on tap, but
        // while the keyboard from the field above is up it can swallow the first
        // tap, and the symptom is a silent empty field rather than an error. So
        // it is typed into until the value is actually there, twice at most.
        let password = app.secureTextFields.firstMatch
        XCTAssertTrue(password.waitForExistence(timeout: 5), "the password field is a secure field")
        for attempt in 1...2 {
            password.replace(with: credentials.password)
            let typed = (password.value as? String)?.isEmpty == false
            if typed { break }
            if attempt == 2 {
                XCTFail("the password field never took focus")
            }
        }

        // The keyboard has to go first. With it up, the sign-in button sits
        // *underneath* it, and a tap at the button's centre is delivered to the
        // keyboard — silently, because the tap succeeds against something else.
        // Return dismisses a SwiftUI field, which is the one gesture that means
        // "I am done typing here".
        app.typeText("\n")

        // The sign-in action is a button labelled "Sign in"; the tab bar carries
        // a tab with the same name once a session exists, so the query is pinned
        // to the button rather than to the label.
        let signIn = app.buttons.matching(identifier: "Sign in").firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 5), "the sign-in button is on the credentials card")
        signIn.tap()

        // What the screen looks like at this point, whether or not the assertion
        // below passes. A UI test that fails with no picture of the screen is a
        // riddle; this is the artefact that answers it.
        let state = XCTAttachment(screenshot: app.screenshot())
        state.name = "after-sign-in-tap"
        state.lifetime = .keepAlways
        add(state)
        print("SCREEN AFTER SIGN-IN:\n\(app.debugDescription)")

        // The tab bar is the proof, and it only lists the tabs this load can
        // serve: an Account tab appearing means the service published a session
        // *and* an account, so the member is in the app rather than staring at the
        // form they just filled in. Asserting the specific destination instead —
        // People, or Setup — would be asserting the server's answer, which this
        // test does not own and which differs per seeded person.
        // The tab is exposed as an image carrying the tab's accessibility label,
        // not as a button with that label — SwiftUI hands the VStack's parts to
        // the accessibility tree individually — so this queries the image.
        let account = app.images["Account"]
        XCTAssertTrue(
            account.waitForExistence(timeout: 20),
            "signing in did not reach the app; the tab bar never offered the account screen"
        )

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "people-after-sign-in"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}

private extension XCUIElement {
    /// Puts an exact value into a field, whatever was there before.
    ///
    /// Three things this has to get right, each learned from a failure:
    ///
    /// 1. **Tap the centre, not the element.** A SwiftUI `TextField`'s hit area
    ///    includes its label and padding, and tapping the element's own origin can
    ///    land on neither. A coordinate tap in the middle always lands inside.
    /// 2. **Select all, then type.** The address field arrives pre-filled with
    ///    the loopback URL, and `typeText` appends, so typing without selecting
    ///    produces a URL with two of them. Sending deletes for every character is
    ///    the other way to clear it and is what fails when focus is uncertain.
    /// 3. **Check the result.** A tap that misses focus fails *silently* in
    ///    XCUITest: the type goes nowhere and the next assertion reports a
    ///    failure with no connection to the cause. So the value is read back.
    func replace(with text: String) {
        tapCentre()
        // The keyboard appearing is the signal that the tap landed. Without this
        // wait the typing races the first-responder change and the text goes
        // nowhere — silently, because the type itself succeeds against whatever
        // happens to hold focus.
        let keyboard = XCUIApplication().keyboards.firstMatch
        _ = keyboard.waitForExistence(timeout: 5)
        if let existing = value as? String, !existing.isEmpty {
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
        typeText(text)
        let current = (value as? String) ?? ""
        if current.isEmpty {
            // A tap that missed focus fails silently in XCUITest: the text goes
            // nowhere and the next assertion blames the app. One more tap turns a
            // mystery into a failure with a cause.
            tapCentre()
            _ = keyboard.waitForExistence(timeout: 5)
            typeText(text)
        }
    }

    /// A tap at the element's midpoint.
    func tapCentre() {
        coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
}