import SwiftUI
import BeenThereKit

/// The connection and sign-in screen.
///
/// ## Why the service address is on screen
///
/// `make demo` picks a port and prints it, so an app that could only reach one
/// hard-coded address would be unusable against any service but that one. The
/// address is therefore typed, checked, and then **verified** with
/// `/v1/health/ready` before anyone types a password — a `503` there is an
/// answer with a body, not a failure, so the screen distinguishes "the service
/// is up but not ready" from "there is nothing at this address".
///
/// ## What the sign-up form asks for, and why
///
/// No age field with a number in it. `readSignUpInput` refuses a body carrying
/// `age` or `ageYears`, and `APIClient.signUp` deliberately has no such
/// parameter: the service derives the band from a calendar date at submission
/// and publishes the band, never the date and never an exact age. The form asks
/// for the date because the server needs one, and displays the band it sends
/// back.
public struct SignInScreen: View {

    @Bindable var model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    @Environment(\.palette) private var palette

    /// Which field the keyboard is on.
    ///
    /// Two reasons it exists. The obvious one is the **Done** key
    /// `keyboardForm` adds: today the only way out of the keyboard is to drag the
    /// form, and nobody is going to guess that. The less obvious one is the bug it
    /// also fixes: focus outlives the screen, so a member presses Sign in, lands on
    /// People, and finds the keyboard still covering the lower third of their
    /// screen — and the tab bar with it, which is how a tap aimed at a tab lands on
    /// a letter.
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case address
        case contact
        case password
    }

    /// Whether the sign-up sheet is up. Local to this screen: the tab bar has no
    /// business knowing that creating an account is a sheet, and the sheet is not
    /// a destination anybody can be sent back to.
    @State private var showingSignUp = false

    public var body: some View {
        Screen("Been There", subtitle: "A client over the real service. Everything below is read from it.") {
            serviceAddress
            credentials
            notice
        }
        .keyboardForm($focus)
        .onChange(of: model.session) { _, next in
            // Signing in replaces this screen with another one; carrying the focus
            // with it would leave the keyboard up over whatever came next.
            if next != nil { focus = nil }
        }
    }

    private var serviceAddress: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                serviceStatus

                LabelledField("Address") {
                    TextField("http://127.0.0.1:8787", text: $model.serviceURLText)
                        .textFieldStyle(.plain)
                        .font(ScaledTypeface.mono)
                        .foregroundStyle(palette.ink)
                        .accessibilityLabel("Service address")
                        .accessibilityHint("The address of the Been There service.")
                        // `LabelledField` draws its content in a fixed 50pt box
                        // (Components.swift), so this is the third place the text
                        // size is held: past `.accessibility3` a 17pt field needs
                        // more height than the box has and gets clipped. What is
                        // traded is the field's own growth — every label around
                        // it still follows the setting without limit.
                        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    }

                HStack(spacing: Space.sm) {
                    PrimaryButton("Connect", isEnabled: model.canConnect && !model.isLoading) {
                        Task { await model.connect() }
                    }
                }

                switch model.serviceReady {
                case .some(true), .some(false):
                    readinessChecks
                case .none:
                    Text("Not checked yet.")
                        .font(ScaledTypeface.callout)
                        .foregroundStyle(palette.inkSecondary)
                }

                SecondaryButton("Check health") {
                    Task { await model.checkService() }
                }
            }
        }
    }

    /// What the readiness probe answered, as one element.
    ///
    /// The icon, the "Service" header and the `Ready` chip are three elements
    /// saying one fact, and the icon is the worst of the three: an SF Symbol
    /// with no label of its own is announced by its own name. So the row is one
    /// element whose value is `serviceReady` — the answer the probe published —
    /// and the drawn row keeps the icon, which is then decoration rather than
    /// something to be read.
    private var serviceStatus: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: model.serviceReady == true ? "checkmark.circle.fill" : "server.rack")
                .font(ScaledTypeface.symbol)
                .foregroundStyle(model.serviceReady == true ? palette.granted : palette.inkSecondary)
            SectionHeader("Service")
            Spacer(minLength: Space.sm)
            if model.serviceReady == true {
                TagChip("Ready", tint: palette.granted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Service")
        .accessibilityValue(serviceStatusSpoken)
    }

    /// What the probe answered, in the words the screen already uses.
    ///
    /// Three cases and no default, because `serviceReady` is `Bool?` and a
    /// fourth state is a type the model does not have — a screen that guessed
    /// "not checked" for a state it had not seen would be reporting the
    /// platform's ignorance as a fact about the service.
    private var serviceStatusSpoken: String {
        switch model.serviceReady {
        case .some(true): "Ready"
        case .some(false): "Not ready"
        case .none: "Not checked yet"
        }
    }

    /// The readiness answer, spoken as one sentence rather than one swipe per
    /// check.
    ///
    /// `ReadinessReport.Check.detail` is the service's own words for the check
    /// that failed, and it is passed through unchanged: this only decides the
    /// order things are said in, never what they are.
    private var readinessChecks: some View {
        var facts: [(label: String, value: String)] = []
        if model.serviceReady != true {
            facts.append((label: "Readiness", value: "not ready"))
        }
        facts.append(
            contentsOf: model.serviceChecks.map { check in
                (label: check.name, value: check.ok ? "ok" : check.detail)
            }
        )
        return VStack(alignment: .leading, spacing: Space.sm) {
            ForEach(facts, id: \.label) { fact in
                FactRow(fact.label, fact.value)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Service readiness")
        .accessibilityValue(spokenFacts(facts))
    }

    private var credentials: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                SectionHeader("Your account")
                field("Email or phone", $model.contact, focusValue: .contact)
                LabelledField("Password") {
                    SecureField("Password", text: $model.password)
                        .textFieldStyle(.plain)
                        .font(ScaledTypeface.body)
                        .foregroundStyle(palette.ink)
                        .accessibilityLabel("Password")
                        .focused($focus, equals: .password)
                        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    }
                if let failure = model.authFailure {
                    FailureNote(failure) { Task { await model.signIn() } }
                }
                PrimaryButton("Sign in", isEnabled: model.canSubmitCredentials) {
                    Task { await model.signIn() }
                }
                createAccount
            }
        }
    }

    /// The service's own words, shown verbatim.
    ///
    /// The age-gate notice is copy the service publishes on the sign-up response.
    /// Rewriting it would be the client stating a policy in its own voice, so it
    /// is displayed as-is and the age band the service derived is shown beside it.
    /// Creating an account is a screen of its own, presented as a sheet: the
    /// sign-up form asks for a birth date and the reason for it, which is not
    /// something to bury under a password field on the way in.
    private var createAccount: some View {
        Button {
            showingSignUp = true
        } label: {
            Text("Create an account")
                .font(ScaledTypeface.callout.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(palette.accent.opacity(0.08))
                .foregroundStyle(palette.accent)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(PressableStyle())
        // The label sits in a 50pt box this screen draws itself, so it is held
        // at the first accessibility size: past that a 17pt label needs more
        // than 50pt and SwiftUI clips it. What is traded is growth of one button
        // label — the sentence above it, the field labels and everything else on
        // the screen keep growing without limit.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .accessibilityHint("Opens the create-an-account form.")
        .accessibilityIdentifier("create-account")
        .sheet(isPresented: $showingSignUp) {
            SignUpScreen(model: model)
                .environment(\.palette, palette)
        }
    }

    private var notice: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if let gate = model.ageGateNotice {
                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        HStack(spacing: Space.sm) {
                            Image(systemName: "checkmark.seal.fill")
                                .font(ScaledTypeface.symbol)
                                .foregroundStyle(palette.accent)
                            Text(gate.title)
                                .font(ScaledTypeface.headline)
                                .foregroundStyle(palette.ink)
                        }
                        Text(gate.body)
                            .font(ScaledTypeface.callout)
                            .foregroundStyle(palette.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                // The notice is the service's own sentence, so it is announced
                // as one sentence rather than as a title element followed by a
                // body element the member has to swipe to and re-read.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(gate.title)
                .accessibilityValue(gate.body)
            }
            if let failure = model.loadFailure, model.authFailure == nil {
                FailureNote(failure) { Task { await model.checkService() } }
            }
        }
    }

    /// The field itself, not a labelled column.
    ///
    /// A helper returning `some View` erases its concrete type, so the caller
    /// cannot attach `.autocapitalization` afterwards. `verbatim` is a plain
    /// `Bool` rather than `UITextContentType` and
    /// `TextInputAutocapitalization` on purpose: those live in UIKit, and this
    /// package imports neither UIKit nor AppKit so the same files build for the
    /// iOS app later. A contact field that autocorrects or capitalises silently
    /// refuses a valid address, which is a failure the user cannot see the
    /// cause of — hence on by default.
    private func field(
        _ placeholder: String,
        _ text: Binding<String>,
        focusValue: Field,
        monospaced: Bool = false,
        verbatim: Bool = true
    ) -> some View {
        LabelledField(placeholder) {
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .focused($focus, equals: focusValue)
                .font(monospaced ? ScaledTypeface.mono : ScaledTypeface.body)
                .foregroundStyle(palette.ink)
                .accessibilityLabel(placeholder)
                .dynamicTypeSize(...DynamicTypeSize.accessibility3)
            // Verbatim entry — a contact address is an identifier, not prose.
            // `.textInputAutocapitalization` exists only in the iOS SDK's
            // SwiftUI (the macOS one has no text-input traits to set), and
            // `.autocorrectionDisabled` is carried by both; `.autocorrection(_:)`
            // was deprecated in iOS 16 and `.autocapitalization(_:)` was
            // UIKit-backed, which the no-UIKit rule forbids. One `#if` on the
            // modifier is narrower than one on a behaviour: the view, its state
            // and its layout stay shared.
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled(verbatim)
        }
    }
}