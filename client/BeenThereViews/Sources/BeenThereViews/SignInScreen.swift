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

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    screenTitle("Been There")
                    screenSubtitle(
                        "A client over the real service. Everything below is read from it; "
                            + "nothing on this screen is invented."
                    )
                }

                serviceAddress
                credentials
                signUpExtras
                notice
            }
            .padding(Space.md)
        }
        .frame(width: phoneWidth)
        .background(Ink.canvas)
    }

    private var serviceAddress: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Service").font(.system(size: 16, weight: .semibold))
                TextField("http://127.0.0.1:8787", text: $model.serviceURLText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, design: .monospaced))
                    .padding(Space.sm)
                    .background(Ink.canvas)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))

                HStack {
                    PrimaryButton("Connect", isEnabled: model.canConnect && !model.isLoading) {
                        Task { await model.connect() }
                    }
                    Button("Check health") {
                        Task { await model.checkService() }
                    }
                    .font(.system(size: 14, weight: .medium))
                }

                switch model.serviceReady {
                case .some(true):
                    FactRow("Readiness", "ready")
                    ForEach(model.serviceChecks, id: \.name) { check in
                        FactRow(check.name, check.ok ? "ok" : check.detail)
                    }
                case .some(false):
                    FactRow("Readiness", "not ready")
                    ForEach(model.serviceChecks, id: \.name) { check in
                        FactRow(check.name, check.ok ? "ok" : check.detail)
                    }
                case .none:
                    screenSubtitle("Not checked yet.")
                }
            }
        }
    }

    private var credentials: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Your account").font(.system(size: 16, weight: .semibold))
                field("Email or phone", $model.contact)
                SecureField("Password", text: $model.password)
                    .textFieldStyle(.plain)
                    .padding(Space.sm)
                    .background(Ink.canvas)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
                PrimaryButton("Sign in", isEnabled: model.canSubmitCredentials) {
                    Task { await model.signIn() }
                }
            }
        }
    }

    private var signUpExtras: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Or create an account").font(.system(size: 16, weight: .semibold))
                field("Date of birth (YYYY-MM-DD)", $model.dateOfBirth, monospaced: true)
                field("Terms version", $model.termsVersion, monospaced: true)
                screenSubtitle(
                    "The terms version is pre-filled as a starting point and is editable. The "
                        + "service refuses a stale one and names the version it wants."
                )
                PrimaryButton("Sign up", isEnabled: model.canSubmitCredentials) {
                    Task { await model.signUp() }
                }
            }
        }
    }

    /// The service's own words, shown verbatim.
    ///
    /// The age-gate notice is copy the service publishes on the sign-up response.
    /// Rewriting it would be the client stating a policy in its own voice, so it
    /// is displayed as-is and the age band the service derived is shown beside it.
    private var notice: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if let gate = model.ageGateNotice {
                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        Text(gate.title).font(.system(size: 16, weight: .semibold))
                        screenSubtitle(gate.body)
                    }
                }
            }
            if let failure = model.authFailure {
                FailureNote(failure) {
                    Task { await model.signIn() }
                }
            }
            if let failure = model.loadFailure, model.authFailure == nil {
                FailureNote(failure) {
                    Task { await model.checkService() }
                }
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
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(.system(size: 14, design: monospaced ? .monospaced : .default))
            // `.autocapitalization` and `.disableAutocorrection` are UIKit-backed
            // and exist only on iOS. They are applied inside `#if os(iOS)` because
            // this package must compile for macOS today and for the iOS app later
            // out of one copy of this file — which is the whole reason the views
            // are their own package. On macOS the text entry behaviour has no
            // equivalent to ask for.
            #if os(iOS)
            .autocapitalization(.never)
            .disableAutocorrection(verbatim)
            #endif
            .padding(Space.sm)
            .background(Ink.canvas)
            .clipShape(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
    }
}