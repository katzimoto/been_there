/**
 * The signed-in personas, their bearer tokens, and the one helper that turns a
 * button press into a service call plus a re-read.
 *
 * Several personas share one browser because the journey cannot be walked alone: a
 * like becomes a match only when the other person likes back, and a block only
 * means something when someone else blocks you. Each persona holds its own
 * session token, which is what a second device would have had.
 */

import { ApiError, call } from './api.js';

const STORE_KEY = 'been-there.web.personas.v1';

/**
 * @typedef {object} Persona
 * @property {string} id
 * @property {string} name
 * @property {string} token
 * @property {string} userId
 * @property {string} ageBand
 * @property {string} [state] account state last published by the service
 * @property {string} [identity] identity state last published by the service
 */

/** @type {Persona[]} */
let personas = [];
/** @type {string | null} */
let activeId = null;
/** @type {(() => void)[]} */
const listeners = [];
/** @type {(() => void)[]} */
const chromeListeners = [];

restore();

function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw === null ? [] : JSON.parse(raw);
    personas = Array.isArray(parsed) ? parsed : [];
  } catch {
    personas = [];
  }
  activeId = personas[0]?.id ?? null;
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(personas));
}

/** The persona this browser is acting as. @returns {Persona | null} */
export function me() {
  return personas.find((entry) => entry.id === activeId) ?? null;
}

/** Its bearer token, or `null` when nobody is signed in. @returns {string | null} */
export function token() {
  return me()?.token ?? null;
}

/** Everyone signed in, for the persona switcher. @returns {Persona[]} */
export function all() {
  return personas;
}

/**
 * Two audiences, because two different things happen.
 *
 * `onChange` means "the person acting changed" — a full re-render. `onChrome`
 * means "the standing of the person acting changed" — the persona chip and the
 * account screen only. An action must *not* re-render: the panel that shows the
 * service's answer to that action lives in the screen that pressed the button,
 * and a re-render here would replace it with a fresh empty panel the instant the
 * answer arrived.
 *
 * @param {() => void} listener
 */
export function onChange(listener) {
  listeners.push(listener);
}

/** @param {() => void} listener */
export function onChrome(listener) {
  chromeListeners.push(listener);
}

function announce() {
  persist();
  for (const listener of listeners) {
    listener();
  }
}

function announceChrome() {
  persist();
  for (const listener of chromeListeners) {
    listener();
  }
}

/**
 * Sign a freshly created account in as the active persona.
 *
 * @param {{ id: string, name: string, token: string, userId: string, ageBand: string }} persona
 */
export function adopt(persona) {
  personas = [persona, ...personas.filter((entry) => entry.userId !== persona.userId)];
  activeId = personas[0].id;
  announce();
}

/**
 * Stop acting as anyone without forgetting who is signed in.
 *
 * Used by "Add a person": the personas already on this browser stay, because a
 * match needs two of them and discarding the first to create the second would
 * make the journey unclickable.
 */
export function detach() {
  activeId = null;
  announce();
}

/** @param {string} id */
export function select(id) {
  activeId = id;
  announce();
}

/** Forget everyone, for a clean walkthrough. */
export function reset() {
  personas = [];
  activeId = null;
  persist();
  announce();
}

/**
 * The one call every screen uses: make a request as the active persona, then
 * re-read the account projection so the chrome shows the standing the service
 * just published.
 *
 * The re-read is not cosmetic. A restriction is applied by a moderator in a
 * different persona, and the point of the demonstration is that this one *cannot*
 * send a message afterwards without the service saying so — which it can only say
 * if the page asks again.
 *
 * @param {object} options
 * @param {string} options.label what the UI was trying to do
 * @param {(bearer: string) => Promise<{ status: number, ok: boolean, body: unknown }>} options.body
 * @returns {Promise<{ status: number, ok: boolean, body: unknown } | null>}
 */
export async function act({ label, body }) {
  const persona = me();
  if (persona === null) {
    return null;
  }
  try {
    const outcome = await body(persona.token);
    await refresh(persona.id);
    announceChrome();
    return outcome;
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        status: 0,
        ok: false,
        body: {
          error: { code: 'service_unreachable', domain: 'web.client', message: `${label}: ${error.message}` },
        },
      };
    }
    throw error;
  }
}

/**
 * Re-read one persona's account projection and cache what it published.
 *
 * @param {string} id
 */
export async function refresh(id) {
  const persona = personas.find((entry) => entry.id === id);
  if (persona === undefined) {
    return;
  }
  const outcome = await call({
    token: persona.token,
    method: 'GET',
    path: `/accounts/${persona.userId}`,
    label: 'read the account projection',
  });
  if (outcome.ok) {
    persona.state = outcome.body?.account?.state ?? 'active';
    persona.identity = outcome.body?.identity?.state ?? 'unverified';
    persona.capabilities = outcome.body?.account?.capabilities ?? [];
  }
}

/**
 * Conversations this browser has been told about.
 *
 * The only endpoint that publishes a `conversationId` is the like response, and
 * only for the like that *created* the match. `GET /v1/matches` returns the
 * match, its participants and its standings, and nothing that opens a
 * conversation — so the person who liked first has no published way to learn
 * one. Rather than invent an id or reach around the API, this remembers what the
 * service actually said and lets the screen say so when there is nothing to
 * remember.
 *
 * @type {Map<string, { conversationId: string, matchId: string, otherId: string, otherName: string }>}
 */
const conversations = new Map();

/** @param {string} a @param {string} b */
function pairKey(a, b) {
  return [a, b].sort().join('|');
}

/**
 * @param {string} viewerId
 * @param {{ conversationId: string, match: string }} like
 * @param {{ userId: string, displayName: string }} other
 */
export function rememberConversation(viewerId, like, other) {
  conversations.set(pairKey(viewerId, other.userId), {
    conversationId: like.conversationId,
    matchId: like.match,
    otherId: other.userId,
    otherName: other.displayName,
  });
}

/**
 * @param {string} viewerId
 * @param {string} otherId
 * @returns {{ conversationId: string, matchId: string, otherId: string, otherName: string } | null}
 */
export function conversationFor(viewerId, otherId) {
  return conversations.get(pairKey(viewerId, otherId)) ?? null;
}
