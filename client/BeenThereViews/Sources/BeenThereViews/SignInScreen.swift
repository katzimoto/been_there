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
    }

    private var serviceAddress: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(spacing: Space.sm) {
                    Image(systemName: model.serviceReady == true ? "checkmark.circle.fill" : "server.rack")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(model.serviceReady == true ? palette.granted : palette.inkTertiary)
                    SectionHeader("Service")
                    Spacer(minLength: Space.sm)
                    if model.serviceReady == true {
                        TagChip("Ready", tint: palette.granted)
                    }
                }

                LabelledField("Address") {
                    TextField("http://127.0.0.1:8787", text: $model.serviceURLText)
                        .textFieldStyle(.plain)
                        .font(Typeface.mono)
                        .foregroundStyle(palette.ink)
                                        }

                HStack(spacing: Space.sm) {
                    PrimaryButton("Connect", isEnabled: model.canConnect && !model.isLoading) {
                        Task { await model.connect() }
                    }
                }

                switch model.serviceReady {
                case .some(true):
                    ForEach(model.serviceChecks, id: \.name) { check in
                        FactRow(check.name, check.ok ? "ok" : check.detail)
                    }
                case .some(false):
                    FactRow("Readiness", "not ready")
                    ForEach(model.serviceChecks, id: \.name) { check in
                        FactRow(check.name, check.ok ? "ok" : check.detail)
                    }
                case .none:
                    Text("Not checked yet.")
                        .font(Typeface.callout)
                        .foregroundStyle(palette.inkTertiary)
                }

                SecondaryButton("Check health") {
                    Task { await model.checkService() }
                }
            }
        }
    }

    private var credentials: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                SectionHeader("Your account")
                field("Email or phone", $model.contact)
                LabelledField("Password") {
                    SecureField("Password", text: $model.password)
                        .textFieldStyle(.plain)
                        .foregroundStyle(palette.ink)
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
                .font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(palette.accent.opacity(0.08))
                .foregroundStyle(palette.accent)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(PressableStyle())
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
                                .foregroundStyle(palette.accent)
                            Text(gate.title)
                                .font(Typeface.headline)
                                .foregroundStyle(palette.ink)
                        }
                        Text(gate.body)
                            .font(Typeface.callout)
                            .foregroundStyle(palette.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
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
        monospaced: Bool = false,
        verbatim: Bool = true
    ) -> some View {
        LabelledField(placeholder) {
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(monospaced ? Typeface.mono : Typeface.body)
                .foregroundStyle(palette.ink)
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