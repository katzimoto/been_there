import type { Server } from 'node:http';

/**
 * Startup and shutdown ordering.
 *
 * ## The ordering is the feature
 *
 * `stop` moves the process to `draining` *synchronously*, before it awaits
 * anything, and only then begins releasing resources. Readiness reads that phase,
 * so a load balancer stops sending traffic at the instant the shutdown starts
 * rather than at the instant the listener actually closes — which is the window
 * in which a request is accepted by a process that is about to stop answering.
 *
 * Then the steps run in the order they were given, every one of them, even after
 * one fails: a connection pool that will not close must not be the reason the
 * listener stays open. Committed work is never at risk from this order, because a
 * request's transaction commits or rolls back inside the request; what the order
 * buys is that an in-flight request is *answered* before the resources it is using
 * are released.
 */

export type LifecyclePhase = 'starting' | 'serving' | 'draining' | 'stopped';

/** One resource to release, named so a failed shutdown says which one. */
export interface ShutdownStep {
  readonly name: string;
  readonly close: () => Promise<void>;
}

export class ServiceLifecycle {
  #phase: LifecyclePhase = 'starting';
  #stopping: Promise<void> | undefined;

  get phase(): LifecyclePhase {
    return this.#phase;
  }

  /** True only while this process should be sent traffic. */
  get serving(): boolean {
    return this.#phase === 'serving';
  }

  /**
   * The transition out of `starting`. Ignored in any other phase: a second call
   * after a drain must not resurrect a process that is on its way out, because
   * `serve` would answer true to a probe that is about to be dropped.
   */
  beginServing(): void {
    if (this.#phase === 'starting') {
      this.#phase = 'serving';
    }
  }

  /**
   * Stops, once. A second call returns the first call's promise rather than
   * closing a second time, so a `SIGTERM` and a `SIGINT` arriving together cannot
   * double-close a pool.
   */
  stop(steps: readonly ShutdownStep[]): Promise<void> {
    this.#stopping ??= this.#drain(steps);
    return this.#stopping;
  }

  async #drain(steps: readonly ShutdownStep[]): Promise<void> {
    this.#phase = 'draining';
    const failures: unknown[] = [];
    for (const step of steps) {
      try {
        await step.close();
      } catch (error) {
        failures.push(new Error(`shutting down "${step.name}" failed`, { cause: error }));
      }
    }
    this.#phase = 'stopped';
    if (failures.length > 0) {
      throw new AggregateError(failures, 'the service did not shut down cleanly');
    }
  }
}

/**
 * Stops accepting connections, then waits for the requests already accepted.
 *
 * `closeIdleConnections` drops keep-alive sockets that are between requests —
 * they hold nothing — and the grace timer bounds the wait for a client that
 * opened a request and never finished it, so a shutdown cannot hang on one
 * socket forever. The timer is unref'd: it must not be the last thing holding
 * this process open.
 */
export async function drainServer(server: Server, graceMs: number): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  server.closeIdleConnections();
  const grace = setTimeout(() => {
    server.closeAllConnections();
  }, graceMs);
  grace.unref();
  try {
    await closed;
  } finally {
    clearTimeout(grace);
  }
}