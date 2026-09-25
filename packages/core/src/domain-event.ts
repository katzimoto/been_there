import type { ActorId, CorrelationId, EventId, SubjectId } from './ids.js';

/**
 * Data-sensitivity classification. Every field crossing a domain boundary or
 * landing in a store, log or analytics sink is tagged, so "where may this be
 * read from" is answerable per field rather than per table (issue #8).
 */
export type DataSensitivity =
  /** Any visitor. Discovery-card fields only. */
  | 'public'
  /** The owning user. */
  | 'user'
  /** Internal to the platform; never rendered to a user. */
  | 'internal'
  /** Highly sensitive: identity evidence, exact location, biometrics. */
  | 'sensitive'
  /** Moderation-only. Requires an audited, per-access-logged read. */
  | 'restricted';

export const SENSITIVITY_RANK: Readonly<Record<DataSensitivity, number>> = {
  public: 0,
  user: 1,
  internal: 2,
  sensitive: 3,
  restricted: 4,
};

/**
 * Event envelope. Domains communicate by publishing these; they never call each
 * other's internals. `sensitivity` gates which consumers may observe the event,
 * which is how safety signals flow without leaking identity internals into the
 * dating product.
 */
export interface DomainEvent<P = Readonly<Record<string, unknown>>> {
  readonly eventId: EventId;
  readonly type: string;
  /** Schema version of `payload`; consumers must tolerate unknown versions. */
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

export interface Clearance {
  readonly upTo: DataSensitivity;
}

export function isClearedToConsume(clearance: Clearance, event: DomainEvent): boolean {
  return SENSITIVITY_RANK[event.sensitivity] <= SENSITIVITY_RANK[clearance.upTo];
}

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

export type Unsubscribe = () => void;

/**
 * In-process event bus contract. The production implementation is durable
 * (transactional outbox + broker); this is the shape both the in-memory double
 * and the real adapter satisfy, so tests exercise the same call shape as
 * production and a swapped transport changes no domain code.
 */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface EventSubscriber {
  subscribe(clearance: Clearance, handler: EventHandler): Unsubscribe;
}

export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  #registered: { clearance: Clearance; handler: EventHandler }[] = [];

  async publish(event: DomainEvent): Promise<void> {
    for (const { clearance, handler } of this.#registered) {
      if (isClearedToConsume(clearance, event)) {
        await handler(event);
      }
    }
  }

  subscribe(clearance: Clearance, handler: EventHandler): Unsubscribe {
    this.#registered.push({ clearance, handler });
    return () => {
      this.#registered = this.#registered.filter((entry) => entry.handler !== handler);
    };
  }
}
