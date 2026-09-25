import type { ActorId, CorrelationId, EventId, SubjectId } from './ids.js';
/**
 * Data-sensitivity classification. Every field crossing a domain boundary or
 * landing in a store, log or analytics sink is tagged, so "where may this be
 * read from" is answerable per field rather than per table (issue #8).
 */
export type DataSensitivity = 
/** Any visitor. Discovery-card fields only. */
'public'
/** The owning user. */
 | 'user'
/** Internal to the platform; never rendered to a user. */
 | 'internal'
/** Highly sensitive: identity evidence, exact location, biometrics. */
 | 'sensitive'
/** Moderation-only. Requires an audited, per-access-logged read. */
 | 'restricted';
export declare const SENSITIVITY_RANK: Readonly<Record<DataSensitivity, number>>;
/**
 * Event envelope. Domains communicate by publishing these; they never call each
 * other's internals. `sensitivity` gates which consumers may observe the event,
 * which is how safety signals flow without leaking identity internals into the
 * dating product.
 */
export interface DomainEvent<P = Readonly<Record<string, unknown>>> {
    readonly eventId: EventId;
    readonly type: string;
    /** Schema version of `payload`; consumers must tolerate unknown major versions. */
    readonly version: number;
    readonly occurredAt: Date;
    /** Who caused it. System actions use `system`. */
    readonly actorId: ActorId | 'system';
    /** Who it happened to — usually the user the event is about. */
    readonly subjectId?: SubjectId;
    readonly correlationId: CorrelationId;
    /** Event that caused this one, for causal chains across domains. */
    readonly causationId?: EventId;
    readonly sensitivity: DataSensitivity;
    readonly payload: P;
}
export interface EventQuery {
    readonly types?: readonly string[];
    readonly subjectId?: SubjectId;
    readonly since?: Date;
    readonly limit?: number;
}
/**
 * Consumer authorisation. A consumer declares the sensitivity it is cleared for;
 * an event above its clearance is invisible to it rather than filtered, so a
 * consumer can never accidentally read what it may not hold.
 */
export interface Clearance {
    readonly upTo: DataSensitivity;
}
export declare function isClearedToConsume(clearance: Clearance, event: DomainEvent): boolean;
/**
 * In-process event bus contract. The production implementation is durable
 * (outbox + broker); this is the shape both the in-memory test double and the
 * real adapter satisfy, so tests exercise the same call shape as production.
 */
export interface EventPublisher {
    publish(event: DomainEvent): Promise<void>;
}
export interface EventSubscriber {
    subscribe(clearance: Clearance, handler: (event: DomainEvent) => Promise<void>): void;
}
export type Unsubscribe = () => void;
export declare class InMemoryEventBus implements EventPublisher, EventSubscriber {
    #private;
    publish(event: DomainEvent): Promise<void>;
    subscribe(clearance: Clearance, handler: (event: DomainEvent) => Promise<void>): Unsubscribe;
}
//# sourceMappingURL=domain-event.d.ts.map