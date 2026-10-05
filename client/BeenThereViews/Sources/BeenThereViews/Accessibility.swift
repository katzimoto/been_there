import SwiftUI

/// Usability that is not a colour and not a token.
///
/// Three obligations live here, and none of them belongs in `DesignSystem.swift`
/// because none of them is something a screen is laid out *with*.
///
/// ## Dynamic Type
///
/// Every font in `Typeface` is a point size, and a point size does not move: the
/// scale is legible and completely deaf to the member's setting. `ScaledTypeface`
/// is the same six steps written as relative text styles, which is the only form
/// of this scale that can follow a text size. At the default size they sit within
/// a point or two of `Typeface`'s fixed values — `display` at 34 against 30,
/// `body` at 17 against 15, `callout` at 13 against 14 — and the cost is that
/// small drift, which is a cheaper trade than text nobody can enlarge.
///
/// Two things on this screen cannot follow the setting all the way, because a
/// box of fixed height draws them: `LabelledField`'s 50pt field and the compact
/// date picker. Those carry a `.dynamicTypeSize` cap at the point of use, with
/// the trade written next to it. Everything around them keeps growing.
///
/// ## VoiceOver
///
/// A chip holding `identity_verification` is a box with a word in it to a screen
/// reader, and a checklist whose only per-row state is a tick beside a
/// monospaced identifier says nothing at all to somebody who cannot see either.
/// So the rule the screens follow is narrow and strict: **a row that shows an
/// identifier also says what that identifier is**, every control has a label
/// rather than inheriting an SF Symbol name, and a group of related facts is one
/// element spoken as one sentence (`spokenFacts`) instead of six swipes through
/// six rows to arrive at one fact.
///
/// ## Switch Control
///
/// Nothing here is reachable only by a drag and the scan order is the reading
/// order. Every tap target in the package was measured from what is drawn
/// rather than from the label next to it, and one control is under 44pt: the
/// report-reason list in `SafetyActions.swift`. The sign-up date picker is the
/// other, and it is a different kind of defect — the platform draws it at 32pt
/// and no amount of framing changes that — so neither was made to look fixed.
///
/// ## The contrast audit
///
/// Measured as WCAG 2.1 relative luminance over the sRGB values in
/// `Palette.swift`, in both schemes, against every background a piece of text is
/// actually drawn on: `canvas`, `surface`, `fill`, `surfaceRaised`, `placeholder`
/// and the four soft state fills. The bar is 4.5:1 for body text, 3:1 for large
/// text and for non-text.
///
/// **Every ink passes on every background.** This table was written when one did
/// not; the failing value and the fix are recorded under the table.
///
/// | pair | light | dark |
/// | --- | --- | --- |
/// | `ink` | 14.28 – 17.93 | 12.58 – 16.93 |
/// | `inkSecondary` | 4.80 – 6.02 | 5.96 – 8.02 |
/// | `inkTertiary` | 4.54 – 5.34 (was **2.49 – 3.12**) | 4.54 – 6.12 (was **3.06 – 4.13**) |
/// | `accent` | 4.61 – 5.79 | 5.81 – 7.82 |
/// | `accentInk` | 6.48 – 8.13 | 7.94 – 10.69 |
/// | `granted` | 5.13 – 6.44 | 7.26 – 9.78 |
/// | `restricted` | 6.01 – 7.54 | 6.16 – 8.29 |
/// | `attention` | 4.71 – 5.91 | 7.33 – 9.87 |
///
/// `onAccent` on `accent` — the filled primary button and the filled circle
/// action — measures 5.79 light and 7.64 dark, so the one place that colour is
/// used is the one place it was measured for. Chip text on its own 10%-tint
/// background measures 4.70 – 6.91 light and 6.10 – 8.02 dark; the tint is
/// composited over `surface` and over `canvas` and both were checked.
///
/// **The one failure this file found has been fixed.** `inkTertiary` was 2.49:1
/// light — below the floor for body text by nearly two points, and below the
/// floor for *every* background in the app — at the 11pt (`SectionHeader`) and
/// 12pt (`caption`, `mono`) it is used at, which are never large text, so the 3:1
/// relaxation never applied to any of it. The palette owner took the values this
/// file stated (`light #6E655E`, `dark #99908A`, the same hue and lightness
/// walked toward the readable end), and both now clear 4.5:1 on
/// `placeholder` — the worst background in the palette — and the canvas. The
/// tier survives: what is given up is the *look* of a third weight that nobody
/// could read, which was not a weight.
public enum ScaledTypeface {
    /// A screen title. Rounded and bold, as `Typeface.display`.
    public static let display = Font.system(.largeTitle, design: .rounded).weight(.bold)
    /// A secondary title. Rounded and semibold, as `Typeface.title`.
    public static let title = Font.system(.title2, design: .rounded).weight(.semibold)
    /// The strongest text in a card. Rounded and semibold, as `Typeface.headline`.
    public static let headline = Font.system(.headline, design: .rounded).weight(.semibold)
    /// Running text.
    public static let body = Font.system(.subheadline)
    /// Running text a step down from `body`.
    public static let callout = Font.system(.footnote)
    /// A caption, at a weight that stays legible when it shrinks.
    public static let caption = Font.system(.caption).weight(.medium)
    /// Anything the server published as an identifier or a number. Monospaced,
    /// so a number reads as a number, and scaled like every other step.
    public static let mono = Font.system(.caption, design: .monospaced).weight(.medium)
    /// An SF Symbol sitting beside running text, sized from that text rather than
    /// from a literal, so an icon never drifts away from the words it labels.
    public static let symbol = Font.system(.subheadline).weight(.semibold)
    /// A bold semibold symbol, for a glyph that carries the state itself.
    public static let symbolStrong = Font.system(.headline).weight(.bold)
}

/// The smallest edge a row this app draws may have, in points.
///
/// iOS and the Switch Control both treat this as the floor: below it, a control
/// is reachable by a finger and by a scanning switch only by accident. It is a
/// constant rather than a modifier because most of the package already satisfies
/// it by construction — every `PrimaryButton` is 52pt, every `SecondaryButton`
/// 50pt, every `CircleAction` 52pt — and the one place a screen needs it is
/// holding the platform's own compact controls to this app's rhythm.
///
/// It is a floor for a *row*, not a way to enlarge a control: padding a view
/// out to 44pt makes the row 44pt and leaves the control inside it the size
/// the platform drew. A control that is genuinely shorter than this has to be
/// replaced rather than framed.
public let minimumTapTarget: CGFloat = 44

/// One spoken sentence for a list of key/value facts.
///
/// `FactRow` draws a fact as two pieces of text, and VoiceOver reads those two
/// pieces as two elements: six swipes to learn one thing. This is the sentence
/// those same facts make when they are announced as one element instead, and it
/// is the reason a screen can group a card without losing anything.
///
/// The labels and values are the strings the server published, passed straight
/// through. Nothing here interprets a value, decides whether a fact is
/// important, or drops one — a screen that shows a row must speak it, or the
/// spoken version of the screen is a different screen.
public func spokenFacts(_ facts: [(label: String, value: String)]) -> String {
    facts.map { "\($0.label): \($0.value)." }.joined(separator: " ")
}

/// A server-published name, read the way `ReportReason.title` reads it.
///
/// Capability names and step names are wire vocabulary: `delete_account`,
/// `verification_failed`, `photo_screening`. A screen reader pronounces the
/// underscores as "underscore" or skips them, so a member hears a word they
/// cannot act on. Reading the underscores as spaces is the same substitution
/// `ReportReason.title` already makes (`SafetyActions.swift`), and it changes
/// how a name sounds without changing which name it is.
public func spokenWords(_ value: String) -> String {
    value.replacingOccurrences(of: "_", with: " ")
}