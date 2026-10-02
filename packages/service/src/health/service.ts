import type { ServiceDependencies } from '../ports.js';
import { type LifecyclePhase, ServiceLifecycle, type ShutdownStep } from './lifecycle.js';
import { ServiceMetrics } from './metrics.js';
import { type ReadinessReport, checkDatabase } from './readiness.js';

/**
 * Everything the health routes answer from, held in one place.
 *
 * There is exactly one of these per running service, which is why
 * `createServiceHealth` memoises on the `ServiceDependencies` identity rather
 * than building one per route module: liveness, readiness and metrics must be
 * reading the same lifecycle and the same metric registry, or a process would
 * report itself healthy against one store and serve numbers from another.
 */
export class ServiceHealth {
  readonly metrics = new ServiceMetrics();
  readonly lifecycle = new ServiceLifecycle();

  constructor(private readonly dependencies: ServiceDependencies) {}

  /**
   * Ready means "send this process traffic", which is two things and not one:
   * the lifecycle has to be serving, and the transactional store has to answer.
   * A draining process answers false without probing anything — it is on its way
   * out and there is nothing to learn from a query it may not get to finish.
   */
  async readiness(): Promise<ReadinessReport> {
    const checkedAt = this.dependencies.now();
    if (!this.lifecycle.serving) {
      return {
        ready: false,
        checkedAt: checkedAt.toISOString(),
        checks: [
          {
            name: 'lifecycle',
            ok: false,
            detail: `this process is ${this.lifecycle.phase} and is not accepting traffic`,
          },
        ],
      };
    }
    const database = await checkDatabase(this.dependencies);
    this.metrics.recordProbe(database.ok ? 'up' : 'down');
    return {
      ready: database.ok,
      checkedAt: checkedAt.toISOString(),
      checks: [database],
    };
  }

  /** The liveness answer. It never touches a dependency, on purpose. */
  liveness(): { status: 'live'; phase: LifecyclePhase; pid: number; uptimeSeconds: number } {
    return {
      status: 'live',
      phase: this.lifecycle.phase,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  stop(steps: readonly ShutdownStep[]): Promise<void> {
    return this.lifecycle.stop(steps);
  }
}

const SURFACES = new WeakMap<ServiceDependencies, ServiceHealth>();

/**
 * The health surface for these dependencies.
 *
 * Memoised rather than constructed per call so `serviceRoutes(dependencies)` and
 * an operator reading `createServiceHealth(dependencies)` are looking at the same
 * numbers — a second surface would serve a second, empty metric registry.
 */
export function createServiceHealth(dependencies: ServiceDependencies): ServiceHealth {
  const existing = SURFACES.get(dependencies);
  if (existing !== undefined) {
    return existing;
  }
  const created = new ServiceHealth(dependencies);
  SURFACES.set(dependencies, created);
  return created;
}