/**
 * Element construction and the two panels this UI is built around.
 *
 * `refusalPanel` and `allowedPanel` are the reason the rest of the page looks the
 * way it does. A refusal from the service is rendered in full — status, `code`,
 * `domain`, `message`, `details` — because the product's claim is that the
 * *server* stops these things, and a claim a user cannot read is not a claim. An
 * answer that succeeded gets the same treatment, because "what did the server
 * allow" is as much a part of the demonstration as "what did it refuse".
 */

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs] `class`, `text`, `html` and `on*` handlers
 * @param {(Node | string | null | undefined)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (name === 'class') {
      node.className = String(value);
    } else if (name === 'text') {
      node.textContent = String(value);
    } else if (name === 'value') {
      node.value = String(value);
    } else if (name.startsWith('on')) {
      node.addEventListener(name.slice(2), value);
    } else if (value === true) {
      node.setAttribute(name, '');
    } else {
      node.setAttribute(name, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {unknown} value @returns {string} */
export function pretty(value) {
  return JSON.stringify(value, null, 2) ?? 'null';
}

/**
 * What the service refused, in the service's words.
 *
 * @param {{ status: number, body: unknown }} outcome
 * @returns {HTMLElement}
 */
export function refusalPanel(outcome) {
  const error = outcome.body?.error;
  const heading =
    error === undefined || error === null
      ? `The service answered ${outcome.status}.`
      : `The service refused this: ${outcome.status} ${String(error.code ?? '')}`.trim();
  return el('div', { class: 'refusal' }, [
    el('h3', { text: heading }),
    el('p', { class: 'note', text: error?.message ?? pretty(outcome.body) }),
    error?.domain === undefined
      ? null
      : el('p', { class: 'note', text: `Domain: ${String(error.domain)}` }),
    error?.details === undefined || error?.details === null
      ? null
      : el('pre', { text: pretty(error.details) }),
  ]);
}

/**
 * What the service allowed, in the service's words.
 *
 * @param {string} title
 * @param {unknown} body
 * @returns {HTMLElement}
 */
export function allowedPanel(title, body) {
  return el('div', { class: 'allowed' }, [
    el('h3', { text: title }),
    el('pre', { text: pretty(body) }),
  ]);
}

/**
 * The server's own list, rendered as a checklist.
 *
 * `missing` and `outstanding` come from the service. The client does not know
 * what makes a profile complete or what onboarding requires — it prints the list
 * it was given, and the labels are the identifiers the service used.
 *
 * @param {readonly string[]} outstanding
 * @param {readonly string[]} [done]
 * @returns {HTMLElement}
 */
export function checklist(outstanding, done = []) {
  const all = [...new Set([...outstanding, ...done])];
  if (all.length === 0) {
    return el('p', { class: 'note', text: 'Nothing outstanding.' });
  }
  return el(
    'ul',
    { class: 'checklist' },
    all.map((item) => {
      const isDone = !outstanding.includes(item);
      return el('li', {}, [
        el('span', { text: item.replaceAll('_', ' ') }),
        el('span', { class: 'pill ' + (isDone ? 'on' : 'off'), text: isDone ? 'done' : 'outstanding' }),
      ]);
    }),
  );
}

/**
 * The capabilities an account currently holds, printed as the server printed
 * them.
 *
 * This is the answer to "what can a restricted account still do", and it is read
 * from `GET /v1/accounts/:userId`, which publishes the grant the account machine
 * computed. The struck-through entries are the ones the service removed — the UI
 * is not deciding which ones those are either.
 *
 * @param {{ state: string, capabilities: readonly string[], visibleInProduct: boolean }} account
 */
export function capabilityPanel(account) {
  const held = new Set(account.capabilities);
  const known = [
    'browse_discovery',
    'like',
    'send_message',
    'report',
    'block',
    'edit_profile',
  ];
  const shown = [...new Set([...known, ...held])];
  return el('div', {}, [
    el('p', { class: 'note', text: `Account state: ${account.state}` }),
    el(
      'div',
      {},
      shown.map((name) =>
        el('span', {
          class: 'pill ' + (held.has(name) ? 'on' : 'off'),
          text: name,
        }),
      ),
    ),
    el('p', {
      class: 'note',
      text:
        'Green is what the service says this account may do. Struck through is what it ' +
        'may not. `report` and `block` cannot be removed by a restriction, and this ' +
        'panel is where you see that.',
    }),
  ]);
}

/** @param {string} text @returns {HTMLElement} */
export function empty(text) {
  return el('p', { class: 'empty', text });
}

/** @param {string} text @param {unknown} [detail] @returns {HTMLElement} */
export function section(title, text, detail) {
  return el('div', { class: 'card' }, [
    el('h2', { text: title }),
    text === '' ? null : el('p', { class: 'note', text }),
    detail ?? null,
  ]);
}
