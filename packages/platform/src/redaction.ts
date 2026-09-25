import { SENSITIVITY_RANK, type Clearance, type DataSensitivity } from '@been-there/core';

/**
 * Redaction at the sink (ADR 0005). Every value that leaves a process for a
 * log line, an analytics property bag, an error report, or a moderator screen
 * passes through here, and here — not at the call site — the clearance of the
 * destination decides what survives.
 *
 * The call-site filter is the thing that always leaks eventually: someone adds
 * a field to a debug log, the filter is three directories away, the review
 * misses it. Putting the filter in the sink makes the leak structurally hard:
 * a field that nobody classified cannot be constructed (the type demands a
 * classification), and a field classified above the sink's clearance is dropped
 * on the way out regardless of who assembled the record.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A field with its classification attached. There is deliberately no
 * constructor that produces a field without a `sensitivity`: adding a field
 * means classifying it, which is the intended friction.
 *
 * A field's value may itself be a classified record, and the sink recurses
 * into it. Without that, "public" would become a word for "anything I did not
 * think about", and a liveness score would ride out inside a profile blob the
 * day somebody grouped two fields for convenience. The cost is one ambiguity:
 * an array of objects that happen to have `name`, `sensitivity`, and `value`
 * keys is read as a nested record, so that shape is reserved.
 */
export interface ClassifiedField {
  readonly name: string;
  readonly sensitivity: DataSensitivity;
  readonly value: ClassifiedValue;
}

export type ClassifiedValue = JsonValue | ClassifiedRecord;

export type ClassifiedRecord = readonly ClassifiedField[];

export interface RedactedField {
  readonly name: string;
  readonly sensitivity: DataSensitivity;
  /** True when the field survived the destination's clearance. */
  readonly delivered: boolean;
}

export interface RedactionResult {
  /** Only fields at or below the sink's clearance. */
  readonly visible: Readonly<Record<string, JsonValue>>;
  /** Every input field with its fate, so a sink can log a count without values. */
  readonly fields: readonly RedactedField[];
}

export function classify(
  name: string,
  sensitivity: DataSensitivity,
  value: ClassifiedValue,
): ClassifiedField {
  return { name, sensitivity, value };
}

/**
 * True when a consumer holding `clearance` may observe `sensitivity`. Uses the
 * shared rank from `@been-there/core` so a classification means the same thing
 * on the bus, in a log line, and in a moderation tool.
 */
export function isWithinClearance(clearance: Clearance, sensitivity: DataSensitivity): boolean {
  return SENSITIVITY_RANK[sensitivity] <= SENSITIVITY_RANK[clearance.upTo];
}

function isClassifiedField(value: unknown): value is ClassifiedField {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'name' in value &&
    'sensitivity' in value &&
    'value' in value
  );
}

function isNestedRecord(value: ClassifiedValue): value is ClassifiedRecord {
  return Array.isArray(value) && value.every(isClassifiedField);
}

function redactValue(
  value: ClassifiedValue,
  clearance: Clearance,
  prefix: string,
  fields: RedactedField[],
): JsonValue {
  if (!isNestedRecord(value)) {
    return value;
  }
  const nested = redact(value, clearance);
  for (const field of nested.fields) {
    fields.push({ ...field, name: `${prefix}.${field.name}` });
  }
  return nested.visible;
}

/**
 * Drops every field classified above `clearance`, at every level.
 *
 * Duplicate field names are a caller bug rather than an expected outcome (a
 * record that names the same field twice invites "the public one wins" shadowing
 * rules), so this throws instead of returning a `Result`.
 */
export function redact(record: ClassifiedRecord, clearance: Clearance): RedactionResult {
  const seen = new Set<string>();
  const visible: Record<string, JsonValue> = {};
  const fields: RedactedField[] = [];

  for (const field of record) {
    if (seen.has(field.name)) {
      throw new TypeError(`redact: duplicate field name "${field.name}"`);
    }
    seen.add(field.name);
    if (!isWithinClearance(clearance, field.sensitivity)) {
      fields.push({ name: field.name, sensitivity: field.sensitivity, delivered: false });
      continue;
    }
    visible[field.name] = redactValue(field.value, clearance, field.name, fields);
    fields.push({ name: field.name, sensitivity: field.sensitivity, delivered: true });
  }

  return { visible, fields };
}

/**
 * The serialisation entry point. This is the only sanctioned way to turn a
 * classified record into bytes for a log, an analytics call, or a support
 * export: dropped fields never reach the string at all, so there is nothing
 * downstream that can recover them.
 */
export function serializeForSink(record: ClassifiedRecord, clearance: Clearance): string {
  return JSON.stringify(redact(record, clearance).visible);
}

