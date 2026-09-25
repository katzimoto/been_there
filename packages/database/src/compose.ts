import type { Pool } from 'pg';
import type { Stores } from '@been-there/contracts';

/**
 * The composition root: one function that turns a pool into the set of stores
 * the service composes against.
 *
 * This exists so the service never imports a concrete store directly. It takes
 * the `Stores` port, builds every implementation, and hands back the port. A
 * test that wants to substitute a store can do so at this one seam rather than
 * at every call site.
 *
 * It is not written yet: the five store implementations are being built in
 * parallel, and wiring them together before they exist would be a stub. The
 * signature is settled so the service can code against it now.
 */
export function createStores(_pool: Pool): Stores {
  throw new Error(
    'createStores is not wired yet: the store implementations are landing separately. ' +
      'This signature is the contract the service codes against.',
  );
}
