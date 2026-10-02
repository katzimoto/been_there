import type { ServiceDependencies } from '../ports.js';

/**
 * Whether this process can do its job.
 *
 * ## Readiness is not liveness, and the difference is the whole point
 *
 * A readiness probe that answers "the process is up" is a liveness probe wearing
 * the wrong name: a service whose database is unreachable must be taken out of
 * the load balancer, and a service whose process is wedged must be restarted.
 * Driving both from one signal gets one of the two wrong, and the wrong one is the
 * expensive one — restarting every replica on a transient database fault turns a
 * degradation into an outage.
 *
 * So this module answers exactly one question, with a real query, against the
 * service's own `Transaction` port: can this process reach its transactional
 * store?
 */

/** One dependency and whether it answered. */
export interface DependencyCheck {
  readonly name: string;
  readonly ok: boolean;
  /** What failed, in words a human reads at 3am. Never a driver message. */
  readonly detail: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: readonly DependencyCheck[];
}

/**
 * A failure this module raised, and therefore the only failure whose message is
 * safe to show.
 *
 * Everything else — a `StoreError`, a driver error, an `AggregateError` from a
 * multi-address connect — carries text that names the host, the port and
 * sometimes the statement. A readiness body is read by whatever is watching the
 * pod, so those messages are replaced rather than passed through.
 */
class ProbeFailure extends Error {}

function refusal(reason: string): ProbeFailure {
  return new ProbeFailure(reason);
}

const UNREACHABLE = 'the transactional store is unreachable';

/**
 * The part of a database handle this probe uses.
 *
 * `Transaction.client` is `unknown` by design — `packages/contracts` stays
 * driver-free and the database package narrows it inside its own stores.
 * Readiness needs to issue one statement of its own, so it narrows the same way:
 * structurally at runtime, with no cast and no `any`.
 */
interface QueryableClient {
  query(text: string): Promise<unknown>;
}

function isQueryable(value: unknown): value is QueryableClient {
  return typeof value === 'object' && value !== null && 'query' in value && typeof value.query === 'function';
}

/**
 * How long a probe may take before it is answered anyway.
 *
 * A readiness probe that waits on a black-hole connection is worse than one that
 * fails: the orchestrator stops getting answers and restarts the pod for being
 * unresponsive rather than for being unhealthy. The driver call is abandoned
 * rather than cancelled — an in-flight query cannot be — so the late failure is
 * swallowed deliberately instead of being left to surface as an unhandled
 * rejection.
 */
const PROBE_TIMEOUT_MS = 2_000;

export async function checkDatabase(
  dependencies: ServiceDependencies,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<DependencyCheck> {
  const query = dependencies.transaction.run(async (tx) => {
    if (!isQueryable(tx.client)) {
      throw refusal('the transaction exposes no queryable handle, so this process cannot reach its store');
    }
    await tx.client.query('SELECT 1');
  });
  query.catch(() => undefined);

  const { promise: timedOut, reject: expire } = Promise.withResolvers<never>();
  const deadline = setTimeout(() => {
    expire(refusal(`the store did not answer within ${timeoutMs}ms`));
  }, timeoutMs);
  deadline.unref();

  try {
    await Promise.race([query, timedOut]);
    return { name: 'database', ok: true, detail: 'the transactional store answered' };
  } catch (error) {
    return { name: 'database', ok: false, detail: error instanceof ProbeFailure ? error.message : UNREACHABLE };
  } finally {
    clearTimeout(deadline);
  }
}