import type { ProviderMode, VerificationProvider } from '@been-there/identity';
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


/**
 * What the process is actually verifying with, stated at the boundary a
 * deployment reads.
 *
 * ## Why this is reported but does not gate readiness
 *
 * The tempting move is to answer `ready: false` when `mode` is `stub`, and it is
 * the wrong one. Readiness means "send this process traffic", and a deployment
 * that chose a stub — a demo, a fixture environment, a product that has not
 * bought a vendor yet — is *supposed* to be serving. Failing the probe would take
 * every replica out of rotation and turn an honest disclosure into an outage,
 * which teaches operators to ignore this endpoint, at which point the disclosure
 * is gone and so is the reason for it.
 *
 * So a stub is reported, loudly and by name, and readiness is left alone. What
 * changes is that nobody can reach a passing `/v1/health/ready` and conclude a
 * vendor is behind it: the field is right there, next to the `ready: true` it
 * accompanies.
 *
 * The distinction being protected is the one that matters for the product. The
 * identity machine, the attempt lifecycle and the 0.9 floor are real in both
 * modes — `mode` says nothing about whether the floor is enforced. What it says
 * is whether anyone has ever looked at a document.
 */
export interface VerificationDeclaration {
  /** `'stub'` or `'vendor'`. Never defaulted and never inferred. */
  readonly mode: ProviderMode;
  /** The adapter's own operational label. */
  readonly label: string;
  /**
   * Present only when `mode` is `stub`, and phrased for the operator reading the
   * probe rather than for the domain: it says what the process does *not* do.
   */
  readonly caveat: string | null;
}

/**
 * The declaration for this process's provider.
 *
 * A function rather than a constant so the caveat cannot drift from the mode it
 * describes: a stub whose caveat went empty would read as a vendor.
 */
export function verificationDeclaration(provider: VerificationProvider): VerificationDeclaration {
  return {
    mode: provider.mode,
    label: provider.label,
    caveat:
      provider.mode === 'stub'
        ? 'verification is running stubbed: no document, selfie or liveness capture has been ' +
          'examined by anyone, and every confidence score reaching the 0.9 floor was asserted ' +
          'by the stub rather than measured. The identity machine and the floor are real; the ' +
          'evidence behind them is not. This process must not be described as verifying anyone.'
        : null,
  };
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: readonly DependencyCheck[];
  /**
   * Always present. A readiness body that omitted it whenever verification was
   * stubbed would be indistinguishable from one written by a process with a
   * vendor, which is the omission this exists to prevent.
   */
  readonly verification: VerificationDeclaration;
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