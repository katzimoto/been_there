# ADR 0005 — Per-field data sensitivity classification

**Status:** accepted · **Issue:** [#8](https://github.com/katzimoto/been_there/issues/8)

## Context

"Dating app" and "holds selfies, exact location, and reports about real people"
are the same system. The dangerous operations are not the obvious ones; they are
the convenient ones — a debug log that includes a payload, an analytics event
that carries a user id, a moderator tool that renders a whole record.

Classification per table does not catch these, because a single table legitimately
holds both a display name and a liveness score.

## Decision

Every field crossing a domain boundary is classified with one of `public`,
`user`, `internal`, `sensitive`, `restricted` (`DataSensitivity` in
`packages/core/src/domain-event.ts`). Events carry the classification, and
consumers declare a `clearance`. An event above a consumer's clearance is never
delivered.

Logging, analytics sinks, and error reporting must drop fields above the sink's
clearance at serialisation time, not at read time.

## Consequences

- Adding a field requires classifying it. That is the intended friction: the
  review question becomes "which class?", not "is this ok?".
- Bulk access to a record is never simply granted; access is per-classification.
- `restricted` reads (moderation evidence) are individually logged. We accept the
  storage cost because the audit trail is also our appeal evidence.
- A misclassified field fails toward under-exposure if the serialization
  filter is the enforcement point, which is why the filter lives in the sink,
  not in each call site.

## Revisit when

A regulatory regime (GDPR erasure, regional residency) forces field-level
retention or residency tracking beyond classification.
