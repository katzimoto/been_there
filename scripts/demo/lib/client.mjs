/**
 * The walk's HTTP client.
 *
 * Deliberately thin, and the same shape as `call()` in
 * `packages/service/test/support/harness.ts`: a bearer token, a JSON body, and
 * the parsed response. Nothing here reaches into the service's internals, so
 * every observation in the walk is one a real client could have made. A step
 * that could reach past HTTP would be testing the wiring rather than the
 * product, and the four steps that matter are all about what a request is *not*
 * allowed to do.
 */

/**
 * A client whose base URL can be moved, which step 11 needs: after the restart
 * the service answers on a different port, and re-reading through the *new*
 * process is the whole point.
 */
export function createClient(base = '') {
  let presentedAddress = null;
  return {
    base,

    /**
     * Presents every subsequent request as arriving from `address`, by sending
     * the header a reverse proxy in front of the service would send.
     *
     * This is the same seam `fromAddress()` gives the test harness, in the
     * production spelling: the harness varies a closure because nothing is in
     * front of it, whereas here a real hop reads `X-Forwarded-For`. Without
     * this, every request in the walk arrives over one loopback socket and so
     * shares one `signup_per_ip` bucket — see `scripts/demo/server.mjs`.
     *
     * @param {string | null} address
     */
    fromAddress(address) {
      presentedAddress = address;
    },

    /**
     * @param {string} method
     * @param {string} path
     * @param {string | undefined} token
     * @param {unknown} [body]
     */
    async call(method, path, token, body) {
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(presentedAddress === null ? {} : { 'x-forwarded-for': presentedAddress }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text.length === 0 ? {} : JSON.parse(text),
      };
    },
  };
}

/**
 * Asserts a status and returns the response, so a step can read the body after
 * having said what the status was.
 *
 * @param {{ status: number, body: Record<string, unknown> }} response
 * @param {number} status
 * @param {string} what
 */
export function expectStatus(response, status, what) {
  if (response.status !== status) {
    throw new Error(
      `${what}: expected HTTP ${status}, received ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response;
}

/** The `error` object of a refusal, or a failure saying the body was not one. */
export function errorOf(response) {
  const error = response.body['error'];
  if (typeof error !== 'object' || error === null) {
    throw new Error(
      `expected a refusal body with an "error" object, received ${JSON.stringify(response.body)}`,
    );
  }
  return /** @type {Record<string, unknown>} */ (error);
}

/** `details` of a refusal, as an object, or `{}`. */
export function detailsOf(response) {
  const details = errorOf(response)['details'];
  return typeof details !== 'object' || details === null
    ? {}
    : /** @type {Record<string, unknown>} */ (details);
}

/** Reads a nested field by dotted path, failing loudly rather than as undefined. */
export function at(body, path) {
  let current = body;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`cannot read ${path}: ${JSON.stringify(body)} has no object at "${key}"`);
    }
    current = current[key];
  }
  return current;
}