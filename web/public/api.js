/**
 * Every call the page makes, and the record of what came back.
 *
 * ## The one rule in this file
 *
 * A refusal is a result, not an exception. `call()` resolves with the status and
 * the parsed body whatever they are, and the UI renders what the service said —
 * its `code`, its `domain`, its `message`, its `details`. Nothing here inspects a
 * status code to decide whether an action was allowed, because the client has no
 * standing to make that call: the server publishes the answer, and a second
 * opinion in the browser is a second answer that can disagree.
 *
 * `ApiError` exists only for the one case where there was no answer at all — the
 * service could not be reached, or replied with something that is not JSON.
 */

/** A call that never reached the service, so there is no domain refusal to show. */
export class ApiError extends Error {
  constructor(label, cause) {
    super(`${label}: ${cause}`);
    this.name = 'ApiError';
  }
}

/** The last 200 exchanges, newest first, for the request log panel. */
const LOG_LIMIT = 200;

/** @type {{ id: number, at: string, method: string, path: string, status: number, request: unknown, response: unknown }[]} */
let entries = [];
let sequence = 0;
const listeners = new Set();

/**
 * One request, and one line in the log.
 *
 * @param {object} options
 * @param {string} options.token bearer token, or `null` for an anonymous call
 * @param {string} options.method
 * @param {string} options.path path under `/v1`
 * @param {unknown} [options.body] JSON request body
 * @param {object} [options.query]
 * @param {string} [options.label] what the UI was trying to do, shown in the log
 */
export async function call({ token, method, path, body, query, label }) {
  const search = query === undefined ? '' : `?${new URLSearchParams(query)}`;
  const url = `/v1${path}${search}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null || token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(label ?? `${method} ${path}`, `the service did not answer (${cause.message})`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    throw new ApiError(label ?? `${method} ${path}`, 'the service replied with something that is not JSON');
  }
  sequence += 1;
  entries = [
    {
      id: sequence,
      at: new Date().toISOString(),
      method,
      path: `${path}${search}`,
      status: response.status,
      request: body ?? null,
      response: parsed,
    },
    ...entries,
  ].slice(0, LOG_LIMIT);
  for (const listener of listeners) {
    listener();
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

/** The exchange log, newest first. @returns {typeof entries} */
export function log() {
  return entries;
}

/** @param {() => void} listener called after every exchange */
export function onExchange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The reasons a report may be filed under, read from the service rather than
 * copied into the client.
 *
 * `REPORT_REASON_POLICY`'s keys live in `packages/moderation` and are not
 * published by any endpoint. The edge validator does publish them: an
 * unrecognised value comes back as `validation_failed` with `details.allowed`
 * listing what was permitted. The handler returns before it touches the database,
 * so the probe costs nothing and writes nothing — and the menu a member picks
 * from is the menu the service accepts, with no second list to drift.
 *
 * @param {string} token
 * @returns {Promise<string[]>}
 */
export async function reportReasons(token) {
  const probe = await call({
    token,
    method: 'POST',
    path: '/reports',
    body: { subjectUserId: '00000000-0000-0000-0000-000000000000', reason: '__ask__' },
    label: 'ask the service which report reasons it accepts',
  });
  const allowed = probe.body?.error?.details?.allowed;
  if (typeof allowed !== 'string') {
    return [];
  }
  return allowed.split(',').filter((entry) => entry.length > 0);
}
