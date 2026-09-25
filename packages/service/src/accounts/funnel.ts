import { randomUUID } from 'node:crypto';
import type { Stores, Transaction } from '@been-there/contracts';
import type { ActorId, SubjectId, UserId } from '@been-there/core';
import {
  type AnalyticsProperty,
  type AnalyticsEventName,
  type AuditAction,
  recordAnalyticsEvent,
} from '@been-there/platform';

/**
 * The two sinks the onboarding funnel writes to, and the run they are joined by.
 *
 * §11 is precise about the split and the code has to be as precise as the
 * document: analytics is aggregate and carries no identity, audit is complete
 * and carries the security facts. Conflating them is how a safety fact becomes a
 * chart, so the two are two functions here and neither can be called with the
 * other's arguments.
 *
 * `correlationId` is the onboarding run id. It is minted per run and returned to
 * the client, so a funnel query is one joinable series rather than a set of rows
 * that share a timestamp.
 */
export interface Funnel {
  readonly stores: Stores;
  readonly tx: Transaction;
  /** The onboarding run id. Never a user id: that would make it a join key. */
  readonly correlationId: string;
  readonly now: Date;
}

/** A run id the client may supply, so pre- and post-registration steps join. */
export function correlationIdFrom(supplied: string | undefined): string {
  return supplied === undefined || supplied.length === 0 ? randomUUID() : supplied;
}

/**
 * Records one analytics event.
 *
 * The event name and its dimensions come from the Platform catalogue, and
 * `recordAnalyticsEvent` refuses an undeclared name, an undeclared dimension, a
 * forbidden property and a non-scalar. A refusal here throws rather than being
 * swallowed: it means the code and the catalogue disagree, and the alternative —
 * a `Result` some caller remembers to check — is a funnel that is quietly wrong.
 * The throw happens inside the request's transaction, so nothing is written.
 */
export async function recordFunnel(
  funnel: Funnel,
  name: AnalyticsEventName,
  properties: Readonly<Record<string, AnalyticsProperty>>,
): Promise<void> {
  const recorded = recordAnalyticsEvent({
    name,
    occurredAt: funnel.now,
    correlationId: funnel.correlationId as Parameters<typeof recordAnalyticsEvent>[0]['correlationId'],
    properties,
  });
  if (!recorded.ok) {
    throw new Error(
      `analytics event ${name} was refused by the catalogue: ${recorded.error.message} (${JSON.stringify(recorded.error.details ?? {})})`,
    );
  }
  await funnel.stores.accounts.insertAnalyticsEvent(
    {
      eventId: randomUUID(),
      type: name,
      occurredAt: funnel.now,
      correlationId: funnel.correlationId,
      properties: recorded.value.properties,
    },
    funnel.tx,
  );
}

export interface AuditEntry {
  readonly action: AuditAction;
  readonly actorId: ActorId;
  readonly subjectId: UserId | SubjectId | null;
  /** What the record is about: `account`, `session`, `recovery`, … */
  readonly entityType: string;
  readonly entityId: string;
  /**
   * Scalars only. A date of birth, a contact identifier, a token and a password
   * have no field here, so an audit row cannot become the copy of the data it
   * describes.
   */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  /** Set for a fact that must happen at most once. */
  readonly dedupeKey?: string;
}

/**
 * Appends to the audit log.
 *
 * The moderation store is the append-only log the whole system writes to — the
 * platform's `InMemoryAuditLog` classifies, this one reconstructs a chain, and
 * §6 of the platform architecture says the one every production call site writes
 * is the one that reconstructs. It has no update and no delete, and the port has
 * no method that could become one.
 */
export async function appendAudit(funnel: Funnel, entry: AuditEntry): Promise<void> {
  await funnel.stores.moderation.appendAudit(
    {
      occurredAt: funnel.now,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      subjectId: entry.subjectId === null ? null : String(entry.subjectId),
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ...(entry.dedupeKey === undefined ? {} : { dedupeKey: entry.dedupeKey }),
    },
    funnel.tx,
  );
}
