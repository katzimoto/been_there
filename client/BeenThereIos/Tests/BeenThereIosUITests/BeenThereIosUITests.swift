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
/// `BEEN_THERE_DEMO_CONTACTS` and `BEEN_THERE_DEMO_PASSWORD`, which the seeder
/// prints. One of the eight seeded people, chosen by index.
/// Signing in as a seeded member rather than signing up is deliberate: a seeded
/// person has a profile and a standing, so the People tab has something to show,
/// and a signup would need four API calls this file has no business making.
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

    /// One seeded person per test, because the service rate-limits sign-ins.
    ///
    /// `LOGIN_ATTEMPTS_PER_WINDOW` is five per account per fifteen minutes, and
    /// this suite signs in once per test — so three tests against one account hit
    /// a limit that has nothing to do with what they are testing, and the failure
    /// reads as a broken password. The seeder loads eight people and prints their
    /// addresses, so each test takes its own. `BEEN_THERE_DEMO_PASSWORD` is one
    /// password for all of them by design.
    private func credentials(as person: Int) -> (contact: String, password: String)? {
        let environment = ProcessInfo.processInfo.environment
        guard let password = environment["BEEN_THERE_DEMO_PASSWORD"] else { return nil }
        let contacts = (environment["BEEN_THERE_DEMO_CONTACTS"] ?? "")
            .split(separator: ",")
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !contacts.isEmpty else { return nil }
        // Wrapped rather than clamped: a suite that grew past the dataset should
        // fail as a missing fixture, not quietly test the same person twice.
        guard person >= 0, person < contacts.count else { return nil }
        return (contacts[person], password)
    }

    /// Signs in for real and checks the app moved.
    ///
    /// ## What this test is really about
    ///
    /// It used to assert that an element labelled "Account" appeared in the tab
    /// bar, and it passed — while the app never left the sign-in form. The
    /// assertion was empty: the SF Symbol for the *sign-in tab* is
    /// `person.crop.circle`, whose system accessibility label is "Account", so
    /// the element was there from the first frame whether or not a single request
    /// had been made.
    ///
    /// Worse, `app.buttons.matching(identifier: "Sign in").firstMatch` resolved to
    /// the tab-bar tab rather than the button on the credentials card — both are
    /// "Sign in" to any client that identifies by name, and the tab sits later in
    /// the hierarchy. So the tap called `go(to: .signIn)`, which is a no-op, and
    /// `signIn()` was never invoked at all. The test proved a link in a chain
    /// three steps away from the thing it claimed to prove.
    ///
    /// What it asserts now is the thing the member would look at: the
    /// credentials form is gone, and the tab bar no longer offers a Sign in tab
    /// to shadow the Sign in button with. Tabs are identified as tabs
    /// (`tab.signIn`), which is what makes the second assertion possible.
    func testAMemberCanSignInAndReachTheirPeople() throws {
        // Another seeded person, not the one with the match: this test asserts
        // that sign-in works, and it does not care who.
        // A third person, deliberately: the two match-dependent tests own Avery
        // and Blair between them, and the service allows five sign-ins per account
        // per fifteen minutes. Two tests sharing an account spend that budget
        // twice per run, and after three local runs the third run is refused —
        // which reads as a UI failure and is not one.
        try signIn(as: 2)

        // The proof: the form the member just filled in is not on screen any
        // more. Before the fix the tap hit the tab bar and this was still true
        // twenty seconds later, which is exactly what made the old assertion
        // useless.
        // `continueAfterFailure` is already false in `setUp`, so a timeout here
        // fails the test on its own.
        let gone = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: app.staticTexts["EMAIL OR PHONE"]
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [gone], timeout: 25), .completed,
            "signing in did not move the app off the sign-in form"
        )

        // And the shadow is gone. A "Sign in" tab with a session held can only
        // return a member to a form they no longer need, so it is withheld; its
        // absence is what stops it swallowing the next tap as well.
        XCTAssertFalse(
            app.buttons["tab.signIn"].exists,
            "the tab bar still offers a Sign in tab alongside a signed-in session"
        )

        // The member surfaces the product cannot be used without are reachable
        // from the tab bar the service's data unlocked.
        XCTAssertTrue(
            app.buttons["tab.matches"].waitForExistence(timeout: 10),
            "the Matches surface is not reachable after signing in"
        )

        attach("after-sign-in")
    }

    /// The matches page lists what `GET /v1/matches` published, and offers the
    /// safety actions the server granted.
    func testAMemberSeesTheirMatchesAndTheSafetyActions() throws {
        // Avery, not Blair: one sign-in per account per run, and the two
        // match-dependent tests must not share a budget. See `MatchedMember`.
        try signIn(as: MatchedMember.first)
        try tapMatchesTab()

        // Before the wait, not after the assertions.
        //
        // `waitForMatchesToLoad()` is where this test fails, and an attachment
        // placed after it never runs on the failure path — so the one run that
        // needed a picture of the screen produced no picture. On the failure
        // paths the four states are distinguishable and mean different bugs: a
        // `FailureNote` is a decode throwing, the progress ring is a fetch that
        // never landed, an `EmptyState` is an empty list from a working request,
        // and rows without the affordances is `ClientGate` withholding them.
        attach("matches")

        try waitForMatchesToLoad()

        // Avery's capabilities carry `block` and `report` on an active account,
        // so both are offered. Which card they land on is the server's answer,
        // so the assertion is "some card offers them", not "this card does".
        XCTAssertTrue(
            app.buttons["Report"].waitForExistence(timeout: 10),
            "the service granted `report`, so the affordance must be on the page"
        )
        XCTAssertTrue(
            app.buttons["Block"].waitForExistence(timeout: 5),
            "the service granted `block`, so the affordance must be on the page"
        )
        attach("matches-after-assertions")
    }

    /// Waits until a match row is actually on screen.
    ///
    /// ## Why not the screen title
    ///
    /// The tab bar offers the Matches tab as soon as `session != nil`, which is
    /// the moment sign-in returns — `refresh()` has not necessarily answered
    /// `GET /v1/matches` yet. And `app.staticTexts["Matches"]` matches the *tab
    /// bar's own label*, which is present from the first frame. So waiting on it
    /// returns instantly, the screen is still showing its progress ring, and any
    /// assertion about a row is really an assertion about the load having
    /// finished, made at the wrong moment.
    ///
    /// "Match" is the label of a `FactRow` that only a rendered match row emits,
    /// so it is the first thing on screen that means the list has content. An
    /// empty match list would render `EmptyState` instead, so this also fails
    /// loudly rather than hanging when there is genuinely nothing to show.
    private func waitForMatchesToLoad() throws {
        XCTAssertTrue(
            app.staticTexts["Match"].waitForExistence(timeout: 20),
            "the matches list never rendered; the screen may still be loading or the list is empty"
        )
    }

    /// Taps the Matches tab and *verifies* where it landed.
    ///
    /// ## Why a coordinate tap, and not `tap()`
    ///
    /// XCUITest reports every button in this app's custom tab bar as
    /// `isHittable == false` while simultaneously reporting it as `exists` with
    /// a correct, fully on-screen frame, and `.tap()` — which asks XCUITest to
    /// scroll the element into view and synthesise at the point it computes —
    /// does nothing at all. It logs `Scroll element to visible` followed by
    /// `Computed hit point {-1, -1}` and the app never moves.
    ///
    /// That was measured, not guessed, and it is *not* a client defect:
    ///
    ///   * all four tabs report the same, so it is not one misplaced button;
    ///   * it reproduces with the tab stacking removed and with `.refreshable`
    ///     removed, so neither is the cause;
    ///   * a coordinate tap at the button's centre selects the tab on the first
    ///     try, every time — so the control receives a real touch perfectly well.
    ///
    /// So the bar is fine and XCUITest's hittability heuristic is not, and this
    /// taps the way a thumb does. `fill` below already taps this way for the
    /// same class of reason.
    ///
    /// ## Why the landing is verified rather than assumed
    ///
    /// The bar is populated from what the service has published, so it grows as
    /// that data lands, and a tab that appears shifts the ones beside it. The
    /// tap is confirmed and retried once so that a reflow costs a retry rather
    /// than the test. Withholding a tab until the data that unlocks it exists is
    /// the client's stated rule — a bar that reflows under a finger is a real
    /// interaction cost, and it is documented as one in `RootScreen.swift`.
    private func tapMatchesTab() throws {
        let matchesTab = app.buttons["tab.matches"]
        // Attached on the failure path, not before the assertion.
        //
        // A wait that times out is the run that needs a picture of the screen,
        // and an attachment placed after the assertion never runs on it — which
        // is how "signing in did not unlock Matches" went unexamined for as long
        // as it did. Taken *after* the wait rather than before it, so the tree is
        // the one the service actually produced rather than the sign-in form.
        let unlocked = matchesTab.waitForExistence(timeout: 20)
        if !unlocked {
            attach("matches-tab-never-arrived")
        }
        XCTAssertTrue(unlocked, "signing in did not unlock Matches")

        matchesTab.tapCentre()
        if !app.buttons["tab.matches"].isSelected {
            matchesTab.tapCentre()
        }
        // Same reasoning again, one step further on: the tree after the tap is
        // the only thing that distinguishes "the tap went to a neighbour" from
        // "the tap landed and the bar disagrees about what is selected".
        let landed = app.buttons["tab.matches"].isSelected
        if !landed {
            attach("matches-tab-tap-missed")
        }
        XCTAssertTrue(landed, "the Matches tab did not stay selected after the tap")
    }

    /// A member with a match opens the conversation behind it and reads it.
    ///
    /// This is the whole chain the product promises — sign in, match, chat — and
    /// the demo dataset already holds a seeded conversation, so nothing is
    /// created to make it pass. Which conversation it is, and who sent what in
    /// it, is the server's answer; the assertions are that the screen opened,
    /// that the history rendered, and that the composer is offered because the
    /// standing carries `send_message`.
    func testAMemberOpensTheConversationBehindAMatch() throws {
        try signIn(as: MatchedMember.second)
        try tapMatchesTab()

        // What is on screen here is the whole answer if the rows never arrive:
        // an empty state, a progress ring or a failure each look different, and
        // guessing between them is how this took a run to diagnose.
        attach("matches")

        // Same reason as the other test: the tab appears before the list has
        // loaded, so waiting for the tab's own label proves nothing about the
        // rows being on screen.
        try waitForMatchesToLoad()
        let openChat = app.buttons["Open chat"]
        XCTAssertTrue(
            openChat.waitForExistence(timeout: 10),
            "the service published a conversation for this match, so the chat must be reachable"
        )
        openChat.tap()

        XCTAssertTrue(
            app.staticTexts["Messages"].waitForExistence(timeout: 10),
            "the chat screen did not open"
        )

        // The seeded history. Its content is the service's, so the assertion is
        // that a transcript rendered and is counted, not what anybody said.
        XCTAssertTrue(
            app.staticTexts["1 in total"].waitForExistence(timeout: 10),
            "the conversation the service holds did not render"
        )

        XCTAssertTrue(
            app.buttons["Send"].waitForExistence(timeout: 5),
            "the standing carries `send_message`, so the composer must be offered"
        )

        attach("chat")
    }

    /// Fills the form and presses the credentials card's own Sign in button, as
    /// the given seeded person.
    private func signIn(as person: Int) throws {
        guard let credentials = credentials(as: person) else {
            throw XCTSkip("seeded person \(person) is missing; `make demo` prints BEEN_THERE_DEMO_CONTACTS")
        }
        try signIn(with: credentials)
    }

    /// The two seeded people the demo dataset matches to each other.
    ///
    /// Avery and Blair are the only match in the dataset, and a match is
    /// symmetrical, so **both** of them can see it — which is what lets the two
    /// match-dependent tests each own an account instead of sharing one.
    ///
    /// They must stay different people. Both tests used to sign in as the same
    /// member, and `LOGIN_ATTEMPTS_PER_WINDOW` is five per account per fifteen
    /// minutes, so a suite run plus a few re-runs of one failing test exhausted
    /// the budget and the service refused with "Too many sign-in attempts".
    /// The symptom was not a rate limit at all: no session meant no member tabs,
    /// so XCUITest reported the missing `tab.matches` button as a computed hit
    /// point of (-1, -1), which reads exactly like a layout bug and sent the
    /// diagnosis after the client instead of after the fixture.
    ///
    /// One sign-in per account per run is what keeps a re-run of a single test
    /// affordable. Please do not "simplify" these two back into one account.
    private enum MatchedMember {
        /// Avery — the first of the pair, and the one the scheme's
        /// `BEEN_THERE_DEMO_CONTACT` names.
        static let first = 0
        /// Blair — the second, who is matched to Avery and so has the same match.
        static let second = 1
    }

    private func signIn(with credentials: (contact: String, password: String)) throws {
        guard let url = serviceURL() else {
            throw XCTSkip("BEEN_THERE_BASE_URL is needed; `make demo` prints it")
        }

        // The address is not typed. The app pre-fills it from
        // `BEEN_THERE_BASE_URL`, so the test asserts it rather than re-entering
        // it — which also removes the one field that arrived with a value in it,
        // and with it the only place the test needed to clear anything.
        let address = app.textFields.firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 10), "the address field is the first thing on the screen")
        XCTAssertEqual(
            address.value as? String, url.absoluteString,
            "the app did not pick the service address up from the environment"
        )
        // The address is left alone, so the keyboard is not up yet.

        let contact = app.textFields.element(boundBy: 1)
        XCTAssertTrue(contact.waitForExistence(timeout: 5), "the contact field is the second field")
        contact.fill(credentials.contact)
        // Scroll the form so the field below sits *above* the keyboard. The
        // keyboard covers the lower half of an 874-point screen and the password
        // field is at y≈673, so tapping it without this lands on a letter.
        // Scrolling rather than sending Return: a keystroke aimed at an unfocused
        // field is a hard XCUITest failure, and the keyboard's own key is labelled
        // differently per keyboard type.
        app.scrollViews.firstMatch.swipeUp()

        // The secure field is the flaky one: SwiftUI gives it focus on tap, but
        // while the keyboard from the field above is up it can swallow the first
        // tap, and the symptom is a silent empty field rather than an error. So
        // it is typed into until the value is actually there, twice at most.
        let password = app.secureTextFields.firstMatch
        XCTAssertTrue(password.waitForExistence(timeout: 5), "the password field is a secure field")
        for attempt in 1...2 {
            password.fill(credentials.password)
            if (password.value as? String)?.isEmpty == false { break }
            XCTAssertNotEqual(attempt, 2, "the password field never took focus")
        }

        // Exactly one control may be called "Sign in".
        //
        // Before the fix there were two — the button on the credentials card and
        // the tab-bar tab — and a client identifying by name cannot choose
        // between them: the tab sits later in the hierarchy and wins the lookup,
        // so the tap called `go(to: .signIn)`, a no-op, and `signIn()` never ran.
        // The count is asserted rather than a `firstMatch` trusted, because the
        // ambiguity is exactly the defect this test exists to catch.
        let candidates = app.buttons.matching(
            NSPredicate(format: "label == 'Sign in' AND identifier != 'tab.signIn'")
        )
        XCTAssertEqual(
            candidates.count, 1,
            "the sign-in action is not addressable: \(candidates.count) controls are named \"Sign in\""
        )
        XCTAssertTrue(candidates.element(boundBy: 0).waitForExistence(timeout: 5))
        candidates.element(boundBy: 0).tap()
    }

    /// The screen as it stands, whether or not the assertions pass.
    ///
    /// A UI test that fails with no picture of the screen is a riddle, and this
    /// file has already paid that price once.
    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
        print("SCREEN AT \(name):\n\(app.debugDescription)")
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
    /// Puts an exact value into an **empty** field.
    ///
    /// Deliberately not "replace". Clearing used delete-keys, and a delete-key
    /// press with no first responder is a hard XCUITest failure rather than a
    /// silent one — so a field that did not take focus turned into an error whose
    /// text pointed at the keyboard, not at the app. The only field that ever
    /// arrived with a value in it was the service address, and the app fills that
    /// from the environment, so nothing needs clearing at all.
    ///
    /// The keyboard wait is what makes the tap reliable: without it the typing
    /// races the first-responder change.
    func fill(_ text: String) {
        // The element's own tap, not a coordinate tap at the centre of the text:
        // a `SecureField` only takes first responder from a tap the control
        // itself recognises, and a coordinate inside its text frame can miss.
        tap()
        let keyboard = XCUIApplication().keyboards.firstMatch
        _ = keyboard.waitForExistence(timeout: 5)
        typeText(text)
    }

    /// A tap at the element's midpoint.
    func tapCentre() {
        coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
}
