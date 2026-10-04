import SwiftUI
import BeenThereKit

/// Creating an account, in the order the service needs it.
///
/// ## What this screen does not decide
///
/// The age gate. A member's date of birth is asked for because the service
/// requires it and refuses the account without it — the client's job is to *ask
/// well* and to show the refusal in the service's own words, not to reimplement
/// the rule. So there is no local "are you 18" check and no local rule about the
/// password's shape: a client that pre-judges either one becomes a second
/// definition of a rule the server owns, and the two drift apart silently.
///
/// ## Why the date is a picker and not a text field
///
/// `readSignUpInput` takes a `YYYY-MM-DD` string and the age gate parses it as a
/// calendar date, which means a text field can produce three kinds of wrong —
/// a typo, an impossible date like `1995-02-30`, and a format the reader did not
/// know. A picker cannot produce any of them, and it shows the member their date
/// before they commit to it. The string is still formatted to `YYYY-MM-DD` in
/// the calendar the picker used, so what is sent is what was seen.
///
/// ## Why the notice comes first
///
/// The service publishes `terms.ageGate` on its readiness endpoint: the sentence
/// explaining why a birth date is asked for, in its own words, including the
/// promise that nobody is shown it. Showing it *before* the field is the whole
/// point — the question is not a surprise, and the promise is the service's rather
/// than this screen's. When the service has not published one, the screen shows
/// no notice instead of writing one.
public struct SignUpScreen: View {
    @Environment(\.palette) private var palette

    @Bindable var model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        Screen("Create your account", subtitle: "It takes about a minute.") {
            if let notice = model.preflightAgeGate {
                Card {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        HStack(spacing: Space.sm) {
                            Image(systemName: "person.badge.shield.checkmark")
                                .foregroundStyle(palette.accent)
                            Text(notice.title)
                                .font(Typeface.headline)
                                .foregroundStyle(palette.ink)
                        }
                        Text(notice.body)
                            .font(Typeface.callout)
                            .foregroundStyle(palette.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            credentials
            dateOfBirth
            terms

            if let band = model.signUpAgeBand {
                Card {
                    HStack(spacing: Space.sm) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(palette.granted)
                        Text("You're in the \(band) band. Nobody is shown your date of birth.")
                            .font(Typeface.callout)
                            .foregroundStyle(palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }

            if let failure = model.authFailure {
                FailureNote(failure) { Task { await model.signUp() } }
            }

            PrimaryButton("Create account", isEnabled: model.canSubmitSignUp) {
                Task { await model.signUp() }
            }
            .disabled(model.isLoading)
        }
    }

    private var credentials: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.md) {
                SectionHeader("Your details")
                LabelledField("Email or phone") {
                    TextField("you@example.com", text: $model.contact)
                        .textFieldStyle(.plain)
                        .font(Typeface.body)
                        .foregroundStyle(palette.ink)
                        .autocorrectionDisabled()
                        .textContentType(.emailAddress)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        #endif
                }
                LabelledField("Password") {
                    SecureField("At least 10 characters", text: $model.password)
                        .textFieldStyle(.plain)
                        .foregroundStyle(palette.ink)
                        .textContentType(.newPassword)
                }
                // A count, not a strength score. The service owns what a password
                // may be — including the breached-password list this client knows
                // nothing about — so a bar here would be a rule the client invented
                // and a member could game. This says only how much they typed.
                HStack {
                    Text("\(model.password.count) characters")
                        .font(Typeface.caption)
                        .foregroundStyle(palette.inkTertiary)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private var dateOfBirth: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader("Date of birth")
                // Today is the maximum: a future date is not a birth date, and
                // letting the picker produce one would be offering an input the
                // service will refuse. The minimum is left open because the
                // service — not this screen — decides who is old enough.
                DatePicker(
                    "Date of birth",
                    selection: $model.signUpDateOfBirth,
                    in: ...Date(),
                    displayedComponents: .date
                )
                .datePickerStyle(.compact)
                .labelsHidden()
                .tint(palette.accent)
                Text(model.signUpDateOfBirth.formatted(.dateTime.year().month(.wide).day()))
                    .font(Typeface.body)
                    .foregroundStyle(palette.ink)
            }
        }
    }

    /// The terms version, stated rather than typed.
    ///
    /// It was an editable text field, which is a developer surface in a member's
    /// sign-up: the member cannot know which version the service accepts, and
    /// editing it could only ever break the request. The version comes from the
    /// service's own readiness answer when it has given one.
    private var terms: some View {
        Card {
            HStack(alignment: .top, spacing: Space.sm) {
                Image(systemName: "doc.text")
                    .foregroundStyle(palette.inkTertiary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Terms version \(model.termsVersion)")
                        .font(Typeface.mono)
                        .foregroundStyle(palette.ink)
                    Text("The service tells us which version it accepts, and refuses anything else.")
                        .font(Typeface.caption)
                        .foregroundStyle(palette.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
    }
}